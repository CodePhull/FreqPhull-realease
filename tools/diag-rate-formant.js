// DIAGNOSTIC (not a test - nothing here asserts, it just measures).
//
// Question: does the formant-correction coloration get WORSE at higher
// sample rates, because lpcOrder (24), envOrder (40) and envTaps (80) are
// fixed sample/coefficient counts while lpcWinLen scales with the rate?
//
// If so, a user recording at 88.2kHz is spreading the same 24 LPC poles
// across 44kHz of spectrum instead of 22kHz - half of them describing
// empty air above 20kHz - leaving a coarser, more generic formant fit in
// the range that actually matters. "Generic formant fit" is what boxy
// sounds like.
//
// Method notes that matter:
//  - The control is a CLEAN synthetic source, never engine output. Using
//    processed audio as a control is what hid the formant bug for five
//    rounds.
//  - Every rate also gets a `bypass: true` run. Bypass MUST measure ~0.0dB
//    on every band. If it doesn't, the measurement is wrong, not the DSP.
//  - Scaled-constant variants are produced by patching the source text
//    before loading it, so the real shipped code is what's under test.
//
// Run:  node tools/diag-rate-formant.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'autotune-worklet.js');
const BASE = fs.readFileSync(SRC_PATH, 'utf8');

function loadEngine(patches) {
  let src = BASE;
  for (const [from, to] of patches || []) {
    if (!src.includes(from)) throw new Error('patch anchor not found: ' + from);
    src = src.replace(from, to);
  }
  const core = src.slice(src.indexOf('// ─── BEGIN DSP CORE'), src.indexOf('// ─── END DSP CORE'));
  const sandbox = { console, Math, Float32Array, Int16Array, Float64Array };
  vm.createContext(sandbox);
  vm.runInContext(core + '\nthis.__exports = { AutotuneEngine };', sandbox);
  return sandbox.__exports.AutotuneEngine;
}

// ── minimal radix-2 FFT ──
function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  const hr = new Float64Array(n / 2), hi = new Float64Array(n / 2);
  const gr = new Float64Array(n / 2), gi = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { hr[i] = re[2*i]; hi[i] = im[2*i]; gr[i] = re[2*i+1]; gi[i] = im[2*i+1]; }
  fft(hr, hi); fft(gr, gi);
  for (let k = 0; k < n / 2; k++) {
    const a = -2 * Math.PI * k / n, c = Math.cos(a), s = Math.sin(a);
    const tr = gr[k]*c - gi[k]*s, ti = gr[k]*s + gi[k]*c;
    re[k] = hr[k] + tr; im[k] = hi[k] + ti;
    re[k + n/2] = hr[k] - tr; im[k + n/2] = hi[k] - ti;
  }
}
function spectrum(x, sr) {
  const N = 8192, acc = new Float64Array(N / 2);
  let frames = 0;
  for (let pos = 0; pos + N <= x.length; pos += N / 2) {
    let e = 0;
    for (let i = 0; i < N; i++) e += x[pos+i] * x[pos+i];
    if (e / N < 1e-9) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[pos+i] * (0.5 - 0.5 * Math.cos(2*Math.PI*i/(N-1)));
    fft(re, im);
    for (let k = 1; k < N/2; k++) acc[k] += Math.sqrt(re[k]*re[k] + im[k]*im[k]);
    frames++;
  }
  for (let k = 0; k < N/2; k++) acc[k] /= Math.max(1, frames);
  return { acc, N, sr };
}
function band(sp, lo, hi) {
  let s = 0, c = 0;
  for (let k = 1; k < sp.N/2; k++) {
    const f = k * sp.sr / sp.N;
    if (f >= lo && f < hi) { s += sp.acc[k] * sp.acc[k]; c++; }
  }
  return 10 * Math.log10(s / Math.max(1, c) + 1e-20);
}

// Clean vocal-like source: fundamental in this user's measured range
// (82-140Hz, median 122), rich harmonics, and real sibilant bursts so the
// noise-like content the formant path damages is actually present.
function makeSource(sr, seconds, detuneCents) {
  const n = Math.floor(sr * seconds);
  const x = new Float32Array(n);
  let ph = 0, seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const f0 = 122 * Math.pow(2, (detuneCents || 0) / 1200);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += 2 * Math.PI * f0 / sr;
    let s = 0;
    for (let h = 1; h <= 80; h++) {
      const f = f0 * h;
      if (f > 18000) break;
      s += Math.sin(ph * h) / Math.pow(h, 0.85);
    }
    if ((t % 0.6) > 0.48) s += rnd() * 3.0;   // sibilant burst
    x[i] = s * 0.05;
  }
  return x;
}

