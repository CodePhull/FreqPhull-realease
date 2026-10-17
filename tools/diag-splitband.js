// DIAGNOSTIC for the split-band formant idea. Measures only - asserts nothing.
//
// Established over three prior sweeps (tools/diag-rate-formant*.js):
//   - formant correction costs ~+3.7dB boxiness, -3.3dB presence, -3.4dB
//     sibilance whenever it is engaged
//   - it is transparent when the input is already in tune, so the damage
//     tracks how much correction is happening
//   - it is NOT a resolution problem: scaling lpcOrder/envOrder/envTaps
//     moved it <=0.2dB, and 2-3x MORE detail made it measurably WORSE
//
// That last result is the clue. A higher-order fit tracks the excitation's
// harmonic peaks and then re-imposes them on a signal whose pitch has already
// moved. And sibilance is noise - it has no harmonic structure to preserve,
// so running it through whiten -> shift -> recolor can only damage it.
//
// THE IDEA: formants that carry vocal identity live at roughly 300-3000Hz.
// Sibilance lives at 4-10kHz. The correction is applied as
//     y = shiftedCorrected + formantContribution * blend
// so band-limiting `formantContribution` keeps full correction where formants
// are and leaves the highs as untouched shifted signal.
//
// THE TRAP THIS SCRIPT EXISTS TO AVOID: you can "fix" boxiness by simply
// turning formant correction off. So this measures TWO things, and a crossover
// only wins if it improves the first WITHOUT wrecking the second:
//
//   1. COLORATION  - added boxiness / lost presence / lost sibilance on a
//                    small correction, vs a clean synthetic control
//   2. PRESERVATION - on a LARGE shift, how close the output's spectral
//                    envelope stays to the original's. This is the entire
//                    reason formant correction exists; the existing suite
//                    asserts it ("formant-corrected shift keeps the spectral
//                    envelope measurably closer to the original than the
//                    naive shift does") and it must not regress.
//
// Run:  node tools/diag-splitband.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'renderer', 'autotune-worklet.js');
const BASE = fs.readFileSync(SRC, 'utf8');

// This script is the Round 80 INVESTIGATION record: every arm works by
// source-patching the pre-Round-80 engine, and the winning arm has since
// been built into the engine for real. Against the current engine its
// anchors are gone by design. The shipped behaviour's regression checks
// live in tools/test-splitband-r80.js - run that instead.
if (BASE.includes('SPLIT_XOVER_HZ')) {
  console.log('diag-splitband.js targets the pre-Round-80 engine and is kept as the');
  console.log('record of how the split-band design was chosen. The engine now ships');
  console.log('it, so these source patches no longer apply.');
  console.log('');
  console.log('Run:  node tools/test-splitband-r80.js');
  process.exit(0);
}

