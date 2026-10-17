// Round 81: every stem separation died at startup with
// "ModuleNotFoundError: No module named '_phull_internal'".
//
// The embedded runtime the app installs ships a python311._pth; with a ._pth
// present Python builds sys.path only from the folders listed there, never
// the script's own folder. server.js copies stems.py (as freqphull_stems.py)
// and _phull_internal.py side by side into Temp, so the sibling import
// failed. Reproduced with the installed engines\python\python.exe and with
// `python -I`, which drops the script folder the same way.
//
// 1. Static: the script's folder goes onto sys.path BEFORE the import.
// 2. Runtime (when a Python is on PATH): copy both files into a temp folder
//    the way server.js does and run `python -I freqphull_stems.py --help`
//    from a different working directory. The import runs at module load,
//    before argparse, so --help exercises it without torch/audio deps.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'stems.py'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const ins = src.search(/sys\.path\.insert\(0,\s*os\.path\.dirname\(os\.path\.abspath\(__file__\)\)\)/);
const imp = src.search(/^import _phull_internal\b/m);
check('stems.py puts its own folder on sys.path', ins >= 0);
check('...before importing _phull_internal', ins >= 0 && imp > ins, 'insert@' + ins + ' import@' + imp);

// Runtime check, skipped (not failed) when no usable Python is found - the
// static check above is the guard that always runs.
let py = null;
for (const cand of ['python3', 'python', 'py']) {
  const r = spawnSync(cand, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
  if (r.status === 0 && /^3/.test((r.stdout || '').trim())) { py = cand; break; }
}
if (!py) {
  console.log('  skip runtime check: no Python 3 on PATH');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-stems-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'stems.py'), path.join(dir, 'freqphull_stems.py'));
    fs.copyFileSync(path.join(ROOT, '_phull_internal.py'), path.join(dir, '_phull_internal.py'));
    const r = spawnSync(py, ['-I', path.join(dir, 'freqphull_stems.py'), '--help'], { cwd: os.tmpdir(), encoding: 'utf8' });
    const err = (r.stderr || '').trim().split('\n').pop();
    check('isolated-mode Python (like the embedded runtime) gets past the import', r.status === 0 && !/_phull_internal/.test(r.stderr || ''),
      r.status === 0 ? 'exit 0' : 'exit ' + r.status + ': ' + err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
