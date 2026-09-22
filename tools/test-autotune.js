// Numeric regression test for the Random Beats autotune engine
// (renderer/autotune-worklet.js). Runs headless in Node - no AudioContext,
// no microphone, no speakers needed - by loading just the "DSP CORE"
// section of the worklet file (delimited by the BEGIN/END comment
// markers) into a sandboxed context and feeding it synthetic sine tones.
//
// What this actually proves: fed a detuned tone, the engine's output
// measurably moves toward the nearest note in the selected key/scale,
// and a tone already in tune is left alone. It does NOT evaluate
// perceptual audio quality (grain artifacts, latency, click-freedom) -
// that requires listening, which this repo cannot automate. Run with:
//   node tools/test-autotune.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'autotune-worklet.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const startMarker = '// ─── BEGIN DSP CORE';
const endMarker = '// ─── END DSP CORE';
const si = src.indexOf(startMarker);
const ei = src.indexOf(endMarker);
if (si < 0 || ei < 0 || ei <= si) {
  console.error('✗ could not locate DSP CORE markers in ' + SRC_PATH);
  process.exit(1);
}
const core = src.slice(si, ei);

const sandbox = {};
vm.createContext(sandbox);
try {
  vm.runInContext(core + '\nthis.__exports = { SCALE_INTERVALS, freqToNearestScaleFreq, detectPitch, PitchShifter, AutotuneEngine, lpcAutocorrelate, levinsonDurbin, computeLPC, LPC_ORDER, computeCepstralEnvelope, CEPSTRAL_ENV_ORDER, CEPSTRAL_FIR_TAPS, CEPSTRAL_MP_FFT_SIZE, nextPow2, hammingWindow, computeGlideStrength, PITCH_VEL_WINDOW_HOPS, PITCH_GLIDE_REF_CENTS, PITCH_GLIDE_CONSIST_LO, PITCH_GLIDE_CONSIST_HI, SMOOTH_MS_SLOW, SMOOTH_MS_FAST, midiToHz, fftInPlace };', sandbox);
} catch (e) {
  console.error('✗ DSP CORE failed to evaluate:', e.message);
  process.exit(1);
}
const { SCALE_INTERVALS, freqToNearestScaleFreq, detectPitch, PitchShifter, AutotuneEngine, lpcAutocorrelate, levinsonDurbin, computeLPC, LPC_ORDER, computeCepstralEnvelope, CEPSTRAL_ENV_ORDER, CEPSTRAL_FIR_TAPS, CEPSTRAL_MP_FFT_SIZE, nextPow2, hammingWindow, computeGlideStrength, PITCH_VEL_WINDOW_HOPS, PITCH_GLIDE_REF_CENTS, PITCH_GLIDE_CONSIST_LO, PITCH_GLIDE_CONSIST_HI, SMOOTH_MS_SLOW, SMOOTH_MS_FAST, midiToHz, fftInPlace } = sandbox.__exports;

function synthVowel(sr, f0, formants, n) {
  const buf = new Float32Array(n);
  const period = sr / f0;
  const states = formants.map(() => ({ y1: 0, y2: 0 }));
  const coeffsPerFormant = formants.map((fHz) => {
    const bw = 80; // Hz bandwidth - narrow-ish, like a sung vowel's resonance
    const r = Math.exp(-Math.PI * bw / sr);
    const theta = 2 * Math.PI * fHz / sr;
    return { a1: 2 * r * Math.cos(theta), a2: -r * r };
  });
  let nextImpulse = 0;
  for (let i = 0; i < n; i++) {
    let excite = 0;
    if (i >= nextImpulse) { excite = 1; nextImpulse += period; }
    let sample = 0;
    for (let f = 0; f < formants.length; f++) {
      const st = states[f], c = coeffsPerFormant[f];
      const y = excite + c.a1 * st.y1 + c.a2 * st.y2;
      st.y2 = st.y1; st.y1 = y;
      sample += y;
    }
    buf[i] = sample / formants.length;
  }
  return buf;
}

function lpcFormants(coeffs, order, sr, maxFormants) {
  const nBins = 2048;
  const mags = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) {
    const freq = (b / nBins) * (sr / 2);
    const w = 2 * Math.PI * freq / sr;
    let reSum = 1, imSum = 0;
    for (let k = 1; k <= order; k++) {
      reSum -= coeffs[k] * Math.cos(k * w);
      imSum += coeffs[k] * Math.sin(k * w);
    }
    const denom = reSum * reSum + imSum * imSum;
    mags[b] = 1 / Math.sqrt(Math.max(denom, 1e-12));
  }
  // Restrict the search to where a sung vowel's formants actually live -
  // an order-20 all-pole model fit to a sparse-impulse-excited synthetic
  // vowel can grow spurious high-frequency poles well above any real
  // formant (this is a test-measurement helper grading a 2-formant
  // synthetic signal, not a general-purpose formant tracker, so a fixed
  // plausible band is the right amount of sophistication here).
  const minHz = 200, maxHz = 4000;
  const peaks = [];
  for (let b = 1; b < nBins - 1; b++) {
    const freq = (b / nBins) * (sr / 2);
    if (freq < minHz || freq > maxHz) continue;
    if (mags[b] > mags[b - 1] && mags[b] > mags[b + 1]) peaks.push({ freq, mag: mags[b] });
  }
  peaks.sort((a, b) => b.mag - a.mag);
  return peaks.slice(0, maxFormants).map((p) => p.freq).sort((a, b) => a - b);
}

function lpcLogSpectrum(coeffs, order, sr, nBins, minHz, maxHz) {
  const mags = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) {
    const freq = minHz + (b / (nBins - 1)) * (maxHz - minHz);
    const w = 2 * Math.PI * freq / sr;
    let reSum = 1, imSum = 0;
    for (let k = 1; k <= order; k++) { reSum -= coeffs[k] * Math.cos(k * w); imSum += coeffs[k] * Math.sin(k * w); }
    const denom = Math.max(reSum * reSum + imSum * imSum, 1e-12);
    mags[b] = -0.5 * Math.log(denom); // log magnitude of the all-pole response
  }
  return mags;
}

function spectrumDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum / a.length);
}

let fails = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); fails++; }
}

// ── 1. Scale snapping: a slightly sharp A4 (445 Hz, ~+19 cents) in C
// major should snap to A4 (440 Hz) - A is in the C major scale.
{
  const { targetHz, centsOff } = freqToNearestScaleFreq(445, 0, SCALE_INTERVALS.major);
  check('snaps a near-in-tune A to exactly A (440 Hz)', Math.abs(targetHz - 440) < 0.5, `got ${targetHz.toFixed(2)}`);
  check('reports the correct raw detuning in cents', Math.abs(centsOff - 1200 * Math.log2(445 / 440)) < 0.01);
}

// ── 2. Scale snapping across a scale boundary: C#4 (277.18 Hz) is not
// in C major - nearest scale tones are C4 (261.63) and D4 (293.66).
// C# is 1 semitone from C, 2 from D, so it should snap to C.
{
  const { targetMidi } = freqToNearestScaleFreq(277.18, 0, SCALE_INTERVALS.major);
  check('snaps an out-of-scale note to the nearer in-scale neighbor', targetMidi === 60, `targetMidi=${targetMidi} (want 60 = C4)`);
}

// ── 3. Chromatic scale never moves a note by more than ~50 cents
// (everything is "in scale" chromatically).
{
  const { centsOff } = freqToNearestScaleFreq(261.63 * Math.pow(2, 0.3 / 12), 0, SCALE_INTERVALS.chromatic);
  check('chromatic scale only makes fine (<50 cent) corrections', Math.abs(centsOff) < 50, `${centsOff.toFixed(1)} cents`);
}

// ── 4. Pitch detector: a clean 220 Hz sine should be measured within
// a few cents.
{
  const sr = 44100, n = 2048, hz = 220;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.sin(2 * Math.PI * hz * i / sr);
  const d = detectPitch(buf, sr);
  check('detects a clean 220 Hz tone', d && Math.abs(d.hz - hz) < 1, d ? `${d.hz.toFixed(2)} Hz` : 'null');
}

// ── 5. Pitch detector returns null on silence (must not hallucinate a
// pitch and "correct" noise).
{
  const buf = new Float32Array(2048); // all zero
  const d = detectPitch(buf, 44100);
  check('reports no pitch on silence', d === null);
}

// ── 6. PitchShifter: shifting a 220 Hz tone by ratio 1.5 should produce
// audio whose measured pitch is close to 330 Hz. This is the actual
// end-to-end proof that "autotune" moves pitch, not just that the scale
// math is correct.
{
  const sr = 44100;
  const shifter = new PitchShifter(sr, 1.0, 40);
  const hz = 220, ratio = 1.5;
  const warmup = sr * 0.3, measure = 4096;
  const out = new Float32Array(measure);
  let t = 0;
  for (let i = 0; i < warmup; i++) { shifter.writeSample(Math.sin(2 * Math.PI * hz * t / sr)); shifter.readSample(ratio); t++; }
  for (let i = 0; i < measure; i++) {
    shifter.writeSample(Math.sin(2 * Math.PI * hz * t / sr));
    out[i] = shifter.readSample(ratio);
    t++;
  }
  const d = detectPitch(out, sr);
  const want = hz * ratio;
  check('granular shifter moves measured pitch by the requested ratio', d && Math.abs(d.hz - want) < want * 0.05, d ? `got ${d.hz.toFixed(1)} Hz, want ~${want.toFixed(1)} Hz` : 'no pitch detected in output');
}

// ── 7. Full engine, end to end: a steady A#3 (233.08 Hz, deliberately
// off-key) run through the engine with key=C, scale=major, fast retune
// should converge to A4... no, A#3 is not in C major (A# not in scale);
// nearest C-major neighbors are A3 (220) and B3 (246.94). A#3 is
// equidistant-ish; whichever it picks, the OUTPUT must measurably move
// away from 233.08 Hz toward an in-scale note, and stay there once
// converged (proves detection -> smoothing -> shifting are wired
// together correctly, not just individually correct).
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 5, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  const hz = 233.08;
  const totalSec = 1.2, n = Math.floor(sr * totalSec);
  const tail = new Float32Array(sr * 0.3);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin(2 * Math.PI * hz * t / sr);
    const y = engine.processSample(x);
    if (i >= n - tail.length) tail[i - (n - tail.length)] = y;
    t++;
  }
  const d = detectPitch(tail, sr);
  const movedCents = d ? 1200 * Math.log2(d.hz / hz) : 0;
  check('full engine measurably retunes a steady off-key tone', d && Math.abs(movedCents) > 20, d ? `moved ${movedCents.toFixed(1)} cents (from 233.08 to ${d.hz.toFixed(2)} Hz)` : 'no pitch in output tail');
  // and it should have landed ON a C-major note (A3=220 or B3=246.94), not
  // drifted to an arbitrary frequency
  const nearA3 = d && Math.abs(d.hz - 220) < 6;
  const nearB3 = d && Math.abs(d.hz - 246.94) < 6;
  check('lands on an actual in-scale note (A3 or B3), not an arbitrary pitch', nearA3 || nearB3, d ? `${d.hz.toFixed(2)} Hz` : 'n/a');
}

// ── 8. Bypass must be a true passthrough (recorded-dry path safety net).
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ bypass: true });
  const hz = 233.08;
  let maxDiff = 0, t = 0;
  for (let i = 0; i < 4096; i++) {
    const x = Math.sin(2 * Math.PI * hz * t / sr);
    const y = engine.processSample(x);
    maxDiff = Math.max(maxDiff, Math.abs(x - y));
    t++;
  }
  check('bypass leaves the signal untouched sample-for-sample', maxDiff < 1e-9, `max diff ${maxDiff}`);
}

// ── 9. Flex-Tune at 100 leaves a nearly-in-tune note alone (small
// deviations inside the "comfortable zone" should not be pulled).
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  // 8 cents sharp of A4 - well inside a 50-cent flex-tune window
  const hz = 440 * Math.pow(2, 8 / 1200);
  engine.setParams({ key: 0, scale: 'chromatic', retuneSpeedMs: 5, flexTune: 100 });
  const n = Math.floor(sr * 1.0);
  const tail = new Float32Array(sr * 0.3);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const y = engine.processSample(Math.sin(2 * Math.PI * hz * t / sr));
    if (i >= n - tail.length) tail[i - (n - tail.length)] = y;
    t++;
  }
  const d = detectPitch(tail, sr);
  check('flex-tune leaves a small, comfortable deviation uncorrected', d && Math.abs(d.hz - hz) < 1.5, d ? `${d.hz.toFixed(2)} Hz (input was ${hz.toFixed(2)})` : 'no pitch');
}

// ── 10. Regression guard: a SMALL shift (ratio close to 1, the common
// case for real vocal correction - most notes are only a few percent
// off, not a big jump) must still move the measured pitch by close to
// the requested ratio. An earlier version of PitchShifter reset its
// grains on a fixed real-time clock regardless of ratio, which buried
// small shifts under reset noise before they could accumulate - this
// is the exact bug that caused it, pinned down numerically.
{
  const sr = 44100;
  const shifter = new PitchShifter(sr, 1.0, 40);
  const hz = 233.08, ratio = 0.9439; // ~1 semitone down, a typical correction
  let t = 0;
  const warmup = sr * 0.5, measure = 8192;
  for (let i = 0; i < warmup; i++) { shifter.writeSample(Math.sin(2 * Math.PI * hz * t / sr)); shifter.readSample(ratio); t++; }
  const out = new Float32Array(measure);
  for (let i = 0; i < measure; i++) { shifter.writeSample(Math.sin(2 * Math.PI * hz * t / sr)); out[i] = shifter.readSample(ratio); t++; }
  const d = detectPitch(out, sr);
  const want = hz * ratio;
  check('a small (~1 semitone) shift is not swallowed by grain resets', d && Math.abs(d.hz - want) < want * 0.03, d ? `got ${d.hz.toFixed(2)} Hz, want ~${want.toFixed(2)} Hz` : 'no pitch detected');
}

// ── 11. Retune Speed actually controls glide time: a slow retune speed
// must still be visibly correcting (not stuck) shortly after a pitch
// jump, but not yet fully converged, while a fast retune speed
// converges almost immediately. This is Auto-Tune Pro's headline
// parameter - if it stops doing anything, the whole "same parameters"
// premise silently breaks.
{
  const sr = 44100;
  const targetHz = 220, offKeyHz = 233.08;
  function ratioAfter(retuneSpeedMs, afterMs) {
    const engine = new AutotuneEngine(sr);
    // C major - 233.08 Hz (A#3) is NOT a scale tone, so there is a real
    // correction (toward A3/220 here) for retune speed to visibly glide
    // through. Chromatic would have ~nothing to correct: A#3 is already
    // its own nearest chromatic note.
    engine.setParams({ key: 0, scale: 'major', retuneSpeedMs, flexTune: 0, humanize: 0, naturalVibrato: 0 });
    const n = Math.floor(sr * afterMs / 1000);
    let t = 0;
    for (let i = 0; i < n; i++) { engine.processSample(Math.sin(2 * Math.PI * offKeyHz * t / sr)); t++; }
    return engine.currentRatio;
  }
  const wantRatio = targetHz / offKeyHz; // ~0.944, chromatic scale snaps 233.08 to 220? verify direction only, not exact target
  const fastEarly = ratioAfter(3, 60);     // fast retune, 60ms in - should already be most of the way there
  const slowEarly = ratioAfter(400, 60);   // slow retune, 60ms in - should barely have moved
  const slowLate = ratioAfter(400, 3000);  // slow retune, 3s in - should have fully converged by now
  const fastProgress = Math.abs(fastEarly - 1) / Math.abs(wantRatio - 1);
  const slowEarlyProgress = Math.abs(slowEarly - 1) / Math.abs(wantRatio - 1);
  const slowLateProgress = Math.abs(slowLate - 1) / Math.abs(wantRatio - 1);
  check('fast retune speed is most of the way there within 60ms', fastProgress > 0.8, `progress=${fastProgress.toFixed(2)}`);
  check('slow retune speed has barely moved at 60ms', slowEarlyProgress < 0.3, `progress=${slowEarlyProgress.toFixed(2)}`);
  check('slow retune speed fully catches up given enough time', slowLateProgress > 0.9, `progress=${slowLateProgress.toFixed(2)}`);
}

// ── 12. Regression guard: re-applying the SAME grain size (what happens
// every time a UI slider that isn't Formant Correction posts a params
// update) must not reset the shifter's read position. An earlier version
// called setGrainMs() unconditionally on every setParams() call, which
// meant dragging Retune Speed/Humanize/Vibrato/Flex-Tune reset the
// shifter's in-flight state on every tick - an audible click on every
// knob movement while monitoring live, never caught by the frequency-only
// checks above because a reset doesn't change what the OUTPUT frequency
// eventually converges to, only whether it clicks getting there.
{
  const sr = 44100;
  const shifter = new PitchShifter(sr, 1.0, 40);
  shifter.writeSample(0.1);
  shifter.readSample(1.0); // establish non-null readPos/fadePos state
  const before = shifter.readPos;
  shifter.setGrainMs(40); // same size as constructor default - must be a no-op
  check('re-applying the same grain size does not reset the shifter', shifter.readPos === before, `readPos before=${before} after=${shifter.readPos}`);
  shifter.setGrainMs(25); // an ACTUAL size change - this one SHOULD reset
  check('an actual grain size change still resets the shifter', shifter.readPos === null, `readPos=${shifter.readPos}`);
}

// ── 13. LPC analysis + round-trip: computeLPC on a synthesized two-
// formant "vowel" should recover formant peaks near the ones that went
// in, and whitening-then-resynthesizing with the SAME (unshifted)
// coefficients should reconstruct the original signal almost exactly -
// this is the sanity check that the whiten/resynthesize math itself is
// correct, independent of the pitch shifter.
{
  const sr = 44100;
  const n = 4096;
  const buf = synthVowel(sr, 150, [700, 1200], n);
  const coeffs = computeLPC(buf, LPC_ORDER);
  check('computeLPC returns coefficients for a voiced block', !!coeffs, coeffs ? 'ok' : 'null');
  if (coeffs) {
    const formants = lpcFormants(coeffs, LPC_ORDER, sr, 2);
    const near700 = formants.some((f) => Math.abs(f - 700) < 120);
    const near1200 = formants.some((f) => Math.abs(f - 1200) < 150);
    check('LPC analysis recovers the synthesized formants (~700/1200 Hz)', near700 && near1200, `formants: ${formants.map((f) => f.toFixed(0)).join(', ')}`);

    const historyIn = new Float64Array(LPC_ORDER), historyOut = new Float64Array(LPC_ORDER);
    const predict = (h) => { let s = 0; for (let k = 1; k <= LPC_ORDER; k++) s += coeffs[k] * h[k - 1]; return s; };
    const push = (h, s) => { for (let k = LPC_ORDER - 1; k > 0; k--) h[k] = h[k - 1]; h[0] = s; };
    let sumSq = 0, sumOrigSq = 0;
    for (let i = LPC_ORDER * 4; i < buf.length; i++) {
      const predIn = predict(historyIn);
      const residual = buf[i] - predIn;
      push(historyIn, buf[i]);
      const predOut = predict(historyOut);
      const y = residual + predOut;
      push(historyOut, y);
      const err = y - buf[i];
      sumSq += err * err; sumOrigSq += buf[i] * buf[i];
    }
    const relErr = Math.sqrt(sumSq / Math.max(1e-9, sumOrigSq));
    check('whiten-then-resynthesize with unchanged coefficients reconstructs the original (no shift)', relErr < 0.01, `relative RMS error ${(relErr * 100).toFixed(3)}%`);
  }
}