// Insert a one-pole low-pass on formantContribution. crossoverHz = 0 means
// "unpatched", i.e. exactly what ships today.
// forceCents, when set, pins the pitch-shift ratio to a constant instead of
// letting note-snapping choose it.
//
// This exists because the preservation test cannot be built any other way.
// Autotune moves pitch to the NEAREST allowed note, so in G minor - whose
// widest gap is a whole step - the largest correction it can ever produce is
// about 100 cents. Asking it for the 500-cent shift that makes formant
// movement measurable is asking for something the mechanism structurally
// cannot do. The first version of this test did exactly that and, worse,
// picked a source pitch of 261.63Hz, which IS C4 and IS in G minor, so the
// engine snapped it to where it already sat and the test measured a shift of
// precisely zero while reporting confident-looking numbers.
// forceBlend pins formantBlend to a constant - the CONTROL ARM.
//
// Split-band only earns its place if it beats the dumbest possible way of
// reducing the same coloration: applying less formant correction. Both
// levers trade boxiness against preservation, so comparing a crossover
// against SHIPPED alone proves nothing - of course it is less coloured, it is
// doing less. The question is whether, AT EQUAL PRESERVATION LOSS, the split
// is less boxy than simply turning the blend down. If it is not, it is added
// complexity buying nothing.
// dual = true selects the DUAL-PATH split instead of the single-path one.
//
// Why the single-path split raises sibilance (+2.7 -> +3.6..3.9 dB):
// `shifted` is not the shifted voice. It is the shifted WHITENED residual
// (x - LPC prediction, line ~1740), which is spectrally flat by design; the
// recolor stage is what puts the voice's natural high-frequency rolloff back.
// Low-passing formantContribution means that above the crossover nothing puts
// it back, so the output up there is flat excitation - brighter than any real
// voice. The split was never "leaving sibilance alone"; it was replacing it
// with whitened noise.
//
// The dual path keeps a SECOND PitchShifter fed the raw, unwhitened input, and
// crosses over between the two:  y = LP(shipped y) + HP(raw shift). Above the
// crossover that is exactly what formant OFF produces, and formant OFF
// measures sib 0.0 against the clean control. Complementary one-pole split, so
// when both paths carry the same signal the sum is exactly that signal.
//
// Known risk, measured rather than assumed: the two shifters splice
// independently, and whitened vs raw waveforms can lead WSOLA to different
// splice points, so the paths may not be phase-aligned at the crossover. If
// that happens it shows up as a dip in the pres/box numbers near the
// crossover frequency, and this arm will look worse than it should.
// shared = true: the dual-path idea, but ONE shifter carrying BOTH signals.
//
// The independent dual path measured a ~1 dB box/presence penalty at every
// crossover and, at 3000Hz, came out WORSE than shipped on presence (-6.2 vs
// -5.5) - a raw shift has no business making 1.5-4kHz quieter. That is the
// two shifters splicing at different positions: whitened and raw waveforms
// correlate differently, so each WSOLA search picks its own landing point and
// the paths drift out of phase and partially cancel across the crossover.
//
// PitchShifter's splice decision is entirely readPos/fadePos plus the
// crossfade weights; the samples come from this.ring. A second ring written
// in lockstep and read at the SAME positions with the SAME weights therefore
// yields a raw output phase-locked to the corrected one by construction, and
// runs no second splice search - so it should also cost less than the
// independent dual path's +40%.
//
// The search keeps running on the primary (whitened) ring, so the corrected
// path is bit-identical to shipped. Only the new above-crossover content is
// new behaviour.
function applySharedShifter(src) {
  const edits = [
    ['this.ring[this.writeCount % this.bufLen] = s;',
     'this.ring[this.writeCount % this.bufLen] = s;\n' +
     '    if (this.auxRing) this.auxRing[this.writeCount % this.bufLen] = (arguments.length > 1 ? arguments[1] : 0);'],
    ['  _readRing(pos) {',
     '  _readAux(pos) { const r = this.ring; this.ring = this.auxRing; const v = this._readRing(pos); this.ring = r; return v; }\n' +
     '  _readRing(pos) {'],
    ['out = this._readRing(this.fadePos) * wOut + this._readRing(this.readPos) * wIn;',
     'out = this._readRing(this.fadePos) * wOut + this._readRing(this.readPos) * wIn;\n' +
     '      if (this.auxRing) this.auxOut = this._readAux(this.fadePos) * wOut + this._readAux(this.readPos) * wIn;'],
    ['out = this._readRing(this.readPos);',
     'out = this._readRing(this.readPos);\n' +
     '      if (this.auxRing) this.auxOut = this._readAux(this.readPos);'],
    ['this.shifter.writeSample(writeSignal);',
     'if (!this.shifter.auxRing) this.shifter.auxRing = new Float32Array(this.shifter.bufLen);\n' +
     'this.shifter.writeSample(writeSignal, x);'],
    ['const shifted = this.shifter.readSample(this.currentRatio);',
     'const shifted = this.shifter.readSample(this.currentRatio);\n' +
     'this.__rawShifted = this.shifter.auxOut;'],
  ];
  for (const [a, b] of edits) {
    const n = src.split(a).length - 1;
    if (n !== 1) throw new Error('shared-shifter anchor matched ' + n + ' times (need exactly 1): ' + a);
    src = src.replace(a, b);
  }
  return src;
}

