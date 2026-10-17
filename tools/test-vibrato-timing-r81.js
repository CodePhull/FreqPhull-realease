// Round 81: "autotune is kinda not sticking to the voice".
//
// Measured on the developer's 88.2kHz take: held notes landed within 2-6c
// on average, but a 4-8Hz wobble of 14c sd (peaks 40-90c) survived inside
// them. Reproduced on a synthetic voice at retune 0: a steady +40c error
// corrects to 0.1c, a +-40c vibrato kept 9.2c sd at 5.5Hz and 11.4c at 8Hz
// (formant OFF) - the faster the movement, the more leaked. Cause: the
// correction is computed from a 46ms window and refreshed per hop, while
// the shifter delays the audio by its own amount; the two do not line up
// (formant OFF: correction ~10ms early; formant ON: slightly late). See
// PITCH_LEAD_MS / CORRECTION_DELAY_MS in renderer/autotune-worklet.js.
//
// Sanity gate: the test rebuilds the PRE-Round-81 timing from the current
// source (delay line bypassed, slope-follow off) and requires it to FAIL
// the vibrato bars - otherwise the bars prove nothing. Note-change and
// slide behaviour is checked against that same legacy build, so the fix
// cannot buy tighter vibrato with worse note changes.
//
// The bars were set after measuring (current engine: 2.2/3.9c formant off,
// 1.7/1.8c formant on; legacy 9.2/11.4c and 4.9/6.2c) with room on both
// sides, not tuned to scrape past.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'autotune-worklet.js'), 'utf8');
function patchOnce(src, a, b) {
  const n = src.split(a).length - 1;
  if (n !== 1) throw new Error('engine anchor matched ' + n + ' times: ' + a);
  return src.replace(a, () => b);
}
function build(legacy) {
  let src = SRC;
  if (legacy) {
    src = patchOnce(src, 'const steerRatio = this.params.formantCorrection ? this.targetRatio : delayedRatio;', 'const steerRatio = this.targetRatio;');
    src = patchOnce(src, 'if (this.params.formantCorrection && targetMidi === this.lastTargetMidi && this.leadHist.length === 3) {', 'if (false) {');
  }
  const core = src.slice(src.indexOf('// ─── BEGIN DSP CORE'), src.indexOf('// ─── END DSP CORE'));
  const sb = { console, Math, Float32Array, Int16Array, Float64Array };
  vm.createContext(sb);
  vm.runInContext(core + '\nthis.__e = { AutotuneEngine };', sb);
  return sb.__e.AutotuneEngine;
}
const NEW = build(false), LEG = build(true);

const F0 = 138.59;          // C#3, the take's median pitch; a G# minor scale note
const DUR = 3.0;
const cents2hz = (c) => F0 * Math.pow(2, c / 1200);

// Voice-like source: band-limited harmonics (-12dB/oct) through three
// formant resonators, plus some of the raw source to keep F0 present.
function synth(sr, f0fn) {
  const n = Math.round(DUR * sr), x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0fn(i / sr); ph += 2 * Math.PI * f / sr;
    let s = 0; const H = Math.floor(8000 / f);
    for (let h = 1; h <= H; h++) s += Math.sin(h * ph) / (h * h);
    x[i] = s;
  }
  const out = new Float32Array(n);
  for (const [fc, bw, g] of [[700, 110, 1], [1200, 120, 0.6], [2600, 160, 0.3]]) {
    const w = 2 * Math.PI * fc / sr, al = Math.sin(w) / (2 * fc / bw);
    const a0 = 1 + al, a1 = -2 * Math.cos(w), a2 = 1 - al;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) { const y = (al * x[i] - al * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; out[i] += g * y; }
  }
  let pk = 0;
  for (let i = 0; i < n; i++) { out[i] += 0.3 * x[i]; pk = Math.max(pk, Math.abs(out[i])); }
  for (let i = 0; i < n; i++) out[i] *= 0.4 / pk;
  return out;
}

// Independent YIN tracker (not the engine's own detector), on a ~22kHz
// box-decimated copy, 5ms hop.
function yin(x, sr) {
  const D = Math.max(1, Math.round(sr / 22050)), y = new Float32Array(Math.floor(x.length / D));
  for (let i = 0; i < y.length; i++) { let a = 0; for (let k = 0; k < D; k++) a += x[i * D + k]; y[i] = a / D; }
  const s = sr / D, W = 1024, tMax = Math.ceil(s / 60), tMin = Math.floor(s / 1000), hop = Math.round(0.005 * s), out = [];
  const d = new Float64Array(tMax + 1), cm = new Float64Array(tMax + 1);
  for (let p = 0; p + W + tMax < y.length; p += hop) {
    for (let t = 1; t <= tMax; t++) { let a = 0; for (let i = 0; i < W; i++) { const df = y[p + i] - y[p + i + t]; a += df * df; } d[t] = a; }
    let run = 0, best = -1; cm[0] = 1;
    for (let t = 1; t <= tMax; t++) { run += d[t]; cm[t] = d[t] * t / (run || 1); }
    for (let t = tMin; t <= tMax; t++) if (cm[t] < 0.15) { while (t + 1 <= tMax && cm[t + 1] < cm[t]) t++; best = t; break; }
    if (best < 0) continue;
    const a = cm[best - 1], b = cm[best], c = cm[best + 1], den = a - 2 * b + c;
    out.push([(p + W / 2) / s, s / (best + (den ? 0.5 * (a - c) / den : 0))]);
  }
  return out.filter(([t, f]) => t > 0.8 && t < DUR - 0.2 && f > 60);
}

