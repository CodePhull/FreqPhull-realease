// DIAGNOSTIC round 2. Follow-up to diag-rate-formant.js.
//
// What round 1 established:
//   - bypass measures 0.00 at every rate, so the method is sound
//   - formant boxiness climbs with sample rate: 4.9dB @48k -> 7.2dB @88.2k
//   - scaling lpcOrder/envOrder/envTaps by sr/44100 changed nothing (-0.1dB)
//
// Why that last result cannot be trusted yet: CEPSTRAL_MP_FFT_SIZE stayed at
// 128 while envOrder was scaled to 80 (88.2k) and 87 (96k). That constant is
// only valid while it sits comfortably past 2*order - the whole argument in
// its comment is that the liftered cepstrum is exactly zero past quefrency
// `order`, so any FFT bigger than ~2*order reproduces the same envelope.
// 2*80 = 160 > 128, so the minimum-phase step was aliasing. The scaled
// variant was probably just broken, which is not the same as ineffective.
//
// This script:
//   A. repeats the scaled test with MP_FFT_SIZE sized correctly
//   B. isolates each constant one at a time, to find which one (if any) owns
//      the rate sensitivity
//   C. tests the alternative hypothesis - that the LPC/cepstral fit simply
//      wastes its poles on the empty 20kHz+ region at high rates - by
//      lowering the cutoff the brightness tap works at, which is the only
//      band-limiting lever available without restructuring the analysis
//
// Run:  node tools/diag-rate-formant2.js
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
function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  const hr = new Float64Array(n/2), hi = new Float64Array(n/2);
  const gr = new Float64Array(n/2), gi = new Float64Array(n/2);
  for (let i = 0; i < n/2; i++) { hr[i]=re[2*i]; hi[i]=im[2*i]; gr[i]=re[2*i+1]; gi[i]=im[2*i+1]; }
  fft(hr,hi); fft(gr,gi);
  for (let k = 0; k < n/2; k++) {
    const a = -2*Math.PI*k/n, c = Math.cos(a), s = Math.sin(a);
    const tr = gr[k]*c - gi[k]*s, ti = gr[k]*s + gi[k]*c;
    re[k]=hr[k]+tr; im[k]=hi[k]+ti; re[k+n/2]=hr[k]-tr; im[k+n/2]=hi[k]-ti;
  }
}
function spectrum(x, sr) {
  const N = 8192, acc = new Float64Array(N/2);
  let frames = 0;
  for (let pos = 0; pos + N <= x.length; pos += N/2) {
    let e = 0;
    for (let i = 0; i < N; i++) e += x[pos+i]*x[pos+i];
    if (e/N < 1e-9) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[pos+i] * (0.5 - 0.5*Math.cos(2*Math.PI*i/(N-1)));
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
    const f = k*sp.sr/sp.N;
    if (f >= lo && f < hi) { s += sp.acc[k]*sp.acc[k]; c++; }
  }
  return 10*Math.log10(s/Math.max(1,c) + 1e-20);
}
function makeSource(sr, seconds, detuneCents) {
  const n = Math.floor(sr*seconds);
  const x = new Float32Array(n);
  let ph = 0, seed = 12345;
  const rnd = () => { seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff*2 - 1; };
  const f0 = 122*Math.pow(2, (detuneCents||0)/1200);
  for (let i = 0; i < n; i++) {
    const t = i/sr;
    ph += 2*Math.PI*f0/sr;
    let s = 0;
    for (let h = 1; h <= 80; h++) { const f = f0*h; if (f > 18000) break; s += Math.sin(ph*h)/Math.pow(h,0.85); }
    if ((t % 0.6) > 0.48) s += rnd()*3.0;
    x[i] = s*0.05;
  }
  return x;
}
const P = { key: 7, scale: 'minor', retuneSpeedMs: 5, trackingSpeedMs: 120,
            humanize: 0, naturalVibrato: 0, flexTune: 0, formantCorrection: true };
function measure(AE, sr, params) {
  const dry = makeSource(sr, 6, 50);
  const e = new AE(sr);
  e.setParams(params || P);
  const y = new Float32Array(dry.length);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < dry.length; i++) y[i] = e.processSample(dry[i]);
  const t1 = process.hrtime.bigint();
  const d = spectrum(dry, sr), w = spectrum(y, sr);
  return {
    box:  (band(w,250,630)-band(w,1500,4000)) - (band(d,250,630)-band(d,1500,4000)),
    pres: band(w,1500,4000) - band(d,1500,4000),
    sib:  band(w,4000,8000) - band(d,4000,8000),
    cpu:  (Number(t1-t0)/1e9)/(dry.length/sr),
  };
}
function row(label, m, ref) {
  const d = ref == null ? '' : '   vs shipped ' + ((m.box-ref) >= 0 ? '+' : '') + (m.box-ref).toFixed(1) + 'dB';
  console.log('  ' + label.padEnd(44) +
    'box ' + m.box.toFixed(1).padStart(5) +
    '  pres ' + m.pres.toFixed(1).padStart(5) +
    '  sib ' + m.sib.toFixed(1).padStart(5) +
    '  cpu ' + m.cpu.toFixed(3) + d);
}
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

