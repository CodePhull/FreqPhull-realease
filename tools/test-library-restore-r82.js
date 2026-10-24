// Round 82: "lets say apps uninstall and reinstalls for some reasons ... make
// sure it can detect stockpile folder to be able to come back to a good state
// and not from scratch".
//
// The library (history, BPM/key, notes, favorites, folders, producer links)
// lived only in AppData. The uninstaller keeps AppData, but a new PC, a
// Windows reset or a deleted AppData folder lost it while the audio sat
// untouched in the Stockpile folder. Now (server: LIBRARY BACKUP CORE):
//   - a copy of the library is kept in <Stockpile>\.freqphull\ (hidden), at
//     most every 2 minutes after a save;
//   - a fresh install with an empty library searches for it and offers to
//     restore it, moving file paths if the folder moved (drive letter...);
//   - a Stockpile folder without a backup (older versions) is rebuilt from
//     its folders.
// The real-server part runs the whole story with a fake home folder:
// rebuild -> favorite + note -> backup written -> AppData "wiped" and the
// Stockpile moved -> found -> restored.
//
// Run:  node tools/test-library-restore-r82.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const aj = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── CORE ──
const si = src.indexOf('// ─── BEGIN LIBRARY BACKUP CORE ───');
const ei = src.indexOf('// ─── END LIBRARY BACKUP CORE ───');
if (si < 0 || ei < 0) throw new Error('LIBRARY BACKUP CORE markers not found');
const sb = { String, RegExp };
vm.createContext(sb);
vm.runInContext(src.slice(si, ei) + '\nthis.f = { rebasePath, planRebuild, LIB_SCAN_SKIP };', sb);
const { rebasePath, planRebuild, LIB_SCAN_SKIP } = sb.f;

check('a path under the old root moves to the new root', rebasePath('E:\\Stockpile\\Drill\\a.mp3', 'E:\\Stockpile', 'F:\\Stockpile') === 'F:\\Stockpile\\Drill\\a.mp3');
check('...case-insensitive, trailing slash ignored', rebasePath('e:\\STOCKPILE\\x.mp3', 'E:\\Stockpile\\', 'D:\\Beats') === 'D:\\Beats\\x.mp3');
check('a path outside the old root is left alone', rebasePath('C:\\Users\\me\\Downloads\\x.mp3', 'E:\\Stockpile', 'F:\\S') === null);
check('a sibling folder with the same prefix is not "under" it', rebasePath('E:\\Stockpile2\\x.mp3', 'E:\\Stockpile', 'F:\\S') === null);

const tree = {
  'R': [{ name: 'Drill', isDir: true }, { name: 'Trap', isDir: true }, { name: '.freqphull', isDir: true }, { name: 'Empty', isDir: true }, { name: 'loose.mp3', isDir: false }, { name: 'cover.jpg', isDir: false }],
  'R/Drill': [{ name: 'a.mp3', isDir: false }, { name: 'b.WAV', isDir: false }, { name: 'notes.txt', isDir: false }],
  'R/Trap': [{ name: 'c.flac', isDir: false }, { name: 'Old', isDir: true }],
  'R/Trap/Old': [{ name: 'e.mp3', isDir: false }, { name: 'Deeper', isDir: true }],
  'R/Empty': [{ name: 'readme.txt', isDir: false }],
  'R/.freqphull': [{ name: 'library.db', isDir: false }],
};
const plan = planRebuild('R', (d) => tree[d] || [], (a, b) => a + '/' + b, new Set(['.mp3', '.wav', '.flac']));
check('each style folder with audio becomes a folder', JSON.stringify(plan.folders.map((f) => f.name)) === '["Drill","Trap"]', plan.folders.map((f) => f.name).join(','));
check('audio is found one level down too, not other files', JSON.stringify(plan.folders.map((f) => f.files)) === '[["R/Drill/a.mp3","R/Drill/b.WAV"],["R/Trap/c.flac","R/Trap/Old/e.mp3"]]');
check('audio in the root is kept as tracks without a folder', JSON.stringify(plan.loose) === '["R/loose.mp3"]');
check('the backup folder and empty folders are skipped', !plan.folders.some((f) => f.name === '.freqphull' || f.name === 'Empty'));
check('system folders are never searched', ['Windows', 'Program Files', 'Program Files (x86)', 'AppData', '$Recycle.Bin', 'node_modules'].every((n) => LIB_SCAN_SKIP.test(n)) && !LIB_SCAN_SKIP.test('Music'));

