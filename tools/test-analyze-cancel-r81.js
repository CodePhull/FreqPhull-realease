// Round 81: clicking through tracks stacked up Python analyses.
//
// Real 0.7.38 log: the Analyzer started a new ~12s analyze.py every 2-6s
// while 3-4 earlier ones were still running. Two causes: the renderer
// never closed the previous track's /analyze EventSource, and /analyze
// never killed its Python when the client went away.
//
// 1. Runtime: the exact cancellation pattern /analyze now uses
//    (res.on('close') + !writableFinished -> kill) on a real http server and
//    a real child process: a client that disconnects mid-run must kill the
//    child; a run that completes normally must NOT be reported as abandoned.
//    This proves the Node semantics the fix relies on.
// 2. Static guards on server.js and renderer/app.js wiring.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

function runCase(childMs, clientAbortMs) {
  return new Promise((resolve) => {
    const out = { abandoned: false, childExit: null, killedAt: null, t0: Date.now() };
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      const proc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, ' + childMs + ')']);
      let abandoned = false, procDone = false;
      res.on('close', () => {
        if (procDone || res.writableFinished) return;
        abandoned = true; out.killedAt = Date.now() - out.t0;
        try { proc.kill(); } catch {}
      });
      proc.on('close', (code, sig) => {
        procDone = true;
        out.abandoned = abandoned; out.childExit = sig || code;
        out.childDoneAt = Date.now() - out.t0;
        if (!abandoned) { res.write('event: done\ndata: {}\n\n'); res.end(); }
        setTimeout(() => { server.close(); resolve(out); }, 50);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const r = http.get({ host: '127.0.0.1', port: server.address().port, path: '/analyze' }, (resp) => {
        resp.on('data', () => {});
        resp.on('end', () => {});
      });
      r.on('error', () => {});
      if (clientAbortMs != null) setTimeout(() => r.destroy(), clientAbortMs);
    });
  });
}

(async () => {
  // ── 1. Runtime ──
  const a = await runCase(10000, 300);
  check('client disconnects mid-analysis -> child is killed promptly', a.abandoned && a.childDoneAt < 3000,
    'killed at ' + a.killedAt + 'ms, child gone at ' + a.childDoneAt + 'ms, exit ' + a.childExit);
  const b = await runCase(300, null);
  check('analysis that finishes normally is not treated as abandoned', !b.abandoned && b.childExit === 0,
    'exit ' + b.childExit);

  // ── 2. Static wiring ──
  const sj = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = sj.slice(sj.indexOf("app.get('/analyze'"), sj.indexOf("app.get('/analyze'") + 12000);
  check('/analyze kills analyze.py when the response closes early',
    /res\.on\('close'[\s\S]{0,300}writableFinished[\s\S]{0,300}proc\.kill\(\)/.test(route));
  check('/analyze skips the result handling for an abandoned run',
    /proc\.on\('close'[\s\S]{0,200}_analyzeAbandoned/.test(route));
  const aj = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const fn = aj.slice(aj.indexOf('async function runPythonAnalysis('), aj.indexOf('async function runPythonAnalysis(') + 6000);
  check('runPythonAnalysis cancels the previous stream before starting', /cancelActiveAnalysis\(\);\s*\n\s*const gen = \+\+_analysisGen;/.test(fn));
  check('a stale cache lookup cannot start a stream for an old track', (fn.match(/gen !== _analysisGen/g) || []).length >= 2);
  check('the new stream is registered as the active one', /_activeAnalysis = \{ es, watchdog/.test(fn));

  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
