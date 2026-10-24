// Round 82: outside text must never reach the page as HTML.
//
// The history list put YouTube titles, channels, thumbnails and keys into
// innerHTML raw (`${h.title||'(untitled)'}`): a video titled with markup ran
// as code in the app window, which can open any file through window.api.
// Round 82's first audit missed it - it filtered whole LINES that contained
// t(', and the history row is one long line that does. This scans every
// SPLICE on its own: `${...}` and `' + ... + '` that touch a field which
// can come from YouTube, a file's tags or the user, and fails unless it is
// wrapped in an escaper or is one of the reviewed safe expressions below.
//
// Sanity gate first: the scanner must flag the exact pre-fix history row.
//
// Run:  node tools/test-html-escape-r82.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const FIELDS = 'title|channel|uploader|artist|album|filename|file_name|file_path|thumbnail|key_note|key_mode|format|genre|folder_name|description|lyrics|youtube_url';
const ESCAPED = /^\s*(escapeHtml|_escapeHTML|esc|encodeURIComponent|fmtSec|fmtTime|fmtSize|Math\.round|t)\s*\(/;
// Reviewed: each of these is internal, numeric, or already escaped inside.
const SAFE = new Set([
  // modeLabel() (Round 82 French pass) shows "minor"/"major" in the user's language; still escaped.
  "r.key_note ? ' · ' + escapeHtml(r.key_note) + ' ' + escapeHtml(modeLabel(r.key_mode)) : ''",
  "tr.channel ? ' · ' + escapeHtml(tr.channel) : ''",
  "(existing.title || 'Track').slice(0, 80)",      // confirmModal() escapes its detail
  "(existing.title||'Track').slice(0,60)",          // extension: native confirm(), plain text
  "(it.title||'').replace(/</g,'&lt;')",            // extension playlist: text node, < escaped
]);

function scan(src) {
  const out = [];
  const re1 = new RegExp('\\$\\{([^{}]*?\\b(?:' + FIELDS + ')\\b[^{}]*?)\\}', 'g');
  let m;
  while ((m = re1.exec(src))) {
    const inner = m[1].trim();
    if (ESCAPED.test(inner) || SAFE.has(inner)) continue;
    // A splice nested inside an escapeHtml(`...`) call is escaped as a whole.
    const before = src.slice(Math.max(0, m.index - 40), m.index);
    if (/escapeHtml\(`[^`]*$/.test(before)) continue;
    out.push(src.slice(0, m.index).split('\n').length + ': ${' + inner.slice(0, 80) + '}');
  }
  const re2 = new RegExp("(['\"])\\s*\\+\\s*([^+;\\n]*?\\b(?:" + FIELDS + ")\\b[^+;\\n]*?)\\s*\\+\\s*(['\"])", 'g');
  while ((m = re2.exec(src))) {
    const expr = m[2].trim();
    const ctx = src.slice(Math.max(0, m.index - 200), m.index + 200);
    if (!/innerHTML|insertAdjacentHTML|<[a-z][^>]*$/i.test(src.slice(Math.max(0, m.index - 200), m.index)) && !/innerHTML/.test(ctx)) continue;
    if (ESCAPED.test(expr) || SAFE.has(expr)) continue;
    out.push(src.slice(0, m.index).split('\n').length + ': + ' + expr.slice(0, 80) + ' +');
  }
  return out;
}

// Sanity gate: the pre-fix history row and extension row must be caught.
const oldRow = '<img class="hist-thumb" src="${resolveThumb(h.thumbnail)}"/><div class="hist-title">${h.title||\'(untitled)\'}</div><span class="badge key">${h.key_note} ${h.key_mode||\'\'}</span>';
const oldExt = "l.innerHTML=rows.map((h,i)=>{return '<div class=\"i\"><b>'+(h.title||'?')+'</b></div>'});";
check('gate: the pre-fix history row is flagged', scan(oldRow).length >= 3, scan(oldRow).length + ' splices');
check('gate: the pre-fix extension row is flagged', scan(oldExt).length >= 1);
check('gate: an escaped splice is not flagged', scan('<b>${escapeHtml(h.title)}</b>').length === 0);

for (const f of ['renderer/app.js', 'renderer/daw.js', 'extension/panel.js', 'renderer/updater/updater.html']) {
  const found = scan(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  check(f + ': no unescaped outside text spliced into HTML', found.length === 0, found.slice(0, 6).join(' | '));
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