// order = number of cascaded one-pole stages in the low-pass (6dB/oct each).
//
// Still complementary at any order: y = LPn(corrected) + raw - LPn(raw), so
// when both paths carry the same signal the sum is exactly that signal. What
// the order changes is how much of the CORRECTED path leaks above the
// crossover. A single pole is only 6dB/oct - at a 2500Hz crossover it is
// barely -6dB at 5kHz - so the shipped path's measured +2.7dB of 4-8kHz fizz
// passes straight through. With the paths phase-locked that leak adds
// coherently, which is the best explanation for shared-splice reading +1.7
// sib where the independent dual path (same raw content above the crossover)
// read -0.7.
//
// crossoverHz === 0 returns the unmodified output line: no split at all.
// Used by the isolation arm to measure splice-on-raw on its own.
function crossoverY(crossoverHz, order) {
  const yA = 'let y = shiftedCorrected + formantContribution * this.formantBlend * transitionDampen;';
  if (!crossoverHz) return yA;
  const n = order || 1;
  // n identical poles at fc put the cascade's -3dB point at
  // fc * sqrt(2^(1/n) - 1): 0.64x for n=2, 0.43x for n=4. Uncorrected, an
  // "order 4 at 2500Hz" row would really cross near 1100Hz and be compared
  // against order-1 rows at a different frequency entirely. Scale each stage
  // up so the whole cascade lands its -3dB point on the stated crossover.
  const stageHz = crossoverHz / Math.sqrt(Math.pow(2, 1 / n) - 1);
  return 'let __yShip = shiftedCorrected + formantContribution * this.formantBlend * transitionDampen;\n' +
    'if (this.__dA === undefined) {\n' +
    '  this.__dA = 1 - Math.exp(-2 * Math.PI * ' + stageHz + ' / this.sr);\n' +
    '  this.__lpS = new Float64Array(' + n + '); this.__lpR = new Float64Array(' + n + ');\n' +
    '}\n' +
    'let __s = __yShip, __r = this.__rawShifted;\n' +
    'for (let __i = 0; __i < ' + n + '; __i++) {\n' +
    '  this.__lpS[__i] += (__s - this.__lpS[__i]) * this.__dA; __s = this.__lpS[__i];\n' +
    '  this.__lpR[__i] += (__r - this.__lpR[__i]) * this.__dA; __r = this.__lpR[__i];\n' +
    '}\n' +
    'let y = __s + (this.__rawShifted - __r);';
}

