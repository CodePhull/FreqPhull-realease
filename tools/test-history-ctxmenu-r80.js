// Round 80: history right-click menu - two of its items had never worked.
//
//   "Copy source URL" read row.source_url. No such field exists anywhere;
//   the column is youtube_url. Every track reported "No URL stored for this
//   track", including one downloaded from a link seconds earlier.
//
//   "Favorite" called toggleHistoryFavorite(), which does not exist (the
//   heart button uses toggleFavorite()). Clicking it threw a ReferenceError.
//
// Both are the same bug class - the menu referencing names that were never
// real - and nothing caught them because nothing checked. So this checks
// the whole menu against reality rather than just these two:
//   - every row.<field> it reads must be a column /history actually sends
//   - every function an item calls must be defined in app.js
//   - every endpoint it hits must exist in server.js
//
// Run:  node tools/test-history-ctxmenu-r80.js
'use strict';
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else    { fail++; console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

console.log('Round 80 - history context menu references are real\n');

const start = app.indexOf('function showHistoryContextMenu(');
const menu = app.slice(start, app.indexOf('const m = document.createElement(\'div\');', start));
check('located showHistoryContextMenu() items', start > 0 && menu.length > 500);

// Columns the list endpoint sends.
const colMatch = server.match(/const HISTORY_LIST_COLUMNS\s*=\s*((?:\s*'[^']*'\s*\+?)+);/);
const columns = new Set((colMatch ? colMatch[1] : '').replace(/'|\+|\s/g, '').split(',').filter(Boolean));
check('parsed HISTORY_LIST_COLUMNS from server.js', columns.size >= 10, columns.size + ' columns');

// Every row.<field> read by the menu.
const fields = [...new Set([...menu.matchAll(/\brow\.([a-z_]+)/g)].map((m) => m[1]))];
for (const f of fields) {
  check('row.' + f + ' is a column /history sends', columns.has(f),
        columns.has(f) ? '' : 'not in HISTORY_LIST_COLUMNS - it will always be undefined');
}
check('Copy source URL reads youtube_url', /row\.youtube_url/.test(menu));

// Every function an act: handler calls.
// Every bare call in the menu body (method calls like histData.find() are
// excluded by the lookbehind). Scanning the whole body rather than trying to
// isolate each act: handler means a new item cannot slip past a clever regex.
// Comment lines are stripped first - the explanatory comment above the items
// names the dead function on purpose.
const code = menu.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const called = new Set();
for (const c of code.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) called.add(c[1]);
const builtins = new Set(['fetch', 'encodeURIComponent', 'if', 'return', 'function', 'catch', 'then',
                          'showHistoryContextMenu']);   // the declaration itself
for (const fn of called) {
  if (builtins.has(fn)) continue;
  const defined = new RegExp('(?:^|\\n)\\s*(?:async\\s+)?function\\s+' + fn + '\\s*\\(').test(app);
  check(fn + '() called by the menu is defined', defined, defined ? '' : 'ReferenceError on click');
}
check('the non-existent toggleHistoryFavorite is no longer called', !/toggleHistoryFavorite\s*\(/.test(app));
check('the stale source_url field is no longer read', !/row\.source_url/.test(app));

// Endpoints.
for (const ep of [...new Set([...menu.matchAll(/API\s*\+\s*'(\/[a-z0-9\-/]+)/g)].map((m) => m[1]))]) {
  check('endpoint ' + ep + ' exists in server.js', new RegExp("app\\.(get|post)\\('" + ep.replace(/\//g, '\\/') + "'").test(server));
}

// Translation keys. t(key) returns the KEY ITSELF when a translation is
// missing (`|| T.en[key] || key`), so the `t('x') || 'Fallback'` pattern used
// all through this menu can never reach its fallback - a missing key shows
// the raw key name as the toast. The only real guard is the key existing.
for (const k of [...new Set([...code.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))]) {
  const count = (app.match(new RegExp('\\b' + k + "\\s*:\\s*'", 'g')) || []).length;
  check("translation '" + k + "' exists in both languages", count >= 2, count + ' found');
}

// Failures must be visible, not silent.
check('Show in folder reports a missing folder', /folderMissing/.test(menu) && /\.then\(\(r\) => \{ if \(!r\.ok\)/.test(menu));
check('Copy source URL reports a clipboard failure', /copyFailed/.test(menu));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
