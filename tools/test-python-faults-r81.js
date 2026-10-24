// Round 81: Python errors from any engine script reach Sentry.
//
// 1. Headless: PYTHON FAULT CORE (which commands are Python, script names,
//    pulling the exception out of a traceback).
// 2. Runtime: the real wrapper from server.js (spawn + watchPythonProcess),
//    run in a sandbox with a fake report(), against real Python scripts:
//    a crash, a clean run, a printed-but-handled traceback, a run the app
//    kills, and an interpreter that doesn't exist. Skipped (not failed)
//    when no Python is installed.
// 3. Static: every spawn in server.js goes through the wrapper.
//
// Run:  node tools/test-python-faults-r81.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const childProcess = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── 1. Headless ──
const ci = src.indexOf('// ─── BEGIN PYTHON FAULT CORE ───');
const ce = src.indexOf('// ─── END PYTHON FAULT CORE ───');
if (ci < 0 || ce < 0) throw new Error('PYTHON FAULT CORE markers not found in server.js');
const core = {};
vm.createContext(core);
vm.runInContext(src.slice(ci, ce) + '\nthis.c = { isPythonCommand, pythonScriptName, pythonFault };', core);
const C = core.c;
check('embedded python.exe is Python', C.isPythonCommand('C:\\Users\\x\\AppData\\Local\\freqphull\\engines\\python\\python.exe'));
check('py launcher is Python', C.isPythonCommand('py') && C.isPythonCommand('py.exe'));
check('python3.11 is Python', C.isPythonCommand('/usr/bin/python3.11'));
check('ffmpeg / yt-dlp / powershell are not', !C.isPythonCommand('ffmpeg.exe') && !C.isPythonCommand('yt-dlp.exe') && !C.isPythonCommand('powershell.exe'));
check('temp copy name -> script name', C.pythonScriptName(['-3.11', 'C:\\T\\freqphull_analyze_ab12cd.py', 'x.wav']) === 'analyze',
  C.pythonScriptName(['C:\\T\\freqphull_analyze_ab12cd.py']));
check('plain script name', C.pythonScriptName(['D:\\app\\stems.py', '--help']) === 'stems');
check('inline -c code', C.pythonScriptName(['-c', 'import sys']) === 'inline');
const tb = 'Traceback (most recent call last):\n  File "stems.py", line 3, in <module>\n    import _phull_internal\nModuleNotFoundError: No module named \'_phull_internal\'\n';
let f = C.pythonFault(tb);
check('traceback -> exception type and line', f.hasTraceback && f.type === 'ModuleNotFoundError' && /No module named/.test(f.line), JSON.stringify(f));
f = C.pythonFault('Traceback (most recent call last):\n  File "x"\ntorch.cuda.OutOfMemoryError: CUDA out of memory\n');
check('dotted exception -> last part', f.type === 'OutOfMemoryError', JSON.stringify(f));
f = C.pythonFault('some log line\nERROR: could not open file\n');
check('no traceback -> last line, no type', !f.hasTraceback && f.type === null && f.line === 'ERROR: could not open file', JSON.stringify(f));

// ── 3. Static ──
// (Round 82: the wrapper now sets PYTHONIOENCODING before spawning, so the
// spawn is no longer its first line; it must still spawn, then watch Python.)
check('server.js spawn is the wrapper', /\nfunction spawn\(cmd, args, opts\) \{[\s\S]{0,700}?const proc = _childProcess\.spawn\(cmd, args, opts\);\s*\n\s*try \{ if \(py\) watchPythonProcess\(proc, args\); \} catch \{\}\s*\n\s*return proc;\s*\n\}/.test(src));
check('no local spawn import bypasses it', !/const \{ spawn \} = require\('child_process'\)/.test(src));

// ── 2. Runtime ──
function findPython() {
  for (const cand of [process.env.FREQPHULL_TEST_PYTHON, 'python', 'py', 'python3']) {
    if (!cand) continue;
    try {
      const r = childProcess.spawnSync(cand, ['--version'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && /Python 3/.test((r.stdout || '') + (r.stderr || ''))) return cand;
    } catch {}
  }
  return null;
}

(async () => {
  const py = findPython();
  if (!py) {
    console.log('  skip runtime checks: no Python 3 found (set FREQPHULL_TEST_PYTHON)');
  } else {
    const wi = src.indexOf('// ── Python fault reporting (Round 81)');
    const we = src.indexOf('\n}\n', src.indexOf('function spawn(cmd, args, opts)')) + 3;
    const reports = [];
    const sb = { _childProcess: childProcess, report: (cat, err, ctx) => reports.push({ cat, msg: err && err.message, ctx }), String, Error, process };
    vm.createContext(sb);
    vm.runInContext(src.slice(wi, we) + '\nthis.spawn = spawn;', sb);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-pyfault-'));
    const script = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
    const run = (args, killAfterMs) => new Promise((resolve) => {
      const before = reports.length;
      const p = sb.spawn(py, args, { windowsHide: true });
      if (killAfterMs) setTimeout(() => p.kill(), killAfterMs);
      p.on('close', () => setTimeout(() => resolve(reports.slice(before)), 50));
      p.on('error', () => setTimeout(() => resolve(reports.slice(before)), 50));
    });
    try {
      let r = await run([script('freqphull_stems_ab12cd.py', 'raise ValueError("bad sample rate 0")\n')]);
      check('a crash is reported as python.<script> with the exception', r.length === 1 && r[0].cat === 'python.stems' &&
        /ValueError: bad sample rate 0/.test(r[0].msg) && r[0].ctx._group === 'ValueError' && r[0].ctx.exitCode === 1, JSON.stringify(r));
      r = await run([script('ok.py', 'print("fine")\n')]);
      check('a clean run is not reported', r.length === 0, JSON.stringify(r));
      r = await run([script('mastering.py', 'import traceback\ntry:\n    1/0\nexcept Exception:\n    traceback.print_exc()\nprint("{}")\n')]);
      check('exit 0 with a printed traceback is reported as handled', r.length === 1 && r[0].cat === 'python.mastering' &&
        r[0].ctx.handled === true && r[0].ctx._group === 'ZeroDivisionError', JSON.stringify(r));
      r = await run([script('analyze.py', 'import time\ntime.sleep(10)\n')], 300);
      check('a run the app kills (cancel / timeout) is not reported', r.length === 0, JSON.stringify(r));
      r = await run([script('x.py', 'import sys\nsys.stderr.write("could not open input\\n")\nsys.exit(3)\n')]);
      check('non-zero exit without a traceback is reported with its last line', r.length === 1 && /could not open input/.test(r[0].msg) && r[0].ctx.exitCode === 3, JSON.stringify(r));
      const before = reports.length;
      await new Promise((resolve) => {
        const p = sb.spawn(path.join(dir, 'nope', 'python.exe'), [script('y.py', '')], { windowsHide: true });
        p.on('error', () => setTimeout(resolve, 50));
        p.on('close', () => setTimeout(resolve, 50));
      });
      const r2 = reports.slice(before);
      check('a missing interpreter is reported once, as python.spawn-failed', r2.length === 1 && r2[0].cat === 'python.spawn-failed', JSON.stringify(r2));
      const n = reports.length;
      await new Promise((resolve) => { const p = sb.spawn(process.execPath, ['-e', 'process.exit(2)']); p.on('close', () => setTimeout(resolve, 50)); });
      check('non-Python processes are not watched', reports.length === n);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