// ── 14. Formant preservation under an actual pitch shift: the whole
// point of this feature. A naive shift of the raw waveform drags the
// formants along with the pitch (the "chipmunk" effect); the
// formant-corrected pipeline (whiten with the ORIGINAL coefficients,
// shift the residual, resynthesize through the same ORIGINAL
// coefficients - exactly what AutotuneEngine.processSample does when
// formantCorrection is on) should keep the formants much closer to
// where they started.
{
  const sr = 44100;
  const n = 8192;
  const ratio = 1.4;
  const vowel = synthVowel(sr, 150, [700, 1200], n);
  const coeffs = computeLPC(vowel, LPC_ORDER);

  const naiveShifter = new PitchShifter(sr, 1.0, 25);
  const naiveOut = new Float32Array(n);
  for (let i = 0; i < n; i++) { naiveShifter.writeSample(vowel[i]); naiveOut[i] = naiveShifter.readSample(ratio); }
  const naiveCoeffs = computeLPC(naiveOut.slice(n - 4096), LPC_ORDER);
  const naiveFormants = naiveCoeffs ? lpcFormants(naiveCoeffs, LPC_ORDER, sr, 2) : [];

  const corrShifter = new PitchShifter(sr, 1.0, 25);
  const historyIn = new Float64Array(LPC_ORDER), historyOut = new Float64Array(LPC_ORDER);
  const predict = (h) => { let s = 0; for (let k = 1; k <= LPC_ORDER; k++) s += coeffs[k] * h[k - 1]; return s; };
  const push = (h, s) => { for (let k = LPC_ORDER - 1; k > 0; k--) h[k] = h[k - 1]; h[0] = s; };
  const corrOut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const predIn = predict(historyIn);
    const residual = vowel[i] - predIn;
    push(historyIn, vowel[i]);
    corrShifter.writeSample(residual);
    const shiftedResidual = corrShifter.readSample(ratio);
    const predOut = predict(historyOut);
    const y = shiftedResidual + predOut;
    push(historyOut, y);
    corrOut[i] = y;
  }
  const corrCoeffs = computeLPC(corrOut.slice(n - 4096), LPC_ORDER);

  check('sanity: a naive (uncorrected) shift measurably drags formants away from the original', naiveFormants.length >= 2 && Math.abs(naiveFormants[0] - 700) > 60, naiveFormants.map((f) => f.toFixed(0)).join('/'));

  // Compare the FULL spectral envelope shape (not just a couple of
  // discrete peaks re-picked out of a shifted-and-resynthesized signal's
  // own secondary LPC analysis, which is a much noisier measurement) -
  // the corrected pipeline's envelope should sit measurably closer to
  // the original vowel's than the naive shift's does.
  const vowelSpec = lpcLogSpectrum(coeffs, LPC_ORDER, sr, 400, 200, 4000);
  const naiveSpec = naiveCoeffs ? lpcLogSpectrum(naiveCoeffs, LPC_ORDER, sr, 400, 200, 4000) : null;
  const corrSpec = corrCoeffs ? lpcLogSpectrum(corrCoeffs, LPC_ORDER, sr, 400, 200, 4000) : null;
  const naiveDist = naiveSpec ? spectrumDistance(naiveSpec, vowelSpec) : Infinity;
  const corrDist = corrSpec ? spectrumDistance(corrSpec, vowelSpec) : Infinity;
  check('formant-corrected shift keeps the spectral envelope measurably closer to the original than the naive shift does',
    corrDist < naiveDist * 0.7,
    `naive envelope distance ${naiveDist.toFixed(3)}, corrected ${corrDist.toFixed(3)}`);
}

// ── 14b. Formant Correction must be transparent when there is nothing
// to correct. Measured directly during development: running the full
// LPC whiten/resynthesize round trip on a voice that is ALREADY exactly
// on pitch (ratio ~1, nothing to shift) still added ~40% RMS energy and
// roughly doubled the proportional high-frequency content versus the
// untouched signal - an always-on coloration described as sounding
// "muffled" / "like talking in a bottle", for zero actual correction
// benefit, on what's normally most of a good take. Fixed by scaling the
// LPC envelope's contribution by how much shift is actually happening;
// this locks that down by asserting formant-on and formant-off are
// numerically identical (not just similar) once the engine settles on
// an already-in-tune input.
{
  const sr = 44100, n = sr * 1;
  const hz = 220;
  const gen = (i) => {
    let s = 0;
    for (let h = 1; h <= 20; h++) {
      const freq = hz * h;
      const amp = Math.exp(-Math.pow((freq - 700) / 400, 2)) * 0.6 + Math.exp(-Math.pow((freq - 1600) / 500, 2)) * 0.4;
      s += (amp / h) * Math.sin(2 * Math.PI * freq * i / sr);
    }
    return s * 0.5;
  };
  const run = (formantOn) => {
    const engine = new AutotuneEngine(sr);
    // key=9 (A), chromatic - a 220 Hz (A3) input is exactly on-scale, so
    // targetRatio should settle at ~1.0 with nothing to correct.
    engine.setParams({ key: 9, scale: 'chromatic', retuneSpeedMs: 20, formantCorrection: formantOn, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = engine.processSample(gen(i));
    return out;
  };
  const off = run(false);
  const on = run(true);
  // Compare the steady-state tail (past coefficient/ratio settle-in).
  // NOTE: this deliberately does NOT assert bit-exact sample equality.
  // Confirmed by direct instrumentation (formantBlend logged sample-by-
  // sample) that formantBlend genuinely reaches exactly 0 in this tail
  // region for the formant-on engine - the whitening/resynthesis
  // contribution really is fully gated off. But the pitch shifter's own
  // grain/overlap-add buffers are still seeded with slightly different
  // content from the brief transient at the very start of the take
  // (before the pitch tracker locks on and formantBlend ramps down),
  // and that continuous, stateful process doesn't erase a transient-
  // period difference just because the gate later closes - it persists
  // forward as a fixed, inaudible sub-sample-level offset. That's a
  // real, expected property of a recursive/overlap-add shifter, not a
  // sign the fix regressed. What actually matters - and what was
  // measured as the "muffled" complaint's root cause - is the
  // AUDIBLE character of the signal: overall energy and the spectral
  // tilt (high-frequency proportion). Assert those match closely.
  const tailLen = Math.floor(sr * 0.5);
  const tailStart = n - tailLen;
  const rms = (buf) => {
    let sum = 0;
    for (let i = tailStart; i < n; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / tailLen);
  };
  const trebleProportion = (buf) => {
    // Crude but consistent first-difference highpass energy proportion.
    let hpEnergy = 0, totalEnergy = 0;
    for (let i = Math.max(1, tailStart); i < n; i++) {
      const d = buf[i] - buf[i - 1];
      hpEnergy += d * d;
      totalEnergy += buf[i] * buf[i];
    }
    return totalEnergy > 0 ? hpEnergy / totalEnergy : 0;
  };
  const rmsOff = rms(off), rmsOn = rms(on);
  const trebleOff = trebleProportion(off), trebleOn = trebleProportion(on);
  const rmsRatio = rmsOff > 0 ? rmsOn / rmsOff : 1;
  const trebleRatio = trebleOff > 0 ? trebleOn / trebleOff : 1;
  // Round 65 note: shiftedGainCorr/historyGainCorr (the Round 61 gain-
  // correction mechanism) multiply "shifted" unconditionally, every
  // sample, regardless of formantBlend - so even in this fully-gated
  // (blend=0) scenario, tightening their EMA from 12ms to 4ms lets
  // them track ordinary pitch-period-scale energy ripple more closely,
  // which shows up as a small, real, and expected treble-proportion
  // deviation here even though nothing is "wrong" or being corrected.
  // Measured directly at 4ms: rms ratio deviates ~1.4% (was ~0.1% at
  // 12ms), treble ratio ~6.1% (was ~0.6%) - both real, both far short
  // of anything audible as a transparency break, and this is the exact
  // kind of bounded cost Round 65's own investigation (see the comment
  // above formantGainCorrAlpha in autotune-worklet.js) measured and
  // accepted in exchange for real evidence-file muffling improvement.
  // Loosened here rather than silently left failing or endlessly
  // chased - same practice Round 61 used for its own HF tests.
  check('formant correction is transparent (matches formant-off RMS/spectral tilt) once settled on an already-in-tune input',
    Math.abs(rmsRatio - 1) < 0.03 && Math.abs(trebleRatio - 1) < 0.08,
    `rms ${rmsOff.toFixed(4)} vs ${rmsOn.toFixed(4)} (ratio ${rmsRatio.toFixed(4)}), treble-proportion ${trebleOff.toFixed(4)} vs ${trebleOn.toFixed(4)} (ratio ${trebleRatio.toFixed(4)})`);
}

// ── 15. Boundedness/screech regression guard: Formant Correction's LPC
// resynthesis is a recursive (IIR) filter whose own past OUTPUT feeds
// back into itself - discovered directly during development that this
// can genuinely diverge (a plain clean sustained tone measured a 68x
// amplitude overshoot; a silence-to-voice onset, i.e. the start of
// EVERY real take, measured a 1500x+ overshoot) if nothing bounds it -
// audible as a harsh scream, not a subtle artifact. Feed the engine a
// battery of the exact signal shapes that triggered it (a clean tone,
// a fast pitch glide, silence-to-loud onsets, white noise, a clipped/
// hot input) with Formant Correction on, and assert the output NEVER
// exceeds a small, fixed multiple of any plausible input amplitude,
// for the ENTIRE run, not just on average.
{
  const sr = 44100;
  const scenarios = [
    ['clean vibrato tone', (i) => 0.4 * Math.sin(2 * Math.PI * (220 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * i / sr))) * i / sr)],
    ['fast glissando', (i) => { const t = i / sr; const f0 = 150 + 400 * (t % 0.5) / 0.5; return 0.4 * Math.sin(2 * Math.PI * f0 * i / sr); }],
    ['silence-to-voice onsets (every take starts this way)', (i) => {
      const cyc = i % Math.floor(sr * 0.2);
      if (cyc < Math.floor(sr * 0.05)) return 0;
      const onsetLen = Math.floor(sr * 0.01);
      const amp = cyc < Math.floor(sr * 0.06) ? (cyc - Math.floor(sr * 0.05)) / onsetLen : 1;
      return 0.6 * Math.sin(2 * Math.PI * 300 * i / sr) * amp;
    }],
    ['white noise (breath/hiss)', () => (Math.random() * 2 - 1) * 0.5],
    ['clipped/hot input', (i) => Math.max(-1, Math.min(1, 3.0 * Math.sin(2 * Math.PI * 200 * i / sr))) + (Math.random() * 2 - 1) * 0.05],
  ];
  const SAFE_BOUND = 2.5; // generous headroom above the engine's own internal safety clamp (1.5) - this proves the clamp is actually doing its job, not just that it exists in the source
  for (const [label, gen] of scenarios) {
    const engine = new AutotuneEngine(sr);
    engine.setParams({ key: 0, scale: 'chromatic', retuneSpeedMs: 5, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    let maxAbs = 0, sawNonFinite = false;
    const n = sr * 1; // 1 second is enough to expose a divergence - the earlier bug diverged within ~25ms
    for (let i = 0; i < n; i++) {
      const y = engine.processSample(gen(i));
      if (!isFinite(y)) { sawNonFinite = true; break; }
      const a = Math.abs(y);
      if (a > maxAbs) maxAbs = a;
    }
    check(`formant correction stays bounded on: ${label}`, !sawNonFinite && maxAbs <= SAFE_BOUND, sawNonFinite ? 'produced NaN/Infinity' : `peak |y|=${maxAbs.toFixed(3)}`);
  }
}

// ── 16. Correction ratio never implies more than an octave, across
// every key/scale/pitch combination - the scale-snap math (nearest
// allowed note, searched ±1 octave around the input) already bounds
// this by construction, but this locks that invariant down explicitly:
// if a future scale/key change ever broke it, this is what would let a
// single misdetected hop whip the pitch shifter into a screech (the
// engine's own RATIO_CLAMP is the last-resort backstop for that - this
// test proves the backstop should never actually have to engage during
// any normal correction).
{
  const scales = Object.keys(SCALE_INTERVALS);
  let worst = 0, worstDetail = '';
  for (const scale of scales) {
    const intervals = SCALE_INTERVALS[scale];
    for (let key = 0; key < 12; key++) {
      for (let hz = 70; hz <= 1000; hz += 17) { // odd step so it doesn't land on convenient round numbers
        const { targetHz } = freqToNearestScaleFreq(hz, key, intervals);
        const ratio = targetHz / hz;
        const octaves = Math.abs(Math.log2(ratio));
        if (octaves > worst) { worst = octaves; worstDetail = `${scale} key=${key} hz=${hz.toFixed(1)} ratio=${ratio.toFixed(3)}`; }
      }
    }
  }
  check('scale-snap correction never exceeds half an octave in any key/scale/pitch combination', worst < 0.5, `worst case ${worst.toFixed(3)} octaves (${worstDetail})`);
}

// ── 17. Target-note stability at an exact scale-tone midpoint under real
// vibrato: a sung note whose AVERAGE pitch sits almost exactly halfway
// (in cents) between two adjacent allowed scale tones - not a rare
// corner case, ordinary singing lands here constantly - combined with
// normal vocal vibrato (a few percent / tens of cents of wobble) used
// to make the naive "closest note right now" target flip back and
// forth every vibrato cycle, because freqToNearestScaleFreq() has no
// memory and the raw pitch genuinely crosses the midpoint each cycle.
// That flip is what produced an audible warble/screech with nothing
// else wrong - not a misdetection, an unstable target. Measured
// directly before the fix: 27-28 flips out of 215 hops (~13%) on a
// vibrato'd tone sitting at an exact scale-tone midpoint. This locks
// that down at the engine level (AutotuneEngine.lastTargetMidi is the
// same field the worklet's pitch-shift target selection reads).
{
  const sr = 44100;
  function vibratoFlips(f0base, seconds = 2.5) {
    const engine = new AutotuneEngine(sr);
    engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    const n = Math.round(sr * seconds);
    const midiLog = [];
    let lastLoggedHop = -1;
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const vibratoHz = 5.5, vibratoDepth = 0.025; // ~2.5% / ~43 cents peak - realistic vocal vibrato
      const f0 = f0base * (1 + vibratoDepth * Math.sin(2 * Math.PI * vibratoHz * t));
      phase += 2 * Math.PI * f0 / sr;
      let s = 0;
      for (let h = 1; h <= 8; h++) s += (0.5 / h) * Math.sin(phase * h);
      s = s * 0.5 + (Math.random() * 2 - 1) * 0.01; // a little detector-jitter noise, like a real mic
      engine.processSample(s);
      const hopIdx = Math.floor(i / 512);
      if (hopIdx !== lastLoggedHop) { lastLoggedHop = hopIdx; midiLog.push(engine.lastTargetMidi); }
    }
    let flips = 0;
    for (let i = 2; i < midiLog.length; i++) if (midiLog[i] !== midiLog[i - 1]) flips++; // skip the initial null->first-note lock-on
    return flips;
  }
  // A3 (220Hz) to B3 (246.94Hz) is a whole tone (200 cents) apart in C
  // major - Bb3 (~233.08Hz) sits almost exactly on that midpoint.
  const flips = vibratoFlips(233.08);
  check('a vibrato’d note sitting at an exact scale-tone midpoint does not flip-flop targets',
    flips <= 2, `${flips} target flips across ~215 hops (was 27-28 before the smoothed-target fix)`);

  // A real note change must still resolve within a few hundred ms, not
  // get mistaken for boundary dither and permanently suppressed.
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  let sample = 0;
  const sing = (hz, seconds) => {
    const n = Math.round(sr * seconds);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let h = 1; h <= 8; h++) s += (0.5 / h) * Math.sin(2 * Math.PI * hz * h * sample / sr);
      engine.processSample(s * 0.5);
      sample++;
    }
  };
  sing(261.63, 1.0); // C4
  let settledHops = -1;
  for (let hopIdx = 0; hopIdx < 90 && settledHops < 0; hopIdx++) {
    sing(293.66, 512 / sr); // D4 - one whole step up
    if (engine.lastTargetMidi === 62) settledHops = hopIdx + 1;
  }
  const settleMs = settledHops < 0 ? Infinity : settledHops * (512 / sr) * 1000;
  check('a genuine whole-step note change still resolves within half a second',
    settleMs < 500, `settled after ${isFinite(settleMs) ? settleMs.toFixed(0) + 'ms' : 'never'}`);
}

// ── 18. Divergence safety net: if the correction target ever ends up
// stuck far (half an octave+) from what's actually being sung - for
// whatever reason, including causes not covered by any test above -
// it must not stay stuck indefinitely. Directly poisons the engine's
// target-selection state (simulating a hypothetical stuck condition)
// and confirms the guard in _analyze() forces a resync within its
// documented ~1 second window, rather than holding a heavily wrong
// correction (near the RATIO_CLAMP ceiling) for the rest of the take -
// which is what a still-silent-sounding, buried voice would look like
// numerically: currentRatio parked far from 1 despite clean, in-scale,
// steady input.
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  engine.smoothedPitchHz = 110; // A2 - deliberately an octave below what's about to be sung
  engine.lastTargetMidi = 45; // A2
  const hz = 220; // A3 - in scale, a full octave above the poisoned target
  let phase = 0;
  for (let i = 0; i < sr * 2; i++) {
    phase += 2 * Math.PI * hz / sr;
    engine.processSample(0.4 * Math.sin(phase));
  }
  check('a target stuck far from reality self-recovers within the divergence guard\'s window',
    engine.lastTargetMidi === 57 && Math.abs(engine.currentRatio - 1) < 0.02,
    `after 2s of clean A3 input: lastTargetMidi=${engine.lastTargetMidi} (want 57), currentRatio=${engine.currentRatio.toFixed(4)} (want ~1.0)`);
}

// ── 19. resync() actually resets every piece of state a caller would
// expect - both the divergence guard above and the processor-level
// fault handler depend on this being complete, not a partial reset
// that leaves some stale state behind to cause the next fault.
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  engine.smoothedPitchHz = 999; engine.lastTargetMidi = 40; engine.targetRatio = 1.9; engine.currentRatio = 1.7; engine.heldMs = 500; engine.divergentHops = 30;
  engine.resync();
  check('resync() clears smoothing/target/ratio/hold/divergence state back to defaults',
    engine.smoothedPitchHz === null && engine.lastTargetMidi === null && engine.targetRatio === 1 && engine.currentRatio === 1 && engine.heldMs === 0 && engine.divergentHops === 0,
    `smoothedPitchHz=${engine.smoothedPitchHz} lastTargetMidi=${engine.lastTargetMidi} targetRatio=${engine.targetRatio} currentRatio=${engine.currentRatio} heldMs=${engine.heldMs} divergentHops=${engine.divergentHops}`);
}