// shared === 'raw' runs the WSOLA splice search on the RAW signal instead of
// the whitened one, by swapping which ring is primary.
//
// Shared-splice with the search on the whitened ring measured sibilance at
// +0.7..+1.9 dB, where the independent dual path got -0.7. Suspected cause:
// the raw path now splices at positions chosen for a DIFFERENT waveform, and
// Round 53 measured exactly what misaligned splices do - leak broadband
// inharmonic energy, which lands in the 4-8kHz band. Searching on raw instead
// makes the above-crossover content splice-optimal; the corrected path takes
// the misaligned splices, but its HF is removed by the crossover and what
// remains is recoloured by the envelope anyway. Cost of this variant: the
// corrected path is no longer bit-identical to shipped.
function buildEngine(crossoverHz, forceCents, forceBlend, dual, shared, order) {
  let src = BASE;
  if (shared) {
    src = applySharedShifter(src);
    if (shared === 'raw') {
      const w = 'this.shifter.writeSample(writeSignal, x);';
      const r = 'const shifted = this.shifter.readSample(this.currentRatio);\nthis.__rawShifted = this.shifter.auxOut;';
      if (!src.includes(w) || !src.includes(r)) throw new Error('raw-search anchors not found');
      src = src.replace(w, 'this.shifter.writeSample(x, writeSignal);');
      src = src.replace(r,
        'this.__rawShifted = this.shifter.readSample(this.currentRatio);\n' +
        'const shifted = this.shifter.auxOut;');
    }
    const yA = 'let y = shiftedCorrected + formantContribution * this.formantBlend * transitionDampen;';
    if (!src.includes(yA)) throw new Error('y anchor not found');
    src = src.replace(yA, crossoverY(crossoverHz, order));
    crossoverHz = 0;
  }
  if (dual) {
    const wA = 'this.shifter.writeSample(writeSignal);';
    const rA = 'const shifted = this.shifter.readSample(this.currentRatio);';
    const yA = 'let y = shiftedCorrected + formantContribution * this.formantBlend * transitionDampen;';
    for (const a of [wA, rA, yA]) if (!src.includes(a)) throw new Error('dual anchor not found: ' + a);
    src = src.replace(wA, wA +
      '\nif (!this.__raw) this.__raw = new PitchShifter(this.sr, 1.0, 40);' +
      '\nthis.__raw.writeSample(x);');
    src = src.replace(rA, rA +
      '\nthis.__raw.periodHint = this.shifter.periodHint;' +
      '\nthis.__rawShifted = this.__raw.readSample(this.currentRatio);');
    src = src.replace(yA,
      'let __yShip = shiftedCorrected + formantContribution * this.formantBlend * transitionDampen;\n' +
      'if (this.__dA === undefined) {\n' +
      '  this.__dA = 1 - Math.exp(-2 * Math.PI * ' + crossoverHz + ' / this.sr);\n' +
      '  this.__lpS = 0; this.__lpR = 0;\n' +
      '}\n' +
      'this.__lpS += (__yShip - this.__lpS) * this.__dA;\n' +
      'this.__lpR += (this.__rawShifted - this.__lpR) * this.__dA;\n' +
      'let y = this.__lpS + (this.__rawShifted - this.__lpR);');
    crossoverHz = 0;   // the single-path patch below must not also apply
  }
  if (forceBlend !== undefined) {
    const bAnchor = 'if (this.formantBlend < 1e-4) this.formantBlend = 0;';
    if (!src.includes(bAnchor)) throw new Error('blend anchor not found');
    src = src.replace(bAnchor, 'this.formantBlend = this.formantBlend > 0 ? ' + forceBlend + ' : 0;');
  }
  if (forceCents) {
    const rAnchor = 'this.targetRatio = Math.max(1 / RATIO_CLAMP, Math.min(RATIO_CLAMP, rawRatio));';
    if (!src.includes(rAnchor)) throw new Error('ratio anchor not found - retune path changed shape');
    src = src.replace(rAnchor,
      'this.targetRatio = ' + Math.pow(2, forceCents / 1200) + ';');
  }
  if (crossoverHz > 0) {
    const anchor = 'let y = shiftedCorrected + formantContribution * this.formantBlend * transitionDampen;';
    if (!src.includes(anchor)) throw new Error('anchor not found - processSample changed shape');
    src = src.replace(anchor,
      'if (this.__fcAlpha === undefined) {\n' +
      '  this.__fcAlpha = 1 - Math.exp(-2 * Math.PI * ' + crossoverHz + ' / this.sr);\n' +
      '  this.__fcState = 0;\n' +
      '}\n' +
      'this.__fcState += (formantContribution - this.__fcState) * this.__fcAlpha;\n' +
      'let y = shiftedCorrected + this.__fcState * this.formantBlend * transitionDampen;'
    );
  }
  const core = src.slice(src.indexOf('// ─── BEGIN DSP CORE'), src.indexOf('// ─── END DSP CORE'));
  const sb = { console, Math, Float32Array, Int16Array, Float64Array };
  vm.createContext(sb);
  vm.runInContext(core + '\nthis.__exports = { AutotuneEngine };', sb);
  return sb.__exports.AutotuneEngine;
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

const SR = 44100;

// Vocal-like source: fundamental in the reported singer's range (82-140Hz,
// median 122), three fixed formants so PRESERVATION is measurable, and real
// sibilant bursts so the noise-like content this is all about is present.
function makeVoice(sr, seconds, f0, withSibilance) {
  const n = Math.floor(sr*seconds);
  const x = new Float32Array(n);
  const formants = [700, 1220, 2600];
  const states = formants.map(() => ({ y1: 0, y2: 0 }));
  const coeffs = formants.map(fHz => {
    const bw = 90, r = Math.exp(-Math.PI*bw/sr), th = 2*Math.PI*fHz/sr;
    return { a1: 2*r*Math.cos(th), a2: -r*r };
  });
  let seed = 9876;
  const rnd = () => { seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff*2 - 1; };
  const period = sr/f0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const t = i/sr;
    let exc = 0;
    if (i >= next) { exc = 1; next += period; }
    let s = 0;
    for (let k = 0; k < formants.length; k++) {
      const st = states[k], c = coeffs[k];
      const y = exc + c.a1*st.y1 + c.a2*st.y2;
      st.y2 = st.y1; st.y1 = y;
      s += y;
    }
    s /= formants.length;
    if (withSibilance && (t % 0.6) > 0.48) s += rnd()*0.9;
    x[i] = s*0.25;
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
  return { y, cpu: (Number(t1-t0)/1e9)/(x.length/sr) };
}

const P = { key: 7, scale: 'minor', retuneSpeedMs: 5, trackingSpeedMs: 120,
            humanize: 0, naturalVibrato: 0, flexTune: 0 };

// ── 1. COLORATION: small correction, does the split reduce the damage? ──
// 50 cents off so correction is genuinely engaged.
const dryColor = makeVoice(SR, 6, 122*Math.pow(2, 50/1200), true);
const dcSpec = spectrum(dryColor, SR);
const dcBox = band(dcSpec,250,630) - band(dcSpec,1500,4000);
const dcPres = band(dcSpec,1500,4000);
const dcSib = band(dcSpec,4000,8000);

// ── 2. PRESERVATION: big shift, does the envelope still track the original? ──
// A 5-semitone correction is where formant correction earns its keep.
//
// Sibilance ON, deliberately. The first version passed false here, which was
// self-defeating: the whole point of the split is that it stops touching
// content above the crossover, so a signal with no energy up there cannot
// show any difference between crossovers. That is why the old run printed an
// identical preservation number for 2000Hz through 8000Hz - there was
// nothing above 2kHz for the low-pass to change.
const PRES_CENTS = -500;                 // driven directly, see buildEngine
const dryPres = makeVoice(SR, 5, 196.00, true);
const dpSpec = spectrum(dryPres, SR);
// Measure where the FORMANT PEAKS actually sit, and compare against where the
// source put them (700/1220/2600Hz, fixed by construction).
//
// The first version of this compared band ENERGIES between input and output
// and was worthless: the output is pitch-shifted, so it is a different
// harmonic comb sampling the same envelope, and it normalised by the 250-630Hz
// band which itself moves with the shift. It reported formant OFF as
// PRESERVING BETTER than formant ON - the exact opposite of what formant
// correction does - and returned an identical 0.80 at every crossover, which
// is what finally gave it away.
//
// Peak positions are the real question and are robust to all of that. Without
// correction the formants ride the pitch shift and move by the shift ratio;
// with correction they should stay put. Smooth hard in log-frequency first so
// individual harmonics do not register as peaks.
// Measured by CROSS-CORRELATION in log frequency, not by matching peaks.
//
// Peak matching was the previous attempt and it quietly saturates. A shift is
// measured as the distance to the NEAREST source formant, but once the shift
// approaches the spacing between formants, a shifted peak sits closer to its
// neighbour's home than to its own: at -500 cents, F2 lands on 914Hz, which is
// 466 cents from the 700Hz target while the correctly-shifted F1 at 524Hz is a
// full 500 cents from it. Peaks get assigned to the wrong formants and the
// reported movement collapses toward zero - which is exactly the 112c the run
// produced for a shift that was genuinely 500c.
//
// Correlating the whole envelope has no assignment step to get wrong. On a
// constant-cents axis a pitch shift is a pure translation, so the lag that
// maximises correlation IS the shift, however large.
const LOGF_LO = 250, LOGF_HI = 4500, LOGF_PTS = 361;   // ~=  transform axis
const CENTS_PER_BIN = 1200 * Math.log2(LOGF_HI / LOGF_LO) / (LOGF_PTS - 1);

// Cepstral liftering, not box smoothing.
//
// Box smoothing in log-frequency cannot separate the envelope from the
// harmonic comb, and the failure is not subtle: harmonic spacing in CENTS
// grows as frequency falls, so down at 250-600Hz the harmonics of a 196Hz
// fundamental are hundreds of cents apart and sail through any smoother wide
// enough to be useful higher up. The comb then dominates the correlation, and
// since the comb moves by exactly the shift that was imposed, the metric
// reports the shift back at you no matter what the formants did. That is what
// produced a flat 500c down the entire column with correlation stuck below
// 0.8 - a number that looked like a passing result and was pure tautology.
//
// The cepstrum separates them by construction: convolution in the time domain
// is addition in the log-spectral domain, so the slow envelope lands in low
// quefrency and the periodic comb lands in a peak at the pitch period. Cutting
// above LIFTER_CUT keeps the vocal tract and discards the excitation.
const LIFTER_CUT = 60;    // well below the ~225-sample period of a 196Hz f0

function cepstralEnvelope(sp) {
  const N = sp.N;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k < N/2; k++) {
    const v = Math.log((sp.acc[k] || 1e-12) + 1e-12);
    re[k] = v; re[N-1-k] = v;            // mirror: real, even -> real cepstrum
  }
  fft(re, im);                            // into quefrency
  for (let q = LIFTER_CUT; q < N - LIFTER_CUT; q++) { re[q] = 0; im[q] = 0; }
  // Inverse via conjugation, so the forward transform is the only one needed.
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  const env = new Float64Array(N/2);
  for (let k = 0; k < N/2; k++) env[k] = (re[k] / N) * (20 / Math.LN10);  // dB
  return env;
}

