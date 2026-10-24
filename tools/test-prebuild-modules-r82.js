// Round 82: the installed 0.7.42 never started its server - "sentry.
// setOptOutFile is not a function", 5 crashes, give up. The live repo had
// kept an old sentry-init.js (13 Aug) next to the new server.js, and the
// build passed. prebuild.js now stops the build when server.js or main.js
// call a sentry.<fn>() that the packaged sentry-init.js does not export.
//
// This runs that block of prebuild.js against a folder holding the old
// sentry-init.js (must abort) and the current one (must pass).
//
// Run:  node tools/test-prebuild-modules-r82.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const pre = fs.readFileSync(path.join(ROOT, 'prebuild.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const s = pre.indexOf('// ── Modules from the same version');
const e = pre.indexOf('// ── Generate integrity manifest');
if (s < 0 || e < 0) throw new Error('module check block not found in prebuild.js');
const block = pre.slice(s, e);

// The 13 Aug sentry-init.js had no opt-out functions. Modelled from the
// current file with them removed (the real old file is in the live repo).
const OLD_SENTRY = "module.exports = { init(){}, scrubString(){}, scrubObject(){}, reportSoftError(){}, addTrail(){}, getInstallId(){}, setStateProvider(){} };\n";

function run(sentrySource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-prebuild-'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  fs.copyFileSync(path.join(ROOT, 'main.js'), path.join(dir, 'main.js'));
  fs.writeFileSync(path.join(dir, 'sentry-init.js'), sentrySource);
  const out = [];
  let exitCode = null;
  const sb = {
    fs, path, projRoot: dir,
    require: (id) => require(path.join(dir, id)),
    console: { log: (m) => out.push(String(m)), error: (m) => out.push(String(m)) },
    process: { exit: (c) => { exitCode = c; throw new Error('__exit__'); } },
    ok: (m) => out.push('OK ' + m),
  };
  vm.createContext(sb);
  try { vm.runInContext(block, sb); } catch (err) { if (err.message !== '__exit__') throw err; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return { exitCode, text: out.join('\n') };
}

const bad = run(OLD_SENTRY);
check('an old sentry-init.js stops the build', bad.exitCode === 1 && /server\.js calls sentry\.setOptOutFile\(\)/.test(bad.text), bad.text.split('\n').filter((l) => /calls/.test(l)).slice(0, 2).join(' | '));
check('...and says what to do', /copy sentry-init\.js from the same version/.test(bad.text));
const good = run(fs.readFileSync(path.join(ROOT, 'sentry-init.js'), 'utf8'));
check('the current sentry-init.js passes', good.exitCode === null && /OK sentry-init\.js matches/.test(good.text));
check('it runs before the integrity manifest is written', s < e);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall prebuild module checks passed');
process.exit(fails ? 1 : 0);