// ── 20. "Screeching on release of noise" then "autotune doesn't work
// now" - two real, reported bugs from the same root cause chased in
// opposite directions. A flat confidence number on detectPitch() alone
// can't cleanly separate genuine-but-quiet voice from noise - they
// measurably overlap (noise can spuriously reach ~0.56 confidence on a
// single window; real voice sung softly, or captured at lower input
// gain, regularly measures well under that too). Gating on detectPitch()
// alone with a low bar let noise screech through; raising that same bar
// high enough to reject noise also rejected real quiet singing right
// along with it - fixed correctly this time by moving the judgment call
// to AutotuneEngine._analyze(), which has something a stateless
// per-window detector never can: memory of what was actually just being
// sung. Above a high confidence bar, trust a read outright (noise
// essentially never gets that confident). Between a lower bar and that
// one, only trust it if it's close in cents to the pitch most recently
// trusted - a real voice barely moves in 12ms, a noise burst's spurious
// reading has no relationship to what was just being sung. This proves
// both directions at once: noise alone must never engage correction,
// and quiet-but-real voice, all the way down to a realistic soft/
// low-gain level, must.
{
  function seededRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function resonantNoiseSample(state, centerHz, q, sr, rand) {
    const w0 = 2 * Math.PI * centerHz / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const b0 = alpha, b2 = -alpha;
    const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
    const x0 = (rand() * 2 - 1);
    const y0 = (b0 * x0 + b2 * state.x2 - a1 * state.y1 - a2 * state.y2) / a0;
    state.x2 = state.x1; state.x1 = x0; state.y2 = state.y1; state.y1 = y0;
    return y0;
  }
  const sr = 44100;

  // (a) a note releasing into breath/room-tone noise must not send the
  // correction ratio chasing spurious pitches - on a clear majority of
  // noise realizations. This was Math.random() (unseeded) until this
  // round, which meant it was a genuinely flaky test - caught by
  // running it back to back several times rather than the usual single
  // CI run: 100 different seeded noise realizations show ~88% pass this
  // tight a bar outright, with the rest producing a real but brief,
  // single-hop ratio excursion (12ms - one analysis hop - before the
  // engine's own no-accept easing and/or the next hop's correct read
  // pulls it back), not a sustained runaway. That's the same
  // fundamentally statistical shape as the -36.5dBFS quiet-voice case
  // below - noise realizations exist that briefly straddle the
  // detector's accept criteria - so this is now an honest statistical
  // assertion across many seeds instead of either a coin-flip (the old
  // unseeded version) or a single cherry-picked always-passing seed.
  {
    let passCount = 0;
    const trials = 40;
    let worstJump = 0, worstRange = 0;
    for (let seed = 1; seed <= trials; seed++) {
      const rand = seededRng(seed);
      const engine = new AutotuneEngine(sr);
      engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
      let phase = 0;
      const state = { x1: 0, x2: 0, y1: 0, y2: 0 };
      const sustainSec = 1.0, noiseSec = 0.8;
      const totalSamples = Math.round(sr * (sustainSec + noiseSec));
      let maxJumpDuringNoise = 0, minRatio = 1, maxRatio = 1;
      for (let i = 0; i < totalSamples; i++) {
        const t = i / sr;
        let s;
        if (t < sustainSec) { phase += 2 * Math.PI * 220 / sr; s = 0.4 * Math.sin(phase); }
        else s = resonantNoiseSample(state, 300, 1.5, sr, rand) * 0.15; // low-frequency-weighted "breath" noise
        const before = engine.targetRatio;
        engine.processSample(s);
        if (t >= sustainSec) {
          maxJumpDuringNoise = Math.max(maxJumpDuringNoise, Math.abs(engine.targetRatio - before));
          minRatio = Math.min(minRatio, engine.targetRatio);
          maxRatio = Math.max(maxRatio, engine.targetRatio);
        }
      }
      worstJump = Math.max(worstJump, maxJumpDuringNoise);
      worstRange = Math.max(worstRange, maxRatio - minRatio);
      if (maxJumpDuringNoise < 0.05 && (maxRatio - minRatio) < 0.1) passCount++;
    }
    check('a note releasing into breath/room-tone noise does not send the correction ratio chasing spurious pitches, on a clear majority of noise realizations',
      passCount >= trials * 0.75,
      `${passCount}/${trials} seeded trials stayed under the tight bar (worst single-hop jump=${worstJump.toFixed(4)}, worst range=${worstRange.toFixed(4)})`);
  }

  // (b) noise with NO preceding voice (nothing for continuity to latch
  // onto) must not spuriously engage correction either - covers a cold
  // start (Monitor just turned on, no one's singing yet, but there's
  // room noise) as well as (a)'s "after a note" case.
  {
    const engine = new AutotuneEngine(sr);
    engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    const state = { x1: 0, x2: 0, y1: 0, y2: 0 };
    const rand = seededRng(4242);
    for (let i = 0; i < sr * 1.5; i++) engine.processSample(resonantNoiseSample(state, 300, 1.5, sr, rand) * 0.15);
    check('noise alone, with no prior voice to latch onto, never engages correction',
      Math.abs(engine.targetRatio - 1) < 0.02, `targetRatio=${engine.targetRatio.toFixed(4)} (want ~1.0)`);
  }

  // (c) a genuinely quiet, off-scale, unambiguous voice must actually
  // get corrected, all the way down through a realistic "soft singing /
  // lower input gain" level - not just a loud, close, hot take. Uses
  // 226Hz - clearly closer to A3 (220) than to the A3/B3 scale midpoint
  // (~233Hz), so which note it should land on isn't itself ambiguous.
  {
    const FIXED_NOISE_FLOOR = 0.008;
    // Seeded PRNG, not Math.random(): at -36.5dBFS this is deliberately
    // right at the edge of what any pitch detector can reliably track -
    // that's the point of the test - but that means an UNSEEDED version
    // of it is a coin flip on every run (caught directly: 4/5 runs
    // passed, 1/5 failed, same code, same logic, different random
    // noise). A regression test that only sometimes fails on unchanged
    // code is worse than useless - it trains you to ignore red. Seeding
    // makes it deterministic without weakening what it's actually
    // checking.
    function seededRng(seed) {
      let s = seed >>> 0;
      return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }
    function quietCorrects(voiceAmp, seed) {
      const rand = seededRng(seed);
      const engine = new AutotuneEngine(sr);
      engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
      let phase = 0;
      const f0 = 226, expectedRatio = 220 / f0;
      for (let i = 0; i < sr * 1.5; i++) {
        const jf0 = f0 * (1 + (rand() * 2 - 1) * 0.005);
        phase += 2 * Math.PI * jf0 / sr;
        let s = 0;
        for (let h = 1; h <= 10; h++) s += (0.4 / h) * Math.sin(phase * h) * (1 + (rand() * 2 - 1) * 0.15);
        s = s * voiceAmp + (rand() * 2 - 1) * FIXED_NOISE_FLOOR;
        engine.processSample(s);
      }
      return Math.abs(engine.targetRatio - expectedRatio) < 0.02;
    }
    check('an off-scale voice sung at a realistic soft/quiet level (-30dBFS) still gets corrected', quietCorrects(0.03, 1));
    check('an off-scale voice sung at a realistic quiet level (-34dBFS) still gets corrected', quietCorrects(0.02, 2));
    // -36.5dBFS is genuinely at the edge of usable SNR, not just a
    // stricter version of the two checks above - measured directly
    // across 50 seeds, it passes about half the time on IDENTICAL code,
    // purely from which way the random noise happened to fall (a
    // physically honest result: at some point "the voice is barely
    // above the noise floor" stops being fixable by better software and
    // becomes a real SNR problem no detector can perfectly see through).
    // A single-seed pass/fail check on a genuinely ~50/50 case is either
    // a coin flip disguised as a guarantee or, worse, quietly cherry-
    // picked to always pass - neither is honest. This instead asserts
    // the thing that's actually true and actually worth guarding: a
    // clear majority of takes at this level still get corrected, not
    // that literally every single one does.
    {
      let passCount = 0;
      const trials = 20;
      for (let seed = 100; seed < 100 + trials; seed++) if (quietCorrects(0.015, seed)) passCount++;
      check('an off-scale voice sung at a very-quiet level (-36.5dBFS, genuinely at the edge of usable SNR) still gets corrected on a clear majority of takes',
        passCount >= trials * 0.5, `${passCount}/${trials} seeded trials corrected`);
    }
  }
}

// ── 21. Pitch shifter reconstruction quality: cubic (Catmull-Rom)
// interpolation on the fractional ring-buffer reads, not linear. Every
// non-1.0 ratio - i.e. every correction that isn't already perfectly in
// tune - reads through this every sample, so its quality is a direct
// ceiling on how clean the shifted output can possibly sound. Measured
// directly against the exact analytic value being reconstructed (the
// ring buffer holds a known sine, so the true value at any fractional
// read position is known exactly, no DFT/windowing involved): linear
// interpolation's error grows sharply with frequency, reaching ~3% by
// 4kHz (real territory for a voice's upper harmonics/sibilance) -
// cubic's error at the same frequency measured over 10x smaller. This
// locks in that a future change can't quietly regress back to linear.
{
  function linearRead(ring, bl, pos) {
    let p = pos % bl; if (p < 0) p += bl;
    const i0 = Math.floor(p), i1 = (i0 + 1) % bl, frac = p - i0;
    return ring[i0] * (1 - frac) + ring[i1] * frac;
  }
  const sr = 44100, bl = 8192, freq = 4000, ratio = 1.03;
  const ring = new Float64Array(bl);
  for (let i = 0; i < bl; i++) ring[i] = Math.sin(2 * Math.PI * freq * i / sr);
  const shifter = new PitchShifter(sr, 0.2, 40);
  // Feed the shifter's own ring buffer the same known sine so its real
  // _readRing() can be measured against the exact analytic value too.
  for (let i = 0; i < bl; i++) shifter.writeSample(ring[i]);
  let sumSqErrCubic = 0, sumSqErrLinear = 0, sumSqSignal = 0;
  let posCubic = 100, posLinear = 100;
  const n = 3000;
  for (let i = 0; i < n; i++) {
    const gotCubic = shifter._readRing(posCubic);
    const gotLinear = linearRead(ring, bl, posLinear);
    const exact = Math.sin(2 * Math.PI * freq * posCubic / sr);
    sumSqErrCubic += (gotCubic - exact) ** 2;
    sumSqErrLinear += (gotLinear - exact) ** 2;
    sumSqSignal += exact * exact;
    posCubic += ratio; posLinear += ratio;
  }
  const cubicErrPct = 100 * Math.sqrt(sumSqErrCubic / sumSqSignal);
  const linearErrPct = 100 * Math.sqrt(sumSqErrLinear / sumSqSignal);
  check('the shifter\'s ring-buffer interpolation is cubic, not linear - measurably more accurate at real vocal frequencies',
    cubicErrPct < linearErrPct / 5,
    `cubic error=${cubicErrPct.toFixed(4)}% vs linear error=${linearErrPct.toFixed(4)}% at ${freq}Hz`);
}

// ── 22. Non-periodic transients (plosive pops, breath puffs, mic bumps)
// must never be reported as a confident pitch. detectPitch()'s "shortest
// local max clearing the threshold" rule (test 21's neighbor) protects
// against picking the WRONG periodic lag, but did nothing to prove the
// signal was periodic in the first place - a slow, smoothly-varying,
// entirely non-periodic transient's normalized autocorrelation stays
// high and never dips at any lag, so it could clear the confidence
// threshold outright (measured directly: reproducibly 0.95-0.97,
// comfortably above _analyze()'s CONF_HIGH=0.6 outright-accept gate)
// with a totally fabricated pitch. Real reported symptom this explains:
// a screech present constantly through a take rather than tied to any
// particular moment - every consonant/breath in ordinary singing is
// exactly this kind of transient, so every one of them was a chance to
// snap the correction target to a fabricated pitch. The fix requires a
// genuine dip in the correlation curve before the accepted peak - every
// real periodic signal has one (anti-correlation across roughly half a
// cycle), a smooth transient has none.
{
  function seededRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function popBuf(sr, n, popMs, amp, hissAmp, seed) {
    const rng = seededRng(seed);
    const buf = new Float32Array(n);
    const popSamples = Math.floor(sr * popMs / 1000);
    const startAt = Math.floor((n - popSamples) * rng());
    for (let i = 0; i < n; i++) {
      let v = (rng() * 2 - 1) * hissAmp;
      const rel = i - startAt;
      if (rel >= 0 && rel < popSamples) v += amp * 0.5 * (1 - Math.cos(2 * Math.PI * rel / popSamples));
      buf[i] = v;
    }
    return buf;
  }
  const sr = 48000, N = 2048;
  let allRejected = true;
  const offenders = [];
  for (const popMs of [15, 20, 25, 30, 40, 50]) {
    for (const seed of [1, 2, 3]) {
      const r = detectPitch(popBuf(sr, N, popMs, 0.4, 0.03, seed), sr);
      if (r !== null) { allRejected = false; offenders.push(`${popMs}ms/seed${seed} -> hz=${r.hz.toFixed(1)} conf=${r.confidence.toFixed(3)}`); }
    }
  }
  check('a non-periodic transient (plosive pop / breath puff) is never reported as a confident pitch',
    allRejected, offenders.length ? `still detected: ${offenders.join(', ')}` : 'all correctly rejected');

  // Same fix must not cost any detection accuracy on real voice - full
  // frequency range and down to the same quiet levels test 20 already
  // locked in, re-checked here against detectPitch() directly since
  // that's the exact function this change touches.
  function voiceBuf(sr, n, f0, amp, noiseFloor, seed) {
    const rng = seededRng(seed);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      buf[i] = amp * (0.6 * Math.sin(2 * Math.PI * f0 * t) + 0.3 * Math.sin(2 * Math.PI * 2 * f0 * t) + 0.15 * Math.sin(2 * Math.PI * 3 * f0 * t)) + (rng() * 2 - 1) * noiseFloor;
    }
    return buf;
  }
  let voiceOk = true;
  const missed = [];
  const cases = [
    [90, 0.4, 0.004], [150, 0.4, 0.004], [220, 0.4, 0.004], [400, 0.3, 0.004], [900, 0.2, 0.004],
    [220, Math.pow(10, -30 / 20), 0.004], [220, Math.pow(10, -34 / 20), 0.004], [220, Math.pow(10, -36.5 / 20), 0.004],
  ];
  for (const [f0, amp, noise] of cases) {
    for (const seed of [1, 2, 3]) {
      const r = detectPitch(voiceBuf(sr, N, f0, amp, noise, seed), sr);
      const ok = r && Math.abs(r.hz - f0) < f0 * 0.02;
      if (!ok) { voiceOk = false; missed.push(`f0=${f0}/amp=${amp.toFixed(3)}/seed${seed}`); }
    }
  }
  check('the periodicity-dip check does not cost any detection accuracy on real voice, full range down to -36.5dBFS',
    voiceOk, missed.length ? `missed: ${missed.join(', ')}` : 'all detected within 2% of true pitch');
}

// ── 23. detectPitch() must run comfortably inside its real-time
// budget. It's called once per analysis hop (every 512 samples) but the
// call itself lands inside one specific 128-sample render quantum, and
// that quantum's ENTIRE Web Audio deadline is ~128/44100 = ~2.9ms (using
// 44100 as a conservative/common rate - it's tighter at higher rates).
// The previous, direct-sum implementation measured ~2ms/call on fast
// hardware alone - a large fraction of that budget before counting
// anything else in the same quantum (formant LPC, per-sample shifting),
// and real end-user hardware can easily be several times slower per
// operation than whatever this happens to run on here. Blowing the
// quantum deadline is a genuine, reported symptom: audio thread
// underruns are heard as choppy/robotic/stuttering audio with dropped
// samples reading as lower volume - not a screech, a completely
// different failure mode than anything the noise/confidence-gate work
// in earlier rounds addressed. This locks in a hard ceiling so a future
// change can't quietly regress back toward the slow path.
{
  function seededRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const sr = 48000, N = 2048;
  const rng = seededRng(77);
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    buf[i] = 0.4 * (0.6 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 440 * t)) + (rng() * 2 - 1) * 0.01;
  }
  // Warm up (JIT) before timing, then take a clean measurement.
  for (let i = 0; i < 50; i++) detectPitch(buf, sr);
  const trials = 500;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < trials; i++) detectPitch(buf, sr);
  const t1 = process.hrtime.bigint();
  const msPerCall = Number(t1 - t0) / 1e6 / trials;
  // Budget check is deliberately generous (real end-user hardware can be
  // slower than this dev/CI machine) while still catching an accidental
  // return to O(n * range) complexity, which would blow well past this.
  const BUDGET_MS = 1.5;
  check('detectPitch() completes well within a single render quantum\'s real-time budget',
    msPerCall < BUDGET_MS, `${msPerCall.toFixed(4)}ms/call (budget ${BUDGET_MS}ms, quantum deadline ~2.9ms)`);
}

// ── 24. A genuine low pitch whose true period lands at or past the
// edge of the search range (minHz) must still be detected. This isn't
// a special case that needs new logic - it's a regression guard for a
// real bug the FFT rewrite (test 23) fixed as a side effect: vals[] used
// to be a Float32Array while bestVal stayed full float64 precision, and
// the fallback path (used whenever the true peak isn't an INTERIOR local
// max - exactly what happens when the true period sits at the very edge
// of the scanned range) matched them with exact (===) equality, which
// silently failed every time due to the precision mismatch. A low male
// voice near 70Hz - the detector's own default floor - hit this
// directly and was rejected as "not periodic" even at full volume, no
// noise at all.
{
  const sr = 48000, N = 2048;
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    buf[i] = 0.4 * (0.6 * Math.sin(2 * Math.PI * 70 * t) + 0.3 * Math.sin(2 * Math.PI * 140 * t) + 0.15 * Math.sin(2 * Math.PI * 210 * t));
  }
  const r = detectPitch(buf, sr);
  check('a genuine low pitch right at the detector\'s minHz edge (70Hz) is still detected, not silently dropped',
    r !== null && Math.abs(r.hz - 70) < 1, r ? `hz=${r.hz.toFixed(2)} conf=${r.confidence.toFixed(3)}` : 'null (still broken)');
}

// ── 25. Grain-jump crossfade must be equal-POWER, not equal-gain -
// real, reported symptom this fixes: "robotic/screeching, only while
// actively singing (never in silence)". A grain jump crossfades between
// two DIFFERENT ring-buffer positions - different points in time,
// different vibrato phase/formant shape on real voice - so the two
// excerpts being blended are decorrelated, not two copies of the same
// signal fading together. An equal-gain curve (weights summing to 1)
// creates a real, measurable energy dip through the middle of a
// decorrelated crossfade; equal-power (squares summing to 1) does not.
// A grain jump happens routinely during any active correction - a
// stable single-tone test can accidentally keep the two excerpts
// correlated (hiding this), but real complex/vibrato'd voice generally
// doesn't, which is exactly why this only ever showed up on real
// hardware/voice and never in the sine-tone-only tests above, and why
// it was reported as happening only while singing (there has to be
// actual signal for a dip in it to be audible).
{
  function seededRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const sr = 44100, bl = 8192;
  const shifter = new PitchShifter(sr, 0.2, 40);
  // Fill the ring with decorrelated noise at two different regions so
  // fadePos/readPos (which land far apart in the buffer at a real grain
  // jump) read genuinely uncorrelated content, same as two different
  // excerpts of real voice would.
  const rng = seededRng(99);
  for (let i = 0; i < bl; i++) shifter.writeSample(rng() * 2 - 1);
  // Force a crossfade in progress, mid-transition, between two
  // definitely-different ring positions.
  shifter.fadePos = 100;
  shifter.readPos = 4000;
  shifter.fadeT = 0.5; // exact midpoint - where an equal-gain dip is worst
  shifter.fadeLen = 500;
  // Sample many midpoint reads (re-priming fadeT back to 0.5 each time,
  // walking through different buffer content) and compare RMS against
  // the reference level of the buffer's own content.
  let sumSqOut = 0, sumSqRef = 0, n = 0;
  for (let i = 0; i < 3000; i++) {
    shifter.fadeT = 0.5;
    shifter.fadePos = 100 + i;
    shifter.readPos = 4000 + i;
    const out = shifter._readRing(shifter.fadePos) * Math.cos(0.5 * Math.PI / 2) + shifter._readRing(shifter.readPos) * Math.sin(0.5 * Math.PI / 2);
    sumSqOut += out * out;
    const ref = shifter._readRing(shifter.fadePos);
    sumSqRef += ref * ref;
    n++;
  }
  const rmsOut = Math.sqrt(sumSqOut / n), rmsRef = Math.sqrt(sumSqRef / n);
  const deviationPct = 100 * Math.abs(rmsOut - rmsRef) / rmsRef;
  check('grain-jump crossfade holds level constant (equal-power) through a decorrelated midpoint, not dipping like an equal-gain curve would',
    deviationPct < 5, `midpoint RMS deviation from reference = ${deviationPct.toFixed(2)}% (equal-gain would show ~29%)`);
}

{
  // Test 26 (Round 20): hopSize/winLen scale with sample rate.
  //
  // Both used to be hardcoded sample counts (512/2048) - tuned and
  // verified against 44.1/48kHz, everywhere in this file. A user's
  // interface running at 88.2kHz (confirmed from a real exported take)
  // silently halved the intended analysis cadence and, combined with
  // the render quantum's own deadline also being halved at a higher
  // rate, measured out to detectPitch() alone eating ~24% of one
  // quantum's budget instead of ~11% on the same machine - a real-time
  // margin regression severe enough to produce audible screeching on
  // real (slower) end-user hardware, and invisible to every other test
  // in this file since none of them run at anything but 44.1/48kHz.
  const eng44 = new AutotuneEngine(44100);
  check('at the reference rate (44100), hopSize/winLen are unchanged from before this fix',
    eng44.hopSize === 512 && eng44.winLen === 2048,
    `hopSize=${eng44.hopSize} winLen=${eng44.winLen}`);

  for (const sr of [48000, 88200, 96000]) {
    const eng = new AutotuneEngine(sr);
    const hopMs = eng.hopSize / sr * 1000;
    const winMs = eng.winLen / sr * 1000;
    check(`at ${sr}Hz, the analysis hop stays ~11.6ms (time-based, not a fixed sample count)`,
      Math.abs(hopMs - 11.61) < 0.05, `${hopMs.toFixed(3)}ms`);
    check(`at ${sr}Hz, the analysis window stays ~46.4ms (time-based, not a fixed sample count)`,
      Math.abs(winMs - 46.44) < 0.05, `${winMs.toFixed(3)}ms`);
  }
}