function logEnvelope(sp) {
  const env = cepstralEnvelope(sp);
  const out = [];
  for (let i = 0; i < LOGF_PTS; i++) {
    const f = LOGF_LO * Math.pow(LOGF_HI / LOGF_LO, i / (LOGF_PTS - 1));
    const k = Math.round(f * sp.N / sp.sr);
    out.push(env[Math.min(env.length - 1, k)]);
  }
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  return out.map(v => v - mean);          // zero-mean: level must not matter
}

const refEnv = () => logEnvelope(dpSpec);

// Returns how far the envelope moved, in cents. Sign discarded - magnitude is
// the question. Also returns the correlation score so a meaningless match
// (flat or noisy envelope) can be told apart from a confident one.
function formantShiftCents(outSpec) {
  const a = refEnv(), b = logEnvelope(outSpec);
  const maxLag = Math.round(800 / CENTS_PER_BIN);
  let bestLag = 0, bestR = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < LOGF_PTS; i++) {
      const j = i + lag;
      if (j < 0 || j >= LOGF_PTS) continue;
      num += a[i] * b[j]; da += a[i] * a[i]; db += b[j] * b[j];
    }
    const r = num / Math.sqrt(da * db + 1e-12);
    if (r > bestR) { bestR = r; bestLag = lag; }
  }
  return { cents: Math.abs(bestLag * CENTS_PER_BIN), matched: bestR.toFixed(2) };
}

