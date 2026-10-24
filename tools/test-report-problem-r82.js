// Round 82: "Report a problem", and what actually leaves the machine.
//
// Runs server.js against a FAKE Sentry on 127.0.0.1 (the DSN points there),
// so the envelope the real @sentry/node SDK sends can be read byte for
// byte. Checks:
//   - a user report arrives with the user's text and the log tail;
//   - nothing identifying is in what was sent: no PC name, no IP (and the
//     "never infer an IP" flag is set), no e-mail, no YouTube link or id,
//     no Windows user name - in the message, the log tail or anywhere else;
//   - an empty report is refused; a build without a DSN says so.
// Static: the Settings button and dialog exist and call the route.
// Skipped (not failed) without node_modules.
//
// Run:  node tools/test-report-problem-r82.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const aj = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
check('Settings has a Report a problem button', aj.includes('onclick="openReportProblem()"'));
check('the dialog posts to /report-problem with the optional log', aj.includes("fetch(API + '/report-problem'") && aj.includes("includeLog: overlay.querySelector('#rp-log').checked"));
check('the dialog tells people what is removed', aj.includes("t('reportPrivacy')"));

// Every module the server needs must resolve - a stray @sentry/node higher up
// the folder tree (found in the user folder on the dev machine) is not enough.
let canRun = true;
for (const mod of ['express', 'sql.js', '@sentry/node']) {
  try { require.resolve(mod, { paths: [ROOT] }); } catch { try { require.resolve(mod); } catch { canRun = false; } }
}

function post(port, p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.end(data);
  });
}

(async () => {
  if (!canRun) {
    console.log('  skip real-server checks: node_modules not installed (run npm install)');
  } else {
    // Fake Sentry: collects every envelope.
    const envelopes = [];
    const fake = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (/gzip/i.test(req.headers['content-encoding'] || '')) { try { buf = zlib.gunzipSync(buf); } catch {} }
        envelopes.push(buf.toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const FPORT = fake.address().port;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-report-'));
    const PORT = 47000 + Math.floor(Math.random() * 900);
    const hostname = os.hostname();
    const user = os.userInfo().username;
    const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), USER_DATA: path.join(work, 'data'), RESOURCES_PATH: ROOT,
        FREQPHULL_SENTRY_DSN: 'http://0123456789abcdef0123456789abcdef@127.0.0.1:' + FPORT + '/1', FREQPHULL_NO_CRASH_REPORT: '' },
    });
    let log = '';
    srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
    try {
      for (let t = 0; t < 150 && !/listening on port/.test(log); t++) await new Promise((r) => setTimeout(r, 100));
      check('server started with reporting on', /listening on port/.test(log));
      let r = await post(PORT, '/report-problem', { message: '  ' });
      check('an empty report is refused', r.status === 400);
      const text = 'Download froze on https://www.youtube.com/watch?v=VHtsNOp4BhI - mail me at kev.smith@gmail.com from 84.12.200.7';
      r = await post(PORT, '/report-problem', { message: text, includeLog: true, tab: 'download' });
      check('the report is accepted', r.status === 200 && r.json && r.json.ok === true && /^[0-9a-f]{8}$/.test(r.json.id), JSON.stringify(r.json));
      for (let t = 0; t < 50 && !envelopes.some((e) => e.includes('user.report')); t++) await new Promise((res2) => setTimeout(res2, 100));
      const env = envelopes.find((e) => e.includes('user.report')) || '';
      check('the report reached (fake) Sentry', env.length > 0, envelopes.length + ' envelope(s)');
      const lines = env.split('\n');
      let ev = null;
      for (const l of lines) { try { const j = JSON.parse(l); if (j && j.extra && j.extra.report_id) ev = j; } catch {} }
      check('it carries the user\'s description', ev && /Download froze on/.test(ev.extra.message));
      // The log is written in batches; the route must flush it first, or the
      // newest lines (startup included, here) are missing. Measured flaky
      // (144 vs 1963 chars) before the flush was added.
      check('it carries the log tail, up to date', ev && typeof ev.extra.log_tail === 'string' && /listening on port/.test(ev.extra.log_tail), ev && String(ev.extra.log_tail).length + ' chars');
      const allEnv = envelopes.join('\n');
      check('no PC name in anything sent (every envelope)', !allEnv.includes(hostname) && !(ev && 'server_name' in ev && ev.server_name !== 'freqphull'), hostname);
      check('IP pinned to null and Sentry told never to infer one', ev && ev.user && ev.user.ip_address === null && ev.sdk && ev.sdk.settings && ev.sdk.settings.infer_ip === 'never');
      check('no e-mail, public IP, YouTube link or video id in anything sent',
        !/kev\.smith@gmail\.com|84\.12\.200\.7|VHtsNOp4BhI|watch\?v=/.test(allEnv));
      check('no Windows user name in anything sent (log paths included)', !new RegExp('\\\\Users\\\\' + user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\\\', 'i').test(allEnv), user);
    } finally {
      srv.kill();
      fake.close();
      await new Promise((r) => setTimeout(r, 300));
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    }
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