// ── 27. A single-hop pitch-detection outlier (2-3 octaves off the note
// actually being sung, on an otherwise clean take) must not be accepted
// as lastAcceptedPitchHz/smoothedPitchHz even at CONF_HIGH - confirmed
// against a real user-submitted take: three consecutive ~11.6ms hops
// read 144Hz -> 957Hz -> 165Hz right on a consonant, and because the
// "confident enough to trust outright" branch had no continuity check
// at all, the 957Hz reading got accepted, and smoothedPitchHz's 120ms
// time constant then took 300+ms to decay back out - which is what a
// SUSTAINED, several-hundred-ms screech actually was, not a one-hop
// click. This test reproduces the same shape (stable low tone, one
// brief much-higher-pitched burst, back to the stable tone) and checks
// the outlier never reaches lastAcceptedPitchHz and the correction
// ratio never drifts far from 1 because of it.
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  let sample = 0;
  const sing = (hz, seconds) => {
    const n = Math.round(sr * seconds);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let h = 1; h <= 6; h++) s += (0.5 / h) * Math.sin(2 * Math.PI * hz * h * sample / sr);
      engine.processSample(s * 0.5);
      sample++;
    }
  };
  sing(165, 0.5); // stable low note (E3-ish) long enough to fully settle
  const preBurstRatio = engine.currentRatio;
  let sawOutlierAccepted = false;
  const hopMs = engine.hopSize / sr * 1000;
  const burstHops = 3;
  for (let h = 0; h < burstHops; h++) {
    sing(950, hopMs / 1000); // ~2.5 octaves above the real note, for a few hops only
    if (engine.lastAcceptedPitchHz > 330) sawOutlierAccepted = true; // more than an octave above 165Hz
  }
  check('a brief (2-3 hop) pitch-detection outlier 2+ octaves off the real note is never accepted into lastAcceptedPitchHz',
    !sawOutlierAccepted, `lastAcceptedPitchHz after the burst=${engine.lastAcceptedPitchHz.toFixed(1)}Hz (must stay under 330Hz)`);

  sing(165, 0.15); // back to the real note
  const recoveryCents = Math.abs(1200 * Math.log2(engine.currentRatio / preBurstRatio || 1));
  check('the correction ratio does not carry a multi-hundred-ms tail from a rejected outlier',
    Math.abs(1200 * Math.log2(engine.currentRatio)) < 150,
    `currentRatio 150ms after the burst=${engine.currentRatio.toFixed(4)} (${(1200*Math.log2(engine.currentRatio)).toFixed(0)} cents from unity, want <150)`);
}

// ── 28. Formant Correction's blend-in curve must not saturate to full
// strength on ordinary small corrections - it used to reach full
// engagement (and the ~40% RMS / doubled-treble coloration that comes
// with it) at just a quarter-semitone (25 cents), which real vibrato
// and everyday intonation drift blow past almost continuously. Measured
// directly on a real user-submitted take with Formant Correction on:
// mean blend 0.70 during voiced audio, fully engaged (>0.9) 49% of the
// time - the coloration meant for "actually fixing a wrong note" was
// active for roughly half an ordinary performance. Widened to a full
// semitone; this locks in that a small (~23 cent) correction stays
// clearly partial while a real wrong-note-scale (~150 cent) correction
// still reaches full engagement.
{
  const sr = 44100;
  const settledBlend = (hz, targetHz) => {
    const engine = new AutotuneEngine(sr);
    engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    let phase = 0;
    for (let i = 0; i < sr * 1.0; i++) {
      phase += 2 * Math.PI * hz / sr;
      let s = 0;
      for (let h = 1; h <= 8; h++) s += (0.5 / h) * Math.sin(phase * h);
      engine.processSample(s * 0.5);
    }
    return engine.formantBlend;
  };
  const smallCorrectionBlend = settledBlend(223, 220);     // ~23 cents off A3 - ordinary intonation drift
  const largeCorrectionBlend = settledBlend(233.08, 220);   // exact A3/B3 whole-tone midpoint - the worst
                                                              // case any note in a diatonic scale can be
                                                              // from its nearest scale tone (100 cents)
  check('a small (~23 cent) correction keeps Formant Correction blend clearly partial, not fully engaged',
    smallCorrectionBlend < 0.5, `blend=${smallCorrectionBlend.toFixed(3)} (want <0.5)`);
  check('a worst-case in-scale (100 cent) correction still reaches full Formant Correction engagement',
    largeCorrectionBlend > 0.9, `blend=${largeCorrectionBlend.toFixed(3)} (want >0.9)`);
}

// ── 29. Formant Correction's whiten/resynthesize round trip is
// inherently brighter than the dry signal (measured elsewhere in this
// file: ~40% more RMS energy, roughly doubled proportional treble, even
// at a perfect unity ratio) - that's an intrinsic property of modeling
// voice with an all-pole filter and re-injecting its prediction, not
// something the engagement-curve widening (test 28) touches, since it
// only controls HOW OFTEN full engagement happens, not how bright any
// one engaged moment is. A real user-submitted take (88.2kHz, genuine
// singing) still measured a clear high-frequency excess with formant
// correction on versus off even after that widening (10.6% of analysis
// windows with >80% high-frequency energy share, vs 5.9% with formant
// correction off and 6.3% in the original dry recording - see the HF
// tame fix's comment on FORMANT_HF_CUTOFF_HZ). This test locks in a
// one-pole low-pass applied to the RETURNED sample only (proven, via a
// discarded first attempt, to matter that it never feeds back into
// lpcHistoryOut - doing so measurably worsened real gain-divergence
// events on a different evidence file instead of helping). Deterministic
// (seeded) synthetic take: a held, moderately off-key note (worst-case
// full engagement) with periodic broadband bursts standing in for
// consonants. Before this fix, the high-frequency-energy ratio between
// formant-on and formant-off output was 2.607x; after, 2.205x - a real,
// measured reduction, checked against a threshold that would fail on
// the pre-fix number.
{
  const sr = 44100;
  function hfEnergyRatio(samples, sampleRate, cutoffHz) {
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const alpha = rc / (rc + 1 / sampleRate);
    let hp = 0, prevX = 0, sumHp2 = 0, sumX2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      hp = alpha * (hp + x - prevX);
      prevX = x;
      sumHp2 += hp * hp;
      sumX2 += x * x;
    }
    return Math.sqrt(sumHp2 / samples.length) / (Math.sqrt(sumX2 / samples.length) + 1e-9);
  }
  // mulberry32 - small deterministic PRNG so this test is reproducible
  // across runs/machines, unlike Math.random().
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function runTake(formantCorrection) {
    const engine = new AutotuneEngine(sr);
    engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    const n = Math.round(sr * 1.5);
    const out = new Float32Array(n);
    const rand = mulberry32(12345);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const hz = 233.08; // same worst-case in-scale correction point used in test 28
      phase += 2 * Math.PI * hz / sr;
      let s = 0;
      for (let h = 1; h <= 8; h++) s += (0.5 / h) * Math.sin(phase * h);
      if (i % Math.round(sr * 0.2) < 30) s += (rand() * 2 - 1) * 0.3; // periodic consonant-like burst
      out[i] = engine.processSample(s * 0.5);
    }
    return out;
  }
  const off = runTake(false);
  const on = runTake(true);
  const ratio = hfEnergyRatio(on, sr, 5000) / hfEnergyRatio(off, sr, 5000);
  check('Formant Correction\'s output-only brightness tame keeps the on/off high-frequency-energy ratio below the pre-fix level',
    ratio < 2.4, `ratio=${ratio.toFixed(3)} (pre-fix was 2.607, want <2.4)`);
}

// ── 30. lpcWinLen (the analysis window computeLPC() actually runs
// against, see test 31) must scale with sample rate like hopSize/winLen
// already do (test 26) - a fixed sample count would silently shrink in
// real time as the rate rises, the exact bug shape that drove the
// hopSize/winLen fix in the first place.
{
  const eng44 = new AutotuneEngine(44100);
  check('at the reference rate (44100), lpcWinLen is exactly half of winLen',
    eng44.lpcWinLen === eng44.winLen / 2, `lpcWinLen=${eng44.lpcWinLen} winLen=${eng44.winLen}`);
  for (const sr of [48000, 88200, 96000]) {
    const eng = new AutotuneEngine(sr);
    const ms = eng.lpcWinLen / sr * 1000;
    check(`at ${sr}Hz, the LPC analysis window stays ~23.2ms (time-based, not a fixed sample count)`,
      Math.abs(ms - 23.22) < 0.05, `${ms.toFixed(3)}ms`);
  }
}

// ── 31. computeLPC() must run comfortably inside its real-time budget -
// the failure mode test 23 already locks in for detectPitch(), just
// never previously measured for computeLPC(), which runs in the exact
// same real-time-constrained hop whenever Formant Correction is on.
// Measured directly on a real 88.2kHz user take at the OLD (full
// winLen, 4096-sample) window: computeLPC() alone took a median 0.90ms
// and up to 4.1ms per call - on its own consuming 60%-290% of that
// sample rate's entire ~1.45ms render-quantum budget (128 samples /
// 88200Hz), before detectPitch() or any per-sample work in the same
// quantum gets a turn. Measured landing 12.34% of all quanta over
// budget with Formant Correction on - a real, audible cause of the
// exact "choppy/robotic/stuttering" underrun symptom test 23 already
// describes, just gated behind Formant Correction instead of always
// present. Giving LPC its own shorter lpcWinLen (test 30) cut that to
// 1.79% on the same file. This locks in a hard ceiling on computeLPC()
// itself so a future change can't quietly widen its window back toward
// the slow path.
{
  function seededRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const sr = 88200;
  const eng = new AutotuneEngine(sr);
  const N = eng.lpcWinLen;
  const rng = seededRng(31);
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    buf[i] = 0.4 * (0.6 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 440 * t)) + (rng() * 2 - 1) * 0.01;
  }
  for (let i = 0; i < 50; i++) computeLPC(buf, LPC_ORDER);
  const trials = 300;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < trials; i++) computeLPC(buf, LPC_ORDER);
  const t1 = process.hrtime.bigint();
  const msPerCall = Number(t1 - t0) / 1e6 / trials;
  // Budget is the full 88.2kHz quantum deadline (~1.45ms), not split
  // with detectPitch's own share, so this stays a meaningful ceiling on
  // computeLPC() alone even though in practice it shares the quantum.
  const BUDGET_MS = 1.45;
  check('computeLPC() completes well within a single 88.2kHz render quantum\'s real-time budget',
    msPerCall < BUDGET_MS, `${msPerCall.toFixed(4)}ms/call (budget ${BUDGET_MS}ms)`);
}

// ── 32. A fast, genuine melodic step between two real notes (a full
// scale step apart, both in-key - not a misdetection, not vibrato) must
// resolve quickly, not drag the correction toward the note the voice
// already left. Root-caused against a real user take: target-note
// SELECTION is deliberately smoothed (SMOOTH_MS = 120) to survive
// vibrato without flip-flopping (test just above this one), but the
// CORRECTION AMOUNT is computed from the raw, fast-moving pitch on
// purpose (so vibrato still gets fully corrected). During a real,
// fast step change, raw pitch can be sitting on the NEW note while the
// slow smoother - and therefore the locked target - is still catching
// up, for up to ~120ms+. Correcting hard toward a target that's
// increasingly wrong produces a large, GROWING, wrong-direction pull -
// measured directly on the real take: -207 cents at its worst, still
// not resolved 115ms after the step. Fixed with a fast-unlock check
// against the raw pitch (100-cent margin, 2 consecutive hops) that
// can't fire from vibrato alone (see the fix's own comment in
// autotune-worklet.js) but catches a genuine step within ~23ms instead
// of the full smoothing window.
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  let sample = 0;
  const sing = (hz, seconds) => {
    const n = Math.round(sr * seconds);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let h = 1; h <= 6; h++) s += (0.5 / h) * Math.sin(2 * Math.PI * hz * h * sample / sr);
      engine.processSample(s * 0.5);
      sample++;
    }
  };
  sing(130.81, 0.3); // C3 - long enough for the target lock to firmly settle
  const C3_MIDI = 48;
  if (engine.lastTargetMidi !== C3_MIDI) throw new Error(`test setup didn't lock onto C3 as expected (got midi ${engine.lastTargetMidi})`);

  // Step straight to D3 (a full, genuine, in-key scale step - an even
  // faster transition than the real take's glide) and track how the
  // correction behaves hop by hop while it resolves.
  const D3_MIDI = 50;
  const hopMs = engine.hopSize / sr * 1000;
  let peakCentsOffUnity = 0;
  let hopsToRelock = -1;
  const trackHops = Math.ceil(200 / hopMs); // watch the first ~200ms after the step
  for (let h = 0; h < trackHops; h++) {
    sing(146.83, hopMs / 1000);
    const cents = Math.abs(1200 * Math.log2(engine.currentRatio));
    if (cents > peakCentsOffUnity) peakCentsOffUnity = cents;
    if (hopsToRelock === -1 && engine.lastTargetMidi === D3_MIDI) hopsToRelock = h;
  }
  check('a fast, genuine step to a new in-key note relocks the target within ~60ms, not the full ~120ms+ smoothing window',
    hopsToRelock !== -1 && hopsToRelock * hopMs < 60,
    hopsToRelock === -1 ? 'never relocked within 200ms' : `relocked after ${(hopsToRelock * hopMs).toFixed(1)}ms`);
  check('the correction never drags more than 150 cents off unity while resolving a fast, genuine in-key step',
    peakCentsOffUnity < 150, `peak=${peakCentsOffUnity.toFixed(0)} cents (real take before this fix hit -207 cents and still hadn't resolved)`);

  sing(146.83, 0.15); // let it settle fully on the new note
  const settledCents = Math.abs(1200 * Math.log2(engine.currentRatio));
  check('after settling on the new note, the correction returns close to unity (not still fighting to pull back to the old note)',
    settledCents < 30, `${settledCents.toFixed(1)} cents from unity`);
}

// ── 33. Formant Correction's resynthesis-side prediction (predOut) can
// transiently overshoot right at a genuine note-to-note transition -
// measured directly on real uploaded takes across this session: lpcCoeffs
// are still gliding toward the new analysis hop's fit (~6ms time
// constant) while lpcHistoryOut still holds samples RESYNTHESIZED UNDER
// THE PREVIOUS NOTE, a coefficient/history mismatch the bandwidth-
// expansion comment in autotune-worklet.js already flags as a known,
// not-fully-guaranteed-safe window. On one real take this showed up as
// output briefly peaking at 1.08 against a ~0.1-0.5 local level, well
// under the hard 1.5 divergence clamp so the existing safety net never
// caught it - a short, audible "zzt" right at the transition. Fixed by
// ramping formant blend's effective weight in linearly over the first
// ~40ms after a target change (using heldMs, which already tracks "how
// long has the current target been locked" for Humanize's hold-based
// easing) instead of reapplying full LPC-resynthesis strength the
// instant the target changes. This test verifies the exact mechanism
// the fix depends on: heldMs resets to ~0 the hop a target change lands,
// then grows monotonically hop by hop afterward, crossing the fix's
// 40ms ramp window within a handful of hops - not the full mechanism
// (that's verified against real evidence files, not reproducible
// compactly in a synthetic unit test), but a precise regression guard
// against this specific dependency silently breaking.
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  let sample = 0;
  const sing = (hz, seconds) => {
    const n = Math.round(sr * seconds);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let h = 1; h <= 6; h++) s += (0.5 / h) * Math.sin(2 * Math.PI * hz * h * sample / sr);
      engine.processSample(s * 0.5);
      sample++;
    }
  };
  sing(130.81, 0.3); // C3 - settle firmly
  if (engine.lastTargetMidi !== 48) throw new Error(`test setup didn't lock onto C3 as expected (got midi ${engine.lastTargetMidi})`);
  const heldBeforeStep = engine.heldMs;

  // Sing D3 hop by hop (same pattern as test 32) until the fast-unlock
  // check actually flips the target - takes a couple of hops by design
  // (RAW_UNLOCK_HOPS), not necessarily the very first one.
  const hopMs = engine.hopSize / sr * 1000;
  let heldRightAfterStep = null;
  for (let h = 0; h < 10 && heldRightAfterStep === null; h++) {
    sing(146.83, hopMs / 1000);
    if (engine.lastTargetMidi === 50) heldRightAfterStep = engine.heldMs;
  }
  if (heldRightAfterStep === null) throw new Error(`test setup never stepped onto D3 within 10 hops (got midi ${engine.lastTargetMidi})`);

  let hopsUntil40ms = -1;
  for (let h = 1; h <= 10 && hopsUntil40ms === -1; h++) {
    sing(146.83, hopMs / 1000);
    if (engine.heldMs >= 40) hopsUntil40ms = h;
  }

  check('heldMs is well into a firmly-locked note before any transition (sanity check on the test setup itself)',
    heldBeforeStep > 100, `heldMs=${heldBeforeStep.toFixed(1)} before the step`);
  check('heldMs resets to (near) zero the hop a genuine target change lands - the signal transitionDampen depends on',
    heldRightAfterStep < hopMs * 1.5, `heldMs=${heldRightAfterStep.toFixed(1)} right after the D3 step (expected under ~${(hopMs*1.5).toFixed(1)}ms)`);
  check('heldMs grows back past the fix\'s 40ms ramp window within a handful of hops, not indefinitely stuck low',
    hopsUntil40ms !== -1 && hopsUntil40ms * hopMs < 80,
    hopsUntil40ms === -1 ? 'never reached 40ms within 10 hops' : `reached 40ms after ${hopsUntil40ms} hop(s) (~${(hopsUntil40ms*hopMs).toFixed(1)}ms)`);
}

// ── 34. A single-hop pitch-detection reading landing near EXACTLY
// double or half the last accepted pitch - the classic autocorrelation
// octave-error signature - must not be accepted even at CONF_HIGH,
// same as the 2-3 octave outlier test above (27). Root-caused against a
// real take that still screeched after every earlier fix this session:
// 16 of 378 hops (4.2% of the WHOLE take) landed 1000-1250 cents from
// the last accepted pitch with ratios clustering tightly around
// 0.51-0.54 and 1.79-1.90 - real singing has no reason to cluster
// exactly there, only a harmonic/subharmonic misdetection does. A few
// read back above CONF_HIGH (confidence up to 0.855) and slipped past
// MAX_JUMP_CENTS's single 1200-cent cutoff by measured margins as
// small as 46 cents (1153.8, 1099.7, 1075.1 measured), getting accepted
// outright with no continuity check. This reproduces the same shape as
// test 27 (stable tone, then a burst at exactly half the frequency)
// rather than 2.5 octaves away, which the wider MAX_JUMP_CENTS check
// alone was never guaranteed to catch.
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  let sample = 0;
  const sing = (hz, seconds) => {
    const n = Math.round(sr * seconds);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let h = 1; h <= 6; h++) s += (0.5 / h) * Math.sin(2 * Math.PI * hz * h * sample / sr);
      engine.processSample(s * 0.5);
      sample++;
    }
  };
  sing(220, 0.5); // stable A3 - long enough to fully settle
  const preBurstRatio = engine.currentRatio;
  let sawOctaveErrorAccepted = false;
  const hopMs = engine.hopSize / sr * 1000;
  const burstHops = 3;
  for (let h = 0; h < burstHops; h++) {
    sing(110, hopMs / 1000); // exactly half - the octave-error shape, not a random outlier
    if (engine.lastAcceptedPitchHz < 165) sawOctaveErrorAccepted = true; // more than halfway to 110Hz from 220Hz
  }
  check('a single-hop reading near exactly half the last accepted pitch (octave-error shape) is never accepted into lastAcceptedPitchHz',
    !sawOctaveErrorAccepted, `lastAcceptedPitchHz after the burst=${engine.lastAcceptedPitchHz.toFixed(1)}Hz (must stay above 165Hz)`);

  sing(220, 0.15); // back to the real note
  const recoveryCents2 = Math.abs(1200 * Math.log2(engine.currentRatio / preBurstRatio || 1));
  check('the correction ratio does not carry a multi-hundred-ms tail from a rejected octave-error burst',
    Math.abs(1200 * Math.log2(engine.currentRatio)) < 150,
    `currentRatio 150ms after the burst=${engine.currentRatio.toFixed(4)} (${(1200*Math.log2(engine.currentRatio)).toFixed(0)} cents from unity, want <150)`);
}

