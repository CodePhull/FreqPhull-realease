// UI overflow risk scanner.
//
// Two real bugs this round came from the same mistake, so it is worth
// finding the rest mechanically rather than waiting for each to be noticed:
//
//   Round 75  the "Pick a beat" panel hung outside its card, because
//             #rb-normal-transport sat in an align-items:center column and
//             declared no width, so it sized to its widest MAX-CONTENT child
//             (an untruncated beat title) instead of to the card.
//   Round 79  the history batch bar pushed the whole page sideways, because
//             .hb-right held eight buttons in a flex row with no flex-wrap.
//             Flex items do not shrink below their content width unless
//             min-width:0 says they may, and with nowhere to wrap the row
//             simply grew past its container.
//
// What this flags:
//   A) flex ROWS with no flex-wrap and no min-width:0 - cannot wrap, cannot
//      shrink, so they overflow once their content exceeds the container.
//      Ranked by how many buttons sit inside them in the markup, because a
//      two-item row is rarely a problem and an eight-item row always is.
//   B) children of an align-items:center COLUMN that declare no width - the
//      Round 75 shape exactly.
//   C) hard pixel widths/min-widths big enough to overflow a narrow window.
//
// It is a heuristic, not a renderer. Everything it prints needs a human to
// decide on - plenty of flex rows hold two short items and will never
// overflow. Treat it as "look at these", not "these are broken".
//
// Run:  node tools/scan-overflow-risk.js
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'renderer', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

// Line number for a character offset, so findings are jump-to-able.
function lineOf(idx) { return html.slice(0, idx).split('\n').length; }