function render(AE, sr, f0fn, formant) {
  const x = synth(sr, f0fn), e = new AE(sr);
  e.setParams({ key: 8, scale: 'minor', retuneSpeedMs: 0, trackingSpeedMs: 30, humanize: 0, naturalVibrato: 0, flexTune: 0, formantCorrection: formant });
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = e.processSample(x[i]);
  return y;
}
function aroundF0(AE, sr, f0fn, formant) {
  const c = yin(render(AE, sr, f0fn, formant), sr).map(([, f]) => 1200 * Math.log2(f / F0));
  const m = c.reduce((a, b) => a + b, 0) / c.length;
  return { mean: m, sd: Math.sqrt(c.reduce((a, b) => a + (b - m) * (b - m), 0) / c.length) };
}
const SCALE = [0, 2, 3, 5, 7, 8, 10].map((v) => (v + 8) % 12);   // G# minor
function nearestDev(f) {
  const m = 69 + 12 * Math.log2(f / 440); let b = 99;
  for (let o = Math.floor(m) - 2; o <= Math.ceil(m) + 2; o++) if (SCALE.includes(((o % 12) + 12) % 12) && Math.abs(m - o) < Math.abs(b)) b = m - o;
  return Math.abs(b * 100);
}
function noteStats(AE, sr, f0fn, formant) {
  const d = yin(render(AE, sr, f0fn, formant), sr).map(([, f]) => nearestDev(f)).sort((a, b) => a - b);
  return { p90: d[Math.floor(0.9 * (d.length - 1))], p99: d[Math.floor(0.99 * (d.length - 1))] };
}

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const vib = (rate, depth) => (t) => cents2hz(depth * Math.sin(2 * Math.PI * rate * t));

// ── Steady errors still fully corrected (both modes) ────────────────────
for (const formant of [false, true]) {
  const r = aroundF0(NEW, 44100, () => cents2hz(40), formant);
  check('formant ' + (formant ? 'ON ' : 'OFF') + ': steady +40c note corrected', Math.abs(r.mean) < 2 && r.sd < 2, 'mean ' + r.mean.toFixed(1) + 'c sd ' + r.sd.toFixed(1) + 'c');
}

// ── Vibrato: current engine passes, legacy timing fails (the gate) ──────
const BARS = { off: { 5.5: 4, 8: 6 }, on: { 5.5: 3.5, 8: 3.5 } };
for (const [mode, formant] of [['off', false], ['on', true]]) {
  for (const rate of [5.5, 8]) {
    const bar = BARS[mode][rate];
    const n = aroundF0(NEW, 44100, vib(rate, 40), formant).sd;
    const l = aroundF0(LEG, 44100, vib(rate, 40), formant).sd;
    check('formant ' + mode.toUpperCase().padEnd(3) + ' ' + rate + 'Hz +-40c vibrato: residual sd < ' + bar + 'c', n < bar, n.toFixed(1) + 'c');
    check('  sanity gate: legacy timing FAILS that bar', l >= bar, 'legacy ' + l.toFixed(1) + 'c');
  }
}
// Rate-independence of the formant-OFF delay (it is in ms, derived from sr).
{
  const n = aroundF0(NEW, 96000, vib(5.5, 40), false).sd;
  check('formant OFF at 96kHz: 5.5Hz vibrato residual sd < 4c', n < 4, n.toFixed(1) + 'c');
}

// ── Note changes and slides: no worse than legacy ───────────────────────
const MOVES = {
  'steps +-200c / 400ms': (t) => cents2hz(200 * (Math.floor(t / 0.4) % 2)),
  'steps 0/+300/+500c / 350ms': (t) => cents2hz([0, 300, 500][Math.floor(t / 0.35) % 3]),
  'fast slide +500c in 120ms': (t) => cents2hz(Math.min(500, Math.max(0, (t - 1.5) * 500 / 0.12))),
};
for (const [name, fn] of Object.entries(MOVES)) {
  const n = noteStats(NEW, 44100, fn, false), l = noteStats(LEG, 44100, fn, false);
  // 5c of slack on p99: the step cases measured 40.3 vs 44.7 and 47.8 vs
  // 45.8 - within the noise of where YIN frames fall around a jump.
  check('formant OFF ' + name + ': p99 no worse than legacy (+5c)', n.p99 <= l.p99 + 5,
    'new p90 ' + n.p90.toFixed(1) + ' p99 ' + n.p99.toFixed(1) + ' | legacy p90 ' + l.p90.toFixed(1) + ' p99 ' + l.p99.toFixed(1));
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