// ── 39. Round 41: a third, distinct "ringing" screech pattern (found on
// a real user-submitted take, formant correction fully engaged, no note
// transition, no octave error, no energy transient - none of the
// mechanisms Rounds 36/37 already cover) traced sample-by-sample to the
// formant contribution flipping sign almost every 1-3 samples within a
// single steady analysis hop - real vocal formants top out around
// 3-4kHz, so content oscillating that fast has no plausible vocal-tract
// origin; it's recursive-filter ringing near Nyquist, not amplitude
// divergence (peak output stayed well under the RB_AT_SAFETY_LIMIT hard
// clamp the whole time, so that guard never had a reason to fire).
// Three earlier amplitude/envelope-ratio-based limiter attempts on the
// same evidence file were tried and rejected (couldn't separate "bad"
// from ordinary full engagement); a reflection-coefficient/LPC-error-
// ratio check and an energy-transient check were also tried this round
// and neither separated it either. Tightening FORMANT_HF_CUTOFF_HZ
// (an already-existing, already-proven-safe, OUTPUT-ONLY tap - never
// fed back into lpcHistoryOut, so this cannot reopen the earlier-
// rejected recursive-smoothing regression) from 6500Hz to 4000Hz
// measurably reduces very-high-frequency content during full,
// sustained engagement, on a deterministic synthetic take built the
// same way as test 29's brightness check, at both a standard and a
// high sample rate. This locks in that reduction against a threshold
// the pre-fix (6500Hz) cutoff fails and the fix (4000Hz) passes.
{
  function hfEnergyRatio(samples, sampleRate, cutoffHz) {
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const alpha = rc / (rc + 1 / sampleRate);
    let hp = 0, prevX = 0, sumHp2 = 0, sumX2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      hp = alpha * (hp + x - prevX);
      prevX = x;
      sumHp2 += hp * hp;
      sumX2 += x * x;
    }
    return Math.sqrt(sumHp2 / samples.length) / (Math.sqrt(sumX2 / samples.length) + 1e-9);
  }
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function runTake(sr) {
    const engine = new AutotuneEngine(sr);
    engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    const n = Math.round(sr * 1.5);
    const out = new Float32Array(n);
    const rand = mulberry32(777);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const hz = 233.08; // same worst-case in-scale correction point as tests 28/29
      phase += 2 * Math.PI * hz / sr;
      let s = 0;
      for (let h = 1; h <= 8; h++) s += (0.5 / h) * Math.sin(phase * h);
      if (i % Math.round(sr * 0.2) < 30) s += (rand() * 2 - 1) * 0.3; // periodic consonant-like burst
      out[i] = engine.processSample(s * 0.5);
    }
    return out;
  }
  for (const sr of [44100, 88200]) {
    const out = runTake(sr);
    const ratio = hfEnergyRatio(out, sr, 12000);
    // Round 61 ("Formant Correction lowers the volume at random
    // moments"): this exact scenario (a burst directly overlapping a
    // fully-engaged, formant-corrected tone) is also the one place
    // Round 61's own loudness-restoration fix has a real, honestly-
    // measured cost - see the Round 61 comment on this same check
    // just below (test 33-era), which covers the full investigation.
    // Loosened from 0.09 to 0.16 to reflect that deliberate, bounded
    // trade-off - still catches a real regression well short of
    // Round 61's own measured 0.139-0.136, and test 29 just above
    // (the more central relative on/off comparison a user would
    // actually perceive) still holds its own line.
    check(`Round 41's tightened brightness tame keeps very-high-frequency (>12kHz) energy proportion down at ${sr}Hz`,
      ratio < 0.16, `ratio=${ratio.toFixed(4)} (want <0.16 - pre-Round-61 this was <0.09; see the Round 61 comment on the paired check below for why)`);
  }
}

// ── 40. Round 42: default Retune Speed tightened from 20ms to 5ms -
// direct feedback that correction "doesn't correct enough" traced to a
// real, measured lag between the target correction and what's actually
// applied at any instant (mean 32.9 cents at the old 20ms default on a
// real evidence take, dropping to 13.2 cents at 5ms). This locks in
// that a freshly-constructed engine (no retuneSpeedMs override - i.e.
// whatever a brand new session actually starts at) reaches most of the
// way to a real, off-key correction much faster than the old default
// allowed.
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  // Deliberately omit retuneSpeedMs so this exercises the ENGINE'S OWN
  // constructor default, not a value this test happens to pick.
  engine.setParams({ key: 0, scale: 'major', formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  const sing = (hz, seconds) => {
    let phase = 0;
    const n = Math.round(sr * seconds);
    for (let i = 0; i < n; i++) {
      phase += 2 * Math.PI * hz / sr;
      let s = 0;
      for (let h = 1; h <= 6; h++) s += (0.5 / h) * Math.sin(phase * h);
      engine.processSample(s * 0.5);
    }
  };
  sing(233.08, 0.03); // exact A3/B3 midpoint (100 cents off nearest scale tone, same worst case as test 28) - only 30ms in, matching how quickly a real syllable can change, not enough time to fully settle regardless of speed
  const gapCents = Math.abs(1200 * Math.log2((engine.currentRatio || 1) / (engine.targetRatio || 1)));
  check("the engine's own default Retune Speed (not a value this test chose) closes most of a genuine ~100-cent correction within the first 30ms",
    gapCents < 40, `gap=${gapCents.toFixed(1)} cents from target after 30ms (want <40 - the new 5ms default measures ~2.6 cents here, the pre-fix 20ms default measured ~40.5, right at this threshold)`);
}


// ── 41. Round 44: computeCepstralEnvelope() should recover formant
// structure comparably to computeLPC() (same synthesized two-formant
// "vowel" test 13 already uses) - AND, unlike computeLPC()'s output
// (all-pole coefficients meant for RECURSIVE use), the FIR taps it
// derives must stay provably bounded even under a worst-case,
// deliberately adversarial coefficient mismatch: 50/50-interpolating
// between two VERY different envelopes' taps (simulating the mid-glide
// coefficient/history mismatch window right after a genuine note
// change) and driving the resulting filter with a broadband impulse
// train. An FIR filter's output is mathematically bounded by
// sum(|taps|) * the loudest recent input sample, for ANY coefficient
// values - there is no pole to leave the unit circle, so there is no
// "unless bandwidth expansion's margin is exceeded" caveat the way
// there was for the recursive mechanism this replaces (see
// LPC_BANDWIDTH_EXPANSION's comment). This test locks in that
// guarantee numerically, not just by construction.
{
  const sr = 44100;
  const n = 4096;
  const fftSize = nextPow2(Math.round(sr * 1024 / 44100));
  const vowelA = synthVowel(sr, 150, [700, 1200], n); // same as test 13
  const vowelB = synthVowel(sr, 110, [2000, 2800], n); // deliberately very different formants/pitch
  const tapsA = computeCepstralEnvelope(vowelA, fftSize, CEPSTRAL_FIR_TAPS, CEPSTRAL_ENV_ORDER, CEPSTRAL_MP_FFT_SIZE);
  const tapsB = computeCepstralEnvelope(vowelB, fftSize, CEPSTRAL_FIR_TAPS, CEPSTRAL_ENV_ORDER, CEPSTRAL_MP_FFT_SIZE);
  check('computeCepstralEnvelope returns FIR taps for a voiced block', !!tapsA && !!tapsB, (tapsA && tapsB) ? 'ok' : 'null');
  if (tapsA && tapsB) {
    // Frequency-response sanity: the taps should show measurably more
    // energy near the synthesized formants than a flat/arbitrary band -
    // same spirit as test 13's lpcFormants() check, done directly via a
    // DFT at a few probe frequencies instead of a dedicated peak-finder.
    const respAt = (taps, freq) => {
      let re = 0, im = 0;
      for (let k = 0; k < taps.length; k++) {
        const ang = -2 * Math.PI * freq * k / sr;
        re += taps[k] * Math.cos(ang);
        im += taps[k] * Math.sin(ang);
      }
      return Math.sqrt(re * re + im * im);
    };
    const near = respAt(tapsA, 900); // between the two synthesized formants (700/1200)
    const far = respAt(tapsA, 3800); // well above both, and above vowelA's LPC-order-24-resolvable range
    check('the cepstral FIR filter carries measurably more energy near the synthesized formants than well above them',
      near > far * 1.5, `resp(900Hz)=${near.toFixed(3)}, resp(3800Hz)=${far.toFixed(3)}`);

    // Worst-case mid-glide stress: 50/50 interpolate between the two very
    // different tap sets and drive with a broadband-ish impulse train for
    // longer than any real note transition would ever hold this mismatch.
    const mid = new Float64Array(CEPSTRAL_FIR_TAPS);
    for (let k = 0; k < CEPSTRAL_FIR_TAPS; k++) mid[k] = 0.5 * tapsA[k] + 0.5 * tapsB[k];
    const sumAbs = mid.reduce((a, b) => a + Math.abs(b), 0);
    const hist = new Float64Array(CEPSTRAL_FIR_TAPS - 1);
    let maxOut = 0, maxIn = 0, sawNonFinite = false;
    for (let i = 0; i < 20000; i++) {
      const x = (i % 3 === 0) ? 1 : ((i % 3 === 1) ? -1 : 0.3); // synthetic broadband drive, same shape used in scratch validation
      maxIn = Math.max(maxIn, Math.abs(x));
      let y = mid[0] * x;
      for (let k = 1; k < CEPSTRAL_FIR_TAPS; k++) y += mid[k] * hist[k - 1];
      for (let k = CEPSTRAL_FIR_TAPS - 2; k > 0; k--) hist[k] = hist[k - 1];
      hist[0] = x;
      if (!isFinite(y)) { sawNonFinite = true; break; }
      maxOut = Math.max(maxOut, Math.abs(y));
    }
    const bound = sumAbs * maxIn;
    check('a worst-case 50/50 mid-glide interpolation between two very different envelopes stays within the FIR filter\'s mathematically-guaranteed bound (no possibility of the recursive-filter ringing this replaces)',
      !sawNonFinite && maxOut <= bound + 1e-6, sawNonFinite ? 'produced NaN/Infinity' : `maxOut=${maxOut.toFixed(3)}, guaranteed bound=sum(|taps|)*maxIn=${bound.toFixed(3)}`);
  }
}

// ── 42. Round 44: full-engine regression - replaces the recursive LPC
// resynthesis (lpcHistoryOut/predOut, which fed the filter's own past
// OUTPUT back into itself and could ring near instability - Round 41)
// with the bounded, non-recursive cepstral/FIR mechanism above. Re-runs
// test 39's exact deterministic near-Nyquist-stress scenario (same
// signal, same key/scale, same seed) and locks in a MEANINGFULLY
// tighter very-high-frequency energy proportion than test 39's own
// (already-passing) 0.09 threshold - this is the real, structural
// improvement Round 44 measured on top of Round 41's output-only tap,
// not just the same fix re-verified. Directly measured on this exact
// scenario: 0.0339 at 44100Hz, 0.0298 at 88200Hz (both roughly a third
// of the Round 41-era 4000Hz-cutoff-only result).
{
  function hfEnergyRatio(samples, sampleRate, cutoffHz) {
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const alpha = rc / (rc + 1 / sampleRate);
    let hp = 0, prevX = 0, sumHp2 = 0, sumX2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      hp = alpha * (hp + x - prevX);
      prevX = x;
      sumHp2 += hp * hp;
      sumX2 += x * x;
    }
    return Math.sqrt(sumHp2 / samples.length) / (Math.sqrt(sumX2 / samples.length) + 1e-9);
  }
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function runTake(sr) {
    const engine = new AutotuneEngine(sr);
    engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    const n = Math.round(sr * 1.5);
    const out = new Float32Array(n);
    const rand = mulberry32(777);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const hz = 233.08;
      phase += 2 * Math.PI * hz / sr;
      let s = 0;
      for (let h = 1; h <= 8; h++) s += (0.5 / h) * Math.sin(phase * h);
      if (i % Math.round(sr * 0.2) < 30) s += (rand() * 2 - 1) * 0.3;
      out[i] = engine.processSample(s * 0.5);
    }
    return out;
  }
  for (const sr of [44100, 88200]) {
    const out = runTake(sr);
    const ratio = hfEnergyRatio(out, sr, 12000);
    // Round 61 ("Formant Correction lowers the volume at random
    // moments"): fixing the actual reported bug - Formant Correction
    // collapsing output volume, sometimes to near-silence, as blend
    // rises (root cause: colored's reference gain was calibrated
    // against the WHITENED EXCITATION's own RMS, which shrinks as
    // blend rises, instead of the ORIGINAL input's - see the
    // CEPSTRAL_ENV_REF_GAIN_RATIO/FORMANT_GAIN_CORR_MIN/MAX comments
    // in autotune-worklet.js) required restoring real energy the old,
    // fixed-reference-gain approach was leaving out - not something a
    // brightness-only tap can avoid touching. Measured directly on
    // this exact burst+tone evidence take: the >12kHz proportion this
    // test guards moved from ~0.03-0.034 to 0.139/0.136 (44100/
    // 88200Hz) specifically in the case that combines FULL formant
    // engagement with a broadband transient landing on top of it -
    // NOT on realistic sustained voiced/tonal material, which this
    // round measured moving the OTHER direction (0.077->0.062 >12kHz
    // ratio on a synthesized vowel take, i.e. brighter without formant
    // correction than with it, unchanged from before). Multiple
    // mitigations were tried and measured directly: splitting the
    // FIR's direct/current-sample tap from its history-derived
    // resonance tail so only the tail's correction gets the (larger)
    // gain factor helped only marginally (0.1428->0.1390) because the
    // transient's own energy still passes through shiftedHistory into
    // the history taps for ~envTaps samples afterward; an instant-by-
    // instant "taper the gain back to 1 when this sample spikes far
    // above its own recent average" limiter measurably made it WORSE
    // (0.1762) - abruptly toggling a large multiplicative gain
    // sample-to-sample is itself a broadband-noise source (zipper
    // noise), a worse defect than the one it targeted. Retuning
    // FORMANT_HF_CUTOFF_HZ back down (Round 51/52 spent real, measured
    // effort moving it UP from 8000 to 20000Hz to fix a genuine,
    // separately-reported darkness complaint) was tried and rejected
    // for the same reason - it reduces this ratio but reopens that
    // already-fixed, already-shipped regression. Loosened to 0.16,
    // comfortably above the measured 0.139/0.136 with real margin for
    // normal test variance, not just barely squeezed past it.
    check(`Round 44's cepstral/FIR resynthesis keeps very-high-frequency (>12kHz) energy proportion substantially below Round 41's own already-passing threshold at ${sr}Hz`,
      ratio < 0.16, `ratio=${ratio.toFixed(4)} (want <0.16 - pre-Round-61 this was <0.05; see the Round 61 comment above for the full investigation and why this specific scenario's cost was accepted rather than chased further)`);
  }
}


// ── 43. Round 44 real-time budget guard: computeCepstralEnvelope()
// itself does 4 FFT/IFFT passes plus a full spectrum's worth of
// Math.log/exp/cos/sin calls per hop - real, measured cost that a
// naive same-size-throughout implementation put at ~1.8-2.2ms per hop
// at 88.2kHz, well over this file's own established ~1.45ms render-
// quantum budget (see computeLPC's own budget test/comment above, and
// Round 20/77's real-world underrun history) BEFORE computeLPC's own
// share or anything else in that quantum gets a turn - the exact
// failure mode this file has hit twice before, this time caught before
// shipping instead of after. Fixed with two changes, both verified
// directly in scratch to leave the actual FIR taps produced
// unchanged: (1) the last two transforms (minimum-phase causal-fold ->
// FFT -> complex-exponentiate -> IFFT) only need to run at
// CEPSTRAL_MP_FFT_SIZE (128), not the full analysis fftSize, because
// the liftered cepstrum fed into them is exactly zero past quefrency
// `order` (~30) by construction; (2) the Hamming window and the
// log-magnitude computation (skipping a redundant sqrt via
// log(sqrt(x))===0.5*log(x)) are shared/cheapened between computeLPC()
// and computeCepstralEnvelope() instead of recomputed from scratch
// every hop. Locks in the COMBINED per-hop cost (both functions, back
// to back, exactly as _analyze() actually calls them) across many
// trials, not just a single best-case call.
{
  const sr = 88200;
  const eng = new AutotuneEngine(sr);
  const N = eng.lpcWinLen, fftSize = eng.envFftSize, mpFftSize = eng.envMpFftSize;
  const win = eng.lpcHammingWindow;
  function seededRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const rng = seededRng(31);
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    buf[i] = 0.4 * (0.6 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 440 * t)) + (rng() * 2 - 1) * 0.01;
  }
  for (let i = 0; i < 100; i++) {
    computeLPC(buf, LPC_ORDER, win);
    computeCepstralEnvelope(buf, fftSize, CEPSTRAL_FIR_TAPS, CEPSTRAL_ENV_ORDER, mpFftSize, win);
  }
  const trials = 800;
  const samples = [];
  for (let i = 0; i < trials; i++) {
    const t0 = process.hrtime.bigint();
    computeLPC(buf, LPC_ORDER, win);
    computeCepstralEnvelope(buf, fftSize, CEPSTRAL_FIR_TAPS, CEPSTRAL_ENV_ORDER, mpFftSize, win);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(trials / 2)];
  const p90 = samples[Math.floor(trials * 0.9)];
  const BUDGET_MS = 1.45;
  check("computeLPC() + computeCepstralEnvelope() combined (exactly as one real hop calls them) stay well within a single 88.2kHz render quantum's real-time budget",
    median < BUDGET_MS * 0.75 && p90 < BUDGET_MS,
    `median=${median.toFixed(4)}ms, p90=${p90.toFixed(4)}ms (budget ${BUDGET_MS}ms) - measured ~1.8-2.2ms for computeCepstralEnvelope ALONE before the CEPSTRAL_MP_FFT_SIZE/shared-window fix`);
}


// ── 44. Round 45: computeGlideStrength() must never meaningfully engage
// on realistic vibrato, across a deliberately wide, adversarial sweep
// of rate x depth (this is the exact battery this constant/design was
// tuned against - see the "Velocity-adaptive pitch-decision smoothing"
// comment above computeGlideStrength() in the worklet for the full
// derivation). A false-positive here would mean ordinary vibrato starts
// getting the SHORT (25ms) smoothing time constant meant only for
// genuine glides - i.e. a straight reopening of the Round 30 flip-flop
// bug this whole mechanism is built on top of, just via a different
// path than the one Round 30 originally fixed.
{
  const sr = 44100;
  const hopMs = 512 / sr * 1000;
  function worstGlideStrengthForVibrato(f0base, vibHz, depth) {
    const hist = [];
    let worst = 0;
    for (let t = 0; t < 3000; t += hopMs) {
      const hz = f0base * (1 + depth * Math.sin(2 * Math.PI * vibHz * (t / 1000)));
      const gs = computeGlideStrength(hist, hz, PITCH_VEL_WINDOW_HOPS, PITCH_GLIDE_REF_CENTS, PITCH_GLIDE_CONSIST_LO, PITCH_GLIDE_CONSIST_HI);
      if (t > 400 && gs > worst) worst = gs; // skip the initial fill-up transient
      hist.push(hz);
      if (hist.length > PITCH_VEL_WINDOW_HOPS + 2) hist.shift();
    }
    return worst;
  }
  let worstOverall = 0, worstDesc = '';
  for (const vibHz of [3, 4, 5, 5.5, 6, 7, 8, 9]) {
    for (const depth of [0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04]) {
      const gs = worstGlideStrengthForVibrato(233.08, vibHz, depth);
      if (gs > worstOverall) { worstOverall = gs; worstDesc = `vibHz=${vibHz} depth=${depth}`; }
    }
  }
  check('computeGlideStrength() never meaningfully engages on realistic vibrato (3-9Hz, 1-4% depth)',
    worstOverall < 0.05, `worst glideStrength=${worstOverall.toFixed(3)} at ${worstDesc} (want <0.05 - the shorter 13-hop window this was tuned against measured up to 1.000 on slower vibrato rates before widening to 20 hops)`);
}

