// Round 82: "when on for too long like overnight memory usage goes up too
// high ... sometimes 2k+ MB".
//
// Measured on the real app (port-shifted copy, 12 x 3-min tracks, track
// changes in the Analyzer with shuffle, forced GC before each reading):
//   before: renderer 105 MB -> 725 MB after 10 track changes (~62 MB each =
//           one decoded 3-min stereo track); heap snapshot: 11 AudioBuffers
//           held by requestAnimationFrame callbacks.
//   after:  103 MB -> 136 MB after 30 track changes; 7 AudioBuffers (baseline).
// Cause: drawWaveform() retried on every animation frame while the Analyzer
// tab was hidden (playing from History / the mini player), one retry loop per
// track change, forever - each one holding its track's decoded audio.
//
// This runs the real drawWaveform() with a hidden panel and 10 track changes,
// and the old version the same way as the gate.
//
// Run:  node tools/test-waveform-leak-r82.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const start = src.indexOf('let _waveDrawWait = null;');
const end = src.indexOf('\n}\n', src.indexOf('function drawWaveform(buf)', start)) + 3;
if (start < 0 || end < 3) throw new Error('drawWaveform not found');
const current = src.slice(start, end);
const OLD = `function drawWaveform(buf) {
  const canvas = document.getElementById('waveform'), wrap = document.getElementById('wave-wrap');
  if (!wrap.offsetWidth) { requestAnimationFrame(() => drawWaveform(buf)); return; }
  drawn.push(buf.id);
}`;

// A hidden Analyzer panel: no width until shown. Frames are run by hand.
function harness(code) {
  const wrap = { offsetWidth: 0, offsetHeight: 80 };
  const canvas = { width: 0, height: 0, getContext: () => ({ scale() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }) };
  const frames = [];
  const observers = [];
  const sb = {
    drawn: [], audioBuf: null, window: { devicePixelRatio: 1 },
    document: { getElementById: (id) => (id === 'wave-wrap' ? wrap : canvas) },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    ResizeObserver: class { constructor(cb) { this.cb = cb; this.on = false; observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } },
  };
  vm.createContext(sb);
  vm.runInContext(code + '\nthis.drawWaveform = drawWaveform;', sb);
  // The real function draws through getChannelData; record which track it drew.
  const track = (id) => ({ id, getChannelData: () => { sb.drawn.push(id); return new Float32Array(4); } });
  const runFrames = (n) => { for (let i = 0; i < n; i++) { const now = frames.splice(0); now.forEach((f) => f()); } };
  return { sb, wrap, frames, observers, track, runFrames };
}

// ── Gate: the old version leaks ──
{
  const h = harness(OLD);
  for (let k = 1; k <= 10; k++) { const b = h.track(k); h.sb.audioBuf = b; h.sb.drawWaveform(b); h.runFrames(3); }
  check('gate: old version keeps one retry per track change alive (each holding its audio)', h.frames.length === 10, h.frames.length + ' pending frame callbacks');
}

// ── Current version ──
{
  const h = harness(current);
  for (let k = 1; k <= 10; k++) { const b = h.track(k); h.sb.audioBuf = b; h.sb.drawWaveform(b); h.runFrames(3); }
  const live = h.observers.filter((o) => o.on);
  check('hidden panel: no frame callbacks left holding tracks', h.frames.length === 0, h.frames.length + ' pending');
  check('one wait for the panel, not one per track', h.observers.length === 1 && live.length === 1, h.observers.length + ' observers');
  check('the wait does not capture a track (draws whatever is current)', !/drawWaveform\(buf\)/.test(current.slice(current.indexOf('new ResizeObserver'))));
  check('nothing drawn while hidden', h.sb.drawn.length === 0);
  h.wrap.offsetWidth = 600;
  live[0].cb();
  check('when the Analyzer is shown, it draws the current track only, once', JSON.stringify(h.sb.drawn) === '[10]', 'drew ' + JSON.stringify(h.sb.drawn));
  check('...and stops waiting', !live[0].on);
  // Visible panel: draws immediately, no wait.
  const b = h.track(11); h.sb.audioBuf = b; h.sb.drawWaveform(b);
  check('visible panel draws immediately', h.sb.drawn[h.sb.drawn.length - 1] === 11 && h.observers.length === 1);
}

// ── Drag-out temp WAVs ──
// Found while measuring this: every track change also wrote a full WAV copy
// to %TEMP%\freqphull-drag (31 MB for 3 min) and nothing ever deleted them -
// 666 files, 19.7 GB on the dev machine. Dry run of the new rule on that
// real folder: removes 596 files / 17.6 GB, keeps the last day's 2.1 GB.
check('the drag WAV is only pre-built when the Analyzer is on screen',
  /if \(_ww && _ww\.offsetWidth\) prepareDragWav\(\);\s*else \{ dragReady = false; dragTempPath = null; \}/.test(src));
check('a drag still builds it on demand', /if \(!dragReady \|\| !dragTempPath\) \{\s*await prepareDragWav\(\);/.test(src));
check('a slow build for a previous track never becomes the drag file', /if \(audioBuf !== forBuf\) return;/.test(src));
{
  const mj = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const s = mj.indexOf('const DRAG_TEMP_MAX_AGE_MS');
  const e = mj.indexOf('// ─── END DRAG TEMP PRUNE CORE');
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(mj.slice(s, e) + '\nthis.f = dragTempToDelete;', sb);
  const now = Date.UTC(2026, 9, 24);
  const H = 3600e3, D = 24 * H, MB = 1048576;
  const f = (name, ageMs, mb) => ({ p: 'T\\' + name, t: now - ageMs, size: mb * MB });
  const del = (files, keep) => sb.f(files, now, keep).map((x) => x.p.slice(2)).sort().join(',');
  check('files older than 3 days go, recent ones stay', del([f('old', 4 * D, 30), f('day', 1 * D, 30), f('new', 1 * H + 1, 30)]) === 'old');
  const many = Array.from({ length: 150 }, (_, i) => f('t' + String(i).padStart(3, '0'), 2 * H + i * 10 * 60e3, 31));   // 4.5 GB within 3 days
  const gone = sb.f(many, now, null);
  const left = many.length - gone.length;
  check('over 3 GB: the oldest go until it fits', left * 31 <= 3 * 1024 && (left + 1) * 31 > 3 * 1024 && gone.every((g) => g.t <= Math.min(...many.filter((m) => !gone.includes(m)).map((m) => m.t))), left + ' kept');
  check('nothing from the last hour, even over the cap', del([f('big', 30 * 60e3, 4000)]) === '');
  check('the file just written is never removed', del([f('cur', 5 * D, 30)], 'T\\cur') === '');
  check('pruned after every write and once at launch', /pruneDragTemp\(tempPath\);/.test(mj) && /app\.whenReady\(\)\.then\(\(\) => setTimeout\(\(\) => pruneDragTemp\(null\), 15000\)\);/.test(mj));
}

// No other "retry next frame with this buffer" pattern anywhere.
check('no requestAnimationFrame retry that captures an argument', !/requestAnimationFrame\(\(\) => *[A-Za-z_]+\([A-Za-z_]/.test(src));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall waveform-leak checks passed');
process.exit(fails ? 1 : 0);
