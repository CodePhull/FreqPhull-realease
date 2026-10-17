// Round 80 memory: the history-row reconciliation leak, plus the memory
// report's renderer inventory.
//
// The leak, as measured in a real heap snapshot (141 MB):
//   Detached HTMLDivElement x14651, Detached HTMLImageElement x2093,
//   Detached V8EventHandlerNonNull x2093, Detached SVGSVGElement x4186,
//   Detached HTMLButtonElement x6279 - i.e. exactly one complete detached
//   copy of ~2,093 history rows.
//
// Cause: when a row's fingerprint changed, _renderHistoryImpl() built a
// throwaway `fresh` copy of the row and then did
//     existingEl.onclick = fresh.onclick;
//     existingEl.ondblclick = fresh.ondblclick;
// Those are INLINE handlers compiled from fresh's own attributes, and an
// inline handler is compiled with its source element in scope - so the live
// row ended up holding a function that kept the entire throwaway subtree
// alive. Tag hydration changes every row's fingerprint, so every row did it.
//
// This cannot be exercised headlessly (no DOM in the test runner), so it is
// guarded structurally, the same way Rounds 59/68/70/73/75 guard renderer
// behaviour: the leaking shape must be absent and the fixed shape present.
//
// Run:  node tools/test-history-leak-r80.js
'use strict';
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

console.log('Round 80 - history row leak + memory report inventory\n');

// ── The leak ─────────────────────────────────────────────────────────────
const impl = app.slice(app.indexOf('function _renderHistoryImpl('), app.indexOf('async function hydrateAllHistoryTags('));
check('located _renderHistoryImpl()', impl.length > 1000);

// Any assignment of a handler property FROM another element is the leak
// shape, whichever handler it is - not just the two that leaked this time.
const leakRe = /\.\s*on[a-z]+\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*on[a-z]+\b/g;
const leaks = impl.match(leakRe) || [];
check('no handler property is copied from one element to another', leaks.length === 0, leaks.join(' | '));
check('row handlers are synced as attribute text',
      /fresh\.getAttribute\(attr\)/.test(impl) && /existingEl\.setAttribute\(attr, src\)/.test(impl));
check('a handler the fresh row lacks is removed, not left stale',
      /existingEl\.removeAttribute\(attr\)/.test(impl));
check('both handlers that flip with select mode are covered',
      /\[\s*'onclick'\s*,\s*'ondblclick'\s*\]/.test(impl));

// Same shape anywhere else in the renderer would leak the same way.
const allLeaks = app.match(leakRe) || [];
check('no handler-property copy anywhere in app.js', allLeaks.length === 0, allLeaks.join(' | '));

// ── Memory report inventory ──────────────────────────────────────────────
console.log('');
check('memory report reads the page\'s own state', /RENDERER_INVENTORY_JS/.test(main) && /executeJavaScript\(RENDERER_INVENTORY_JS/.test(main));
for (const name of ['audioBuf', 'svState', 'rbReviewBeatBuf', 'rbReviewVocalBuf', 'rbGraphOriginalVocalBuf', 'rbRecChunks']) {
  // Each one must still exist in app.js, or the inventory silently reports
  // it absent forever after a rename.
  // Multi-declarations count: audioBuf lives in
  // `let audioCtx=null,audioBuf=null,srcNode=null,gainNode=null;`.
  const declared = new RegExp('^(let|const|var)\\s[^;\\n]*\\b' + name + '\\b', 'm').test(app);
  check('inventory names ' + name + ' and app.js still declares it at top level',
        main.includes(name) && declared);
}
check('a hung page cannot hang the report (3s timeout)', /setTimeout\(\(\) => r\(null\), 3000\)/.test(main));
check('buildMemoryReport is awaited by both callers',
      /async function buildMemoryReport/.test(main) &&
      /await buildMemoryReport\(\)/.test(main) && /buildMemoryReport\(\)\.then\(/.test(main));
check('app.js is still a classic script (top-level names reachable)',
      /<script src="app\.js" defer><\/script>/.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
