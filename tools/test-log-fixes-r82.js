// Round 82: fixes found in the developer's real 0.7.42 logs (2026-10-24),
// plus two UI reports from the same session.
//
// 1. Every track opened in the Analyzer was re-analysed every time
//    ("analysis-cache MISS id=6599 (file changed on disk)" right after the
//    same track was analysed and tagged): writing BPM/key tags changes the
//    file's mtime, which the analysis cache is keyed on.
// 2. "extension auto-synced 4.6.0 -> 4.5.0": an older build replaced the
//    newer extension (synced on any version difference).
// 3. "[86BPM A#m] � Stems": Python wrote its output in cp1252, Node read UTF-8.
// 4. "auto-file: track 6600 -> ?" when the download went to the Stockpile root.
// 5. Screenshot: the menu showed "Convert Convert" (a label span was added
//    inside the nav button, which applyLang's navMap also writes).
// 6. "In french keep ralenti and reverb to slowed and reverb".
//
// Run:  node tools/test-log-fixes-r82.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const core = (name) => {
  const s = src.indexOf('// ─── BEGIN ' + name + ' ───'), e = src.indexOf('// ─── END ' + name + ' ───');
  if (s < 0 || e < 0) throw new Error(name + ' markers not found');
  return src.slice(s, e);
};

// ── 1. Analysis cache survives the tag write ──
{
  const sb = { Math };
  vm.createContext(sb);
  vm.runInContext(core('TAG WRITE CACHE CORE') + '\nthis.f = analysisMtimeAfterTagWrite;', sb);
  const f = sb.f;
  check('a cache valid just before the tag write moves to the new mtime', f(1000, 1500, 9000) === 9000);
  check('a cache that was already stale is left alone', f(1000, 50000, 60000) === null);
  check('no cache, nothing to move', f(null, 1500, 9000) === null);
  check('the tag write records the mtime before, and fixes the cache after a successful write',
    /let mtimeBefore = null;\s*try \{ mtimeBefore = fs\.statSync\(filePath\)\.mtimeMs; \} catch \{\}/.test(src) &&
    /slog\('writeTagsToFile: stamped '[^\n]*\n\s*keepAnalysisCacheAfterTagWrite\(historyId, filePath, mtimeBefore\);/.test(src));
  // Gate: the cache lookup really does reject a changed mtime (the bug).
  check('gate: the cache lookup rejects an mtime more than 2 s off', /Math\.abs\(mtime - row\.analysis_mtime\) > 2000/.test(src));
}

// ── 2. Extension: only ever upgraded ──
{
  const sb = { String, Math, parseInt };
  vm.createContext(sb);
  vm.runInContext(core('EXT VERSION CORE') + '\nthis.f = extVersionNewer;', sb);
  const f = sb.f;
  check('4.6.0 is newer than 4.5.0, not the other way round', f('4.6.0', '4.5.0') === true && f('4.5.0', '4.6.0') === false);
  check('4.10.0 is newer than 4.9.2 (numbers, not text)', f('4.10.0', '4.9.2') === true);
  check('same version is not newer', f('4.6.0', '4.6.0') === false && f('4.6', '4.6.0') === false);
  check('startup sync and "update available" only for a newer bundle',
    /if \(!bv \|\| !iv \|\| !extVersionNewer\(bv, iv\)\) return;/.test(src) && src.includes('extVersionNewer(bundledVersion, installedVersion)') && !/bv === iv\) return;/.test(src));
}

// ── 3. Python output in UTF-8 ──
check('every Python process gets PYTHONIOENCODING=utf-8', /if \(!opts\.env\.PYTHONIOENCODING\) opts\.env\.PYTHONIOENCODING = 'utf-8';/.test(src));
{
  const candidates = [process.env.FREQPHULL_TEST_PYTHON, path.join(process.env.LOCALAPPDATA || '', 'freqphull', 'engines', 'python', 'python.exe')].filter(Boolean);
  const py = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!py || process.platform !== 'win32') {
    console.log('  skip real Python check: no Windows Python found');
  } else {
    const code = 'import sys; sys.stderr.write("[86BPM A#m] \\u2014 Stems\\n")';
    const envNo = { ...process.env }; delete envNo.PYTHONIOENCODING; delete envNo.PYTHONUTF8;
    const before = spawnSync(py, ['-c', code], { env: envNo }).stderr.toString('utf8');
    const after = spawnSync(py, ['-c', code], { env: { ...envNo, PYTHONIOENCODING: 'utf-8' } }).stderr.toString('utf8');
    check('gate: without it the dash arrives broken (as in the log)', /�/.test(before), JSON.stringify(before.trim()));
    check('with it the dash arrives intact', after.includes('—') && !/�/.test(after), JSON.stringify(after.trim()));
  }
}

// ── 4. Readable auto-file log ──
check('auto-file log names the Stockpile root instead of "?"', src.includes("(r.committed.folder_name || 'Stockpile root (no folder matched)')") && !/folder_name \|\| '\?'/.test(src));

// ── 5. No label span inside menu buttons ──
const navButtons = html.match(/<button class="nav-btn[^>]*>[\s\S]*?<\/button>/g) || [];
const withSpan = navButtons.filter((b) => /data-i18n=/.test(b));
check('menu buttons have no extra label (no "Convert Convert")', navButtons.length >= 10 && withSpan.length === 0, navButtons.length + ' buttons, ' + withSpan.length + ' with a label span');

// ── 6. French menu label ──
const frStart = app.indexOf('\n  fr: {');
check('French shows "Slowed + Reverb"', app.slice(frStart).includes("navSlowverb:'Slowed + Reverb'") && app.slice(frStart).includes("svTitle:'Slowed + Reverb'"));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall log-fix checks passed');
process.exit(fails ? 1 : 0);