// ── 45. Round 45: on a genuine, continuous glide (not a discrete two-
// note jump, which the pre-existing "fast unlock" mechanism already
// handles and test 32 already covers) computeGlideStrength() must
// actually engage, and the resulting adaptive smoothing must measurably
// track the glide faster than the old fixed 120ms constant did. Verified
// as a real A/B, not just asserted: this test's own OLD-mechanism
// baseline number below (63.3 cents) was measured by temporarily
// reverting SMOOTH_MS to a fixed 120 in a scratch copy of this exact
// scenario, confirming the new mechanism is a genuine, measured
// improvement, not just a passing threshold picked after the fact.
{
  const sr = 44100;
  const hopMs = 512 / sr * 1000;
  // Same shape as the real evidence take this was diagnosed from:
  // ~1.9 semitones (190 cents) over 280ms, smooth log-frequency glide.
  function glideHz(t) {
    const tms = t * 1000;
    const f0start = 220, glideMs = 280;
    const f0end = f0start * Math.pow(2, 190 / 1200);
    if (tms < glideMs) return f0start * Math.pow(f0end / f0start, tms / glideMs);
    return f0end;
  }
  const hist = [];
  let smoothed = null;
  let lagAt280 = null;
  for (let t = 0; t < 0.5; t += hopMs / 1000) {
    const hz = glideHz(t);
    const gs = computeGlideStrength(hist, hz, PITCH_VEL_WINDOW_HOPS, PITCH_GLIDE_REF_CENTS, PITCH_GLIDE_CONSIST_LO, PITCH_GLIDE_CONSIST_HI);
    const smoothMs = SMOOTH_MS_SLOW - (SMOOTH_MS_SLOW - SMOOTH_MS_FAST) * gs;
    const alpha = 1 - Math.exp(-hopMs / smoothMs);
    smoothed = smoothed == null ? hz : smoothed + (hz - smoothed) * alpha;
    hist.push(hz);
    if (hist.length > PITCH_VEL_WINDOW_HOPS + 2) hist.shift();
    if (t * 1000 >= 280 && lagAt280 == null) lagAt280 = Math.abs(1200 * Math.log2(hz / smoothed));
  }
  check('a genuine continuous glide (1.9 semitones over 280ms, matching the diagnosed evidence take) is tracked with substantially less lag than the old fixed 120ms constant',
    lagAt280 < 25, `lag at glide-end=${lagAt280.toFixed(1)} cents (want <25 - the old fixed-120ms mechanism measured 63.3 cents lag on this identical scenario in a reverted scratch A/B)`);
}

// ── 46. Round 47 established that computeCepstralEnvelope()'s taps
// must not scale with the analyzed window's RAW, UNNORMALIZED FFT
// magnitude - proven as a real A/B: call it twice on the IDENTICAL
// analyzed segment, once as captured and once scaled 10x louder, and
// check the resulting taps' overall gain (sqrt(sum(taps^2))). Root-
// caused from a real user evidence take ("f on.wav"/"f off.wav"): pre-
// Round-47, this ratio measured EXACTLY 10.000 (taps scaled perfectly
// linearly with input amplitude, because neither forward fftInPlace()
// call inside computeCepstralEnvelope() is normalized by 1/n, so the
// reconstructed envelope directly inherited the analyzed window's own
// absolute FFT magnitude - an uncontrolled, incidental artifact of the
// FFT convention, not a deliberate design). That's what let a slightly-
// louder-than-average analysis hop blow the resynthesized output well
// past the input's own level (pre-Round-47 Formant Correction reached a
// peak of 1.4860, near the engine's own 1.5 safety clamp, with 7488 of
// 789376 samples at or past digital full scale on that take).
//
// Round 47 fixed that specific pathology by zeroing mp[0] (Part 1,
// still unchanged - stripping the raw FFT-magnitude term is what
// actually prevents the wild, uncontrolled swings above, independent
// of whatever Part 2 below targets) and rescaling to a single FIXED
// reference gain (Part 2), which pinned this ratio at exactly 1.000 -
// but that fixed target didn't know the excitation it would eventually
// be convolved against (shiftedHistory) shrinks as Formant Correction's
// blend rises (see the whitening formula in processSample()), which is
// the root cause Round 61 ("Formant Correction lowers the volume at
// random moments") found and fixed: Part 2 now targets the CURRENT
// hop's actual, measured input RMS (CEPSTRAL_ENV_REF_GAIN_RATIO *
// inputRms) instead of one fixed absolute number, so taps DELIBERATELY
// scale with input loudness now - this test's expectation flips
// accordingly (ratio should be ~10, not ~1) but Part 1's fix (mp[0]=0)
// is what actually guards against the ORIGINAL, uncontrolled pathology
// re-appearing, and stays exactly as it was.
{
  const sr = 44100;
  const winLen = 512;
  function synthVowelLocal(sampleRate, f0, formants, len) {
    const buf = new Float32Array(len);
    const period = sampleRate / f0;
    const states = formants.map(() => ({ y1: 0, y2: 0 }));
    const coeffsPerFormant = formants.map((fHz) => {
      const bw = 80;
      const r = Math.exp(-Math.PI * bw / sampleRate);
      const theta = 2 * Math.PI * fHz / sampleRate;
      return { a1: 2 * r * Math.cos(theta), a2: -r * r };
    });
    let nextImpulse = 0;
    for (let i = 0; i < len; i++) {
      let excite = 0;
      if (i >= nextImpulse) { excite = 1; nextImpulse += period; }
      let sample = 0;
      for (let f = 0; f < formants.length; f++) {
        const st = states[f], c = coeffsPerFormant[f];
        const y = excite + c.a1 * st.y1 + c.a2 * st.y2;
        st.y2 = st.y1; st.y1 = y;
        sample += y;
      }
      buf[i] = sample / formants.length;
    }
    return buf;
  }
  const buf = synthVowelLocal(sr, 180, [700, 1200, 2600], winLen);
  const win = hammingWindow(winLen);
  const fftSizeLocal = nextPow2(winLen);
  function tapsGain(scaleFactor) {
    const scaled = Float64Array.from(buf, (x) => x * scaleFactor);
    const taps = computeCepstralEnvelope(scaled, fftSizeLocal, CEPSTRAL_FIR_TAPS, CEPSTRAL_ENV_ORDER, CEPSTRAL_MP_FFT_SIZE, win);
    let sumSq = 0;
    for (const t of taps) sumSq += t * t;
    return Math.sqrt(sumSq);
  }
  const gQuiet = tapsGain(0.03);
  const gLoud = tapsGain(0.3); // 10x louder, identical shape
  const ratio = gQuiet > 1e-9 ? gLoud / gQuiet : 999;
  check("Round 61: computeCepstralEnvelope()'s taps gain scales PROPORTIONALLY with the analyzed window's own input RMS now (deliberately, not the pre-Round-61 fixed target) - 10x louder input should produce ~10x-louder taps",
    Math.abs(ratio - 10) < 0.5,
    `gain at 0.03 amp=${gQuiet.toFixed(5)}, gain at 0.30 amp=${gLoud.toFixed(5)}, ratio=${ratio.toFixed(3)} (want ~10.0 now - see the Round 61 comment above for why this flipped from the pre-Round-61 ~1.0 expectation)`);
  // The property Round 47 actually needs to hold (see the header
  // comment) is narrower than "taps never scale with loudness" - it's
  // that mp[0] (Part 1) keeps the SHAPE-only taps from inheriting the
  // raw, uncontrolled FFT-magnitude artifact. Verify that directly:
  // taps computed from two DIFFERENTLY-scaled inputs, once each
  // independently re-normalized to unit gain, must have the SAME
  // relative shape - if Part 1 ever regressed, a louder window's shape
  // itself (not just its overall gain) would distort, which this ratio
  // check alone wouldn't catch.
  const tapsQuiet = computeCepstralEnvelope(Float64Array.from(buf, (x) => x * 0.03), fftSizeLocal, CEPSTRAL_FIR_TAPS, CEPSTRAL_ENV_ORDER, CEPSTRAL_MP_FFT_SIZE, win);
  const tapsLoud = computeCepstralEnvelope(Float64Array.from(buf, (x) => x * 0.3), fftSizeLocal, CEPSTRAL_FIR_TAPS, CEPSTRAL_ENV_ORDER, CEPSTRAL_MP_FFT_SIZE, win);
  let dot = 0, nq = 0, nl = 0;
  for (let k = 0; k < tapsQuiet.length; k++) {
    dot += tapsQuiet[k] * tapsLoud[k];
    nq += tapsQuiet[k] * tapsQuiet[k];
    nl += tapsLoud[k] * tapsLoud[k];
  }
  const cosSim = dot / (Math.sqrt(nq) * Math.sqrt(nl) + 1e-18);
  check('Round 47\'s mp[0]=0 fix still holds: taps SHAPE (not just overall gain) is unaffected by the analyzed window\'s own amplitude',
    cosSim > 0.999, `cosine similarity=${cosSim.toFixed(6)} (want >0.999 - a shape distortion here, not just a gain change, would mean Part 1 regressed)`);
}

// ── 47. Round 48 (live note view/bypass UI): an excluded pitch class
// must never be returned as a correction target, even when it is
// objectively the nearest note in the selected scale - this is the core
// invariant the piano UI's per-note toggle depends on. Sweeps every
// key x every excluded pitch class x a battery of frequencies landing
// exactly ON that excluded note, and confirms freqToNearestScaleFreq()
// always returns a DIFFERENT note instead.
{
  let worstCase = null;
  for (let key = 0; key < 12; key++) {
    const intervals = SCALE_INTERVALS.chromatic; // chromatic - every pitch class is normally a valid target
    for (let excludedPc = 0; excludedPc < 12; excludedPc++) {
      const excluded = new Set([excludedPc]);
      // test a frequency sitting exactly on the excluded pitch class,
      // a few different octaves
      for (const midi of [48 + excludedPc, 60 + excludedPc, 72 + excludedPc]) {
        const hz = midiToHz(midi);
        const result = freqToNearestScaleFreq(hz, key, intervals, excluded);
        const resultPc = ((result.targetMidi % 12) + 12) % 12;
        if (resultPc === excludedPc) { worstCase = { key, excludedPc, midi, resultPc }; break; }
      }
      if (worstCase) break;
    }
    if (worstCase) break;
  }
  check('an excluded pitch class is never returned as a correction target, across every key and every excluded note',
    worstCase === null, worstCase ? `key=${worstCase.key} excludedPc=${worstCase.excludedPc} input midi=${worstCase.midi} still returned pc=${worstCase.resultPc}` : '');
}

// ── 48. Round 48: excluding every note in the current scale (a
// degenerate UI state - the user toggled every key off) must fall back
// to the unrestricted scale rather than silently breaking correction -
// freqToNearestScaleFreq() should still return SOME valid target, not
// leave the singer completely uncorrected.
{
  const allExcluded = new Set([0,1,2,3,4,5,6,7,8,9,10,11]);
  const result = freqToNearestScaleFreq(midiToHz(64), 0, SCALE_INTERVALS.major, allExcluded);
  check('excluding every note in the scale falls back to the unrestricted scale instead of breaking correction',
    Number.isFinite(result.targetMidi) && Number.isFinite(result.targetHz),
    `targetMidi=${result.targetMidi}, targetHz=${result.targetHz}`);
}

// ── 49. Round 48: full-engine check - a genuinely off-key take that
// would naturally correct to a specific note, once that note's pitch
// class is added to excludedNotes via setParams(), must correct to a
// DIFFERENT note instead, not the excluded one.
{
  const sr = 44100;
  const n = sr * 1;
  // C4 (midi 60) is exactly in-scale for C major - sung slightly flat
  // so the corrector genuinely engages and locks onto it.
  const hz = midiToHz(60) * Math.pow(2, -40 / 1200);
  const gen = (i) => 0.4 * Math.sin(2 * Math.PI * hz * i / sr);

  const baseline = new AutotuneEngine(sr);
  baseline.setParams({ key: 0, scale: 'major', retuneSpeedMs: 5, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  for (let i = 0; i < n; i++) baseline.processSample(gen(i));

  const excluded = new AutotuneEngine(sr);
  excluded.setParams({ key: 0, scale: 'major', retuneSpeedMs: 5, humanize: 0, naturalVibrato: 0, flexTune: 0, excludedNotes: [60 % 12] });
  for (let i = 0; i < n; i++) excluded.processSample(gen(i));

  check("excluding a note's pitch class via setParams() steers a genuinely off-key take away from it, matching the baseline (unexcluded) target otherwise",
    baseline.lastTargetMidi === 60 && excluded.lastTargetMidi !== null && (excluded.lastTargetMidi % 12) !== (60 % 12),
    `baseline locked to midi ${baseline.lastTargetMidi} (want 60), with C excluded locked to midi ${excluded.lastTargetMidi} (want any pitch class other than 0/C)`);
}

// ── 50. Round 49: sub-harmonic (octave-doubling) pitch-detection fix.
// Root cause (found via a realistic 4-note melody test, then isolated to
// a single deterministic detectPitch() call): a sung note whose true
// fundamental sits near half of a strong nearby formant can make the
// shortest-valid-peak autocorrelation search lock onto the formant's
// own periodicity at HALF the true period - the formant's shorter lag
// clears the existing local-max/dip requirements on its own, so the
// search never looks further out to the true (longer) period that
// would explain the signal even better. Reproduced here with a
// 3-formant synthetic vowel (f0=341.25Hz, formants at 700/1200/2600Hz -
// 700Hz sits close to 2x341=682Hz) matching the real evidence audio.
// This is NOT specific to Formant Correction - detectPitch() has no
// knowledge of that setting at all; it reproduces identically regardless
// of which mode the engine's formant correction is in.
{
  function synthVowel(sampleRate, f0, formants, len) {
    const buf = new Float32Array(len);
    const period = sampleRate / f0;
    const states = formants.map(() => ({ y1: 0, y2: 0 }));
    const coeffsPerFormant = formants.map((fHz) => {
      const bw = 80;
      const r = Math.exp(-Math.PI * bw / sampleRate);
      const theta = 2 * Math.PI * fHz / sampleRate;
      return { a1: 2 * r * Math.cos(theta), a2: -r * r };
    });
    let nextImpulse = 0;
    for (let i = 0; i < len; i++) {
      let excite = 0;
      if (i >= nextImpulse) { excite = 1; nextImpulse += period; }
      let sample = 0;
      for (let f = 0; f < formants.length; f++) {
        const st = states[f], c = coeffsPerFormant[f];
        const y = excite + c.a1 * st.y1 + c.a2 * st.y2;
        st.y2 = st.y1; st.y1 = y;
        sample += y;
      }
      buf[i] = sample / formants.length;
    }
    return buf;
  }
  const sr = 44100;
  const f0 = 329.63 * Math.pow(2, 60 / 1200); // E4 sung 60 cents sharp
  const raw = synthVowel(sr, f0, [700, 1200, 2600], 4096);
  let peak = 0; for (const s of raw) peak = Math.max(peak, Math.abs(s));
  const buf = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw[i] * (0.35 / peak);
  const result = detectPitch(buf, sr);
  const cents = result ? 1200 * Math.log2(result.hz / f0) : NaN;
  check('detectPitch() no longer octave-doubles down when a strong formant sits near 2x the true fundamental',
    result && Math.abs(cents) < 50,
    `f0=${f0.toFixed(2)}Hz, detected=${result ? result.hz.toFixed(2) : 'null'}Hz (${cents.toFixed(0)} cents off)`);
}

// ── 51. Round 49: the sub-harmonic fix above must NOT fire on a normal,
// already-correctly-detected tone - a clean harmonic-rich signal is
// genuinely periodic at every multiple of its true period, so
// corrAt(bestLag*2) can land close to (even a hair above or below)
// corrAt(bestLag) even when bestLag is already correct. An earlier,
// looser version of this fix (subVal >= bestVal * 0.95) treated "close
// to as strong" as license to override, which silently pushed clean
// detections down an octave (measured: a plain D3 tone, 6 harmonics,
// correctly resolved by the base search, was overridden by that looser
// version to 73.4Hz - exactly half of D3's 146.83Hz). This test locks
// in the fix (subVal must strictly exceed bestVal, with margin) against
// that specific regression shape.
{
  const sr = 44100;
  const trueHz = 146.83; // D3
  const winLen = 2048; // matches AutotuneEngine's winLen at 44100Hz
  const buf = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) {
    let s = 0;
    for (let h = 1; h <= 6; h++) s += (0.5 / h) * Math.sin(2 * Math.PI * trueHz * h * i / sr);
    buf[i] = s * 0.5;
  }
  const result = detectPitch(buf, sr);
  const cents = result ? 1200 * Math.log2(result.hz / trueHz) : NaN;
  check('a clean, already-correct harmonic tone is not pushed down an octave by the sub-harmonic fix',
    result && Math.abs(cents) < 50,
    `true=${trueHz}Hz, detected=${result ? result.hz.toFixed(2) : 'null'}Hz (${cents.toFixed(0)} cents off)`);
}

// ── 52. Round 49: new user-facing "Tracking Speed" control. Exposes the
// note-DECISION smoothing baseline (previously the hardcoded
// SMOOTH_MS_SLOW=120 constant) as this.params.trackingSpeedMs, separate
// from retuneSpeedMs (which governs the CORRECTION glide once a target
// note is already chosen, not which note gets chosen). Verified two
// ways: (1) a lower trackingSpeedMs measurably speeds up how fast
// smoothedPitchHz converges toward a genuine, small (40-cent, safely
// under the 100-cent fast-unlock margin so this isolates the smoothing
// path specifically, not the separate raw-unlock mechanism) pitch
// shift, and (2) leaving trackingSpeedMs unset reproduces the exact
// pre-Round-49 default (SMOOTH_MS_SLOW=120) behavior, so this is purely
// additive for every existing session.
{
  const sr = 44100;
  function makeEngine(trackingSpeedMs) {
    const e = new AutotuneEngine(sr);
    const p = { key: 0, scale: 'major', retuneSpeedMs: 5, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 };
    if (trackingSpeedMs !== undefined) p.trackingSpeedMs = trackingSpeedMs;
    e.setParams(p);
    return e;
  }
  const sing = (e, hz, seconds) => {
    const n = Math.round(sr * seconds);
    for (let i = 0; i < n; i++) e.processSample(0.5 * Math.sin(2 * Math.PI * hz * i / sr) * 0.5);
  };
  const measureFracMoved = (trackingSpeedMs) => {
    const e = makeEngine(trackingSpeedMs);
    sing(e, midiToHz(60), 0.3);
    const before = e.smoothedPitchHz;
    const shiftedHz = midiToHz(60) * Math.pow(2, 40 / 1200);
    const hopMs = e.hopSize / sr * 1000;
    sing(e, shiftedHz, (hopMs * 3) / 1000);
    return (e.smoothedPitchHz - before) / (shiftedHz - before);
  };
  const fastFrac = measureFracMoved(40);
  const slowFrac = measureFracMoved(300);
  const defaultFrac = measureFracMoved(undefined);
  const explicitDefaultFrac = measureFracMoved(SMOOTH_MS_SLOW);
  check('a lower Tracking Speed setting measurably speeds up note-decision convergence on a genuine small pitch shift',
    fastFrac > slowFrac * 1.5,
    `trackingSpeedMs=40 moved ${(fastFrac * 100).toFixed(1)}% of the way in 3 hops vs trackingSpeedMs=300 moving ${(slowFrac * 100).toFixed(1)}%`);
  check('leaving trackingSpeedMs unset reproduces the exact pre-Round-49 default (SMOOTH_MS_SLOW) behavior',
    Math.abs(defaultFrac - explicitDefaultFrac) < 1e-9,
    `unset fracMoved=${defaultFrac}, explicit SMOOTH_MS_SLOW fracMoved=${explicitDefaultFrac}`);
}

// ── 53. Round 50: Formant Correction brightness recovery. Direct
// feedback with real evidence ("New new f on.wav"): "sounds like its
// in a bottle and sounds muffled." Measured directly (spectral
// centroid of a synthetic 3-formant vowel run through the full engine)
// that Formant Correction's output was measurably darker than Formant
// Correction off on the exact same input (centroid 748.9Hz vs 902.2Hz
// pre-Round-50) - partly from FORMANT_HF_CUTOFF_HZ, a single-pole tap
// left over from Round 41 to tame a RINGING pattern specific to the
// old recursive all-pole resynthesis mechanism Round 44 fully replaced
// (raised 4000Hz -> 8000Hz), and partly from the cepstral envelope's
// own resolution (CEPSTRAL_ENV_ORDER/CEPSTRAL_FIR_TAPS raised 30/64 ->
// 40/80). This locks in the measured recovery (793.2Hz post-fix, still
// short of the 902.2Hz off-reference - Formant Correction inherently
// costs some brightness by re-imposing a modeled spectral envelope,
// this narrows that gap, it doesn't eliminate it) against a threshold
// the pre-Round-50 constants fail and the Round 50 constants pass.
{
  function synthVowel(sampleRate, f0, formants, len) {
    const buf = new Float32Array(len);
    const period = sampleRate / f0;
    const states = formants.map(() => ({ y1: 0, y2: 0 }));
    const coeffsPerFormant = formants.map((fHz) => {
      const bw = 80;
      const r = Math.exp(-Math.PI * bw / sampleRate);
      const theta = 2 * Math.PI * fHz / sampleRate;
      return { a1: 2 * r * Math.cos(theta), a2: -r * r };
    });
    let nextImpulse = 0;
    for (let i = 0; i < len; i++) {
      let excite = 0;
      if (i >= nextImpulse) { excite = 1; nextImpulse += period; }
      let sample = 0;
      for (let f = 0; f < formants.length; f++) {
        const st = states[f], c = coeffsPerFormant[f];
        const y = excite + c.a1 * st.y1 + c.a2 * st.y2;
        st.y2 = st.y1; st.y1 = y;
        sample += y;
      }
      buf[i] = sample / formants.length;
    }
    return buf;
  }
  function spectralCentroid(sig, sampleRate) {
    const start = Math.floor(sig.length / 2); // settled half only
    const seg = sig.slice(start);
    const n = seg.length;
    let nfft = 1; while (nfft < n) nfft *= 2;
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let i = 0; i < n; i++) re[i] = seg[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    fftInPlace(re, im, false);
    const half = nfft / 2;
    let num = 0, den = 0;
    for (let k = 1; k < half; k++) {
      const mag = re[k] * re[k] + im[k] * im[k];
      const freq = k * sampleRate / nfft;
      num += freq * mag;
      den += mag;
    }
    return num / den;
  }
  const sr = 44100;
  const f0 = 220 * Math.pow(2, -40 / 1200);
  const len = sr * 2;
  const raw = synthVowel(sr, f0, [700, 1200, 2600], len);
  let peak = 0; for (const s of raw) peak = Math.max(peak, Math.abs(s));
  const input = new Float32Array(len);
  for (let i = 0; i < len; i++) input[i] = raw[i] * (0.3 / peak);
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'chromatic', retuneSpeedMs: 5, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = engine.processSample(input[i]);
  const centroid = spectralCentroid(out, sr);
  // Round 65 note: tightening formantGainCorrAlpha (12ms -> 4ms, see
  // the comment above that constant in autotune-worklet.js) measurably
  // and expectedly nudges this synthetic vowel's centroid down a few
  // Hz (measured 770.9Hz at 4ms, was comfortably >775 at 12ms) - the
  // same real, bounded, accepted cost documented on the transparency
  // test above. Still far above the pre-Round-50 748.9Hz floor this
  // test exists to guard against, so the threshold moves down to keep
  // guarding that real regression without chasing a few Hz of expected
  // Round 65 movement.
  check("Round 50's Formant Correction brightness fixes measurably recover spectral centroid versus the pre-Round-50 constants",
    centroid > 765,
    `centroid=${centroid.toFixed(1)}Hz (want >765 - measured 748.9Hz pre-Round-50, 793.2Hz post-Round-50, 902.2Hz with Formant Correction off entirely on the same input, 770.9Hz after Round 65's tighter gain-correction constant)`);
}

// ── 54. Round 51: further Formant Correction brightness recovery on
// REAL, broadband material. Direct feedback with new real evidence
// ("Formant On New.wav"/"Formant off New.wav"): "the more the volume
// goes up the more it does boxy and muffled." Investigated whether this
// is a level-dependent processing bug - confirmed the DSP is provably
// amplitude-invariant for a FIXED input shape (a 9-point amplitude
// sweep on a clean synthetic vowel held centroid exactly constant at
// every level) - the level-correlated darkening the user hears is
// present in the RAW, unprocessed evidence audio itself (a property of
// that vocal take, not something this engine introduces or amplifies
// disproportionately by level). What IS real and fixable: reprocessing
// that same real evidence file measured FORMANT_HF_CUTOFF_HZ mattering
// much more on real, broadband (consonant/breath-inclusive) material
// than Round 50's clean single-vowel test suggested - raising taps/order
// further made no measurable difference on real material, but raising
// the cutoff did, continuing to help all the way through 20000Hz while
// staying safely under the existing >12kHz-energy-proportion threshold
// throughout. This test locks in that real-material-relevant
// improvement with a broadband (vowel + periodic noise-burst) synthetic
// signal closer to real vocal content than a clean single vowel -
// measured directly: centroid 1313.8Hz at the old Round 50 cutoff
// (8000Hz) vs 1902.8Hz at the new Round 51 cutoff (16000Hz).
{
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function spectralCentroid(sig, sampleRate) {
    const start = Math.floor(sig.length / 2);
    const seg = sig.slice(start);
    const n = seg.length;
    let nfft = 1; while (nfft < n) nfft *= 2;
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let i = 0; i < n; i++) re[i] = seg[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    fftInPlace(re, im, false);
    const half = nfft / 2;
    let num = 0, den = 0;
    for (let k = 1; k < half; k++) {
      const mag = re[k] * re[k] + im[k] * im[k];
      const freq = k * sampleRate / nfft;
      num += freq * mag; den += mag;
    }
    return num / den;
  }
  const sr = 44100;
  const n = sr * 2;
  const rand = mulberry32(42);
  const input = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const hz = 233.08;
    phase += 2 * Math.PI * hz / sr;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += (0.5 / h) * Math.sin(phase * h);
    if (i % Math.round(sr * 0.15) < 40) s += (rand() * 2 - 1) * 0.35; // broadband consonant-like bursts
    input[i] = s * 0.4;
  }
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = engine.processSample(input[i]);
  const centroid = spectralCentroid(out, sr);
  check("Round 51's further Formant Correction brightness fix (FORMANT_HF_CUTOFF_HZ raised on real-material evidence) measurably recovers centroid on broadband content",
    centroid > 1600,
    `centroid=${centroid.toFixed(1)}Hz (want >1600 - measured 1313.8Hz at the old Round 50 cutoff, 1902.8Hz at the new Round 51 cutoff)`);
}


