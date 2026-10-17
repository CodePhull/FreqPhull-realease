// Round 81: Inspect Element / DevTools are off in installed builds.
//
// Static checks on main.js (BrowserWindow can't run headless):
//  - DEVTOOLS_ALLOWED is true from source, false when packaged, and true
//    again when packaged with FREQPHULL_DEVTOOLS=1;
//  - every BrowserWindow passes devTools: DEVTOOLS_ALLOWED;
//  - Ctrl+Shift+I returns before toggleDevTools when not allowed;
//  - nothing else in main.js opens DevTools.
//
// Pass a path to check another copy of main.js (used to prove the checks
// fail on the pre-fix file):  node tools/test-devtools-locked-r81.js [main.js]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] || path.join(__dirname, '..', 'main.js');
const src = fs.readFileSync(file, 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const m = src.match(/^const DEVTOOLS_ALLOWED = (.+);$/m);
check('DEVTOOLS_ALLOWED is defined', !!m);
if (m) {
  const val = (isPackaged, env) => vm.runInNewContext(m[1], { app: { isPackaged }, process: { env } });
  check('allowed when running from source', val(false, {}) === true);
  check('blocked in an installed build', val(true, {}) === false);
  check('FREQPHULL_DEVTOOLS=1 re-enables it for support', val(true, { FREQPHULL_DEVTOOLS: '1' }) === true);
}

const windows = src.split('new BrowserWindow(').length - 1;
const locked = (src.match(/devTools: DEVTOOLS_ALLOWED,/g) || []).length;
check('every BrowserWindow sets devTools: DEVTOOLS_ALLOWED', windows > 0 && locked === windows, locked + ' of ' + windows);

const key = src.match(/else if \(k === 'i'\) \{([\s\S]*?)\}\s*\n\s*\}\);/);
check('Ctrl+Shift+I is gated before toggleDevTools',
  !!key && /if \(!DEVTOOLS_ALLOWED\) return;[\s\S]*toggleDevTools/.test(key[1]));

const opens = (src.match(/\.(openDevTools|toggleDevTools)\(/g) || []).length;
check('no other place opens DevTools', opens === 1, opens + ' call(s)');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
