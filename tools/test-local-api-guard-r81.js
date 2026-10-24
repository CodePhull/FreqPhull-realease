// Round 81: websites can no longer use the app's local server.
//
// Before this round, 127.0.0.1:47891 answered every caller with
// "Access-Control-Allow-Origin: *": a request carrying a website's Origin
// got a private file back from GET /file (measured). Now only the app's
// windows (per-launch token, injected by main.js), the browser extension
// (its Origin) and header-less local tools get in.
//
// 1. Headless: LOCAL API GUARD CORE decision table.
// 2. Real server (skipped without node_modules): the original attack and
//    every legitimate caller, against server.js with a token set.
// 3. Static: main.js creates the token, passes it to the server and adds
//    it to every request its windows make.
//
// Run:  node tools/test-local-api-guard-r81.js
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
const si = src.indexOf('// ─── BEGIN LOCAL API GUARD CORE ───');
const ei = src.indexOf('// ─── END LOCAL API GUARD CORE ───');
if (si < 0 || ei < 0) throw new Error('LOCAL API GUARD CORE markers not found in server.js');
const sb = { String };
vm.createContext(sb);
vm.runInContext(src.slice(si, ei) + '\nthis.decide = localApiDecision;', sb);
const TOKEN = 'a'.repeat(48);
const H = '127.0.0.1:47891';
const dec = (headers, method, p) => sb.decide(Object.assign({ host: H }, headers), method || 'GET', p || '/history', TOKEN, 47891).allow;
// What the app's file:// window sends (measured on Electron 28): no Origin, cross-site.
const appWin = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
check('app window with the token: allowed', dec(Object.assign({ 'x-freqphull-token': TOKEN }, appWin)));
check('app <audio> with the token: allowed', dec({ 'x-freqphull-token': TOKEN, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'audio' }, 'GET', '/file'));
check('same request without the token: refused', !dec(appWin));
check('wrong token: refused', !dec(Object.assign({ 'x-freqphull-token': 'b'.repeat(48) }, appWin)));
check('Chrome extension origin: allowed', dec({ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'sec-fetch-site': 'cross-site' }));
// Measured with an extension loaded in Electron 28: its GET / EventSource /
// <audio> send no Origin, Sec-Fetch-Site: none (host permission).
check('extension GET / EventSource (no Origin, Sec-Fetch-Site: none): allowed', dec({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }));
check('extension <audio> (no Origin, none): allowed', dec({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'audio' }, 'GET', '/file'));
check('Firefox extension origin: allowed', dec({ origin: 'moz-extension://1b2c3d4e-0000-1111-2222-333344445555' }));
check('website fetch: refused', !dec({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }, 'GET', '/file'));
check('website form POST: refused', !dec({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, 'POST', '/history/clear'));
check('sandboxed frame (Origin: null): refused', !dec({ origin: 'null', 'sec-fetch-site': 'cross-site' }));
check('lookalike origin: refused', !dec({ origin: 'chrome-extension://abc.evil.example' }));
check('website <img> to a GET with side effects: refused', !dec({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, 'GET', '/download'));
check('website <audio> of a file: refused', !dec({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'audio' }, 'GET', '/file'));
check('drag-out download of /file (navigation): allowed', dec({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'empty' }, 'GET', '/file'));
check('...but a navigation to anything else: refused', !dec({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, 'GET', '/download'));
check('local tool, no browser headers: allowed', dec({}));
check('address typed in a browser (Sec-Fetch-Site: none): allowed', dec({ 'sec-fetch-site': 'none' }));
check('DNS rebinding (foreign Host): refused even without Origin', !sb.decide({ host: 'evil.example:47891' }, 'GET', '/file', TOKEN, 47891).allow);
check('localhost Host: allowed', sb.decide({ host: 'localhost:47891' }, 'GET', '/health', TOKEN, 47891).allow);

// ── 3. Static ──
const mj = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
check('main.js makes a random token per launch', /const LOCAL_API_TOKEN = require\('crypto'\)\.randomBytes\(24\)/.test(mj));
check('main.js passes it to the server', /FREQPHULL_API_TOKEN: LOCAL_API_TOKEN/.test(mj));
{
  const hook = mj.slice(mj.indexOf('onBeforeSendHeaders('), mj.indexOf('onBeforeSendHeaders(') + 500);
  check('main.js adds it to every request to the local server',
    hook.includes("'http:\\/\\/127.0.0.1:47891/*'") && hook.includes("'http:\\/\\/localhost:47891/*'") &&
    hook.includes("details.requestHeaders['X-FreqPhull-Token'] = LOCAL_API_TOKEN"));
}
check('the hook is installed before the window is created', mj.indexOf('onBeforeSendHeaders') < mj.indexOf('createTray();\n  startBackend();') || mj.indexOf('onBeforeSendHeaders') < mj.indexOf('createWindow();'));
// Other app-safety guards from the same audit.
const lockFn = mj.slice(mj.indexOf('function lockWindowToApp('), mj.indexOf('function lockWindowToApp(') + 800);
check('both app windows are locked to their own page (no navigation, no pop-ups)',
  mj.includes('lockWindowToApp(mainWindow);') && mj.includes('lockWindowToApp(updaterWindow);') &&
  lockFn.includes("on('will-navigate'") && lockFn.includes('e.preventDefault();') &&
  lockFn.includes('setWindowOpenHandler(') && lockFn.includes("action: 'deny'"));
const pj = fs.readFileSync(path.join(ROOT, 'extension', 'panel.js'), 'utf8');
check('extension history escapes YouTube titles, channels and thumbnails',
  pj.includes("<b>'+escapeHtml(h.title||'?')") && pj.includes('escapeHtml([h.channel,date,dur]') && pj.includes("src=\"'+escapeHtml(h.thumbnail)"));
check('extension notifications escape their text', pj.includes("notif-msg\">'+escapeHtml(msg)"));
check('no wildcard CORS left in server.js', !/app\.use\(cors\(\)\)/.test(src) && !/'Access-Control-Allow-Origin': '\*'/.test(src));

// ── 2. Real server ──
let canRun = true;
try { require.resolve('express', { paths: [ROOT] }); } catch { try { require.resolve('express'); } catch { canRun = false; } }
function req(port, method, p, headers) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: headers || {} }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: e.message }));
    r.end();
  });
}

