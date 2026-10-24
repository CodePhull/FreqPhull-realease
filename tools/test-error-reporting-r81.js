// Round 81: every error a user or the extension sees is reported.
//
// 1. Headless: the ERROR REPORT CORE region of server.js (route naming,
//    finding error frames in SSE / NDJSON chunks, 5xx bodies, cancel filter).
// 2. Real server: server.js on a spare port with an empty data folder.
//    Reporting is off (FREQPHULL_NO_CRASH_REPORT=1), but every report is
//    also written to the log as "[report] <category>: ...", which is what
//    this checks. Skipped (not failed) when node_modules isn't installed.
// 3. Static wiring: the red-toast hook in the app and the extension hooks.
//
// Run:  node tools/test-error-reporting-r81.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── 1. Headless ──
const si = src.indexOf('// ─── BEGIN ERROR REPORT CORE ───');
const ei = src.indexOf('// ─── END ERROR REPORT CORE ───');
if (si < 0 || ei < 0) throw new Error('ERROR REPORT CORE markers not found in server.js');
const sb = { Buffer, JSON, String };
vm.createContext(sb);
vm.runInContext(src.slice(si, ei) + '\nthis.c = { errorRouteKey, errorsInChunk, errorFromBody, isCancelMessage };', sb);
const C = sb.c;

check('route ids collapse into one name', C.errorRouteKey('get', '/history/123/analysis') === 'GET /history/:n/analysis');
check('long hex ids collapse too', C.errorRouteKey('POST', '/stems/0123456789abcdef0123/x') === 'POST /stems/:id/x');
let e = C.errorsInChunk('event: error\ndata: {"message":"yt-dlp failed","code":"download_failed"}\n\n');
check('SSE error frame is found with its message', e.length === 1 && e[0].kind === 'sse' && e[0].message === 'yt-dlp failed', JSON.stringify(e));
e = C.errorsInChunk('event: progress\ndata: {"pct":40}\n\n');
check('non-error SSE frame is ignored', e.length === 0);
e = C.errorsInChunk(Buffer.from('event: error\ndata: plain text\n\n'));
check('SSE error with a non-JSON body still reports the text', e.length === 1 && e[0].message === 'plain text');
e = C.errorsInChunk('{"type":"progress","i":0,"pct":3}\n{"type":"error","i":1,"message":"File not found"}\n');
check('NDJSON error line is found', e.length === 1 && e[0].kind === 'stream' && e[0].message === 'File not found', JSON.stringify(e));
e = C.errorsInChunk('{"type":"end","ok":2,"failed":1,"cancelled":false}\n');
check('a summary line that merely counts failures is not an error', e.length === 0);
check('5xx JSON body -> its error text', C.errorFromBody('{"error":"Could not copy analyze.py"}') === 'Could not copy analyze.py');
check('5xx plain body -> the text', C.errorFromBody('boom') === 'boom');
check('5xx object body -> its error text', C.errorFromBody({ error: 'x' }) === 'x');
check('cancel messages are not bugs', C.isCancelMessage('Download cancelled') && C.isCancelMessage('aborted by user'));
check('real errors are not mistaken for cancels', !C.isCancelMessage('ffmpeg exited with code 1'));