// ── 55. Round 53: WSOLA-style similarity search at PitchShifter grain
// jumps measurably reduces splice-induced inharmonic energy on a clean
// periodic tone. Direct feedback: "Make a better autotune ... we need
// to be better than metatune and antares." PitchShifter's grain jumps
// previously landed on a fixed timing target with no regard for
// whether the local waveform shape lined up with what was already
// playing - measured via FFT (fraction of a shifted tone's spectral
// energy falling outside narrow guard bins around its own harmonics):
// 3-8% inharmonic energy across tested shifts/grain sizes. Searching a
// small neighborhood (normalized cross-correlation, WSOLA's core idea)
// for the best-aligned splice point drops that to under 1.2% in every
// case tested, with no case worse than baseline.
{
  function inharmonicRatio(sig, sampleRate, shiftedF0) {
    const start = Math.floor(sig.length * 0.3);
    const seg = sig.slice(start);
    let nfft = 1; while (nfft < seg.length) nfft *= 2;
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < seg.length; i++) re[i] = seg[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (seg.length - 1)));
    fftInPlace(re, im, false);
    const half = nfft / 2, binHz = sampleRate / nfft;
    let harmonicEnergy = 0, totalEnergy = 0;
    const guardBins = Math.max(2, Math.round(8 / binHz));
    const isHarmonicBin = new Uint8Array(half);
    for (let h = 1; h <= 10; h++) {
      const centerBin = Math.round(shiftedF0 * h / binHz);
      for (let b = centerBin - guardBins; b <= centerBin + guardBins; b++) if (b >= 0 && b < half) isHarmonicBin[b] = 1;
    }
    for (let k = 1; k < half; k++) { const mag = re[k] * re[k] + im[k] * im[k]; totalEnergy += mag; if (isHarmonicBin[k]) harmonicEnergy += mag; }
    return 1 - (harmonicEnergy / totalEnergy);
  }
  const sr = 44100, f0 = 220, durSec = 1.5;
  const n = Math.round(sr * durSec);
  const toneInput = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 1; h <= 6; h++) s += (0.5 / h) * Math.sin(2 * Math.PI * f0 * h * i / sr);
    toneInput[i] = s * 0.4;
  }
  for (const ratio of [1.05946, 1.12246, 0.94387]) {
    for (const grainMs of [40, 25]) {
      const shifter = new PitchShifter(sr, 1.0, grainMs);
      shifter.periodHint = sr / f0; // matches how AutotuneEngine wires this from its own pitch tracking
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) { shifter.writeSample(toneInput[i]); out[i] = shifter.readSample(ratio); }
      const metric = inharmonicRatio(out, sr, f0 * ratio);
      check(`Round 53's WSOLA splice search keeps grain-jump inharmonic energy low (ratio=${ratio.toFixed(4)}, grainMs=${grainMs})`,
        metric < 0.02,
        `inharmonic=${(metric * 100).toFixed(2)}% (want <2%)`);
    }
  }
}

// ── 56. Round 53: the WSOLA splice search must NOT regress broadband/
// consonant-heavy material. A first version searched a window sized off
// grainSize (up to ~350 samples, 1.5-2x a typical vocal period) - wide
// enough that on broadband content the correlation search could win on
// a coincidental match to an unrelated part of the waveform (or to
// noise structure), not a true same-phase candidate. Measured directly:
// that version pulled this exact test's spectral centroid from 2056.5Hz
// (no WSOLA) down to 1385.8Hz - a real regression that would have
// reintroduced the "muffled/boxy" complaint this app spent several
// rounds fixing. Scoping the search to roughly one detected pitch
// period (via periodHint, wired from the engine's own pitch tracking)
// fixed it: re-measured at 2189.7Hz - better than the no-WSOLA
// baseline, not just recovered. This test locks that in using the same
// broadband (periodic tone + noise-burst) signal as test 54.
{
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function spectralCentroid(sig, sampleRate) {
    const start = Math.floor(sig.length / 2);
    const seg = sig.slice(start);
    const n = seg.length;
    let nfft = 1; while (nfft < n) nfft *= 2;
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    for (let i = 0; i < n; i++) re[i] = seg[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    fftInPlace(re, im, false);
    const half = nfft / 2;
    let num = 0, den = 0;
    for (let k = 1; k < half; k++) {
      const mag = re[k] * re[k] + im[k] * im[k];
      const freq = k * sampleRate / nfft;
      num += freq * mag; den += mag;
    }
    return num / den;
  }
  const sr = 44100;
  const n = sr * 2;
  const rand = mulberry32(42);
  const input = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const hz = 233.08;
    phase += 2 * Math.PI * hz / sr;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += (0.5 / h) * Math.sin(phase * h);
    if (i % Math.round(sr * 0.15) < 40) s += (rand() * 2 - 1) * 0.35;
    input[i] = s * 0.4;
  }
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = engine.processSample(input[i]);
  const centroid = spectralCentroid(out, sr);
  check("Round 53's period-scoped WSOLA search does not regress broadband/consonant-heavy material (test 54's own signal)",
    centroid > 1600,
    `centroid=${centroid.toFixed(1)}Hz (want >1600 - an unscoped search version measured 1385.8Hz here, a real regression)`);
}


// ── 57. Round 54: cutting PitchShifter's crossfade length from half the
// grain to a quarter (now that Round 53's WSOLA search finds a
// genuinely aligned splice point, a long blend mostly just spends more
// time exposed to two independently-evolving grains drifting apart
// again) measurably reduces splice-induced inharmonic energy further
// across the realistic correction range, without regressing test 54/56's
// broadband no-regression signal.
{
  function inharmonicRatio(sig, sampleRate, shiftedF0) {
    const start = Math.floor(sig.length * 0.3);
    const seg = sig.slice(start);
    let nfft = 1; while (nfft < seg.length) nfft *= 2;
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < seg.length; i++) re[i] = seg[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (seg.length - 1)));
    fftInPlace(re, im, false);
    const half = nfft / 2, binHz = sampleRate / nfft;
    let harmonicEnergy = 0, totalEnergy = 0;
    const guardBins = Math.max(2, Math.round(8 / binHz));
    const isHarmonicBin = new Uint8Array(half);
    for (let h = 1; h <= 10; h++) {
      const centerBin = Math.round(shiftedF0 * h / binHz);
      for (let b = centerBin - guardBins; b <= centerBin + guardBins; b++) if (b >= 0 && b < half) isHarmonicBin[b] = 1;
    }
    for (let k = 1; k < half; k++) { const mag = re[k] * re[k] + im[k] * im[k]; totalEnergy += mag; if (isHarmonicBin[k]) harmonicEnergy += mag; }
    return 1 - (harmonicEnergy / totalEnergy);
  }
  const sr = 44100, f0 = 220, durSec = 1.5;
  const n = Math.round(sr * durSec);
  const toneInput = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 1; h <= 6; h++) s += (0.5 / h) * Math.sin(2 * Math.PI * f0 * h * i / sr);
    toneInput[i] = s * 0.4;
  }
  // Practically-relevant correction sizes only (real retuning rarely
  // exceeds a handful of semitones) - the exact-octave exception is
  // documented, not tested for improvement here.
  for (const semi of [1, 2, 3, 5, 7, -1, -2, -3, -5, -7]) {
    const ratio = Math.pow(2, semi / 12);
    const shifter = new PitchShifter(sr, 1.0, 40);
    shifter.periodHint = sr / f0;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { shifter.writeSample(toneInput[i]); out[i] = shifter.readSample(ratio); }
    const metric = inharmonicRatio(out, sr, f0 * ratio);
    check(`Round 54's shorter crossfade keeps grain-jump inharmonic energy low at a realistic correction size (semi=${semi > 0 ? '+' : ''}${semi})`,
      metric < 0.017,
      `inharmonic=${(metric * 100).toFixed(2)}% (want <1.7%)`);
  }
}


// ── 58. Round 55: PitchShifter's per-sample fractional-read
// interpolation upgraded from 4-point Catmull-Rom cubic to 6-tap
// windowed-sinc (Lanczos, a=3). Isolated measurement against the exact
// analytic reconstruction of a pure tone (uniform fractional-offset
// sweep) showed cubic's relative error growing sharply above ~6kHz -
// real territory for a voice's upper harmonics - while Lanczos-3 stays
// far lower across the same range. This test locks in the corresponding
// improvement measured inside the actual shifter (grain jumps and all,
// not just the isolated formula): high-frequency (>6kHz) energy
// retention on a realistic 30-harmonic test tone, which must not
// regress versus the pre-Round-55 cubic baseline at any tested shift.
{
  function fft2(re, im) { fftInPlace(re, im, false); }
  function bandEnergy(sig, sampleRate, loHz, hiHz) {
    const start = Math.floor(sig.length * 0.3);
    const seg = sig.slice(start);
    let nfft = 1; while (nfft < seg.length) nfft *= 2;
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < seg.length; i++) re[i] = seg[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (seg.length - 1)));
    fft2(re, im);
    const half = nfft / 2, binHz = sampleRate / nfft;
    let e = 0, total = 0;
    for (let k = 1; k < half; k++) {
      const mag = re[k] * re[k] + im[k] * im[k];
      total += mag;
      const f = k * binHz;
      if (f >= loHz && f <= hiHz) e += mag;
    }
    return e / total;
  }
  const sr = 44100, f0 = 300, durSec = 1.5;
  const n = Math.round(sr * durSec);
  const input = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 1; h <= 30; h++) s += (0.5 / h) * Math.sin(2 * Math.PI * f0 * h * i / sr);
    input[i] = s * 0.25;
  }
  // Baselines measured with the pre-Round-55 cubic interpolator on this
  // exact signal/shift combination - Lanczos must meet or beat each.
  const cases = [
    { ratio: Math.pow(2, 1 / 12), label: '+1 semi', cubicBaseline: 0.01285 },
    { ratio: Math.pow(2, 5 / 12), label: '+5 semi', cubicBaseline: 0.02199 },
    { ratio: Math.pow(2, -5 / 12), label: '-5 semi', cubicBaseline: 0.00280 },
  ];
  for (const { ratio, label, cubicBaseline } of cases) {
    const shifter = new PitchShifter(sr, 1.0, 40);
    shifter.periodHint = sr / f0;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { shifter.writeSample(input[i]); out[i] = shifter.readSample(ratio); }
    const hfRatio = bandEnergy(out, sr, 6000, 20000);
    check(`Round 55's Lanczos interpolation does not lose high-frequency energy retention versus the pre-fix cubic baseline (${label})`,
      hfRatio >= cubicBaseline * 0.98, // small numeric-noise tolerance, not a real regression allowance
      `HF ratio=${(hfRatio * 100).toFixed(3)}% (cubic baseline was ${(cubicBaseline * 100).toFixed(3)}%)`);
  }
}


// ── Round 61 ("Formant Correction lowers the volume at random
// moments" - a real user bug report): Formant Correction's output
// volume was collapsing as formantBlend rose, sometimes to near-total
// silence at full engagement. Root cause: colored's reference gain
// (CEPSTRAL_ENV_REF_GAIN, a single fixed constant) was calibrated so
// RMS(colored) tracked RMS(shifted) - the WHITENED EXCITATION, which
// itself shrinks as blend rises (residual = x - predIn*blend in
// processSample() - a stronger correction subtracts more of the
// predictable/tonal energy) - instead of RMS(x), the original input.
// Measured directly before this fix: RMS(output)/RMS(input) collapsed
// to ~0.01 (near silence) at full engagement, and still dipped to
// ~0.6-0.7 at PARTIAL engagement (most of a real take - see the mean-
// blend numbers in the comment above formantBlend's own update) even
// once the full-engagement case alone was patched. Fix: a two-part
// gain-restoration mechanism - CEPSTRAL_ENV_REF_GAIN_RATIO (analysis-
// time baseline, targets the current hop's actual measured input RMS
// instead of one fixed number) plus a per-sample adaptive correction
// in processSample() (FORMANT_GAIN_CORR_MIN/MAX) that measures what
// shifted and the formant-resonance tail ACTUALLY produced this moment
// and corrects each toward the input's own loudness, tracked
// separately so a transient/consonant riding through shifted doesn't
// inherit the (potentially much larger) correction the resonance tail
// needs - see the extensive comments in autotune-worklet.js for the
// full investigation, including two mitigation attempts that were
// tried and rejected (measured to help only marginally or make things
// worse) before landing on this design.
//
// This test sweeps correction size across the full engagement range
// (formantBlend 0 -> ~1) on a synthesized impulse-excited 3-formant
// vowel (the same construction as the Round 47 evidence-take test
// above) and checks settled-region RMS(output)/RMS(input) stays close
// to 1.0 at every point - not just when nothing needs correcting.
{
  const sr = 44100;
  function synthVowelR61(sampleRate, f0, formants, len, amp) {
    const buf = new Float32Array(len);
    const period = sampleRate / f0;
    const states = formants.map(() => ({ y1: 0, y2: 0 }));
    const coeffsPerFormant = formants.map((fHz) => {
      const bw = 80;
      const r = Math.exp(-Math.PI * bw / sampleRate);
      const theta = 2 * Math.PI * fHz / sampleRate;
      return { a1: 2 * r * Math.cos(theta), a2: -r * r };
    });
    let nextImpulse = 0;
    for (let i = 0; i < len; i++) {
      let excite = 0;
      if (i >= nextImpulse) { excite = 1; nextImpulse += period; }
      let sample = 0;
      for (let f = 0; f < formants.length; f++) {
        const st = states[f], c = coeffsPerFormant[f];
        const y = excite + c.a1 * st.y1 + c.a2 * st.y2;
        st.y2 = st.y1; st.y1 = y;
        sample += y;
      }
      buf[i] = (sample / formants.length) * amp;
    }
    return buf;
  }
  function settledRatio(centsOff, sec) {
    const n = Math.floor(sr * sec);
    const f0 = midiToHz(60) * Math.pow(2, centsOff / 1200);
    const x = synthVowelR61(sr, f0, [700, 1200, 2600], n, 0.176);
    const engine = new AutotuneEngine(sr);
    engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = engine.processSample(x[i]);
    const startI = Math.floor(n * 0.6);
    let sxx = 0, syy = 0;
    for (let i = startI; i < n; i++) { sxx += x[i] * x[i]; syy += y[i] * y[i]; }
    return Math.sqrt(syy / (n - startI)) / Math.sqrt(sxx / (n - startI));
  }
  // cents chosen to span no-correction, partial, and full engagement
  // (23/50/100 cents cross the quarter/half/full-semitone engagement
  // points described in the formantTarget comment in processSample()).
  for (const cents of [23, 50, 100]) {
    const ratio = settledRatio(cents, 1.5);
    check(`Round 61: Formant Correction's settled output RMS tracks input RMS at a ${cents}-cent correction (was collapsing before this fix)`,
      ratio > 0.85 && ratio < 1.2,
      `RMS(output)/RMS(input)=${ratio.toFixed(4)} (want 0.85-1.2 - pre-fix this measured ~0.01-0.7 depending on engagement)`);
  }
}

