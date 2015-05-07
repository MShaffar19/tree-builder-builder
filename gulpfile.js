var gulp = require('gulp');
var parseArgs = require('minimist');
var fs = require('fs');
var assert = require('chai').assert;
var mocha = require('gulp-mocha');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var http = require('http');

var TreeBuilder = require('./lib/tree-builder');
var HTMLWriter = require('./lib/html-writer');
var JSWriter = require('./lib/js-writer');
var StatsWriter = require('./lib/stats-writer');
var StyleFilter = require('./lib/style-filter');
var StyleMinimizationFilter = require('./lib/style-minimization-filter');
var StyleTokenizerFilter = require('./lib/style-tokenizer-filter');
var SchemaBasedFabricator = require('./lib/schema-based-fabricator');
var NukeIFrameFilter = require('./lib/nuke-iframe-filter');
var ParseExperiment = require('./lib/parse-experiment');
var StyleDetokenizerFilter = require('./lib/style-detokenizer-filter');

var options = parseArgs(process.argv.slice(2));

function writeFile(output, data, cb) {
  if (typeof data !== 'string')
    stringData = JSON.stringify(data);
  else
    stringData = data;
  fs.writeFile(output, stringData, function(err) {
    if (err)
      throw err;
    console.log('written results into \"' + output + '\".');
    // passthrough data
    cb(data);
  });
}

function readJSONFile(filename, cb) {
  fs.readFile(filename, 'utf8', function(err, data) {
    if (err)
      throw err;
    var data = JSON.parse(data);
    cb(data);
  });
}

function readFile(filename, cb) {
  fs.readFile(filename, 'utf8', function(err, data) {
    if (err)
      throw err;
    cb(data);
  });
}

/*
 * Pipeline Stages
 *
 * Each stage accepts a data object and a callback, and is responsible for
 * calling the callback with the result of processing the data.
 */

function JSONReader(filename) {
  return { 
    impl: function(_, cb) { readJSONFile(filename, cb); },
    name: 'JSONReader: ' + filename,
    input: 'unit',
    output: 'JSON'
  };
}

function fileToJSON() {
  return {
    impl: readJSONFile,
    name: 'fileToJSON',
    input: 'string',
    output: 'JSON'
  };
}

function fileReader(filename) {
  return {
    impl: function(_, cb) { readFile(filename, cb); },
    name: 'fileReader: ' + filename,
    input: 'unit',
    output: 'string'
  };
}

function filter(FilterType) {
  return {
    impl: treeBuilder(FilterType),
    name: 'filter: ' + FilterType.name,
    input: 'JSON',
    output: 'JSON',
  };
}

function fabricator(FabType, input) {
  input = input || 'JSON';
  return {
    impl: function(data, cb) {
      var fab = new FabType(data);
      cb(fab.fabricate());
    },
    name: 'fabricator: ' + FabType,
    input: input,
    output: 'JSON'
  };
}

function treeBuilder(WriterType) {
  return function(data, cb) {
    var writer = new WriterType();
    var builder = new TreeBuilder();
    builder.build(data);
    builder.write(writer);
    cb(writer.getHTML());
  };
};

function treeBuilderWriter(WriterType) {
  return {
    impl: treeBuilder(WriterType),
    name: 'treeBuilderWriter: ' + WriterType,
    input: 'JSON',
    output: 'string'
  };
}

function fileOutput(filename) {
  var typeVar = newTypeVar();
  return {
    impl: function(data, cb) { writeFile(filename, data, cb); },
    name: 'fileOutput: ' + filename,
    input: typeVar,
    output: typeVar 
  };
}

function toFile() {
  var typeVar = newTypeVar();
  return {
    impl: function(data, cb) { writeFile(data.right, data.left, cb); },
    name: 'toFile',
    input: "(" + typeVar + ",string)",
    output: typeVar
  };
}

function consoleOutput() {
  var typeVar = newTypeVar();
  return {
    impl: function(data, cb) { console.log(data); cb(data); },
    name: 'consoleOutput',
    input: typeVar,
    output: typeVar 
  };
}

// update PYTHONPATH for all telemetry invocations
function updatePYTHONPATH() {
  if (options.chromium !== undefined)
    process.env.PYTHONPATH += ':' + options.chromium + '/tools/telemetry';
}

updatePYTHONPATH();

function telemetryTask(pyScript, pyArgs) {
  return function(unused, cb) {
    var result = "";
    var task = spawn('python', ['telemetry/' + pyScript].concat(pyArgs));
    task.stdout.on('data', function(data) { result += data; });
    task.stderr.on('data', function(data) { console.log('stderr: ' + data); });
    task.on('close', function(code) { cb(result); });
  };
}