console.log('Split-band formant correction - crossover sweep');
console.log('Low-passing formantContribution so the correction applies to the');
console.log('formant region only and leaves sibilance as shifted signal.\n');
console.log('COLORATION (small correction, vs clean control - lower box is better)');
console.log('PRESERVATION (-500 cent shift; how far the formant PEAKS moved, in');
console.log('              cents. 0 = held in place, ~500 = rode the shift.)\n');

const fmt = (r) => r ? (r.cents.toFixed(0).padStart(4) + 'c/' + r.matched) : '  --';

// Baselines.
const offColor = run(buildEngine(0), dryColor, SR, { ...P, formantCorrection: false });
const offPres  = run(buildEngine(0, PRES_CENTS), dryPres, SR, { ...P, formantCorrection: false });
const offSpecC = spectrum(offColor.y, SR);
const offMove  = formantShiftCents(spectrum(offPres.y, SR));
console.log('  formant OFF (baseline)      box ' +
  ((band(offSpecC,250,630)-band(offSpecC,1500,4000))-dcBox).toFixed(1).padStart(5) +
  '  pres ' + (band(offSpecC,1500,4000)-dcPres).toFixed(1).padStart(5) +
  '  sib ' + (band(offSpecC,4000,8000)-dcSib).toFixed(1).padStart(5) +
  '   moved ' + fmt(offMove) + '  <- no correction at all');
console.log('');

// SANITY GATE. Everything below is meaningless unless the metric can tell
// correction from no correction, so check that first and say so loudly.
// The previous version of this test failed exactly here and I read its
// numbers anyway: it scored formant OFF as preserving BETTER than formant
// ON, which is backwards, because it compared band energies between two
// different harmonic combs. A metric that cannot reproduce the known-good
// case cannot be trusted on the unknown one.
const SANITY_MIN_CENTS = 200;   // uncorrected formants must visibly move
// ON must be SUBSTANTIALLY better than OFF, not merely lower. The first
// version of this gate asked only for ON < OFF and duly passed 500c against
// 514c - a difference of one 13.9-cent bin, i.e. noise, on a column that was
// otherwise flat at exactly the imposed shift. A threshold that a single bin
// of jitter can satisfy is not a threshold.
const SANITY_MAX_ON_RATIO = 0.6;
// And the correlation must actually be confident, or the lag it reports is
// just where the noise happened to line up best.
const SANITY_MIN_R = 0.85;

let shippedMove = null;
for (const fc of [0, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000]) {
  const c = run(buildEngine(fc), dryColor, SR, { ...P, formantCorrection: true });
  const p = run(buildEngine(fc, PRES_CENTS), dryPres, SR, { ...P, formantCorrection: true });
  const cs = spectrum(c.y, SR);
  const mv = formantShiftCents(spectrum(p.y, SR));
  if (fc === 0) shippedMove = mv;
  const label = fc === 0 ? 'SHIPPED (no split)' : 'crossover ' + fc + 'Hz';
  console.log('  ' + label.padEnd(28) +
    'box ' + (((band(cs,250,630)-band(cs,1500,4000))-dcBox)).toFixed(1).padStart(5) +
    '  pres ' + (band(cs,1500,4000)-dcPres).toFixed(1).padStart(5) +
    '  sib ' + (band(cs,4000,8000)-dcSib).toFixed(1).padStart(5) +
    '   moved ' + fmt(mv) +
    '   cpu ' + c.cpu.toFixed(3));
}

