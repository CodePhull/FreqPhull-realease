// Round 82 (second audit): two matching bugs found by running the real app.
//
// 1. The silent history repair (runs ~3 s after every launch) relinked
//    missing tracks to wrong files: in a smoke run, "Beat 5", "Beat 8" and
//    "Beat 9" were all relinked to ONE unrelated file in Downloads. "Beat 5"
//    tokenizes to {beat}, a 100% coverage match for any file with "beat" in
//    its name, and nothing stopped several rows claiming one file.
//    -> REPAIR MATCH GUARD (server.js): auto-apply only unique, unused files,
//       and fuzzy matches only with >= 2 distinctive shared words.
// 2. Two top-level functions were both named normalizeForMatch; the later
//    (repair) one silently replaced the artist matcher's, which splits
//    accented names ("Drakéo" -> "drak o"). Measured 12/12 vs 10/12.
//    -> the artist one is normalizeArtistText; a general guard below fails
//       on any duplicate top-level function name.
//
// Run:  node tools/test-match-guards-r82.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const fnText = (name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  return src.slice(i, src.indexOf('\n}\n', i) + 3);
};

// ── 1. Repair guard ──
const gi = src.indexOf('// ─── BEGIN REPAIR MATCH GUARD ───');
const ge = src.indexOf('// ─── END REPAIR MATCH GUARD ───');
if (gi < 0 || ge < 0) throw new Error('REPAIR MATCH GUARD markers not found');
const sb = { path: path.win32, String, Set, Map, Object };
vm.createContext(sb);
vm.runInContext(fnText('normalizeForMatch') + fnText('tokenize') + fnText('tokenCoverage') + src.slice(gi, ge) +
  '\nthis.g = { decideRepairs, strongSharedTokens, tokenize, tokenCoverage };', sb);
const G = sb.g;
const josman = 'C:\\Users\\u\\Downloads\\FREE_Josman_x_Hamza_Type_Beat_-_Freeze_vocal.wav';
const fuzzy = (title, file) => {
  const q = G.tokenize(title);
  return { stage: 'fuzzy', score: G.tokenCoverage(title, path.win32.basename(file)), strong: G.strongSharedTokens(q, path.win32.basename(file)), file: { path: file } };
};
// The measured case.
const beats = ['Beat 5', 'Beat 8', 'Beat 9'].map((t, i) => ({ row: { id: i + 1, title: t }, bestMatch: fuzzy(t, josman) }));
check('gate: "Beat 5" vs the Josman file clears the old 0.70 line (why it was auto-applied)', beats[0].bestMatch.score >= 0.70, beats[0].bestMatch.score.toFixed(2));
let d = G.decideRepairs(beats, new Set());
check('three tracks wanting one file: none applied, all to review', d.apply.length === 0 && d.review.length === 3, d.review.map((r) => r.reason).join(' | '));
d = G.decideRepairs([beats[0]], new Set());
check('a lone generic-word match is not applied either', d.apply.length === 0 && d.review[0].reason === 'only generic words match');
// A genuine moved file still relinks by itself.
const real = { row: { id: 9, title: 'Drake - One Dance' }, bestMatch: fuzzy('Drake - One Dance', 'D:\\Music\\Drake_-_One_Dance_(Official_Audio).mp3') };
d = G.decideRepairs([real], new Set());
check('a real match (2+ distinctive words) is still applied', d.apply.length === 1, 'strong=' + real.bestMatch.strong + ' score=' + real.bestMatch.score.toFixed(2));
d = G.decideRepairs([real], new Set([path.win32.resolve('D:\\Music\\Drake_-_One_Dance_(Official_Audio).mp3').toLowerCase()]));
check('...unless that file already belongs to another track', d.apply.length === 0 && d.review[0].reason === 'file already belongs to another track');
const exact = { row: { id: 10, title: 'x' }, bestMatch: { stage: 'exact', score: 1, file: { path: 'E:\\Beats\\old name.wav' } } };
check('an exact filename match is applied (no word test)', G.decideRepairs([exact], new Set()).apply.length === 1);
const wiring = src.slice(src.indexOf("app.post('/repair-history'"), src.indexOf("app.post('/repair-apply'"));
check('the repair route applies only what the guard allows', wiring.includes('const decided = decideRepairs(proposals, inUse);') &&
  !/if \(!reviewMode && bestMatch\.score >= AUTO_APPLY_THRESHOLD\) \{\s*\/\/ Auto-apply\s*try \{\s*dbRun/.test(wiring));

// ── 2. Artist matcher normalizer ──
const ai = src.indexOf('function normalizeArtistText(s) {');
const ae = src.indexOf('// List all folders with track counts.');
check('the artist matcher has its own normalizer', ai > 0 && src.slice(ai, ae).includes('normalizeArtistText(rawSeed)'));
const sb2 = { String, Math, Array, Set };
vm.createContext(sb2);
// Run the artist region together with the repair normalizer, as the whole
// file does - proves the name collision is gone, not just renamed in a copy.
vm.runInContext(src.slice(ai, ae) + '\n' + fnText('normalizeForMatch') + '\nthis.f = findArtistMatch;', sb2);
const cases = [
  ['Drakéo The Ruler Type Beat', 'Drakeo'], ['[FREE] Drakeo The Ruler Type Beat', 'Drakéo'], ['Zoé Type Beat', 'Zoe'],
  ['Beyoncé Type Beat', 'Beyonce'], ['Céline Dion Type Beat', 'Celine Dion'], ['Sleepy_Hallow_Type_Beat', 'Sleepy Hallow'],
  ['EBK Jaayboo type beat', 'EBK Jaybo'], ['Lil-Tecca type beat', 'Lil Tecca'], ['Ninho x Tiakola Type Beat', 'Tiakola'],
];
const misses = cases.filter(([h, s]) => !sb2.f(h, [s]).matched).map(([h, s]) => s + ' / ' + h);
check('accented and punctuated artist names match (' + cases.length + ' cases)', misses.length === 0, misses.join('; '));
check('...and unrelated artists still do not', !sb2.f('Josman Type Beat', ['Ninho']).matched);

// ── 3. General guard: no duplicate top-level function names ──
const dupes = [];
const top = (f) => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
for (const f of ['server.js', 'main.js', 'sentry-init.js', 'updater.js']) {
  const c = {}; for (const n of top(f)) c[n] = (c[n] || 0) + 1;
  for (const [n, k] of Object.entries(c)) if (k > 1) dupes.push(f + ': ' + n);
}
// app.js and daw.js share one page, so a name in both is also a collision.
const pageNames = {};
for (const f of ['renderer/app.js', 'renderer/daw.js']) for (const n of top(f)) pageNames[n] = (pageNames[n] || 0) + 1;
for (const [n, k] of Object.entries(pageNames)) if (k > 1) dupes.push('renderer page: ' + n);
check('gate: the scan sees a duplicate when there is one', (() => { const c = {}; for (const n of ['a', 'b', 'a']) c[n] = (c[n] || 0) + 1; return Object.values(c).some((k) => k > 1); })());
check('no top-level function is defined twice (the later one would silently win)', dupes.length === 0, dupes.join(', '));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