function telemetrySave(browser, url) {
  return {
    impl: function(unused, cb) {
      telemetryTask('save.py', ['--browser='+browser, '--', url])(unused, function(data) { cb(JSON.parse(data)); });
    },
    name:'telemetrySave: ' + browser + ', ' + url,
    input: 'unit',
    output: 'JSON'  
  };
}

function startADBForwarding(then) {
  exec(options.adb + ' reverse tcp:8000 tcp:8000', then);
}

function stopADBForwarding(then) {
  exec(options.adb + ' reverse --remove tcp:8000', then);
}

function startServing(data) {
  return http.createServer(function(req, res) {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(data);
  }).listen(8000, '127.0.0.1');
}

function stopServing(server) {
  server.close();
}

// perform perf testing of the provided url
function telemetryPerf(browser, url) {
  return {
    impl: telemetryTask('perf.py', ['--browser='+browser, '--', url]),
    name: 'telemetryPerf: ' + browser + ', ' + url,
    input: 'unit',
    output: 'JSON'
  };
}

// start a local server and perf test pipeline-provided data
function simplePerfer() {
  var telemetryStep = telemetryPerf(options.perfBrowser, 'http://localhost:8000');
  return {
    impl: function(data, cb) {
      startADBForwarding(function() {
        var server = startServing(data);
        telemetryStep.impl(undefined, function(result) {
          stopServing(server);
          stopADBForwarding(function() {
            cb(result);
          });
        });
      });
    },
    name: 'simplePerfer',
    input: 'string',
    output: 'JSON'
  };
}

gulp.task('test', function() {
  return gulp.src('tests/*.js', {read: false})
      .pipe(mocha({
        ui: 'bdd',
        ignoreLeaks: true,
        reporter: 'nyan'
    }));
});

function parseExperiment() {
  return {
    impl: function(data, cb) { cb(new ParseExperiment().parse(data)); },
    name: 'parseExperiment',
    input: 'string',
    output: 'experiment'
  };
}

var primitives = {'string': true, 'JSON': true, 'experiment': true};
function isPrimitive(type) {
  return primitives[type] == true || isTypeVar(type);
}

var typeVarID = 0;

function newTypeVar() {
  return "'" + (typeVarID++);
}

function isTypeVar(type) {
  return type[0] == "'";
}

function isList(type) {
  return type[0] == '[' && type[type.length - 1] == ']';
}

function delist(type) {
  assert.isTrue(isList(type));
  return type.slice(1, type.length - 1);
}

function isTuple(type) {
  return /\(([^,].*),([^,].*)\)/.exec(type) !== null;
}

function leftType(type) {
  assert.isTrue(isTuple(type));
  return /\(([^,].*),([^,].*)\)/.exec(type)[1];
}

function rightType(type) {
  assert.isTrue(isTuple(type));
  return /\(([^,].*),([^,].*)\)/.exec(type)[2];
}

function substitute(type, coersion) {
  assert.isTrue(isPrimitive(type) && isTypeVar(type), type + ' is a primitive type var');
  var subs = {};
  subs.value = coersion[type];
  subs.coersion = {};
  for (key in coersion) {
    if (key == type)
      continue;
    subs.coersion[key] = coersion[key];
  }
  return subs;
}

// TODO complete this, deal with multiple type vars if they ever arise.
function coerce(left, right, coersion) {
  // 'a -> 'a, string -> string, JSON -> JSON, etc.
  if (left == right)
    return coersion;

  if (isList(left) && isList(right)) {
    return coerce(delist(left), delist(right), coersion);
  }

  if (isTuple(left) && isTuple(right)) {
    var leftCoerce = coerce(leftType(left), leftType(right), coersion);
    var rightCoerce = coerce(rightType(left), rightType(right), coersion);
    if (leftCoerce == undefined || rightCoerce == undefined) 
      return undefined;
    for (key in rightCoerce)
      leftCoerce[key] = rightCoerce[key];
    return leftCoerce;
  }

  assert.equal(isPrimitive(left), true, left + ' is a primitive type');
  assert.equal(isPrimitive(right), true, right + ' is a primitive type');

  // 'a -> 'b

  if (isTypeVar(left) && isTypeVar(right)) {
    var result = left;
    while (isTypeVar(result) && coersion[result] !== undefined)
      result = coersion[result];
    left = result;
  }

  // 'a -> string
  if (isTypeVar(left)) {
    var subs = substitute(left, coersion);
    if (subs.value == right)
      return subs.coersion;
  }

  // string -> 'a
  if (isTypeVar(right)) {
    coersion[right] = left;
    return coersion;
  }

  return undefined;
}