// ── CONTROL ARM: plain blend reduction, no split ──
console.log('');
console.log('CONTROL - just less formant correction (no split-band at all):');
for (const b of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
  const c = run(buildEngine(0, undefined, b), dryColor, SR, { ...P, formantCorrection: true });
  const p = run(buildEngine(0, PRES_CENTS, b), dryPres, SR, { ...P, formantCorrection: true });
  const cs = spectrum(c.y, SR);
  console.log('  blend ' + b.toFixed(2).padEnd(22) +
    'box ' + (((band(cs,250,630)-band(cs,1500,4000))-dcBox)).toFixed(1).padStart(5) +
    '  pres ' + (band(cs,1500,4000)-dcPres).toFixed(1).padStart(5) +
    '  sib ' + (band(cs,4000,8000)-dcSib).toFixed(1).padStart(5) +
    '   moved ' + fmt(formantShiftCents(spectrum(p.y, SR))));
}
console.log('');
console.log('DUAL-PATH split (corrected below crossover, RAW shift above it):');
for (const fc of [1000, 1500, 2000, 3000]) {
  const c = run(buildEngine(fc, undefined, undefined, true), dryColor, SR, { ...P, formantCorrection: true });
  const p = run(buildEngine(fc, PRES_CENTS, undefined, true), dryPres, SR, { ...P, formantCorrection: true });
  const cs = spectrum(c.y, SR);
  console.log('  dual ' + (fc + 'Hz').padEnd(23) +
    'box ' + (((band(cs,250,630)-band(cs,1500,4000))-dcBox)).toFixed(1).padStart(5) +
    '  pres ' + (band(cs,1500,4000)-dcPres).toFixed(1).padStart(5) +
    '  sib ' + (band(cs,4000,8000)-dcSib).toFixed(1).padStart(5) +
    '   moved ' + fmt(formantShiftCents(spectrum(p.y, SR))) +
    '   cpu ' + c.cpu.toFixed(3));
}
console.log('  Success here = sib back near 0.0 (formant OFF\'s value) while');
console.log('  box/moved stay close to the single-path row at the same crossover.');
console.log('');
console.log('SHARED-SPLICE split (one shifter, both signals, phase-locked):');
for (const fc of [1000, 1500, 2000, 2500, 3000]) {
  const c = run(buildEngine(fc, undefined, undefined, false, true), dryColor, SR, { ...P, formantCorrection: true });
  const p = run(buildEngine(fc, PRES_CENTS, undefined, false, true), dryPres, SR, { ...P, formantCorrection: true });
  const cs = spectrum(c.y, SR);
  console.log('  shared ' + (fc + 'Hz').padEnd(21) +
    'box ' + (((band(cs,250,630)-band(cs,1500,4000))-dcBox)).toFixed(1).padStart(5) +
    '  pres ' + (band(cs,1500,4000)-dcPres).toFixed(1).padStart(5) +
    '  sib ' + (band(cs,4000,8000)-dcSib).toFixed(1).padStart(5) +
    '   moved ' + fmt(formantShiftCents(spectrum(p.y, SR))) +
    '   cpu ' + c.cpu.toFixed(3));
}
console.log('  Success here = sib near 0.0 like dual, AND box/pres at least as');
console.log('  good as dual at the same crossover (no phase-cancellation penalty),');
console.log('  AND cpu below dual\'s ~0.30. If shared 3000Hz still reads worse');
console.log('  than SHIPPED on pres, phase was not the cause and I was wrong.');
console.log('');
console.log('SHARED-SPLICE, search on RAW (tests the sibilance explanation):');
for (const fc of [2000, 2500, 3000]) {
  const c = run(buildEngine(fc, undefined, undefined, false, 'raw'), dryColor, SR, { ...P, formantCorrection: true });
  const p = run(buildEngine(fc, PRES_CENTS, undefined, false, 'raw'), dryPres, SR, { ...P, formantCorrection: true });
  const cs = spectrum(c.y, SR);
  console.log('  sharedRaw ' + (fc + 'Hz').padEnd(18) +
    'box ' + (((band(cs,250,630)-band(cs,1500,4000))-dcBox)).toFixed(1).padStart(5) +
    '  pres ' + (band(cs,1500,4000)-dcPres).toFixed(1).padStart(5) +
    '  sib ' + (band(cs,4000,8000)-dcSib).toFixed(1).padStart(5) +
    '   moved ' + fmt(formantShiftCents(spectrum(p.y, SR))) +
    '   cpu ' + c.cpu.toFixed(3));
}
console.log('  If sib drops toward dual\'s -0.7 while box/pres hold near the shared');
console.log('  rows above, the splice-alignment explanation is right. If sib does');
console.log('  not move, it is something else and I will not guess at it.');

