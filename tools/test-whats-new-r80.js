// Round 80: the "what's new" page appears once per genuine update - never
// on every launch.
//
// It used to open whenever the running version DIFFERED from the last run.
// Two builds sharing one data folder (a test build next to the installed
// one, or a rollback) flipped that on every launch. This runs the real
// decision function from main.js against every launch sequence that matters.
//
// Run:  node tools/test-whats-new-r80.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}
console.log('Round 80 - what\'s new shows once per real update\n');

const block = main.slice(main.indexOf('// ─── BEGIN WHATS-NEW DECISION ───'), main.indexOf('// ─── END WHATS-NEW DECISION ───'));
check('located the decision block', block.length > 300);
const sb = { String, Math, parseInt };
vm.createContext(sb);
vm.runInContext(block + '\nthis.api = { whatsNewDecision, compareVersions };', sb);
const { whatsNewDecision, compareVersions } = sb.api;

// Simulate launches: returns which launches showed the page.
function launches(seq, initial) {
  let stamp = initial === undefined ? null : initial;
  const shown = [];
  for (const v of seq) {
    const d = whatsNewDecision(stamp, v);
    shown.push(d.show);
    stamp = d.next;
  }
  return shown;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check('version compare is numeric, not text (0.7.10 > 0.7.9)', compareVersions('0.7.10', '0.7.9') > 0);
check('equal versions compare equal', compareVersions('0.7.40', '0.7.40') === 0);

let s = launches(['0.7.40']);
check('first-ever install: nothing shown', eq(s, [false]), JSON.stringify(s));

s = launches(['0.7.39', '0.7.40', '0.7.40', '0.7.40']);
check('update: shown on the FIRST launch after it only', eq(s, [false, true, false, false]), JSON.stringify(s));

// The reported bug: a test build and the installed build, alternating.
s = launches(['0.7.39', '0.7.40', '0.7.39', '0.7.40', '0.7.39', '0.7.40']);
check('two builds alternating: shown once, not every launch', eq(s, [false, true, false, false, false, false]), JSON.stringify(s));

s = launches(['0.7.40', '0.7.39', '0.7.39']);
check('rolling back to an older build: never shown', eq(s, [false, false, false]), JSON.stringify(s));

s = launches(['0.7.39', '0.7.40', '0.7.39', '0.7.41']);
check('a real newer update after a rollback is still announced', eq(s, [false, true, false, true]), JSON.stringify(s));

s = launches(['0.7.40', '0.7.41'], { version: '0.7.39' });
check('old-format stamp (version only) is honoured, no repeat', eq(s, [true, true]), JSON.stringify(s));
s = launches(['0.7.39'], { version: '0.7.39' });
check('old-format stamp at the same version: nothing shown', eq(s, [false]), JSON.stringify(s));

// Wiring.
check('consumeUpdateFlag uses the decision function', /whatsNewDecision\(stamp, current\)/.test(main));
check('the stamp is written before the page is shown', main.indexOf('fs.writeFileSync(stampPath') < main.indexOf('return d.show;'));
check('the page is opened only when consumeUpdateFlag says so',
      /if \(consumeUpdateFlag\(\)\) \{\s*setTimeout\(\(\) => \{\s*try \{ openUpdaterWindow\(\{ phase: 'complete' \}\)/.test(main));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
