// Regression test for the v4.5.0 cross-browser extension fix.
//
// The bug, reported by a user on Opera whose Freq.Phull button did nothing:
// background.js opened with a bare
//     chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
// on line 1. chrome.sidePanel is a Chrome API (114+) - Chrome, Edge and
// Brave have it, Opera does not and never has, because Opera ships its own
// sidebar. On Opera that line threw a TypeError at the TOP of the service
// worker, before a single listener below it was registered. So it was not
// "the sidebar fails to open" - the whole extension was dead: no open-panel
// handling, no tab sync, no update check. content.js:23 fires 'open-panel'
// when the in-page button is clicked, and nothing was listening.
//
// This is a static source guard. Driving four real browsers' extension
// runtimes is not something this repo can do headlessly (same limitation as
// Rounds 59/68/70/73/75), but what can be pinned exactly is that no
// unguarded sidePanel access ever returns to the top level, and that a
// fallback path exists for browsers without the API.
'use strict';
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'extension');
const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const content = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── Nothing may touch chrome.sidePanel without feature-detecting first ──
check('v4.5.0: the extension feature-detects chrome.sidePanel',
  /const HAS_SIDE_PANEL = !!\(chrome\.sidePanel && chrome\.sidePanel\.open\)/.test(bg));

// The original crash: a sidePanel call at top level, outside any guard or
// function. Walk the file and flag any sidePanel access that is not inside
// a HAS_SIDE_PANEL block or a function body.
const lines = bg.split('\n');
const offenders = [];
let depth = 0, guarded = false, guardDepth = -1;
lines.forEach((line, i) => {
  const code = line.replace(/\/\/.*$/, '');
  if (/if\s*\(HAS_SIDE_PANEL/.test(code)) { guarded = true; guardDepth = depth; }
  // The feature-detect itself is top-level BY DESIGN and is safe: reading a
  // property off `chrome` never throws, and `chrome.sidePanel && ...` short-
  // circuits before the call. An earlier version of this scan flagged the one
  // line that makes everything else safe, which is precisely backwards.
  // Anything that short-circuits on `chrome.sidePanel &&` is fine for the
  // same reason; only an unguarded CALL can crash the worker.
  const isDetection = /HAS_SIDE_PANEL\s*=/.test(code) || /chrome\.sidePanel\s*&&/.test(code);
  if (/chrome\.sidePanel/.test(code) && !isDetection && !guarded && depth === 0) {
    offenders.push((i + 1) + ': ' + line.trim());
  }
  depth += (code.match(/\{/g) || []).length;
  depth -= (code.match(/\}/g) || []).length;
  if (guarded && depth <= guardDepth) { guarded = false; guardDepth = -1; }
});
check('v4.5.0: no unguarded chrome.sidePanel access at the service worker top level (this is the exact line that killed the worker on Opera)',
  offenders.length === 0, offenders.join(' | '));

check('v4.5.0: setPanelBehavior only runs when the API is actually present',
  /if \(HAS_SIDE_PANEL\) \{[\s\S]{0,300}setPanelBehavior/.test(bg));

// ── A fallback must exist for browsers without a side panel ──
check('v4.5.0: there is a fallback that opens the panel as a popup window',
  /function openPanelFallback\(\)/.test(bg) && /chrome\.windows\.create/.test(bg));
check('v4.5.0: the fallback reuses panel.html, so there is no second UI to maintain',
  /chrome\.runtime\.getURL\('panel\.html'\)/.test(bg));
check('v4.5.0: repeated clicks focus the existing fallback window instead of opening more',
  /chrome\.windows\.update\([\s\S]{0,80}focused: true/.test(bg));
check('v4.5.0: the tracked fallback window id is cleared when the user closes it',
  /chrome\.windows\.onRemoved\.addListener/.test(bg));

// ── The toolbar button must work in both worlds ──
check('v4.5.0: without sidePanel, the toolbar action gets an explicit click handler (nothing opens it natively)',
  /if \(!HAS_SIDE_PANEL\) \{[\s\S]{0,300}chrome\.action\.onClicked\.addListener/.test(bg));
check('sanity: the manifest still has no default_popup, or action.onClicked would never fire',
  !(manifest.action && manifest.action.default_popup));

// ── The in-page button's message must still be handled ──
check('sanity: content.js still sends open-panel (the in-page button the user actually pressed)',
  /type: 'open-panel'/.test(content));
check('v4.5.0: open-panel routes through openPanel() rather than calling sidePanel directly',
  /if \(msg\.type === 'open-panel'\)[\s\S]{0,400}openPanel\(tabId\)/.test(bg));
check('v4.5.0: open-panel no longer bails out when there is no tabId (the fallback does not need one)',
  !/if \(msg\.type === 'open-panel'\)[\s\S]{0,200}if \(tabId\) \{/.test(bg));

// ── Manifest still declares what Chrome/Edge/Brave need ──
check('sanity: sidePanel permission retained for the browsers that do support it',
  Array.isArray(manifest.permissions) && manifest.permissions.includes('sidePanel'));
check('sanity: side_panel default_path still points at panel.html',
  manifest.side_panel && manifest.side_panel.default_path === 'panel.html');
check('v4.5.0: extension version was bumped so users get the fix',
  manifest.version !== '4.4.0', 'version=' + manifest.version);

console.log('');
if (fails) { console.log(`✗ ${fails} ext-crossbrowser check(s) failed`); process.exit(1); }
console.log('✓ ext-crossbrowser: all checks passed');
