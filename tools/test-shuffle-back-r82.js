// Round 82: "when using shuffle going to the last track should go back to the
// last track sent u to, not to a new track, and next track is random".
// Before: with shuffle on, ← played index-1 of the list - after a random jump
// that is an unrelated track. SHUFFLE HISTORY CORE (renderer/app.js) keeps the
// tracks shuffle left; ← walks back through them, → stays random.
//
// Run:  node tools/test-shuffle-back-r82.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const bi = src.indexOf('// ─── BEGIN SHUFFLE HISTORY CORE');
const ei = src.indexOf('// ─── END SHUFFLE HISTORY CORE');
if (bi < 0 || ei < 0) throw new Error('SHUFFLE HISTORY CORE markers not found');
const sb = { Math };
vm.createContext(sb);
vm.runInContext(src.slice(bi, ei) + '\nthis.push=shuffleBackPush;this.pop=shuffleBackPop;this.pick=shufflePickNext;this.MAX=SHUFFLE_BACK_MAX;', sb);

// Simulated player: same steps as globalPlayerNext / globalPlayerPrev.
const tracks = Array.from({ length: 50 }, (_, i) => ({ id: 1000 + i }));
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
function session(prevFn) {
  const stack = []; let idx = 3; const heard = [idx];
  const next = () => { const n = sb.pick(tracks.length, idx, rand); sb.push(stack, tracks[idx].id); idx = n; heard.push(idx); };
  for (let i = 0; i < 6; i++) next();
  const back = [];
  for (let i = 0; i < 6; i++) { idx = prevFn(stack, idx); back.push(idx); }
  return { heard, back };
}
const fixed = session((stack, idx) => { const i = sb.pop(stack, tracks, idx); return i < 0 ? idx : i; });
const expected = fixed.heard.slice(0, -1).reverse();
check('← retraces the shuffled tracks in reverse', JSON.stringify(fixed.back) === JSON.stringify(expected),
  'heard ' + fixed.heard.join(',') + ' / back ' + fixed.back.join(','));
// Sanity gate: the old ← (index-1) must fail the same check.
seed = 7;
const old = session((stack, idx) => Math.max(0, idx - 1));
check('gate: old index-1 behaviour fails it', JSON.stringify(old.back) !== JSON.stringify(old.heard.slice(0, -1).reverse()),
  'old back ' + old.back.join(','));

check('nothing to go back to → -1', sb.pop([], tracks, 0) === -1);
const s2 = [1000, 9999, 1001]; // 9999 not in the list (deleted / other playlist)
check('skips tracks no longer in the list', sb.pop(s2, tracks, 5) === 1 && sb.pop(s2, tracks, 5) === 0 && sb.pop(s2, tracks, 5) === -1);
const s3 = []; sb.push(s3, 1); sb.push(s3, 1); sb.push(s3, null);
check('no duplicate or empty entries', s3.length === 1);
const s4 = []; for (let i = 0; i < 500; i++) sb.push(s4, i);
check('history capped', s4.length === sb.MAX && s4[s4.length - 1] === 499);

// → stays random, never the current track, every track reachable, uniform
const counts = new Array(10).fill(0); let sameAsCur = 0;
for (let i = 0; i < 90000; i++) { const n = sb.pick(10, 4, Math.random); if (n === 4) sameAsCur++; counts[n]++; }
const others = counts.filter((_, i) => i !== 4);
check('→ never repeats the current track', sameAsCur === 0);
check('→ uniform over the other tracks', Math.min(...others) > 9400 && Math.max(...others) < 10600, others.join(','));
check('→ edge indices reachable', sb.pick(2, 0, () => 0.99) === 1 && sb.pick(2, 1, () => 0) === 0);

// Wiring: both player paths use the history, every shuffled move forward records it
const fn = (name) => { const i = src.indexOf('function ' + name + '('); return src.slice(i, src.indexOf('\n}\n', i)); };
const prev = fn('globalPlayerPrev'), next = fn('globalPlayerNext'), end = fn('pickNextTrackAfterEnd');
check('← (Analyzer and mini player) uses shuffle history', (prev.match(/shuffleBackPop\(/g) || []).length === 2);
check('→ (both paths) records and picks randomly', (next.match(/shuffleBackPush\(/g) || []).length === 2 && (next.match(/shufflePickNext\(/g) || []).length === 2);
check('track end records and picks randomly', /shuffleBackPush\(/.test(end) && /shufflePickNext\(/.test(end));
check('a track picked by hand is recorded', /shuffleBackPush\(shuffleBack, currentHistId\)/.test(fn('playFromHistory')));
check('no retry loop left for random picks', !/while \(nextIdx === /.test(src));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall shuffle-back checks passed');
process.exit(fails ? 1 : 0);