function run(AE, x, sr, params) {
  const e = new AE(sr);
  e.setParams(params);
  const y = new Float32Array(x.length);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < x.length; i++) y[i] = e.processSample(x[i]);
  const t1 = process.hrtime.bigint();
  const realtimeRatio = (Number(t1 - t0) / 1e9) / (x.length / sr);
  return { y, realtimeRatio };
}

const RATES = [44100, 48000, 88200, 96000];
// 50 cents off so correction is genuinely engaged - the coloration only
// appears when the engine is actually working (it is transparent on an
// already-in-tune input).
const DETUNE = 50;
const P = { key: 7, scale: 'minor', retuneSpeedMs: 5, trackingSpeedMs: 120,
            humanize: 0, naturalVibrato: 0, flexTune: 0 };

function measure(AE, sr, params) {
  const dry = makeSource(sr, 6, DETUNE);
  const { y, realtimeRatio } = run(AE, dry, sr, params);
  const d = spectrum(dry, sr), w = spectrum(y, sr);
  return {
    box:  (band(w,250,630) - band(w,1500,4000)) - (band(d,250,630) - band(d,1500,4000)),
    pres: band(w,1500,4000) - band(d,1500,4000),
    sib:  band(w,4000,8000) - band(d,4000,8000),
    cpu:  realtimeRatio,
  };
}

console.log('Formant coloration vs sample rate');
console.log('(dB change against a CLEAN synthetic control, correction engaged at 50 cents)');
console.log('positive box = boxier. negative presence/sibilance = duller.\n');

const stock = loadEngine(null);

console.log('--- A. bypass sanity check (must be ~0.0 everywhere, else the method is broken) ---');
for (const sr of RATES) {
  const m = measure(stock, sr, { ...P, bypass: true });
  console.log('  ' + String(sr).padStart(6) + ' Hz   box ' + m.box.toFixed(2).padStart(6) +
              '   presence ' + m.pres.toFixed(2).padStart(6) + '   sibilance ' + m.sib.toFixed(2).padStart(6));
}

console.log('\n--- B. SHIPPED constants (lpcOrder 24, envOrder 40, envTaps 80) ---');
console.log('  rate      formant OFF                      formant ON                       x realtime');
const stockOn = {};
for (const sr of RATES) {
  const off = measure(stock, sr, { ...P, formantCorrection: false });
  const on  = measure(stock, sr, { ...P, formantCorrection: true  });
  stockOn[sr] = on;
  console.log('  ' + String(sr).padStart(6) +
    '   box ' + off.box.toFixed(1).padStart(5) + ' pres ' + off.pres.toFixed(1).padStart(5) + ' sib ' + off.sib.toFixed(1).padStart(5) +
    '    box ' + on.box.toFixed(1).padStart(5) + ' pres ' + on.pres.toFixed(1).padStart(5) + ' sib ' + on.sib.toFixed(1).padStart(5) +
    '    ' + on.cpu.toFixed(3));
}

console.log('\n--- C. RATE-SCALED constants (all three scaled by sr/44100) ---');
console.log('  keeps poles-per-Hz and FIR time-span constant across rates');
console.log('  rate      formant ON (scaled)              vs shipped      x realtime');
for (const sr of RATES) {
  const k = sr / 44100;
  const lpc = Math.round(24 * k), envO = Math.round(40 * k), envT = Math.round(80 * k);
  const scaled = loadEngine([
    ['const LPC_ORDER = 24;', 'const LPC_ORDER = ' + lpc + ';'],
    ['const CEPSTRAL_ENV_ORDER = 40;', 'const CEPSTRAL_ENV_ORDER = ' + envO + ';'],
    ['const CEPSTRAL_FIR_TAPS = 80;', 'const CEPSTRAL_FIR_TAPS = ' + envT + ';'],
  ]);
  const m = measure(scaled, sr, { ...P, formantCorrection: true });
  const delta = m.box - stockOn[sr].box;
  console.log('  ' + String(sr).padStart(6) +
    '   box ' + m.box.toFixed(1).padStart(5) + ' pres ' + m.pres.toFixed(1).padStart(5) + ' sib ' + m.sib.toFixed(1).padStart(5) +
    '    box ' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' dB' +
    '    ' + m.cpu.toFixed(3) + '   (lpc ' + lpc + ', env ' + envO + ', taps ' + envT + ')');
}

console.log('\nHow to read this:');
console.log('  B) If "box" climbs with sample rate, the fixed constants ARE rate-sensitive');
console.log('     and recording at 88.2k is making the boxiness worse than at 44.1/48k.');
console.log('  C) If scaling drops "box" and recovers presence/sibilance, that is the fix.');
console.log('     Watch "x realtime" - it must stay well under 1.0 or the worklet underruns.');
console.log('     This file has hit real-time underruns twice before (Round 20, Round 77),');
console.log('     so a quality win that costs too much CPU is not shippable as-is.');
