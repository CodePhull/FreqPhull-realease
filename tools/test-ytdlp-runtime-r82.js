// Round 82: YouTube 403s (Sentry ELECTRON-8) and yt-dlp updates that didn't stick.
//
// Measured: the bundled yt-dlp 2026.08.19 (also the latest release) prints
// "No supported JavaScript runtime could be found ... some formats may be
// missing" without Deno on PATH, and "JS runtimes: deno-x" with it. The app
// now fetches Deno once (checksum-verified) and puts it on PATH; and
// yt-dlp updates go to <userData>\bin instead of over the bundled copy, so
// app updates and portable restarts no longer undo them.
//
// Headless: YTDLP UPDATE CORE (version order, checksum parsing for both
// published formats) + static wiring. The network path (real Deno download,
// verify, yt-dlp sees it) was run end to end while building this; it needs
// the internet, so it is not part of this test.
//
// Run:  node tools/test-ytdlp-runtime-r82.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const si = src.indexOf('// ─── BEGIN YTDLP UPDATE CORE ───');
const ei = src.indexOf('// ─── END YTDLP UPDATE CORE ───');
if (si < 0 || ei < 0) throw new Error('YTDLP UPDATE CORE markers not found in server.js');
const sb = { String, parseInt, Math };
vm.createContext(sb);
vm.runInContext(src.slice(si, ei) + '\nthis.c = { compareYtdlpVersions, checksumFor };', sb);
const { compareYtdlpVersions: cmp, checksumFor } = sb.c;

check('date versions compare numerically', cmp('2026.10.05', '2026.08.19') > 0 && cmp('2026.08.19', '2026.10.05') < 0);
check('equal versions are equal', cmp('2026.08.19', '2026.08.19') === 0);
check('a .1 re-release is newer', cmp('2026.08.19.1', '2026.08.19') > 0);
check('month 10 beats month 9 (not text order)', cmp('2026.10.01', '2026.9.30') > 0);
const H = 'a'.repeat(64), H2 = 'b'.repeat(64);
const sums = H2 + '  yt-dlp\n' + H + '  yt-dlp.exe\n' + 'c'.repeat(64) + '  yt-dlp_macos\n';
check('yt-dlp SHA2-256SUMS: picks the exact file', checksumFor(sums, 'yt-dlp.exe') === H);
check('...not a name that merely starts the same', checksumFor(sums, 'yt-dlp') === H2);
check('Deno .sha256sum (PowerShell format, upper case)', checksumFor('\r\nAlgorithm : SHA256\r\nHash      : ' + H.toUpperCase() + '\r\n', 'x.zip') === H);
check('no checksum -> null (the download is refused)', checksumFor('nothing here', 'yt-dlp.exe') === null);

// Static wiring
const upd = src.slice(src.indexOf('async function checkAndUpdateYtdlp('), src.indexOf('// ── JavaScript runtime for yt-dlp'));
check('updates are written to <userData>\\bin, never over the bundled copy',
  upd.includes('const tmp = USER_YTDLP + \'.new\';') && !upd.includes("live + '.new'"));
check('yt-dlp downloads are checked against the published SHA-256', upd.includes("if (got !== expected) throw new Error('checksum mismatch"));
check('bin(\'yt-dlp\') prefers the updated copy', /function bin\(name\) \{[\s\S]{0,200}if \(name === 'yt-dlp'\) \{\s*const u = userYtdlpPath\(\);/.test(src));
check('...unless the bundled copy is at least as new', upd.includes('compareYtdlpVersions(bundledVer, userVer) >= 0') && upd.includes('_userYtdlpPreferred = false'));
check('the cached version is refreshed after an update', (upd.match(/_ytdlpVersion = null;/g) || []).length >= 2);
const deno = src.slice(src.indexOf('async function ensureDeno('), src.indexOf("app.get('/ytdlp/status'"));
check('Deno download is checked against its published SHA-256', deno.includes("if (got !== expected) throw new Error('checksum mismatch"));
check('a Deno already on PATH is used, not downloaded again', deno.includes('const sys = denoOnPath();'));
check('the app\'s Deno is put on PATH for yt-dlp', deno.includes('addDenoToPath();'));
check('Deno setup runs at boot and on "check now"', /setTimeout\(\(\) => \{ ensureDeno\(\); \}, 20000\);/.test(src) && src.includes("if (jsRuntimeState.status !== 'ok') await ensureDeno();"));
check('Settings shows the YouTube helper state', fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8').includes("t('ytdlpJsMissing')"));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