// ── 3. Static wiring ──
const aj = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const sn = aj.slice(aj.indexOf('function showAppNotification('), aj.indexOf('function showAppNotification(') + 600);
check('every red toast in the app is reported', /if \(t === 'err'\) _reportUiNotice\(msgStr\);/.test(sn));
check('UI reports name the open tab (.nav-btn.on, not the old .tabbtn)', !/\.tabbtn/.test(aj) && /_reportUiNotice[\s\S]{0,600}\.nav-btn\.on/.test(aj));
const pj = fs.readFileSync(path.join(ROOT, 'extension', 'panel.js'), 'utf8');
check('extension panel reports crashes', /addEventListener\('error'[\s\S]{0,200}reportExt\('ext-crash'/.test(pj));
check('extension panel reports its red status messages', /function st\(msg,type\)\{if\(type==='err'\)reportExt\('ext-notice',msg\);/.test(pj));
const bj = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
check('extension service worker reports crashes', /self\.addEventListener\('error'[\s\S]{0,80}reportBg/.test(bj));
check('extension only ever talks to the local app', !/https?:\/\/(?!127\.0\.0\.1)[^'"]*sentry/i.test(pj + bj));
check('server knows the extension report kinds', /'ext-crash': 'extension\.crash', 'ext-notice': 'extension\.error-shown'/.test(src));
check('every yt-dlp download failure is reported, not just 3 kinds', /: 'other'\),\s*\n\s*new Error\(msg\)/.test(src));
check('failed video-info lookups are reported (they answer 400, which the hook skips)', src.includes("report('ytdlp.info.' +"));
check('a route that throws is caught by a final error handler', /app\.use\(\(err, req, res, next\) =>[\s\S]{0,400}reportRouteError\(req, res, 'unhandled'/.test(src));

// ── 2. Real server ──
let canRun = true;
try { require.resolve('express', { paths: [ROOT] }); } catch { try { require.resolve('express'); } catch { canRun = false; } }

function req(port, method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: p, method,
      headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', () => resolve({ status: 0, body: '' }));
    r.end(data || undefined);
  });
}

(async () => {
  if (!canRun) {
    console.log('  skip real-server checks: node_modules not installed (run npm install)');
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-report-'));
    const PORT = 47000 + Math.floor(Math.random() * 900);
    const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), USER_DATA: path.join(work, 'data'), RESOURCES_PATH: ROOT, FREQPHULL_NO_CRASH_REPORT: '1' },
    });
    let log = '';
    srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
    try {
      for (let t = 0; t < 150 && !/listening on port/.test(log); t++) await new Promise((r) => setTimeout(r, 100));
      check('server started', /listening on port/.test(log));
      const reports = () => (log.match(/\[report\] [^\n]*/g) || []);
      const before = reports().length;

      // Streaming error from a real route (the converter's NDJSON).
      await req(PORT, 'POST', '/convert', { files: [path.join(work, 'missing.wav')], format: 'mp3' },
        { Origin: 'chrome-extension://abcdefghijklmnop' });
      await new Promise((r) => setTimeout(r, 200));
      check('a failed file in a stream is reported with its route',
        reports().some((l) => /server\.stream POST \/convert: File not found/.test(l)), reports().slice(before).join(' | '));

      // Caller mistakes are not bugs.
      const n1 = reports().length;
      const bad = await req(PORT, 'POST', '/convert', { files: ['x'], format: 'exe' });
      const malformed = await req(PORT, 'POST', '/convert', '{not json');
      await new Promise((r) => setTimeout(r, 200));
      check('4xx responses are not reported', bad.status === 400 && malformed.status === 400 && reports().length === n1,
        bad.status + '/' + malformed.status + ', ' + (reports().length - n1) + ' new');

      // What the app window and the extension send.
      const n2 = reports().length;
      await req(PORT, 'POST', '/client-error', { kind: 'notice', message: 'Could not decode this file', tab: 'convert' });
      await req(PORT, 'POST', '/client-error', { kind: 'ext-notice', message: 'Download failed', extVersion: '4.6.0' });
      await req(PORT, 'POST', '/client-error', { kind: 'ext-crash', message: 'TypeError: x is undefined', extVersion: '4.6.0' });
      await new Promise((r) => setTimeout(r, 200));
      const got = reports().slice(n2).join(' | ');
      check('red toast in the app -> renderer.error-shown', /renderer\.error-shown: Could not decode this file/.test(got), got);
      check('extension status error -> extension.error-shown', /extension\.error-shown: Download failed/.test(got));
      check('extension crash -> extension.crash', /extension\.crash: TypeError/.test(got));

      // The log line itself must already be scrubbed.
      await req(PORT, 'POST', '/client-error', { kind: 'notice', message: 'failed https://www.youtube.com/watch?v=VHtsNOp4BhI' });
      await new Promise((r) => setTimeout(r, 200));
      check('reported text is scrubbed (no video link)', !/VHtsNOp4BhI/.test(reports().join('\n')));
    } finally {
      srv.kill();
      await new Promise((r) => setTimeout(r, 300));
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    }
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