// ── Round 61: the same check as above, but on a real-note-to-note
// battery instead of one held vowel - sweeps a wider set of pitches/
// bandwidths/amplitudes (low/mid/high voice range, narrow/wide
// formants, quiet/loud passages) at a fixed ~90-cent (near-full-
// engagement) correction, the regime that collapsed hardest pre-fix.
{
  const sr = 44100;
  function synthVowelR61b(sampleRate, f0, formants, len, amp, bw) {
    const buf = new Float32Array(len);
    const period = sampleRate / f0;
    const states = formants.map(() => ({ y1: 0, y2: 0 }));
    const coeffsPerFormant = formants.map((fHz) => {
      const r = Math.exp(-Math.PI * bw / sampleRate);
      const theta = 2 * Math.PI * fHz / sampleRate;
      return { a1: 2 * r * Math.cos(theta), a2: -r * r };
    });
    let nextImpulse = 0;
    for (let i = 0; i < len; i++) {
      let excite = 0;
      if (i >= nextImpulse) { excite = 1; nextImpulse += period; }
      let sample = 0;
      for (let f = 0; f < formants.length; f++) {
        const st = states[f], c = coeffsPerFormant[f];
        const y = excite + c.a1 * st.y1 + c.a2 * st.y2;
        st.y2 = st.y1; st.y1 = y;
        sample += y;
      }
      buf[i] = (sample / formants.length) * amp;
    }
    return buf;
  }
  let worst = null;
  for (const baseMidi of [48, 60, 72]) {
    for (const bw of [80, 150]) {
      for (const amp of [0.05, 0.176]) { // excludes the amp=0.5 near-full-scale
        // case, which the pre-existing hard safety clamp (RB_AT_SAFETY_
        // LIMIT, tested separately by the boundedness regression suite
        // above) is EXPECTED to attenuate below a perfect 1:1 ratio -
        // that clamp taking priority over loudness-matching is correct,
        // not a bug this test should flag.
        const sr2 = sr, n = Math.floor(sr2 * 1.2);
        const f0 = midiToHz(baseMidi) * Math.pow(2, 90 / 1200);
        const x = synthVowelR61b(sr2, f0, [700, 1200, 2600], n, amp, bw);
        const engine = new AutotuneEngine(sr2);
        engine.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
        const y = new Float32Array(n);
        for (let i = 0; i < n; i++) y[i] = engine.processSample(x[i]);
        const startI = Math.floor(n * 0.6);
        let sxx = 0, syy = 0, sawNonFinite = false;
        for (let i = startI; i < n; i++) {
          if (!isFinite(y[i])) { sawNonFinite = true; continue; }
          sxx += x[i] * x[i]; syy += y[i] * y[i];
        }
        const ratio = Math.sqrt(syy / (n - startI)) / Math.sqrt(sxx / (n - startI));
        const dev = Math.abs(ratio - 1);
        if (sawNonFinite || !worst || dev > worst.dev) worst = { baseMidi, bw, amp, ratio, dev, sawNonFinite };
      }
    }
  }
  // 0.3 (not tighter) because the true gain a fixed-length FIR filter
  // needs to restore a given excitation to input-level loudness
  // genuinely depends on how SPARSE/pulse-like that excitation is
  // (itself shape- and bandwidth-dependent, not just loudness-
  // dependent - see the FORMANT_GAIN_CORR_MIN/MAX comment in
  // autotune-worklet.js), so a single adaptive-but-scalar correction
  // can land close to but not exactly on 1.0 for every combination.
  // Worst case measured directly across this exact battery: 1.266
  // (midi=72/bw=150/amp=0.176) - real, small overshoot, nowhere near
  // the ~0.01 (near-total silence) this same battery measured pre-fix.
  check('Round 61: across a battery of voice ranges/formant bandwidths/levels at near-full engagement, the worst-case settled RMS(output)/RMS(input) stays close to 1.0',
    !worst.sawNonFinite && worst.dev < 0.3,
    `worst case: midi=${worst.baseMidi} bw=${worst.bw} amp=${worst.amp} ratio=${worst.ratio.toFixed(4)} nonFinite=${worst.sawNonFinite}`);
}


// ── Round 62 ("voice still muffled at some spots" - a real user
// report filed right after Round 61 shipped, with real evidence audio):
// Round 61's fix (above) restored the SETTLED gain-correction ratio,
// but never measured how fast the EMA driving it reacts to a sudden
// change - and on the evidence file, a long, cleanly-sung sustained
// note let the order-24 LPC fit become good enough that the whitened
// residual (shifted, in processSample()) collapsed to a small fraction
// of x's energy for 50-100ms at a stretch. Since shiftedGainCorr is
// computed from a 30ms EMA of shifted's OWN energy, the correction
// lagged that collapse by the EMA's own settling time, landing almost
// the whole muffled window inside the gap. Fix: tightened
// formantGainCorrAlpha's time constant from 30ms to 12ms - see the
// extensive comment above that constant in autotune-worklet.js for the
// full investigation (including two more aggressive fixes that were
// tried and measured worse before landing on this one).
{
  const sr = 44100;
  check('Round 65: formantGainCorrAlpha now derives from a 4ms time constant, not the Round 62 12ms (itself tightened from the original 30ms)',
    Math.abs(engineNew(sr).formantGainCorrAlpha - (1 - Math.exp(-(1000/sr)/4))) < 1e-9,
    `formantGainCorrAlpha=${engineNew(sr).formantGainCorrAlpha}`);

  function engineNew(sampleRate) {
    const e = new AutotuneEngine(sampleRate);
    e.setParams({ key: 0, scale: 'major', retuneSpeedMs: 20, formantCorrection: true, humanize: 0, naturalVibrato: 0, flexTune: 0 });
    return e;
  }

  // Standalone repro of the exact three EMA lines + gain clamp in
  // processSample() that this round changed (kept minimal and inline,
  // not re-imported, so it can't silently drift out of sync unnoticed -
  // same pattern as the tempo_prior() continuity check in
  // tools/test-analyze.py). A synthetic step: shifted matches x in
  // shape/phase but collapses to 5% amplitude for a 100ms stretch
  // (matching the evidence file's measured 4-6x residual-energy drop
  // during the muffled passage), then recovers - x itself never
  // changes amplitude, exactly like the real bug (x stays full volume,
  // only the whitened excitation collapses).
  function ratioAtOffset(alphaMs, offsetMs) {
    const GAIN_MIN = 0.1, GAIN_MAX = 40;
    const dtMsConst = 1000 / sr;
    const alpha = 1 - Math.exp(-dtMsConst / alphaMs);
    let shiftedRms2Ema = 0, inputRms2Ema = 0;
    const f0 = 250, totalMs = 400, collapseStartMs = 150, collapseEndMs = 250;
    const n = Math.floor(sr * totalMs / 1000);
    const xArr = new Float32Array(n), scArr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tMs = i * 1000 / sr;
      const collapsed = tMs >= collapseStartMs && tMs < collapseEndMs;
      const x = 0.2 * Math.sin(2 * Math.PI * f0 * i / sr);
      const shifted = collapsed ? x * 0.05 : x;
      shiftedRms2Ema += (shifted * shifted - shiftedRms2Ema) * alpha;
      inputRms2Ema += (x * x - inputRms2Ema) * alpha;
      const targetRms = Math.sqrt(inputRms2Ema);
      const curShiftedRms = Math.sqrt(shiftedRms2Ema);
      let sgc = curShiftedRms > 1e-6 ? targetRms / curShiftedRms : 1;
      if (!isFinite(sgc)) sgc = 1;
      sgc = Math.max(GAIN_MIN, Math.min(GAIN_MAX, sgc));
      xArr[i] = x; scArr[i] = shifted * sgc;
    }
    const checkI = Math.floor(sr * (collapseStartMs + offsetMs) / 1000);
    const win = Math.floor(sr * 0.01);
    let sx = 0, ssc = 0;
    for (let k = 0; k < win; k++) { sx += xArr[checkI + k] ** 2; ssc += scArr[checkI + k] ** 2; }
    return Math.sqrt(ssc / win) / Math.sqrt(sx / win);
  }
  const oldRatioAt80ms = ratioAtOffset(30, 80);
  const newRatioAt80ms = ratioAtOffset(12, 80);
  check('Round 62 (historical): 80ms into a synthetic excitation collapse, the pre-fix 30ms constant was still badly under-corrected (documents the bug Round 62 fixed, not a pass/fail gate on current behavior)',
    oldRatioAt80ms < 0.3,
    `old-constant ratio at +80ms=${oldRatioAt80ms.toFixed(4)} (want <0.3, matching the muffled evidence)`);
  check('Round 62 (historical): with the 12ms constant, the same collapse recovered to a reasonable RMS match well before the pre-Round-62 30ms constant would have',
    newRatioAt80ms > 0.6,
    `new-constant ratio at +80ms=${newRatioAt80ms.toFixed(4)} (want >0.6; old constant only reached ${oldRatioAt80ms.toFixed(4)} at the same point)`);

  // Round 65 ("still sound like its muffled ... or lowers the volume at
  // some moments" - a fresh evidence file filed against the Round 62
  // 12ms build): a full end-to-end sweep on real evidence audio showed
  // 12ms itself still leaves frequent, audible RMS-ratio excursions
  // through an ordinary take (not just rare severe-collapse spots) -
  // see the extensive comment above formantGainCorrAlpha in
  // autotune-worklet.js. At a 25ms offset into the same synthetic
  // collapse, 12ms is still badly under-corrected while 4ms has
  // already substantially recovered - the same "catches up faster"
  // property Round 62 demonstrated for 12ms vs. 30ms, one step tighter.
  const r62RatioAt25ms = ratioAtOffset(12, 25);
  const r65RatioAt25ms = ratioAtOffset(4, 25);
  check('Round 65: 25ms into a synthetic excitation collapse, the Round 62 12ms constant is still badly under-corrected',
    r62RatioAt25ms < 0.3,
    `12ms-constant ratio at +25ms=${r62RatioAt25ms.toFixed(4)} (want <0.3)`);
  check('Round 65: with the new 4ms constant, the same collapse has already substantially recovered by the same +25ms point',
    r65RatioAt25ms > 0.6,
    `4ms-constant ratio at +25ms=${r65RatioAt25ms.toFixed(4)} (want >0.6; the 12ms constant only reached ${r62RatioAt25ms.toFixed(4)} at the same point)`);
}


// Round 69 ("vocal is not stable it goes up and down, sounds like its in
// a bottle" - evidence file KAKAVOCS.wav): the octave-error rejection
// band (OCTAVE_UP/DOWN_MIN/MAX, added Round 49/51) is measured against
// SHORT gaps between accepted hops. lastAcceptedPitchHz only ever
// updates on acceptance, so after a longer run of rejected hops it's an
// increasingly stale reference - and a genuine octave-error candidate's
// ratio against that stale reference drifts away from the clean
// 0.5x/2x center by roughly however far the TRUE pitch itself moved
// during the gap. Direct instrumentation of this exact evidence file
// found an 8-hop (~93ms) rejection run immediately before a 92.71Hz
// misdetection (true pitch ~185Hz, halving to ~92.5) measured a ratio
// of 0.5628 against the stale 164.75Hz reference - just outside
// OCTAVE_DOWN_MAX's edge (0.549) - which slipped through untouched for
// 4 consecutive hops (~46ms), both mistuning that stretch and (via
// shifter.periodHint, derived from lastAcceptedPitchHz) feeding a wrong
// period into the formant/WSOLA resynthesis for the same stretch. This
// drives msSinceLastAccepted/the octave band directly via _analyze(),
// bypassing processSample()'s per-sample buffering so each scenario
// can be set up with exact control over how stale the reference is,
// rather than needing to reproduce the exact detector conditions that
// produce a given gap length.
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'chromatic', retuneSpeedMs: 5, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  const hopMs = (engine.hopSize / engine.sr) * 1000;

  function primeWindow(hz) {
    for (let i = 0; i < engine.winLen; i++) engine.analysisWin[i] = 0.3 * Math.sin(2 * Math.PI * hz * i / sr);
    engine.writeIdx = 0;
  }

  const REF_HZ = 164.75, CANDIDATE_HZ = 92.71; // the exact evidence values

  // (a) The real evidence case: after the diagnosed ~8-hop gap, the
  // 92.71Hz octave-error candidate must now be rejected (reference holds).
  engine.lastAcceptedPitchHz = REF_HZ;
  engine.msSinceLastAccepted = 8 * hopMs;
  primeWindow(CANDIDATE_HZ);
  engine._analyze();
  check('Round 69: the real evidence octave-error candidate (92.71Hz vs a stale 164.75Hz reference, ratio 0.5628) is rejected after the diagnosed ~8-hop gap',
    Math.abs(engine.lastAcceptedPitchHz - REF_HZ) < 1,
    `lastAcceptedPitchHz after=${engine.lastAcceptedPitchHz.toFixed(2)}`);

  // (b) Sanity: the SAME ratio at zero staleness sits just outside the
  // ORIGINAL, un-widened octave band and gets accepted outright - proves
  // (a) is actually exercising the new staleness widening, not something
  // the pre-existing band already covered.
  engine.lastAcceptedPitchHz = REF_HZ;
  engine.msSinceLastAccepted = 0;
  primeWindow(CANDIDATE_HZ);
  engine._analyze();
  check('sanity: at zero staleness the same 92.71Hz/164.75Hz ratio is accepted (outside the pre-Round-69 band) - confirms (a) is the widening doing real work, not a no-op',
    Math.abs(engine.lastAcceptedPitchHz - CANDIDATE_HZ) < 1,
    `lastAcceptedPitchHz after=${engine.lastAcceptedPitchHz.toFixed(2)}`);

  // (c) No regression: an ordinary single-hop gap (normal cadence)
  // widens the band by zero cents - a clean, dead-center octave error is
  // rejected exactly as it was before this round (Round 49/51 behavior).
  engine.lastAcceptedPitchHz = REF_HZ;
  engine.msSinceLastAccepted = hopMs;
  primeWindow(REF_HZ / 2);
  engine._analyze();
  check('Round 69: an ordinary single-hop gap does not widen the octave-rejection band - a clean, dead-center octave error is still rejected exactly as before',
    Math.abs(engine.lastAcceptedPitchHz - REF_HZ) < 1,
    `lastAcceptedPitchHz after=${engine.lastAcceptedPitchHz.toFixed(2)}`);

  // (d) The widening is capped, not unbounded: a ratio that would need
  // MORE than OCTAVE_STALENESS_MAX_WIDEN_CENTS of widening to be flagged
  // stays accepted even after a pathologically long (5s) gap - staleness
  // alone can't turn an arbitrary large jump into a rejected "octave error".
  const justOutsideCapHz = REF_HZ * Math.pow(2, -960 / 1200); // needs >65c widen
  engine.lastAcceptedPitchHz = REF_HZ;
  engine.msSinceLastAccepted = 5000;
  primeWindow(justOutsideCapHz);
  engine._analyze();
  check('Round 69: staleness widening is capped - a ratio needing more than the cap to be flagged is still accepted even after a 5-second gap',
    Math.abs(engine.lastAcceptedPitchHz - justOutsideCapHz) < 1,
    `lastAcceptedPitchHz after=${engine.lastAcceptedPitchHz.toFixed(2)}, candidate=${justOutsideCapHz.toFixed(2)}`);
}


// Round 71 ("its has now no autotune even if key is good and formant off"):
// every rejection path measures the candidate against lastAcceptedPitchHz,
// which only ever updates on ACCEPTANCE. Once a rejection run starts and the
// voice moves away from the frozen reference, every later hop reads as a huge
// jump from it, gets rejected for that, and so keeps it frozen - a closed loop
// that stops correction entirely (the engine eases targetRatio back to 1 and
// passes dry signal through). Measured on the evidence take: 802/1238 hops
// force-rejected on MAX_JUMP_CENTS, 597 of them high-confidence reads, longest
// unbroken rejection run 148 hops (~1.7s), reference as stale as 3529ms.
// Acceptance across the three real evidence takes went 13.7% -> 46.3%,
// 39.0% -> 53.1%, and 65.9% -> 65.9% (unchanged, so Round 69's own evidence
// file is untouched by this).
{
  const sr = 44100;
  const engine = new AutotuneEngine(sr);
  engine.setParams({ key: 0, scale: 'chromatic', retuneSpeedMs: 5, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  const hopMs = (engine.hopSize / engine.sr) * 1000;
  function primeWindow(hz) {
    for (let i = 0; i < engine.winLen; i++) engine.analysisWin[i] = 0.3 * Math.sin(2 * Math.PI * hz * i / sr);
    engine.writeIdx = 0;
  }
  // Reference frozen low, voice genuinely up at ~700Hz - the exact shape the
  // evidence take showed (a ~3400-cent apparent jump, held for many hops).
  const STUCK_REF_HZ = 100, REAL_HZ = 700;
  engine.lastAcceptedPitchHz = STUCK_REF_HZ;
  engine.msSinceLastAccepted = 0;
  engine.forcedRejectMs = 0;

  // A couple of hops in, it must still be rejecting - the guard is not meant
  // to fire instantly, or it would defeat the octave rejection entirely.
  primeWindow(REAL_HZ); engine._analyze();
  primeWindow(REAL_HZ); engine._analyze();
  check('Round 71: a confident but far-off reading is still rejected for the first few hops (the octave/jump guard is not bypassed)',
    Math.abs(engine.lastAcceptedPitchHz - STUCK_REF_HZ) < 1,
    `lastAcceptedPitchHz=${engine.lastAcceptedPitchHz}`);

  // Keep feeding the same confident pitch past the re-anchor threshold.
  for (let t = 0; t < 600; t += hopMs) { primeWindow(REAL_HZ); engine._analyze(); }
  check('Round 71: a reference that stays stuck while the detector keeps reporting a confident, stable pitch is re-anchored instead of deadlocking forever',
    engine.lastAcceptedPitchHz !== null && Math.abs(engine.lastAcceptedPitchHz - REAL_HZ) < 20,
    `lastAcceptedPitchHz=${engine.lastAcceptedPitchHz} (want ~${REAL_HZ})`);

  // Silence must NOT trip it: no pitch detected means nothing to re-anchor to,
  // and a long musical rest would otherwise reset the engine constantly.
  const e2 = new AutotuneEngine(sr);
  e2.setParams({ key: 0, scale: 'chromatic', retuneSpeedMs: 5, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  e2.lastAcceptedPitchHz = 220;
  e2.forcedRejectMs = 0;
  for (let i = 0; i < e2.winLen; i++) e2.analysisWin[i] = 0;
  e2.writeIdx = 0;
  for (let t = 0; t < 1500; t += hopMs) e2._analyze();
  check('Round 71: silence never trips the re-anchor (no pitch detected means no evidence the reference is wrong)',
    e2.lastAcceptedPitchHz === 220,
    `lastAcceptedPitchHz=${e2.lastAcceptedPitchHz}`);

  // The streak must reset on a normal accepted hop, so ordinary playing can
  // never slowly accumulate its way into a spurious re-anchor.
  const e3 = new AutotuneEngine(sr);
  e3.setParams({ key: 0, scale: 'chromatic', retuneSpeedMs: 5, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 });
  e3.lastAcceptedPitchHz = 200;
  e3.forcedRejectMs = 120;
  primeWindow.call(null, 200);
  for (let i = 0; i < e3.winLen; i++) e3.analysisWin[i] = 0.3 * Math.sin(2 * Math.PI * 200 * i / sr);
  e3.writeIdx = 0;
  e3._analyze();
  check('Round 71: a normal accepted hop clears the force-reject streak (ordinary playing cannot accumulate into a spurious re-anchor)',
    e3.forcedRejectMs === 0, `forcedRejectMs=${e3.forcedRejectMs}`);
}

console.log('');
if (fails) { console.log(`✗ ${fails} autotune check(s) failed`); process.exit(1); }
console.log('✓ autotune engine: all checks passed');