(async () => {
  if (!canRun) {
    console.log('  skip real-server checks: node_modules not installed (run npm install)');
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-guard-'));
    const secret = path.join(work, 'secret.txt');
    fs.writeFileSync(secret, 'my private notes');
    const PORT = 47000 + Math.floor(Math.random() * 900);
    const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), USER_DATA: path.join(work, 'data'), RESOURCES_PATH: ROOT,
        FREQPHULL_NO_CRASH_REPORT: '1', FREQPHULL_API_TOKEN: TOKEN },
    });
    let log = '';
    srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
    try {
      for (let t = 0; t < 150 && !/listening on port/.test(log); t++) await new Promise((r) => setTimeout(r, 100));
      check('server started', /listening on port/.test(log));
      const filePath = '/file?path=' + encodeURIComponent(secret);
      const evil = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
      let r = await req(PORT, 'GET', filePath, evil);
      check('THE ATTACK: website reading a file -> 403, no data, no CORS header',
        r.status === 403 && !/private notes/.test(r.body) && !r.headers['access-control-allow-origin'], r.status + ' ' + JSON.stringify(r.body).slice(0, 60));
      r = await req(PORT, 'GET', '/history', evil);
      check('website reading history -> 403', r.status === 403);
      r = await req(PORT, 'OPTIONS', '/convert', { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
      check('website preflight for a POST -> refused, no CORS header', r.status === 403 && !r.headers['access-control-allow-origin'], String(r.status));
      r = await req(PORT, 'GET', filePath, Object.assign({ 'X-FreqPhull-Token': TOKEN }, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'audio' }));
      check('app window (token) reading a file -> 200', r.status === 200 && /private notes/.test(r.body), String(r.status));
      const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
      r = await req(PORT, 'GET', '/history', { Origin: ext, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' });
      check('extension reading history -> 200 with its own origin in the CORS header', r.status === 200 && r.headers['access-control-allow-origin'] === ext, r.status + ' ' + r.headers['access-control-allow-origin']);
      r = await req(PORT, 'OPTIONS', '/convert', { Origin: ext, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
      check('extension preflight -> allowed', r.status === 204 && r.headers['access-control-allow-origin'] === ext, String(r.status));
      r = await req(PORT, 'GET', '/history', { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' });
      check('extension GET as measured (no Origin, Sec-Fetch-Site: none) -> 200', r.status === 200, String(r.status));
      r = await req(PORT, 'GET', '/health', {});
      check('local tool without browser headers -> allowed', r.status === 200, String(r.status));
      r = await req(PORT, 'GET', '/health', { Host: 'evil.example:' + PORT });
      check('foreign Host (DNS rebinding) -> 403', r.status === 403, String(r.status));
      check('blocked requests are logged', /local-api: blocked GET \/file \(origin https:\/\/evil\.example\)/.test(log));
      check('blocked requests are not sent to Sentry (a website could spam them)', !/\[report\][^\n]*Forbidden/.test(log));
    } finally {
      srv.kill();
      await new Promise((r) => setTimeout(r, 300));
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    }
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