function processStages(stages, cb, fail) {
  _wrappedStages(null, stages, cb, fail);
}

/*
 * Constructing a pipeline
 *
 * Sorry for potato quality.
 */
function _wrappedStages(input, stages, cb, fail) {
  assert.equal(stages[0].input, 'unit');
  var coersion = {};
  for (var i = 0; i < stages.length - 1; i++) {
    coersion = coerce(stages[i].output, stages[i + 1].input, coersion);
    assert.isDefined(coersion, "Type checking failed for " + stages[i].output + " -> " + stages[i + 1].input);
  }
  for (var i = stages.length - 1; i >= 0; i--) {
    cb = (function(i, cb) { return function(data) {
      try {
        stages[i].impl(data, cb);
      } catch (e) {
        fail(e);
      }
    } })(i, cb);
  }
  cb(input);
};


function buildTask(name, stages) {
  gulp.task(name, function(incb) {
    var cb = function(data) { incb(); };
    processStages(stages, cb, function(e) { throw e; });
  });
};

/*
 * Some example pipelines.
 */
buildTask('html', [JSONReader(options.file), treeBuilderWriter(HTMLWriter), fileOutput('result.html.html')]);
buildTask('mhtml', [fileInputs(options.inputSpec), map(tee()), map(left(fileToJSON())), map(left(treeBuilderWriter(HTMLWriter))), 
                    map(right(outputName(options.inputSpec, options.outputSpec))), map(toFile())]);
buildTask('js', [JSONReader(options.file), treeBuilderWriter(JSWriter), fileOutput('result.js.html')]);
buildTask('stats', [JSONReader(options.file), treeBuilderWriter(StatsWriter), consoleOutput()]);
buildTask('compactComputedStyle', [JSONReader(options.file), filter(StyleFilter), fileOutput(options.file + '.filter')]);
buildTask('extractStyle', [JSONReader(options.file), filter(StyleMinimizationFilter), fileOutput(options.file + '.filter')]);
buildTask('generate', [JSONReader(options.file), fabricator(SchemaBasedFabricator), fileOutput(options.file + '.gen')]);
buildTask('tokenStyles', [JSONReader(options.file), filter(StyleTokenizerFilter), fileOutput(options.file + '.filter')]);
buildTask('nukeIFrame', [JSONReader(options.file), filter(NukeIFrameFilter), fileOutput(options.file + '.filter')]);
buildTask('runExperiment', [fileReader(options.file), parseExperiment(), experimentPhase()]);
buildTask('get', [telemetrySave(options.saveBrowser, options.url), fileOutput('result.json')]);
buildTask('perf', [telemetryPerf(options.perfBrowser, options.url), fileOutput('trace.json')]);
buildTask('endToEnd', [telemetrySave(options.saveBrowser, options.url), treeBuilderWriter(HTMLWriter), simplePerfer(), fileOutput('trace.json')]);

/*
 * experiments
 */

function collectInputs(inputSpec) {
  if (inputSpec.substring(0, 7) == 'http://')
    return [inputSpec];
  var re = new RegExp('^' + inputSpec + '$');
  var files = fs.readdirSync('.');
  return files.filter(re.exec.bind(re));
}

function readerForInput(name) {
  if (name.substring(0, 7) == 'http://')
    return telemetrySave(options.saveBrowser, name)
  return JSONReader(name);
}

function fileInputs(inputSpec) {
  return {
    impl: function(unused, cb) {
      var re = new RegExp('^' + inputSpec + '$');
      var files = fs.readdirSync('.');
      cb(files.filter(re.exec.bind(re)));
    },
    name: 'fileInputs: ' + inputSpec,
    input: 'unit',
    output: '[string]'
  }
}

function map(stage) {
  assert.isDefined(stage.input, stage + ' has no input type');
  assert.isDefined(stage.output + ' has no output type');
  var input = '[' + stage.input + ']';
  var output = '[' + stage.output + ']';

  return {
    impl: function(input, incb) {
      var results = [];
      var cb = function() { incb(results); };
      for (var i = input.length - 1; i >= 0; i--) {
        cb = (function(cb, i) {
          return function() {
            stage.impl(input[i], function(data) { results.push(data); cb(); });
          }})(cb, i);
      }
      cb();
    },
    name: 'map(' + stage.name + ')',
    input: input,
    output: output
  };
}

function tee() {
  var typeVar = newTypeVar();
  return {
    impl: function(input, cb) { cb({left: input, right: input}); },
    name: 'tee',
    input: typeVar,
    output: "(" + typeVar + "," + typeVar + ")",
  }
}

