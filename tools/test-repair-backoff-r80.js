// Round 80: automatic engine repair no longer retries on every launch.
//
// "At most once per session" meant once per LAUNCH. On a machine where
// repair can never succeed (antivirus deleting the package back out, missing
// VC++ runtime, pip landing in another interpreter), every launch reinstalled
// the broken packages in the background and sent another
// "repair ran but verification still fails" Sentry report.
//
// This runs the REAL backoff block from server.js (extracted between its
// BEGIN/END markers) against a throwaway home directory, then checks the
// wiring in attemptEngineRepair() structurally.
//
// Run:  node tools/test-repair-backoff-r80.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}
console.log('Round 80 - engine repair backoff\n');

const block = src.slice(src.indexOf('// ─── BEGIN REPAIR BACKOFF ───'), src.indexOf('// ─── END REPAIR BACKOFF ───'));
check('located the backoff block', block.length > 500);

// Sandbox with a fake home dir and a controllable clock + version.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-repair-'));
let now = Date.UTC(2026, 8, 28);
function load(version) {
  const sb = {
    fs, path, JSON, String, Math,
    os: { homedir: () => home },
    Date: { now: () => now },
    _serverVersion: version,
  };
  vm.createContext(sb);
  vm.runInContext(block + '\nthis.api = { readRepairState, writeRepairState, clearRepairState, repairSuppressedReason, REPAIR_BACKOFF_DAYS, REPAIR_STATE_PATH };', sb);
  return sb.api;
}

let a = load('0.7.40');
check('state lives next to the engines marker', /freqphull[\\/]engines-repair-state\.json$/.test(a.REPAIR_STATE_PATH));
check('no record -> automatic repair allowed', a.repairSuppressedReason(['torch'], 'startup-verify') === null);

a.writeRepairState(['torch', 'demucs'], 'still broken after repair');
check('after a failure, the same break is NOT auto-retried',
      typeof a.repairSuppressedReason(['demucs', 'torch'], 'startup-verify') === 'string');
check('package order does not matter to the match',
      a.repairSuppressedReason(['torch', 'demucs'], 'startup-verify') !== null);
check('Settings -> Repair (manual) is never blocked',
      a.repairSuppressedReason(['torch', 'demucs'], 'manual') === null);
check('a DIFFERENT set of broken packages gets a fresh attempt',
      a.repairSuppressedReason(['whisper'], 'startup-verify') === null);

a.writeRepairState(['torch', 'demucs'], 'still broken after repair');
check('repeated failures are counted', a.readRepairState().failures === 2, 'failures=' + a.readRepairState().failures);

const b = load('0.7.41');
check('an app UPDATE lifts the suppression', b.repairSuppressedReason(['torch', 'demucs'], 'startup-verify') === null);

now += (a.REPAIR_BACKOFF_DAYS - 0.5) * 86400000;
check('still suppressed just inside the backoff window', a.repairSuppressedReason(['torch', 'demucs'], 'startup-verify') !== null);
now += 1 * 86400000;
check('suppression expires after REPAIR_BACKOFF_DAYS', a.repairSuppressedReason(['torch', 'demucs'], 'startup-verify') === null);

a.clearRepairState();
check('clearing the record allows repair again', a.repairSuppressedReason(['torch', 'demucs'], 'startup-verify') === null);
a.clearRepairState();
check('clearing twice does not throw', true);

fs.writeFileSync(a.REPAIR_STATE_PATH, '{not json');
check('a corrupt record is ignored, not fatal', a.repairSuppressedReason(['torch'], 'startup-verify') === null);

// ── Wiring in attemptEngineRepair ────────────────────────────────────────
console.log('');
const fn = src.slice(src.indexOf('function attemptEngineRepair('), src.indexOf('// Startup self-check'));
const iSup = fn.indexOf('repairSuppressedReason(brokenPackages, origin)');
const iLatch = fn.indexOf('_repairAttemptedThisSession = true');
check('suppression is checked BEFORE the session latch is set', iSup > 0 && iLatch > iSup,
      'otherwise a skipped repair would still burn the one per-launch attempt');
check('a verified-clean repair clears the record', /if \(v\.ok\) \{\s*clearRepairState\(\);/.test(fn));
check('still-broken-after-repair is recorded', /writeRepairState\(brokenPackages, 'still broken after repair'\)/.test(fn));
check('a failed repair process is recorded', /writeRepairState\(brokenPackages, sawError \|\| \('repair exited ' \+ code\)\)/.test(fn));
check('a repair that cannot even start is recorded', /writeRepairState\(brokenPackages, 'could not start repair: '/.test(fn));
check('startup finding engines healthy clears the record',
      /if \(v\.ok\) \{ clearRepairState\(\); slog\('startup verify: engines healthy'\)/.test(src));

// ── Repair targets the interpreter that verification ran under ───────────
// Sentry ELECTRON-4: the server verified with system `py` while the setup
// script chose its own interpreter by different rules, so repairs landed in
// an interpreter nobody checked.
console.log('');
const ps1 = fs.readFileSync(path.join(__dirname, '..', 'installer', 'setup-engines.ps1'), 'utf8');
check('server passes the verified sys.executable to the repair',
      /const verifiedExe = _lastVerifyResult && _lastVerifyResult\.executable;/.test(fn) &&
      /repairArgs\.push\('-PythonExe', String\(verifiedExe\)\)/.test(fn));
check('only an absolute path that exists is passed', /path\.isAbsolute\(String\(verifiedExe\)\) && fs\.existsSync\(verifiedExe\)/.test(fn));
check('verify_engines.py still reports sys.executable',
      /"executable":\s*sys\.executable/.test(fs.readFileSync(path.join(__dirname, '..', 'verify_engines.py'), 'utf8')));
check('setup-engines.ps1 accepts -PythonExe', /\[string\]\s*\$PythonExe\s*=/.test(ps1));
const iPin = ps1.indexOf('if ($Repair -and $PythonExe)');
const iEmbed = ps1.indexOf('elseif (Test-EmbeddedRuntime)');
check('-PythonExe is honoured BEFORE embedded/system discovery', iPin > 0 && iEmbed > iPin,
      'discovery must not override the pinned interpreter');
check('a pinned interpreter skips discovery (the chain starts with "if ($pythonCmd)")',
      /if \(\$pythonCmd\) \{[\s\S]{0,200}\} elseif \(Test-EmbeddedRuntime\)/.test(ps1));
check('the Sentry report names both interpreters', /verified_with:/.test(fn) && /repaired_into:/.test(fn));

fs.rmSync(home, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
