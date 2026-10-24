// Round 82: "Send to ..." from History and Stockpile.
//
// "Send to Stem Separator" and "Send to Transcribe" in the History
// right-click menu never worked: they called switchTab(),
// stageStemsFromPath() and stageTranscribeFromPath(), which don't exist.
// Each call was wrapped in `typeof X === 'function'`, so instead of an
// error the user got a toast claiming the tab had switched. tools/xref.py
// can't see this (the guard hides the call), so this test checks it in
// general: every `typeof X === 'function'` in the renderer must name
// something that is defined somewhere, or be a reviewed browser feature.
//
// Also: Send to Convert (single + History select mode), Stockpile rows get
// the same menu, and a transcript is saved onto the track it came from -
// it used to be saved onto whatever was open in the Analyzer.
//
// Run:  node tools/test-send-to-r82.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const daw = fs.readFileSync(path.join(ROOT, 'renderer', 'daw.js'), 'utf8');
const all = app + '\n' + daw + '\n' + html;
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function isDefined(name) {
  const n = esc(name);
  return new RegExp('function\\s+' + n + '\\s*\\(').test(all) ||
    new RegExp('(const|let|var)\\s+' + n + '\\s*=').test(all) ||
    new RegExp('window\\.' + n + '\\s*=').test(all) ||
    new RegExp('[{,]\\s*' + n + '\\s*[,}]').test(all);   // destructured / exported
}

// ── 1. Guarded calls to things that don't exist ──
// Browser / optional-library features legitimately feature-detected.
const OPTIONAL = new Set(['require', 'structuredClone', 'queueMicrotask', 'requestIdleCallback', 'showDirectoryPicker',
  'fetch', 'AudioWorkletNode', 'ResizeObserver', 'IntersectionObserver', 'BroadcastChannel', 'createImageBitmap',
  'OffscreenCanvas', 'MediaRecorder', 'EyeDropper', 'scheduler']);
const re = /typeof\s+(?:window\.)?([A-Za-z_$][\w$]*)\s*===?\s*['"]function['"]/g;
const missing = [];
const seen = new Set();
let m;
while ((m = re.exec(app))) {
  const name = m[1];
  if (seen.has(name) || OPTIONAL.has(name)) continue;
  seen.add(name);
  if (!isDefined(name)) missing.push(name + ' (line ' + app.slice(0, m.index).split('\n').length + ')');
}
check('gate: a made-up name is reported as missing', !isDefined('stageTranscribeFromPath_doesNotExist'));
check('every `typeof X === "function"` names something that exists', missing.length === 0, missing.join(', '));

// Found by the scan above: switchTab() never existed, so these did nothing.
{
  const sw = app.slice(app.indexOf('function switchTab(name) {'), app.indexOf('function switchTab(name) {') + 300);
  check('switchTab() exists and opens tabs by name (refusing hidden ones)', sw.length > 0 && sw.includes('btn.offsetParent === null'));
}
check('Ctrl+1..9 opens the N-th visible tab (the old list named tabs that do not exist)',
  app.includes("const visible = Array.from(document.querySelectorAll('.nav-btn[data-tab]')).filter((b) => b.offsetParent !== null);") && !app.includes('TAB_ORDER['));
check('an open Stockpile folder refreshes after a tag change', app.includes('async function loadFolderTracks(folderId) {'));
check('auto-organize refreshes the folder cards', app.includes('  await loadStockpile();\n  if (typeof loadHistory'));

// ── 2. The send-to actions ──
const send = app.slice(app.indexOf('function _histRowWithFile('), app.indexOf('function bulkSendToConvert('));
for (const fn of ['showSeparatorSource', 'showTab', 'stageTranscribeFile', 'convInit', 'convAddPaths', 'trSt']) {
  check('send-to uses ' + fn + '(), which exists', send.includes(fn + '(') && isDefined(fn));
}
check('no dead fallbacks left in send-to', !/switchTab|stageStemsFromPath|stageTranscribeFromPath/.test(send));
check('the menu offers Send to Convert', app.includes("act: () => sendHistoryToConvert(id)"));
check('History select mode has a Convert button', html.includes('onclick="bulkSendToConvert()"'));
check('Stockpile folder rows open the same menu', app.includes('oncontextmenu="showHistoryContextMenu(event, ${tr.id})"'));
check('Stockpile untagged rows open the same menu', app.includes("row.addEventListener('contextmenu', (e) => showHistoryContextMenu(e, track.id));"));

// ── 3. Transcript goes to the right track ──
const tr = app.slice(app.indexOf('async function startTranscribeFile('), app.indexOf('function copyTranscript('));
check('the transcript is saved onto the track it came from', tr.includes("fetch(API + '/history/' + histId + '/transcript'"));
check('...not onto whatever is open in the Analyzer', !tr.includes("'/history/' + currentHistId + '/transcript'"));
check('a hand-picked file is not tied to any track', app.includes('stageTranscribeFile(e.target.files[0], null);'));

// ── 4. Labels exist in both languages (t() returns the KEY when missing) ──
check('a missing file is a warning, not a reported error', app.includes("showAppNotification(t('sendFileMissing'), 'warn', null, 6000);"));
for (const key of ['ctxSendConvert', 'sendNoFile', 'sendLoading', 'sendFailed', 'sendFileMissing', 'copied']) {
  const n = (app.match(new RegExp('\\n\\s+' + key + ":'", 'g')) || []).length;
  check('label ' + key + ' exists in English and French', n === 2, n + ' found');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
