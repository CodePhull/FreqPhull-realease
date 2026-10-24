// Round 82: the engine-repair loop (Sentry ELECTRON-4).
//
// The real event: scikit-learn failed with "numpy.dtype size changed, may
// indicate binary incompatibility. Expected 96 from C header, got 88" and
// repair reinstalled scikit-learn alone, so verification failed again on
// every launch (5 events, 0.7.38 and 0.7.41).
//
// Runs the real verify_engines.py with planted fake modules (PYTHONPATH
// puts them ahead of anything installed):
//   - a scikit-learn that raises the exact error from the event -> the whole
//     numeric stack is marked for repair, numpy_abi_mismatch is set;
//   - an ordinary import failure -> only that package, no ABI flag;
//   - a module in the per-user site folder -> listed in user_site_modules.
// Plus static checks that repair uses them. Skipped without Python.
//
// Run:  node tools/test-verify-engines-r82.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── Static ──
const sj = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const ps = fs.readFileSync(path.join(ROOT, 'installer', 'setup-engines.ps1'), 'utf8');
check('repair passes -PipUser when broken modules load from the per-user folder', sj.includes("repairArgs.push('-PipUser');"));
check('setup-engines.ps1 accepts -PipUser and adds --user', /\[switch\] \$PipUser/.test(ps) && ps.includes('if ($PipUser) { $repairArgs += "--user"'));
check('repair still installs every package in one pip call', ps.includes('Invoke-PipInstall -Packages $pkgList -Label "repair" -ExtraArgs $repairArgs'));
check('a repeat failure reports numpy version, ABI flag and module files',
  sj.includes('numpy_abi_mismatch: !!v.numpy_abi_mismatch') && sj.includes('module_files:'));

function findPython() {
  for (const cand of [process.env.FREQPHULL_TEST_PYTHON, 'python', 'py', 'python3']) {
    if (!cand) continue;
    try {
      const r = spawnSync(cand, ['--version'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && /Python 3/.test((r.stdout || '') + (r.stderr || ''))) return cand;
    } catch {}
  }
  return null;
}
const py = findPython();
if (!py) {
  console.log('  skip runtime checks: no Python 3 found (set FREQPHULL_TEST_PYTHON)');
} else {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-verify-'));
  const fake = path.join(work, 'fake');
  const mk = (dir, name, body) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, '__init__.py'), body); };
  const run = (env) => {
    const r = spawnSync(py, [path.join(ROOT, 'verify_engines.py')], { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, env), timeout: 120000 });
    try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { return { _raw: r.stdout, _err: r.stderr }; }
  };
  try {
    // 1. The exact error from ELECTRON-4.
    mk(fake, 'sklearn', 'raise ValueError("numpy.dtype size changed, may indicate binary incompatibility. Expected 96 from C header, got 88 from PyObject")\n');
    let j = run({ PYTHONPATH: fake });
    const sk = j.tiers && j.tiers.core && j.tiers.core.modules.sklearn;
    check('the ELECTRON-4 error is caught as a failed import', sk && sk.ok === false && /dtype size changed/.test(sk.error || ''), sk && sk.error);
    check('it is flagged as a numpy binary mismatch', j.numpy_abi_mismatch === true);
    const bp = j.broken_packages || [];
    check('the whole numeric stack is marked for repair (not just scikit-learn)',
      bp.includes('numpy>=1.24,<2.1') && bp.includes('scipy>=1.10') && bp.includes('scikit-learn>=1.3'), JSON.stringify(bp));
    check('no package is listed twice', new Set(bp).size === bp.length);
    check('the failing module\'s location is reported', sk && sk.file && sk.file.startsWith(fake), sk && sk.file);

    // 2. An ordinary failure stays narrow.
    fs.rmSync(path.join(fake, 'sklearn'), { recursive: true, force: true });
    mk(fake, 'soundfile', 'raise OSError("cannot load library libsndfile.dll")\n');
    j = run({ PYTHONPATH: fake });
    check('an ordinary failure is not treated as a numpy mismatch', j.numpy_abi_mismatch === false);
    check('...and repairs only that package', (j.broken_packages || []).includes('soundfile>=0.12') && !(j.broken_packages || []).includes('numpy>=1.24,<2.1'), JSON.stringify(j.broken_packages));

    // 3. A copy in the per-user site folder.
    const ub = path.join(work, 'userbase');
    const us = spawnSync(py, ['-c', 'import site;print(site.getusersitepackages())'], { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONUSERBASE: ub }) }).stdout.trim();
    fs.rmSync(path.join(fake, 'soundfile'), { recursive: true, force: true });
    mk(us, 'mutagen', '__version__ = "0.0-test"\n');
    j = run({ PYTHONUSERBASE: ub, PYTHONPATH: '' });
    check('a module loading from the per-user folder is listed', (j.user_site_modules || []).includes('mutagen'), JSON.stringify(j.user_site_modules) + ' user_site=' + j.user_site);
    check('numpy version is reported', 'numpy_version' in j);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