// ── Wiring ──
check('every library save schedules a backup', /fs\.renameSync\(tmp, DB_PATH\);\s*scheduleLibraryBackup\(\);/.test(src));
check('nothing writes the library file during a restore', /if \(!db \|\| _libRestoring\) return;/.test(src));
check('an empty library never replaces a backup', /if \(!tracks\) return;\s*\/\/ an empty library never replaces a backup/.test(src));
check('a much smaller library keeps the big backup aside', /prev\.tracks > tracks \* 2/.test(src) && /'-tracks\.db'/.test(src));
check('restore keeps the current library first', src.includes("fs.copyFileSync(DB_PATH, DB_PATH + '.before-restore.' + Date.now() + '.bak')"));
check('restore opens the library like a launch (migrations included)', /db = null;\s*_libRestoring = false;\s*await initDB\(\);/.test(src));
check('drives are only searched when the library is empty', /if \(tracks > 0 && req\.query\.force !== '1'\) return res\.json\(\{ libraryTracks: tracks, backups: \[\] \}\);/.test(src));
check('fresh install offers found backups before the Stockpile setup', /if \(!skipRestoreCheck && await libOfferFoundBackups\(\)\) return;/.test(aj));
check('picking a Stockpile folder checks what it can bring back', (aj.match(/libCheckPickedFolder\(folder\);/g) || []).length === 2);
check('Settings has Restore library', aj.includes('onclick="libRestoreFromSettings()"'));
check('restore copies the server-kept settings into the window too', aj.includes("localStorage.setItem('freqphull.autoSend'") && aj.includes("localStorage.setItem('fp_stockpile', root)"));
check('the restore window never puts a path into markup', /data-lib="' \+ \(acts\.length - 1\) \+ '"/.test(aj) && aj.includes('escapeHtml(b.root)'));
for (const key of ['libFoundTitle', 'libFoundBody', 'libRestore', 'libStartFresh', 'libRestored', 'libRebuildTitle', 'libRebuildBody', 'libRebuildBtn', 'libSettingName', 'libSettingBtn', 'libReplaceWarn', 'libNothing']) {
  const n = (aj.match(new RegExp('\\b' + key + ':\'', 'g')) || []).length;
  if (n !== 2) check('label ' + key + ' in English and French', false, n + ' found');
}

// ── Real server ──
let canRun = true;
for (const mod of ['express', 'sql.js']) {
  try { require.resolve(mod, { paths: [ROOT] }); } catch { try { require.resolve(mod); } catch { canRun = false; } }
}
function req(port, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.end(data || undefined);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startServer(work, data, port) {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), USER_DATA: data, RESOURCES_PATH: ROOT, FREQPHULL_NO_CRASH_REPORT: '1',
      USERPROFILE: path.join(work, 'home'), HOME: path.join(work, 'home') },
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let t = 0; t < 150; t++) {
    const h = await req(port, 'GET', '/health');
    if (h.json && h.json.db) break;
    await sleep(100);
  }
  return { srv, log: () => log };
}