const stock = loadEngine(null);
const RATES = [48000, 88200];

for (const sr of RATES) {
  console.log('\n================ ' + sr + ' Hz ================');
  const ref = measure(stock, sr);
  row('SHIPPED (lpc 24, env 40, taps 80, mpfft 128)', ref);

  const k = sr/44100;
  const lpc = Math.round(24*k), envO = Math.round(40*k), envT = Math.round(80*k);

  console.log('\n  -- A. all three scaled, WITH mpFFT sized correctly --');
  const mp = nextPow2(Math.max(128, 4*envO));
  row('all scaled + mpfft ' + mp, measure(loadEngine([
    ['const LPC_ORDER = 24;', 'const LPC_ORDER = ' + lpc + ';'],
    ['const CEPSTRAL_ENV_ORDER = 40;', 'const CEPSTRAL_ENV_ORDER = ' + envO + ';'],
    ['const CEPSTRAL_FIR_TAPS = 80;', 'const CEPSTRAL_FIR_TAPS = ' + envT + ';'],
    ['const CEPSTRAL_MP_FFT_SIZE = 128;', 'const CEPSTRAL_MP_FFT_SIZE = ' + mp + ';'],
  ]), sr), ref.box);
  row('(control) mpfft ' + mp + ' alone, orders untouched', measure(loadEngine([
    ['const CEPSTRAL_MP_FFT_SIZE = 128;', 'const CEPSTRAL_MP_FFT_SIZE = ' + mp + ';'],
  ]), sr), ref.box);

  console.log('\n  -- B. one constant at a time --');
  row('lpcOrder ' + lpc + ' only', measure(loadEngine([
    ['const LPC_ORDER = 24;', 'const LPC_ORDER = ' + lpc + ';'],
  ]), sr), ref.box);
  row('envOrder ' + envO + ' only (+mpfft ' + nextPow2(Math.max(128,4*envO)) + ')', measure(loadEngine([
    ['const CEPSTRAL_ENV_ORDER = 40;', 'const CEPSTRAL_ENV_ORDER = ' + envO + ';'],
    ['const CEPSTRAL_MP_FFT_SIZE = 128;', 'const CEPSTRAL_MP_FFT_SIZE = ' + nextPow2(Math.max(128,4*envO)) + ';'],
  ]), sr), ref.box);
  row('envTaps ' + envT + ' only', measure(loadEngine([
    ['const CEPSTRAL_FIR_TAPS = 80;', 'const CEPSTRAL_FIR_TAPS = ' + envT + ';'],
  ]), sr), ref.box);

  console.log('\n  -- C. push the orders WELL past scaling (is more detail better at all?) --');
  for (const mult of [2, 3]) {
    const o = 40*mult, t = 80*mult, l = 24*mult;
    const m2 = nextPow2(Math.max(128, 4*o));
    row('lpc ' + l + ', env ' + o + ', taps ' + t + ', mpfft ' + m2, measure(loadEngine([
      ['const LPC_ORDER = 24;', 'const LPC_ORDER = ' + l + ';'],
      ['const CEPSTRAL_ENV_ORDER = 40;', 'const CEPSTRAL_ENV_ORDER = ' + o + ';'],
      ['const CEPSTRAL_FIR_TAPS = 80;', 'const CEPSTRAL_FIR_TAPS = ' + t + ';'],
      ['const CEPSTRAL_MP_FFT_SIZE = 128;', 'const CEPSTRAL_MP_FFT_SIZE = ' + m2 + ';'],
    ]), sr), ref.box);
  }

  console.log('\n  -- D. brightness tap cutoff (only band-limiting lever available) --');
  for (const fc of [12000, 16000]) {
    row('FORMANT_HF_CUTOFF_HZ ' + fc, measure(loadEngine([
      ['const FORMANT_HF_CUTOFF_HZ = 20000;', 'const FORMANT_HF_CUTOFF_HZ = ' + fc + ';'],
    ]), sr), ref.box);
  }
}

console.log('\nReading it:');
console.log('  If A now helps at 88.2k but B shows no single constant does, the');
console.log('  rate sensitivity is in the INTERACTION and scaling is the fix.');
console.log('  If C (2-3x the detail) still does not help, the problem is not');
console.log('  resolution at all and the split-band rewrite is the only route.');
console.log('  Any row must keep cpu well under 1.0 to be shippable.');
