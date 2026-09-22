// Headless regression test for rbWithTimeout() (renderer/app.js), the
// Round 50 fix for Record occasionally doing nothing at all on its
// first press with no visible error (see the marker comment at its
// definition for the full evidence/reasoning). Extracts the function
// via its BEGIN/END RB TIMEOUT UTIL markers, same pattern already used
// for RB DSP PARAM MATH / RB GRAPH DSP CORE elsewhere in this codebase.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'app.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const si = src.indexOf('// ─── BEGIN RB TIMEOUT UTIL');
const ei = src.indexOf('// ─── END RB TIMEOUT UTIL');
if (si < 0 || ei < 0) throw new Error('RB TIMEOUT UTIL markers not found in app.js');
const core = src.slice(si, ei);

const sandbox = { setTimeout, clearTimeout, Promise };
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.__exports = { rbWithTimeout };', sandbox);
const { rbWithTimeout } = sandbox.__exports;

let fails = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

(async () => {
  // 1. A promise that resolves well before the timeout must win, with
  // its real value, and must not be treated as a failure.
  {
    const fast = new Promise((resolve) => setTimeout(() => resolve('real-value'), 20));
    const result = await rbWithTimeout(fast, 500, 'fast case');
    check('a promise that resolves before the timeout wins with its real value', result === 'real-value', `got ${JSON.stringify(result)}`);
  }

  // 2. A promise that never settles must be converted into a rejection
  // once the timeout elapses - this is the actual fix: Record's mic-open
  // await can no longer hang forever with zero visible feedback.
  {
    const neverSettles = new Promise(() => {});
    const t0 = Date.now();
    let caught = null;
    try {
      await rbWithTimeout(neverSettles, 100, 'hang case');
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - t0;
    check('a promise that never settles is converted into a visible rejection once the timeout elapses',
      !!caught && caught.rbTimedOut === true, caught ? `rbTimedOut=${caught.rbTimedOut}` : 'no error thrown at all - still hangs silently');
    check('the timeout rejection fires close to the requested window, not immediately and not much later',
      elapsed >= 90 && elapsed < 400, `elapsed=${elapsed}ms (want ~100ms)`);
  }

  // 3. A promise that genuinely rejects on its own (e.g. a real
  // getUserMedia permission-denied error) before the timeout must still
  // propagate that REAL error/reason, not a generic timeout error - the
  // timeout is a backstop for silence, not a replacement for real
  // rejections that already explain themselves.
  {
    const realError = new Error('NotAllowedError: permission denied');
    const rejectsFast = new Promise((_, reject) => setTimeout(() => reject(realError), 10));
    let caught = null;
    try {
      await rbWithTimeout(rejectsFast, 500, 'real rejection case');
    } catch (e) {
      caught = e;
    }
    check('a promise that genuinely rejects on its own propagates the real error, not a synthetic timeout',
      caught === realError, caught ? `got a different error: ${caught.message}` : 'no error caught');
  }

  console.log('');
  if (fails) { console.log(`✗ ${fails} rb-timeout check(s) failed`); process.exit(1); }
  console.log('✓ rb-timeout util: all checks passed');
})();
