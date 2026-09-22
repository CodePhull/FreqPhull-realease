// Headless regression test for SPAWN_ENOENT_RE - the shared pattern that
// decides whether a failed ffmpeg/yt-dlp/Python spawn gets translated into
// actionable guidance ("antivirus quarantined it", "Windows Temp was
// cleared", etc.) or leaks its raw, cryptic Node error straight to the user.
//
// Added Round 66 after a user screenshot showed exactly that leak: a toast
// reading "ffmpeg conversion failed: Cannot start ffmpeg.exe: spawn
// C:\Users\...\ffmpeg.exe ENOENT" during playback of an older track, instead
// of the friendly "ffmpeg.exe is missing or blocked..." message server.js
// clearly intends to show in that case.
//
// Root cause: the old regex was /spawn (UNKNOWN|ENOENT|EPERM|EACCES)/ -
// requiring the error CODE immediately after the literal word "spawn". That
// is only how Node formats the message when spawn() is given a bare command
// name (e.g. "spawn ffmpeg ENOENT"). Every real call site here resolves a
// full absolute path via bin('ffmpeg')/bin('yt-dlp') first, so Node's actual
// message is "spawn <full absolute path> ENOENT" - the code is never
// adjacent to "spawn" in practice, so the old regex silently never matched,
// in any of the 5 places it was used, for the exact inputs this app always
// produces.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const si = src.indexOf('// ─── BEGIN SPAWN ENOENT REGEX ───');
const ei = src.indexOf('// ─── END SPAWN ENOENT REGEX ───');
if (si === -1 || ei === -1) throw new Error('SPAWN_ENOENT_RE markers not found in server.js');
const core = src.slice(si, ei);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.__exports = { SPAWN_ENOENT_RE };', sandbox);
const { SPAWN_ENOENT_RE } = sandbox.__exports;

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── The exact real-evidence case: a resolved absolute path between
// "spawn" and the error code (this is what every real call site produces,
// since bin() always returns a full path, never a bare command name). ──
{
  const msg = 'Cannot start ffmpeg.exe: spawn C:\\Users\\KNIGHT~1\\AppData\\Local\\Temp\\' +
    '3IgrwoJMNAR0Q2Qzs5pq4ezmYBm\\resources\\bin\\ffmpeg.exe ENOENT';
  check('Round 66: the real evidence message (ffmpeg, full Windows temp-extraction path) is recognized as a spawn failure',
    SPAWN_ENOENT_RE.test(msg));
}
{
  const msg = 'spawn C:\\Program Files\\FreqPhull\\resources\\bin\\yt-dlp.exe ENOENT';
  check('Round 66: a yt-dlp full-path spawn failure is recognized',
    SPAWN_ENOENT_RE.test(msg));
}
{
  const msg = 'Cannot start Python: spawn C:\\Users\\me\\AppData\\Local\\freqphull\\engines\\python\\python.exe EPERM';
  check('Round 66: a Python full-path spawn failure (EPERM) is recognized',
    SPAWN_ENOENT_RE.test(msg));
}
{
  const msg = '/usr/local/bin/ffmpeg ENOENT';
  // Not actually how Node formats it (missing "spawn"), included to prove
  // the pattern still requires the word "spawn" and isn't just matching
  // any ENOENT anywhere.
  check('Round 66: a code without the word "spawn" at all is NOT treated as a spawn failure',
    !SPAWN_ENOENT_RE.test(msg));
}

// ── Bare command name (the case the OLD regex was actually built for) still
// works with the new pattern - no regression for the simple case. ──
{
  const msg = 'spawn ffmpeg ENOENT';
  check('Round 66: the old regex\'s own intended case (bare command name) still matches',
    SPAWN_ENOENT_RE.test(msg));
}
{
  const msg = 'spawn EACCES';
  check('Round 66: no command name at all, just "spawn EACCES", still matches',
    SPAWN_ENOENT_RE.test(msg));
}

// ── The regression this test exists to catch: the OLD, broken pattern
// (spawn immediately followed by the code) genuinely fails on the real
// evidence case - proving this test would have caught the original bug. ──
{
  const oldRe = /spawn (UNKNOWN|ENOENT|EPERM|EACCES)/;
  const msg = 'Cannot start ffmpeg.exe: spawn C:\\Users\\KNIGHT~1\\AppData\\Local\\Temp\\' +
    '3IgrwoJMNAR0Q2Qzs5pq4ezmYBm\\resources\\bin\\ffmpeg.exe ENOENT';
  check('sanity: the pre-Round-66 regex genuinely fails to match the real evidence message (proves this is a real fix, not a no-op)',
    oldRe.test(msg) === false);
}

// ── Should not false-positive on ffmpeg's own normal error output, which
// never contains the literal word "spawn". ──
{
  const ffmpegRealError = 'Invalid data found when processing input\n' +
    'At least one output file must be specified';
  check('Round 66: ffmpeg\'s own real decode-failure error text (no "spawn") does not false-positive',
    !SPAWN_ENOENT_RE.test(ffmpegRealError));
}

console.log('');
if (fails) { console.log(`✗ ${fails} spawn-enoent check(s) failed`); process.exit(1); }
console.log('✓ spawn-enoent: all checks passed');
