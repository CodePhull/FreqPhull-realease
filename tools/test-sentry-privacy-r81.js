// Round 81: what leaves the machine in a Sentry report.
//
// Every bug is reported now (see test-error-reporting-r81.js), so nothing
// that identifies the person may ride along. This runs sentry-init's real
// scrubber and beforeSend hook on realistic payloads - no network, no DSN.
//
// Run:  node tools/test-sentry-privacy-r81.js [path/to/sentry-init.js]
// (a path checks another copy - used to prove the checks fail on the old one)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SI = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'sentry-init.js');
const s = require(SI);
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const scrub = s.scrubString;

// ── The scrubber ──
const cases = [
  ['yt-dlp video id', 'ERROR: [youtube] VHtsNOp4BhI: Please sign in', 'ERROR: [youtube] <id>: Please sign in'],
  ['youtube:tab id', '[youtube:tab] PLabcdefghi: Downloading', '[youtube:tab] <id>: Downloading'],
  ['YouTube URL keeps only the host', 'failed https://www.youtube.com/watch?v=VHtsNOp4BhI&list=RDx now', 'failed https://www.youtube.com/<url> now'],
  ['short youtu.be link', 'https://youtu.be/VHtsNOp4BhI', 'https://youtu.be/<url>'],
  ['Windows user name in a path', 'C:\\Users\\Kevin Smith\\Music\\a.mp3', 'C:\\Users\\<user>\\Music\\a.mp3'],
  ['e-mail address', 'contact kev.smith@gmail.com please', 'contact <email> please'],
  ['public IPv4', 'connect ETIMEDOUT 84.12.200.7:443', 'connect ETIMEDOUT <ip>:443'],
  ['IPv6', 'via 2001:0db8:85a3:0000:0000:8a2e:0370:7334 x', 'via <ip> x'],
  ['loopback stays (the app backend)', 'ECONNREFUSED 127.0.0.1:47891', 'ECONNREFUSED 127.0.0.1:47891'],
  ['app version untouched', 'version 0.7.41 build r81', 'version 0.7.41 build r81'],
];
for (const [name, input, want] of cases) {
  const got = scrub(input);
  check('scrub: ' + name, got === want, got === want ? null : JSON.stringify(got));
}

// ── beforeSend on a full event ──
// beforeSend isn't exported; pull it out of the source the same way the
// other tests extract their regions, with the module's own helpers.
const src = fs.readFileSync(SI, 'utf8');
const bi = src.indexOf('function beforeSend(');
const be = src.indexOf('\nfunction commonOptions(');
check('found beforeSend', bi > 0 && be > bi);
let optedOut = false;
const sb = { scrubString: s.scrubString, scrubObject: s.scrubObject, String, isOptedOut: () => optedOut };
vm.createContext(sb);
vm.runInContext(src.slice(bi, be) + '\nthis.beforeSend = beforeSend;', sb);
const ev = sb.beforeSend({
  server_name: 'DESKTOP-KEVINSMITH',
  user: { id: 'install-abc', ip_address: '84.12.200.7', email: 'kev@gmail.com', username: 'kevin' },
  request: { url: 'https://www.youtube.com/watch?v=VHtsNOp4BhI', headers: { cookie: 'SID=secret', 'user-agent': 'x' }, cookies: { SID: 'secret' }, query_string: 'v=VHtsNOp4BhI' },
  message: 'download failed for https://www.youtube.com/watch?v=VHtsNOp4BhI',
  exception: { values: [{ value: 'ENOENT C:\\Users\\Kevin\\AppData\\x.exe', stacktrace: { frames: [{ filename: 'C:\\Users\\Kevin\\a.js', abs_path: 'C:\\Users\\Kevin\\a.js' }] } }] },
  extra: { stderrTail: '[youtube] VHtsNOp4BhI: Sign in', from: 'kev@gmail.com', dir: 'C:\\Users\\Kevin\\Music' },
  contexts: { device: { name: 'DESKTOP-KEVINSMITH', arch: 'x64' }, app_state: { python: 'C:\\Users\\Kevin\\py' } },
  tags: { note: 'peer 84.12.200.7' },
  breadcrumbs: [{ message: 'GET https://www.youtube.com/watch?v=VHtsNOp4BhI' }],
});
const out = JSON.stringify(ev);
check('Sentry is told never to infer an IP (and so no city)', ev.sdk && ev.sdk.settings && ev.sdk.settings.infer_ip === 'never' && !('geo' in ev.user));
check('PC name removed', !('server_name' in ev) && !/KEVINSMITH/.test(out));
check('user is only the install id, IP pinned to null', JSON.stringify(ev.user) === JSON.stringify({ id: 'install-abc', ip_address: null }), JSON.stringify(ev.user));
check('request keeps only a scrubbed URL', JSON.stringify(ev.request) === JSON.stringify({ url: 'https://www.youtube.com/<url>' }), JSON.stringify(ev.request));
check('no cookie / session value anywhere', !/SID|secret/.test(out));
check('no video id anywhere', !/VHtsNOp4BhI/.test(out));
check('no e-mail anywhere', !/kev@gmail\.com|kev\.smith/.test(out));
check('no public IP anywhere', !/84\.12\.200\.7/.test(out));
check('no Windows user name anywhere', !/Kevin/.test(out));
check('useful detail survives (arch, error text)', ev.contexts.device.arch === 'x64' && /ENOENT/.test(ev.exception.values[0].value));

// ── Opt-out marker (support only; no UI exposes it yet) ──
if (typeof s.setOptOutFile === 'function') {
  optedOut = true;
  check('opted out: beforeSend drops every event', sb.beforeSend({ message: 'x' }) === null);
  optedOut = false;
  const os = require('os');
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-optout-')), 'crash-reporting-off');
  s.setOptOutFile(marker);
  check('no marker file: reporting stays on', s.isOptedOut() === false);
  s.setOptedOut(true);
  check('marker written: reporting off at once', s.isOptedOut() === true && fs.existsSync(marker));
  s.setOptedOut(false);
  check('marker removed: reporting back on', s.isOptedOut() === false && !fs.existsSync(marker));
  s.setOptOutFile(null);
  fs.rmSync(path.dirname(marker), { recursive: true, force: true });
}

// ── Init options ──
check('sendDefaultPii is off', /sendDefaultPii:\s*false/.test(src));
check('serverName replaces the PC name', /serverName:\s*'freqphull'/.test(src));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