// ── Pull every CSS rule out of the <style> blocks ──
const rules = [];
const ruleRe = /([^{}@\/]+)\{([^{}]*)\}/g;
let m;
while ((m = ruleRe.exec(html)) !== null) {
  const sel = m[1].trim().replace(/\s+/g, ' ');
  const body = m[2].trim();
  if (!sel || sel.startsWith('<') || sel.includes('<') || !body) continue;
  if (!/[.#a-zA-Z*\[:]/.test(sel[0])) continue;
  rules.push({ sel, body, line: lineOf(m.index) });
}

// The leading (?:^|[;{\s]) matters: without it, asking for `width` also
// matches the `width` inside `max-width:` and `min-width:`. That produced two
// false positives on the first run - .tab-pane and .sp-fv-mini-player were
// both reported as having hard 700px+ widths when one is max-width:1080px and
// the other pairs width:760px with max-width:calc(100vw - 28px). Both are
// correctly constrained; the scanner was wrong, not the CSS.
function propRe(prop, tail) {
  return new RegExp('(?:^|[;{\\s])' + prop.replace(/-/g, '\\-') + '\\s*:' + (tail || ''));
}
const has = (body, prop) => propRe(prop).test(body);
const val = (body, prop) => {
  const mm = body.match(propRe(prop, '\\s*([^;]+)'));
  return mm ? mm[1].trim() : null;
};

// Rough count of buttons inside the element a class/id belongs to. Finds the
// opening tag in the markup then counts <button> until the nesting closes.
// Approximate on purpose - it only needs to separate "a couple" from "loads".
function childButtonCount(sel) {
  const name = sel.replace(/^[.#]/, '').split(/[ :.>,\[]/)[0];
  // Only a plain class/id identifier can be looked up in the markup. Anything
  // else - `*`, attribute selectors, pseudo-elements - either has no single
  // element to count or would inject regex metacharacters into the pattern
  // below. `*` in particular produced \b*\b, which is not a valid regex and
  // took the whole scan down.
  if (!/^[A-Za-z][\w-]*$/.test(name || '')) return 0;
  const openRe = new RegExp('<(\\w+)[^>]*(?:class="[^"]*\\b' + name + '\\b[^"]*"|id="' + name + '")[^>]*>');
  const om = html.match(openRe);
  if (!om) return 0;
  const start = html.indexOf(om[0]) + om[0].length;
  const slice = html.slice(start, start + 6000);
  // Stop at the point nesting returns to zero.
  let depth = 1, end = slice.length;
  const tagRe = /<(\/?)div\b[^>]*>/g;
  let t;
  while ((t = tagRe.exec(slice)) !== null) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) { end = t.index; break; }
  }
  return (slice.slice(0, end).match(/<button\b/g) || []).length;
}

const findings = { A: [], B: [], C: [] };

for (const r of rules) {
  const display = val(r.body, 'display') || '';
  const isFlex = /\bflex\b/.test(display);
  const dir = val(r.body, 'flex-direction') || 'row';

  // ── A. unwrappable, unshrinkable flex rows ──
  if (isFlex && !/column/.test(dir)) {
    const wraps = /wrap/.test(val(r.body, 'flex-wrap') || '') || /wrap/.test(val(r.body, 'flex-flow') || '');
    const canShrink = /min-width\s*:\s*0/.test(r.body);
    if (!wraps && !canShrink) {
      const btns = childButtonCount(r.sel);
      findings.A.push({ sel: r.sel, line: r.line, btns });
    }
  }

  // ── B. Round 75 shape: centred column parent ──
  if (isFlex && /column/.test(dir) && /align-items\s*:\s*center/.test(r.body)) {
    findings.B.push({ sel: r.sel, line: r.line });
  }

  // ── C. hard widths that a narrow window cannot honour ──
  // A fixed width paired with a max-width cap is fine - the cap is what the
  // element actually honours on a narrow window. Only an UNCAPPED fixed width
  // can overflow, so skip anything that also declares max-width.
  const capped = has(r.body, 'max-width');
  if (!capped) {
    for (const prop of ['width', 'min-width']) {
      const v = val(r.body, prop);
      if (!v) continue;
      const px = v.match(/^(\d{3,})px$/);
      if (px && parseInt(px[1], 10) >= 700) {
        findings.C.push({ sel: r.sel, line: r.line, prop, value: v });
      }
    }
  }
}

console.log('UI overflow risk scan — renderer/index.html');
console.log('(' + rules.length + ' CSS rules parsed)\n');

console.log('── A. flex rows that can neither wrap nor shrink ──');
console.log('   ranked by buttons inside; these overflow once content exceeds the container\n');
findings.A.sort((a, b) => b.btns - a.btns);
const riskyA = findings.A.filter(f => f.btns >= 3);
if (!riskyA.length) console.log('   none holding 3+ buttons');
for (const f of riskyA) {
  console.log('   ' + String(f.btns).padStart(2) + ' buttons  line ' + String(f.line).padEnd(6) + f.sel);
}
const quietA = findings.A.length - riskyA.length;
console.log('\n   (' + quietA + ' more with 0-2 buttons - usually fine, listed with --all)');
if (process.argv.includes('--all')) {
  for (const f of findings.A.filter(x => x.btns < 3)) {
    console.log('      ' + String(f.btns) + '  line ' + String(f.line).padEnd(6) + f.sel);
  }
}

console.log('\n── B. centred flex columns (children need an explicit width) ──');
console.log('   this is the shape that broke the Pick-a-beat panel: any child of');
console.log('   one of these that does NOT declare width:100% will collapse to');
console.log('   its widest max-content child\n');
if (!findings.B.length) console.log('   none');
for (const f of findings.B) console.log('   line ' + String(f.line).padEnd(6) + f.sel);

console.log('\n── C. hard pixel widths >= 700px ──');
if (!findings.C.length) console.log('   none');
for (const f of findings.C) {
  console.log('   line ' + String(f.line).padEnd(6) + f.sel + '  {' + f.prop + ': ' + f.value + '}');
}

console.log('\nNothing here is automatically a bug - a flex row with two short');
console.log('labels will never overflow. The button count is the signal: the two');
console.log('real bugs this round had eight buttons and an untruncated title.');
