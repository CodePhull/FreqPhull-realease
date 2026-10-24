// Round 82: the history list is paged.
//
// Measured before/after with the real renderer and server in Electron, on a
// 2,250-track library (the developer's library size): rows in the page
// 2,250 -> 150, elements 40,500 -> 2,700, a full history render 590 ms ->
// 20.5 ms, JS heap 77.6 -> 16.3 MB, renderer working set 347 -> 151 MB.
// Scrolling to the end paged more rows in (150 -> 450 in the run).
//
// Headless: the HISTORY PAGING CORE math, then static wiring for the parts
// that must keep working on the full list (search count, select-all,
// scroll-to-playing, play-state sync).
//
// Run:  node tools/test-history-paging-r82.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const si = app.indexOf('// ─── BEGIN HISTORY PAGING ───');
const ei = app.indexOf('// ─── END HISTORY PAGING ───');
if (si < 0 || ei < 0) throw new Error('HISTORY PAGING markers not found');
const sb = { Math };
vm.createContext(sb);
vm.runInContext(app.slice(si, ei) + '\nthis.p = { HIST_PAGE, histNextLimit, histLimitToShow };', sb);
const { HIST_PAGE, histNextLimit, histLimitToShow } = sb.p;

check('a page is a few screens of rows, not the whole library', HIST_PAGE >= 50 && HIST_PAGE <= 300, String(HIST_PAGE));
check('far from the end: no new page', histNextLimit(150, 2250, 0, 800, 12000, 1200) === 150);
check('near the end: one more page', histNextLimit(150, 2250, 10500, 800, 12000, 1200) === 300);
check('never past the end of the list', histNextLimit(2200, 2250, 99999, 800, 100000, 1200) === 2250);
check('all rows shown: nothing to add', histNextLimit(2250, 2250, 99999, 800, 100000, 1200) === 2250);
check('a short list is never padded', histNextLimit(40, 40, 0, 800, 900, 1200) === 40);
check('row already on the page: limit unchanged', histLimitToShow(150, 10) === 150);
check('row further down: the page grows to include it', histLimitToShow(150, 900) > 900);
check('row not in the filtered list: limit unchanged', histLimitToShow(150, -1) === 150);

const impl = app.slice(app.indexOf('function _renderHistoryImpl('), app.indexOf('async function hydrateAllHistoryTags('));
check('only the first page of the filtered list is drawn', impl.includes('const rows = allRows.slice(0, _histRenderLimit);'));
check('the search count still reports the full list', impl.includes('_updateHistSearchCount(allRows.length, histData.length);'));
check('a new search or filter starts again at the top', impl.includes("if (queryKey !== _histLastQueryKey) { _histLastQueryKey = queryKey; _histRenderLimit = HIST_PAGE; }"));
check('adding a page keeps the rows already drawn (no full rewrite)', impl.includes('> FULL_REWRITE_THRESHOLD && !pagingGrow)'));
check('rows revealed by scrolling don\'t flash as new downloads', impl.includes("if (!pagingGrow) fresh.classList.add('row-pulse');"));
const follow = app.slice(app.indexOf('function _scrollActiveRowIntoView('), app.indexOf('function _scrollActiveRowIntoView(') + 900);
check('following the playing track pages down to it first', follow.includes('histEnsureRowRendered(id);'));
check('select-all works on the full list, not the page', /function toggleCheckAll\(checked\) \{[\s\S]{0,300}histData\.filter/.test(app));
check('scrolling the history tab adds pages', app.includes("if (ticking || lastTab !== 'history') return;") && app.includes('histNextLimit(_histRenderLimit, _histFilteredIds.length'));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
