// Regression test for the Round 75 "Pick a beat" overflow fix.
//
// The bug: .rb-card is a column flex container with align-items:center, so
// every direct child shrink-to-fits unless it declares a width. .rb-transport,
// .rb-seek-row and .rb-actions all set width:100%. #rb-normal-transport - the
// wrapper added later, when record mode got its own transport - did not, and
// had no CSS rule at all. It therefore sized to its widest MAX-CONTENT child.
// Its children include the picker rows, whose untruncated beat titles run to
// hundreds of pixels ("(free) Don Toliver x Travis Scott x Sapjer type beat
// 'lettherebelight' (Prod. Sapjer)"), so the wrapper grew past the card's
// 552px content box and the whole transport block - picker panel and seek bar
// alike - spilled out over the card's rounded border.
//
// This is a static source guard. Layout lives in an Electron renderer and
// there is no headless browser here to measure a rendered box (the same
// limitation Rounds 59/68/70/73 hit), but what CAN be pinned down exactly is
// that the wrapper still declares a width, and that the siblings it has to
// agree with still declare theirs.
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── The fix itself ──
const rule = html.match(/#rb-normal-transport\{([^}]*)\}/);
check('Round 75: #rb-normal-transport has a CSS rule at all (it had none, which is what caused the overflow)',
  !!rule);
if (rule) {
  check('Round 75: it declares width:100% so it fills the card instead of sizing to its widest beat title',
    /width:\s*100%/.test(rule[1]), rule[1]);
  check('Round 75: it declares min-width:0 so long titles ellipsis instead of pushing the box wider',
    /min-width:\s*0/.test(rule[1]), rule[1]);
}

// ── The premise the fix depends on ──
// If .rb-card ever stops centring its children, the width:100% above becomes
// redundant rather than load-bearing - worth knowing, not worth failing over,
// so this asserts the shape the fix was reasoned against.
const card = html.match(/\.rb-card\{([^}]*)\}/);
check('sanity: .rb-card is still a column flex container', !!card && /flex-direction:\s*column/.test(card[1]));
check('sanity: .rb-card still centres its children (this is WHY an undeclared width collapses)',
  !!card && /align-items:\s*center/.test(card[1]));

// Siblings must keep declaring width, or they regress the same way.
for (const sel of ['rb-transport', 'rb-seek-row', 'rb-actions']) {
  const m = html.match(new RegExp('\\.' + sel + '\\{([^}]*)\\}'));
  check('sanity: .' + sel + ' still declares width:100% (same requirement, same reason)',
    !!m && /width:\s*100%/.test(m[1]));
}

// ── The panel must stay inside the wrapper, or the fix does not apply to it ──
const wrapIdx = html.indexOf('<div id="rb-normal-transport">');
const panelIdx = html.indexOf('id="rb-picker-panel"');
const actionsIdx = html.indexOf('id="rb-actions-row"');
check('Round 75: the picker panel is still inside #rb-normal-transport (the element the width fix applies to)',
  wrapIdx !== -1 && panelIdx > wrapIdx && actionsIdx > panelIdx);

// ── The row-level shrink that lets titles ellipsis ──
const meta = html.match(/\.rb-picker-meta\{([^}]*)\}/);
check('Round 75: .rb-picker-meta keeps min-width:0, without which a long title cannot shrink at all',
  !!meta && /min-width:\s*0/.test(meta[1]));
// Must match the STANDALONE .rb-picker-title rule, not a descendant selector
// that happens to end with it. Round 75 added
//     .rb-picker-row.current .rb-picker-title{color:var(--white)}
// which sits earlier in the file, so an unanchored search found that instead
// and reported the real (correct) rule as missing its truncation.
const title = html.match(/(?:^|[}\n;])\s*\.rb-picker-title\s*\{([^}]*)\}/);
check('Round 75: .rb-picker-title still truncates rather than wrapping or pushing',
  !!title && /text-overflow:\s*ellipsis/.test(title[1]) && /overflow:\s*hidden/.test(title[1]),
  title ? title[1] : 'rule not found');

console.log('');
if (fails) { console.log(`✗ ${fails} picker-layout check(s) failed`); process.exit(1); }
console.log('✓ picker-layout: all checks passed');
