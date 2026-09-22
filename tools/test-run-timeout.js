// Headless regression test for run()'s optional timeoutMs - added Round 67
// after finding analyzeOneInBackground()'s ffmpeg decode step had NO
// timeout at all (unlike the Python analysis step right after it, which
// already force-kills at 240s). Because the background analysis worker
// loop does a plain serial `await analyzeOneInBackground(row)`, a single
// hung ffmpeg process there wedges the ENTIRE analysis queue forever -
// no error, no log line, matching a real report of the "Analyzing N..."
// UI pill getting stuck indefinitely with nothing in the logs to explain
// it. This tests the general-purpose timeout mechanism added to run()
// itself, extracted directly from server.js so it can't silently drift
// from what ships.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const SRC_PATH = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const si = src.indexOf('// ─── BEGIN RUN WITH TIMEOUT ───');
const ei = src.indexOf('// ─── END RUN WITH TIMEOUT ───');
if (si === -1 || ei === -1) throw new Error('run() with-timeout markers not found in server.js');
const core = src.slice(si, ei);

const sandbox = { spawn, path, Promise, Error, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.__exports = { run };', sandbox);
const { run } = sandbox.__exports;

let fails = 0;
let pending = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

async function main() {
  // A command guaranteed to hang well past any short test timeout, using
  // only Node itself so this test has no external binary dependency.
  const hangingCmd = process.execPath;
  const hangingArgs = ['-e', 'setTimeout(() => {}, 60000)'];

  // ── A hung process with a short timeout: must reject, must say why,
  // must not take anywhere near the full 60s the process itself would run. ──
  {
    const start = Date.now();
    let threw = null, msg = null;
    try {
      await run(hangingCmd, hangingArgs, 300);
    } catch (e) {
      threw = true;
      msg = e.message;
    }
    const elapsed = Date.now() - start;
    check('Round 67: a genuinely hung process with a 300ms timeout rejects instead of hanging forever',
      threw === true);
    check('Round 67: the timeout rejection message says it timed out (not a generic/confusing error)',
      /timed out/i.test(msg || ''), `message="${msg}"`);
    check('Round 67: the timeout fires close to the requested 300ms, not immediately and not after the full 60s hang',
      elapsed >= 250 && elapsed < 5000, `elapsed=${elapsed}ms`);
  }

  // ── No timeoutMs argument at all: existing callers (12 call sites in
  // server.js, none of which pass a third argument except the one Round 67
  // added) must keep their exact current behavior - no premature rejection
  // on a command that finishes well within a normal amount of time. ──
  {
    let threw = false, result = null;
    try {
      result = await run(process.execPath, ['-e', 'console.log("ok")']);
    } catch (e) {
      threw = true;
    }
    check('Round 67: omitting timeoutMs entirely does not change behavior for a normal, fast command (no regression)',
      threw === false && /ok/.test(result || ''));
  }

  // ── A command that fails on its own (non-zero exit) before any timeout
  // would fire must still reject with the ORIGINAL failure reason, not a
  // timeout message - the timeout guard must not interfere with normal
  // failure handling. ──
  {
    let msg = null;
    try {
      await run(process.execPath, ['-e', 'process.exit(1)'], 5000);
    } catch (e) {
      msg = e.message;
    }
    check('Round 67: a fast non-zero exit under a long timeout still reports as a normal exit failure, not a timeout',
      msg != null && !/timed out/i.test(msg), `message="${msg}"`);
  }

  console.log('');
  if (fails) { console.log(`✗ ${fails} run-timeout check(s) failed`); process.exit(1); }
  console.log('✓ run-timeout: all checks passed');
}

main().catch(e => { console.error('test crashed:', e); process.exit(1); });
