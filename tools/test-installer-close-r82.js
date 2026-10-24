// Round 82: installing over a running app failed ("Failed to uninstall old
// application files ... : 2") because Freq.Phull kept running in the tray.
//
// 1. Static: the installer and uninstaller close the app first (polite
//    taskkill, then forced), by an exact image name that can't match the
//    setup file itself. (The NSIS hooks were compile-checked with
//    electron-builder's cached makensis 3.0.4 while building this.)
// 2. Runtime: the library save the forced close could interrupt is now
//    write-then-rename. The real _flushDB() from server.js is run against a
//    temp folder; a failure between write and rename must leave the previous
//    library byte-for-byte intact and no temp file behind.
//
// Run:  node tools/test-installer-close-r82.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── 1. Installer hooks ──
const nsh = fs.readFileSync(path.join(ROOT, 'assets', 'installer.nsh'), 'utf8');
const mac = nsh.slice(nsh.indexOf('!macro FP_CLOSE_RUNNING_APP'), nsh.indexOf('!macroend', nsh.indexOf('!macro FP_CLOSE_RUNNING_APP')));
check('a close-the-app macro exists', mac.length > 0);
check('it asks politely first, then forces', mac.indexOf('taskkill /IM "Freq.Phull.exe" /T') >= 0 &&
  mac.indexOf('taskkill /F /IM "Freq.Phull.exe" /T') > mac.indexOf('taskkill /IM "Freq.Phull.exe" /T'));
check('installer runs it before removing the old version', /!macro customInit\s+!insertmacro FP_CLOSE_RUNNING_APP\s+!macroend/.test(nsh));
check('uninstaller runs it too', /!macro customUnInit\s+!insertmacro FP_CLOSE_RUNNING_APP\s+!macroend/.test(nsh));
const artifact = require(path.join(ROOT, 'package.json')).build.nsis.artifactName;
check('the image name can never match the setup file', /^Freq\.Phull-Setup-/.test(artifact) && artifact.split('.').slice(0, 2).join('.') !== 'Freq.Phull.exe', artifact);
check('package.json includes this file in the installer', require(path.join(ROOT, 'package.json')).build.nsis.include === 'assets/installer.nsh');

// ── 2. Atomic library save ──
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const fi = src.indexOf('function _flushDB() {');
const fe = src.indexOf('\n}\n', fi) + 3;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-dbsave-'));
const DB_PATH = path.join(dir, 'freqphull.db');
try {
  const logs = [];
  const mkSandbox = (fsImpl, payload) => {
    // _libRestoring / scheduleLibraryBackup: the library backup added later
    // in Round 82 (test-library-restore-r82.js covers it).
    const sb = { fs: fsImpl, DB_PATH, Buffer, slog: (m) => logs.push(m), _dbSavePending: true, _dbSaveTimer: null, clearTimeout,
      _libRestoring: false, scheduleLibraryBackup: () => {}, db: { export: () => payload } };
    vm.createContext(sb);
    vm.runInContext(src.slice(fi, fe), sb);
    return sb;
  };
  fs.writeFileSync(DB_PATH, 'OLD LIBRARY');
  // Normal save.
  let sb = mkSandbox(fs, new Uint8Array(Buffer.from('NEW LIBRARY')));
  sb._flushDB();
  check('a normal save writes the new library', fs.readFileSync(DB_PATH, 'utf8') === 'NEW LIBRARY');
  check('...and leaves no temp file', !fs.existsSync(DB_PATH + '.tmp'));
  // Killed between write and rename (simulated by rename failing).
  const brokenFs = Object.assign({}, fs, { renameSync: () => { throw new Error('process ended'); } });
  sb = mkSandbox(brokenFs, new Uint8Array(Buffer.from('HALF')));
  sb._flushDB();
  check('interrupted save: the previous library is intact', fs.readFileSync(DB_PATH, 'utf8') === 'NEW LIBRARY');
  check('interrupted save: temp file cleaned up', !fs.existsSync(DB_PATH + '.tmp'));
  check('interrupted save is logged', logs.some((l) => /DB save error/.test(l)));
  // The old direct write would have destroyed it.
  check('nothing writes the library directly any more', !/writeFileSync\(DB_PATH,/.test(src));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
