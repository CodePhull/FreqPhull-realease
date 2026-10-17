// Round 80: builds must not ship with error reporting silently off.
//
// Sentry held exactly ONE error event from ONE user in 90 days - the
// developer's own install - while real users were hitting errors. The real
// sentry.config.json is gitignored, and the proposed CI step copied the
// .example file, whose placeholder DSN fails sentry-init.js's own format
// check: every CI-built release would have reported nothing, and said nothing.
//
// Run:  node tools/test-sentry-coverage-r80.js
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}
console.log('Round 80 - crash reporting cannot be silently off\n');

const init = read('sentry-init.js');
const fmt = init.match(/\/\^https:\\\/\\\/\[A-Za-z0-9\]\+@\[\\w\.-\]\+\\\/\\d\+\$\//);
check('sentry-init.js still validates the DSN format', !!fmt);
const example = JSON.parse(read('sentry.config.example.json'));
check('the committed example DSN is a placeholder that FAILS that check (so copying it = reporting off)',
      !/^https:\/\/[A-Za-z0-9]+@[\w.-]+\/\d+$/.test(example.dsn || ''));

const yml = read('release.yml.PROPOSED');
check('CI never copies the example config into a release', !/Copy-Item 'sentry\.config\.example\.json' 'sentry\.config\.json'/.test(yml));
check('CI writes the DSN from the SENTRY_DSN secret', /SENTRY_DSN: \$\{\{ secrets\.SENTRY_DSN \}\}/.test(yml));
check('CI validates the secret with the same format as the app', /-match '\^https:\/\/\[A-Za-z0-9\]\+@\[\\w\.-\]\+\/\\d\+\$'/.test(yml));
check('a missing secret raises a visible build warning', /::warning title=Crash reporting OFF::/.test(yml));

const pkg = JSON.parse(read('package.json'));
check('electron-builder still packages sentry.config.json',
      JSON.stringify(pkg.build || {}).includes('sentry.config.json'));

const main = read('main.js');
check('startup log states whether crash reporting is on', /log\('crash reporting: ' \+ \(_sentry \? 'ON'/.test(main));
check('Ctrl+Shift+M report states whether crash reporting is on', /lines\.push\('crash reporting: '/.test(main));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
