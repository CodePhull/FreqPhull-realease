// Round 82: per-stem BPM/key never ran.
//
// stems.py does `import analyze` after separating, but the server copied
// only stems.py and _phull_internal.py into the temp folder, so the import
// always failed and every separation shipped without per-stem readouts,
// silently (ImportError -> skipped).
//
// 1. Static: the /stems route copies analyze.py next to freqphull_stems.py,
//    under the name stems.py imports.
// 2. Runtime (skipped without Python + numpy/scipy): the same three files in
//    a fresh folder, laid out as the route lays them out; the import that
//    stems.py does must resolve, and analyze_stem() must return a BPM for a
//    120 BPM click track.
//
// Run:  node tools/test-stem-analyze-r82.js
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

const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const route = src.slice(src.indexOf("const scriptTmp = path.join(os.tmpdir(), 'freqphull_stems.py');"), src.indexOf("const scriptTmp = path.join(os.tmpdir(), 'freqphull_stems.py');") + 1200);
check('/stems copies analyze.py into the same folder as freqphull_stems.py',
  route.includes("const analyzeTmp = path.join(os.tmpdir(), 'analyze.py');") && route.includes('fs.copyFileSync(analyzeSrc, analyzeTmp);'));
const st = fs.readFileSync(path.join(ROOT, 'stems.py'), 'utf8');
check('stems.py imports it by that name', st.includes('import analyze as _analyzer'));
check('stems.py puts its own folder on sys.path (Round 81)', st.includes('sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))'));

function findPython() {
  for (const cand of [process.env.FREQPHULL_TEST_PYTHON, 'python', 'py', 'python3']) {
    if (!cand) continue;
    try {
      const r = spawnSync(cand, ['-c', 'import numpy, scipy; print("ok")'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && /ok/.test(r.stdout || '')) return cand;
    } catch {}
  }
  return null;
}
const py = findPython();
if (!py) {
  console.log('  skip runtime check: no Python with numpy + scipy (set FREQPHULL_TEST_PYTHON)');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-stemanalyze-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'stems.py'), path.join(dir, 'freqphull_stems.py'));
    fs.copyFileSync(path.join(ROOT, '_phull_internal.py'), path.join(dir, '_phull_internal.py'));
    fs.copyFileSync(path.join(ROOT, 'analyze.py'), path.join(dir, 'analyze.py'));
    // Run from somewhere else, as the app does, with the import stems.py uses.
    const code = [
      'import sys, os, json, wave, numpy as np',
      'sys.path.insert(0, sys.argv[1])',
      'import analyze as _analyzer',
      'sr = 44100; n = sr * 12; x = np.zeros(n)',
      'for i in range(0, n, int(sr * 60 / 120)):',
      '    x[i:i + 300] += np.sin(2 * np.pi * 1000 * np.arange(min(300, n - i)) / sr) * np.hanning(300)[:min(300, n - i)]',
      'p = os.path.join(sys.argv[1], "drums.wav")',
      'w = wave.open(p, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)',
      'w.writeframes((np.clip(x, -1, 1) * 32000).astype("<i2").tobytes()); w.close()',
      'r = _analyzer.analyze_stem(p)',
      'print(json.dumps({"file": _analyzer.__file__, "result": r}, default=str))',
    ].join('\n');
    const r = spawnSync(py, ['-c', code, dir], { encoding: 'utf8', windowsHide: true, cwd: os.tmpdir(), timeout: 180000 });
    let j = null;
    try { j = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch {}
    check('the import stems.py does now resolves to the copied analyze.py', j && path.dirname(j.file) === dir, j ? j.file : (r.stderr || '').trim().split('\n').pop());
    const bpm = j && j.result && (j.result.bpm || j.result.BPM);
    check('analyze_stem returns a BPM for a 120 BPM click track', bpm && Math.abs(bpm - 120) < 2, j ? JSON.stringify(j.result).slice(0, 160) : '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