// ── Isolation: splice search on RAW, NO split. ──
// sharedRaw beat SHIPPED on preservation (42c/28c vs 56c), which the
// crossover alone cannot explain - every whitened-search split row was WORSE
// than shipped on preservation. The claim is that shipped's splice search,
// running on the flat whitened residual, is itself degrading the corrected
// path. If so, this row alone should show moved well under 56c with box/pres/
// sib roughly unchanged from SHIPPED (no split = no coloration change).
console.log('');
console.log('ISOLATION - splice search on RAW, no split (is the search itself the win?):');
{
  const c = run(buildEngine(0, undefined, undefined, false, 'raw'), dryColor, SR, { ...P, formantCorrection: true });
  const p = run(buildEngine(0, PRES_CENTS, undefined, false, 'raw'), dryPres, SR, { ...P, formantCorrection: true });
  const cs = spectrum(c.y, SR);
  console.log('  rawSearch, no split         ' +
    'box ' + (((band(cs,250,630)-band(cs,1500,4000))-dcBox)).toFixed(1).padStart(5) +
    '  pres ' + (band(cs,1500,4000)-dcPres).toFixed(1).padStart(5) +
    '  sib ' + (band(cs,4000,8000)-dcSib).toFixed(1).padStart(5) +
    '   moved ' + fmt(formantShiftCents(spectrum(p.y, SR))) +
    '   cpu ' + c.cpu.toFixed(3));
  console.log('  compare to SHIPPED: box 3.5  pres -5.5  sib 2.7  moved 56c');
}

// ── Steeper crossover on sharedRaw: does the leak explain sib? ──
console.log('');
console.log('sharedRaw, STEEPER crossover (order = poles, 6dB/oct each, all at -3dB = fc):');
for (const [fc, ord] of [[2500,1],[2500,2],[2500,4],[3000,1],[3000,2],[3000,4]]) {
  const c = run(buildEngine(fc, undefined, undefined, false, 'raw', ord), dryColor, SR, { ...P, formantCorrection: true });
  const p = run(buildEngine(fc, PRES_CENTS, undefined, false, 'raw', ord), dryPres, SR, { ...P, formantCorrection: true });
  const cs = spectrum(c.y, SR);
  console.log('  ' + (fc + 'Hz order ' + ord).padEnd(28) +
    'box ' + (((band(cs,250,630)-band(cs,1500,4000))-dcBox)).toFixed(1).padStart(5) +
    '  pres ' + (band(cs,1500,4000)-dcPres).toFixed(1).padStart(5) +
    '  sib ' + (band(cs,4000,8000)-dcSib).toFixed(1).padStart(5) +
    '   moved ' + fmt(formantShiftCents(spectrum(p.y, SR))) +
    '   cpu ' + c.cpu.toFixed(3));
}
console.log('  Leak explanation is right if sib falls as order rises (toward');
console.log('  dual\'s -0.7). Watch pres too: a steeper complementary split can');
console.log('  bump or notch right at the crossover, which lands in 1.5-4kHz.');
console.log('');
console.log('  Read the two tables TOGETHER, matching rows by "moved" (equal');
console.log('  preservation cost). Split-band is only worth shipping if, at the');
console.log('  same moved, its box is clearly lower than the control\'s. If the');
console.log('  two curves lie on top of each other, the crossover is just a');
console.log('  roundabout blend control and should not be added.');

// ── The gate, evaluated after the table so the numbers are visible either way ──
console.log('');
const offC = offMove ? offMove.cents : 0;
const shC  = shippedMove ? shippedMove.cents : 0;
const offR = offMove ? parseFloat(offMove.matched) : 0;
const shR  = shippedMove ? parseFloat(shippedMove.matched) : 0;
const weakCorr = Math.min(offR, shR) < SANITY_MIN_R;
if (offC < SANITY_MIN_CENTS || shC > offC * SANITY_MAX_ON_RATIO || weakCorr) {
  console.log('METRIC FAILED ITS SANITY CHECK - IGNORE THE NUMBERS ABOVE.');
  console.log('  formant OFF moved ' + offC.toFixed(0) + 'c (r=' + offR.toFixed(2) + '), ' +
              'formant ON moved ' + shC.toFixed(0) + 'c (r=' + shR.toFixed(2) + ').');
  if (offC < SANITY_MIN_CENTS)
    console.log('  -> OFF should ride the full shift (>=' + SANITY_MIN_CENTS + 'c). It did not, so the');
  else if (weakCorr)
    console.log('  -> correlation below ' + SANITY_MIN_R + ': the lag is where noise lined up, not a');
  else
    console.log('  -> ON is not meaningfully better than OFF (needs <' +
                (SANITY_MAX_ON_RATIO * 100) + '% of it), so the');
  console.log('     preservation column is not measuring formant preservation.');
  console.log('  No crossover should be adopted on the strength of it.');
} else {
  console.log('Sanity check PASSED: OFF ' + offC.toFixed(0) + 'c vs ON ' + shC.toFixed(0) +
              'c - the metric can see correction working.');
  console.log('');
  console.log('What a win looks like:');
  console.log('  box down versus SHIPPED, while "moved" stays near SHIPPED and');
  console.log('  well below the formant-OFF number. If moved climbs toward');
  console.log('  formant-OFF, the crossover has just switched the feature off');
  console.log('  quietly and the apparent improvement is worthless.');
}
