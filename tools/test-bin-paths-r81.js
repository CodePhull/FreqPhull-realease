// Round 81 regression tests, all from one real 0.7.40 portable-build log.
//
// 1. bin() must never return a path INSIDE app.asar. Electron's fs says such
//    a path exists (the archive header lists it) but spawn() cannot run it.
//    When Temp\<hash>\resources\bin was deleted mid-session, bin() returned
//    app.asar\bin\yt-dlp.exe and every download failed "spawn ... ENOENT".
//    Run headless: the BIN CANDIDATES region is extracted with vm and fed a
//    fake fs where every app.asar path "exists", the way Electron's does.
// 2. Binaries must ship once (extraResources), not twice (also asarUnpack).
// 3. Auto-rename must run BEFORE the tag write, and the fingerprint job must
//    read the row's current path - both raced a move/rename and logged
//    "file not found" on every download. Static source guards: these paths
//    need the DB and Python, which can't run headless.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── 1. bin() candidate list ──────────────────────────────────────────────
const si = src.indexOf('// ─── BEGIN BIN CANDIDATES ───');
const ei = src.indexOf('// ─── END BIN CANDIDATES ───');
if (si < 0 || ei < 0) throw new Error('BIN CANDIDATES markers not found in server.js');
const region = src.slice(si, ei);
function resolveWith(RES, dirname, exists) {
  const sb = { path: path.win32, RES, __dirname: dirname, name: 'yt-dlp', exe: '.exe',
    asarUnpacked: dirname.replace(/[\\/]app\.asar([\\/]|$)/, (m, tail) => '/app.asar.unpacked' + tail) };
  vm.createContext(sb);
  vm.runInContext(region + '\nthis.__c = candidates;', sb);
  return sb.__c.find(exists) || null;
}
const RES = 'C:\\Users\\X\\AppData\\Local\\Temp\\3K6dhy\\resources';
const ASAR = RES + '\\app.asar';
const isAsarInner = (p) => /[\\/]app\.asar[\\/]/.test(p);
{
  // The real incident: resources\bin gone, asar header still "has" bin\.
  const got = resolveWith(RES, ASAR, (p) => isAsarInner(p));
  check('resources\\bin deleted: bin() does not return a path inside app.asar', got === null, got);
}
{
  // Only the asar.unpacked copy survives: it must be found, not shadowed.
  const got = resolveWith(RES, ASAR, (p) => isAsarInner(p) || /app\.asar\.unpacked/.test(p));
  check('asar.unpacked copy present: it is chosen over the unrunnable asar path', !!got && /app\.asar\.unpacked/.test(got), got);
}
{
  const got = resolveWith(RES, ASAR, () => true);
  check('normal packaged run: resources\\bin is still the first choice', got === path.win32.join(RES, 'bin', 'yt-dlp.exe'), got);
}
{
  // Dev run (npm start): __dirname is the real project folder.
  const dev = 'C:\\dev\\freqphull';
  const got = resolveWith(dev, dev, (p) => p.startsWith(dev + '\\bin'));
  check('dev run: project bin\\ is still a candidate', got === path.win32.join(dev, 'bin', 'yt-dlp.exe'), got);
}

// ── 2. Packaging: binaries ship once ─────────────────────────────────────
const build = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build;
check('asarUnpack no longer duplicates bin/ (extraResources already ships it)',
  !(build.asarUnpack || []).some((g) => /^bin\b/.test(g)));
check('files excludes bin/ (or it would be packed INSIDE app.asar instead)',
  (build.files || []).includes('!bin/**'));
check('extraResources still ships yt-dlp/ffmpeg/ffprobe',
  (build.extraResources || []).some((r) => r.from === 'bin/' && ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe'].every((f) => (r.filter || []).includes(f))));

// ── 3. Rename before tag write; fingerprint reads the current path ──────
function body(startMarker, len) { const i = src.indexOf(startMarker); return i < 0 ? '' : src.slice(i, i + len); }
const analysisRoute = body("app.post('/history/:id/analysis'", 6000);
{
  const tail = analysisRoute.slice(analysisRoute.indexOf('res.json({ ok: true });'));
  // Match the CALLS (with their argument), not mentions in comments.
  const r = tail.indexOf('maybeAutoRename(id,'), w = tail.indexOf('writeTagsToFile(id,');
  check('/history/:id/analysis: auto-rename runs before the tag write', r > 0 && w > 0 && r < w, 'rename@' + r + ' tags@' + w);
  check('/history/:id/analysis: both in ONE setImmediate (no separate queued rename)',
    !/setImmediate\(\(\) => maybeAutoRename/.test(tail.slice(0, 1500)));
}
{
  const i = src.indexOf("slog('bg-analyze id=' + row.id + ' OK");
  const before = src.slice(Math.max(0, i - 800), i);
  const r = before.lastIndexOf('maybeAutoRename('), w = before.lastIndexOf('writeTagsToFile(');
  check('bg-analyze: auto-rename runs before the tag write', r > 0 && w > 0 && r < w, 'rename@' + r + ' tags@' + w);
}
{
  const fp = body('function computeFingerprint(', 1200);
  check('computeFingerprint re-reads file_path from the DB before checking it exists',
    /SELECT file_path FROM history WHERE id=\?/.test(fp) && fp.indexOf('SELECT file_path') < fp.indexOf("'computeFingerprint: file missing"));
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