function left(stage) {
  var typeVar = newTypeVar();
  return {
    impl: function(input, cb) {
      stage.impl(input.left, function(data) {
        cb({left: data, right: input.right});
      });
    },
    name: 'left(' + stage.name + ')',
    input: "(" + stage.input + "," + typeVar + ")",
    output: "(" + stage.output + "," + typeVar + ")"
  }
}

function justLeft() {
  var typeVar1 = newTypeVar();
  var typeVar2 = newTypeVar();
  return {
    name: 'justLeft',
    impl: function(input, cb) { cb(input.left); },
    input: "(" + typeVar1 + "," + typeVr2 + ")",
    output: typeVar1
  };
}

function right(stage) {
  var typeVar = newTypeVar();
  return {
    impl: function(input, cb) {
      stage.impl(input.right, function(data) {
        cb({right: data, left: input.left});
      });
    },
    name: 'right(' + stage.name + ')',
    input: "(" + typeVar + "," + stage.input + ")",
    output: "(" + typeVar + "," + stage.output + ")"
  }
}

function stage(list) {
  return {
    impl: function(input, cb) {
      _wrappedStages(input, list, cb, function(e) { console.log('failed pipeline', e, '\n', e.stack); cb(null); });
    },
    input: list[0].input,
    output: list[list.length - 1].output
  };
}

function outputForInput(inputSpec, input, output) {
  var re = new RegExp(inputSpec);
  return input.replace(re, output);
}

function outputName(inputSpec, output) {
  return {
    impl: function(input, cb) {
      cb(outputForInput(inputSpec, input, output));
    },
    name: 'outputName',
    input: 'string',
    output: 'string'
  };
}

// Returns a list of {stages: [pipeline-element], output: result}
function appendEdges(experiment, stages, edges) {
  var newList = [];
  for (var j = 0; j < edges.length; j++) {
    var newStages = stages.concat(edges[j].stages);
    if (edges[j].output in experiment.tree) {
      if (edges[j].output.substring(edges[j].output.length - 1) !== '*'){
        newStages.push('output:' + edges[j].output);
      }
      newList = newList.concat(appendEdges(experiment, newStages, experiment.tree[edges[j].output]));
    } else {
      newList.push({stages: newStages, output: edges[j].output});
    }
  }
  return newList;
}

function experimentTask(name, experiment) {
  gulp.task(name, function(cb) { runExperiment(experiment, cb); });
}

function stageFor(stageName, inputSpec, input) {
  if (stageName.substring(0, 7) == 'output:') {
    return stage([
      tee(),
      right(map(right(outputName(inputSpec, stageName.substring(7))))),
      right(map(toFile())),
      justLeft()
    ]);
  }
  if (stageName[0].toLowerCase() == stageName[0])
    return map(left(eval(stageName)()));
  if (stageName.indexOf('Fabricator') !== -1)
    return map(left(fabricator(eval(stageName))));
  // FIXME: This relies on the fact that filters and writers are both the same thing
  // right now (i.e. filter and treeBuilderWriter are the same function).
  // This could well become a problem in the future.
  // Also, eval: ew. If there was a local var dict I could look up the constructor name directly.
  return map(left(filter(eval(stageName))));
}

function updateOptions(optionsDict) {
  for (key in optionsDict) {
    if (key in options) {
      console.warn('Overriding option ' + key + ' from commandline value ' + options[key] + ' to ' + optionsDict[key]);
    }
    options[key] = optionsDict[key];
  }
  if (optionsDict.chromium)
    updatePYTHONPATH();
}

function runExperiment(experiment, incb) {
  updateOptions(experiment.flags);
  var pipelines = [];
  for (var i = 0; i < experiment.inputs.length; i++) {
    var edges = experiment.tree[experiment.inputs[i]];
    var stagesList = [];
    stagesList = appendEdges(experiment, stagesList, edges);

    for (var j = 0; j < stagesList.length; j++) {
      var pl = [fileInputs(experiment.inputs[i]), map(tee()), map(left(fileToJSON()))].concat(
          stagesList[j].stages.map(function(a) { return stageFor(a, experiment.inputs[i]); }));
      pl.push(map(right(outputName(experiment.inputs[i], stagesList[j].output))));
      pl.push(map(toFile()));
      pipelines.push(pl);
    }
  }
  var cb = function() { incb(); }
  for (var i = 0; i < pipelines.length; i++) {
    var cb = (function(i, cb) {
      return function() {
        processStages(pipelines[i], cb, function(e) {
          console.log('failed pipeline', e, '\n', e.stack); cb(null);
        });
      }
    })(i, cb);
  }
  cb(null);
}

function experimentPhase() {
  return {
    impl: runExperiment,
    name: 'experimentPhase',
    input: 'experiment',
    output: 'unit'
  };
}