(async () => {
  if (!canRun) {
    console.log('  skip real-server checks: node_modules not installed (run npm install)');
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-lib-'));
    const stock = path.join(work, 'home', 'Music', 'Stockpile');
    for (const d of ['Drill', 'Trap']) fs.mkdirSync(path.join(stock, d), { recursive: true });
    for (const f of ['Drill/a.mp3', 'Drill/b.mp3', 'Trap/c.mp3', 'loose.mp3']) fs.writeFileSync(path.join(stock, f), 'not really audio');
    const PORT = 47000 + Math.floor(Math.random() * 900);
    let s = null;
    try {
      // Install 1: an older-version Stockpile (no backup) is rebuilt.
      s = await startServer(work, path.join(work, 'dataA'), PORT);
      let r = await req(PORT, 'GET', '/library/inspect?root=' + encodeURIComponent(stock));
      check('a Stockpile without backup is recognised', r.json && r.json.backup === null && r.json.folders === 2 && r.json.files === 4, JSON.stringify(r.json));
      r = await req(PORT, 'POST', '/library/rebuild', { root: stock });
      check('rebuild adds its tracks and folders', r.json && r.json.tracks === 4 && r.json.folders === 2, JSON.stringify(r.json));
      r = await req(PORT, 'POST', '/library/rebuild', { root: stock });
      check('rebuilding twice adds nothing', r.json && r.json.tracks === 0, JSON.stringify(r.json));
      const hist = (await req(PORT, 'GET', '/history')).json || [];
      const a = hist.find((h) => h.title === 'a');
      await req(PORT, 'POST', '/history/' + a.id + '/favorite', { favorite: true });
      await req(PORT, 'POST', '/history/' + a.id + '/notes', { notes: 'hard 808s' });
      r = await req(PORT, 'GET', '/library/backups');
      check('a library with tracks never searches the drives', r.json && r.json.libraryTracks === 4 && r.json.backups.length === 0);
      for (let t = 0; t < 120 && !fs.existsSync(path.join(stock, '.freqphull', 'library-info.json')); t++) await sleep(100);
      await sleep(300);
      const info = JSON.parse(fs.readFileSync(path.join(stock, '.freqphull', 'library-info.json'), 'utf8'));
      check('the backup is written into the Stockpile folder', info.tracks === 4 && info.folders === 2 && fs.existsSync(path.join(stock, '.freqphull', 'library.db')), JSON.stringify(info));
      s.srv.kill(); await sleep(400);

      // AppData "wiped", Stockpile moved (another drive / folder).
      const moved = path.join(work, 'home', 'Music', 'Beats Archive');
      fs.renameSync(stock, moved);
      s = await startServer(work, path.join(work, 'dataB'), PORT);
      r = await req(PORT, 'GET', '/library/backups');
      const found = r.json && r.json.backups.find((b) => b.root.toLowerCase() === moved.toLowerCase());
      check('a fresh install finds the backup', r.json && r.json.libraryTracks === 0 && !!found, JSON.stringify(r.json && r.json.backups.map((b) => b.root)));
      await sleep(900);   // the fresh install saves its (empty) library file first
      r = await req(PORT, 'POST', '/library/restore', { root: moved });
      check('restore brings the library back, paths moved to the new place', r.json && r.json.ok && r.json.tracks === 4 && r.json.folders === 2 && r.json.rebased === 4 && r.json.missing === 0, JSON.stringify(r.json));
      const h2 = (await req(PORT, 'GET', '/history')).json || [];
      const a2 = h2.find((h) => h.title === 'a');
      check('favorite and note are back', a2 && a2.is_favorite === 1 && a2.notes === 'hard 808s');
      check('every file is found at its new path', h2.length === 4 && h2.every((h) => h.file_path.toLowerCase().startsWith(moved.toLowerCase()) && fs.existsSync(h.file_path)));
      const prefs = (await req(PORT, 'GET', '/prefs')).json || {};
      check('the Stockpile setting points to the new place', prefs.stockpile_root === moved);
      check('the library that was there is kept', fs.readdirSync(path.join(work, 'dataB')).some((f) => /\.before-restore\.\d+\.bak$/.test(f)));
      r = await req(PORT, 'POST', '/library/restore', { root: path.join(work, 'nowhere') });
      check('a folder without backup is refused', r.status === 404);
    } finally {
      if (s) s.srv.kill();
      await sleep(400);
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    }
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall library-restore checks passed');
  process.exit(fails ? 1 : 0);
})();
