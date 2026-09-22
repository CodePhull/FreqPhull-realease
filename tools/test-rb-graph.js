// Numeric regression test for Random Beats' Graph Mode offline DSP
// (renderer/app.js, the "RB GRAPH DSP CORE" section). Runs headless in
// Node - no AudioContext, no canvas, no pointer events - by loading just
// that marker-delimited section into a sandbox, the same technique
// tools/test-autotune.js and tools/test-rb-recorder.js already use for
// their own files.
//
// What this proves: the duplicated pitch detector/LPC/shifter primitives
// behave the same way their autotune-worklet.js originals do (this copy
// exists because that file only runs in AudioWorkletGlobalScope and
// can't be reused from the main thread - see the comment on RB GRAPH DSP
// CORE in app.js), and that the whiten/shift/resynthesize pipeline
// rbGraphApplyEdits() runs inline actually moves a tone's pitch toward
// an edited target. It does NOT exercise the canvas drawing, pointer
// dragging, or the async chunking/status-text UI around the real
// function - those need a browser, which this repo cannot automate.
//   node tools/test-rb-graph.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'app.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const startMarker = '// ─── BEGIN RB GRAPH DSP CORE';
const endMarker = '// ─── END RB GRAPH DSP CORE';
const si = src.indexOf(startMarker);
const ei = src.indexOf(endMarker);
if (si < 0 || ei < 0 || ei <= si) {
  console.error('✗ could not locate RB GRAPH DSP CORE markers in ' + SRC_PATH);
  process.exit(1);
}
const core = src.slice(si, ei);

const sandbox = {};
vm.createContext(sandbox);
try {
  vm.runInContext(core + '\nthis.__exports = { rbGraphMidiToHz, rbGraphHzToMidi, rbGraphAutocorrelate, rbGraphLevinsonDurbin, rbGraphComputeLPC, rbGraphDetectPitch, RBGraphPitchShifter, RB_GRAPH_LPC_ORDER };', sandbox);
} catch (e) {
  console.error('✗ RB GRAPH DSP CORE failed to evaluate:', e.message);
  process.exit(1);
}
const { rbGraphMidiToHz, rbGraphHzToMidi, rbGraphComputeLPC, rbGraphDetectPitch, RBGraphPitchShifter, RB_GRAPH_LPC_ORDER } = sandbox.__exports;

let fails = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); fails++; }
}

// ── 1. midi/hz round-trip.
{
  const hz = rbGraphMidiToHz(69); // A4
  check('midi 69 is A4 (440 Hz)', Math.abs(hz - 440) < 0.01, `got ${hz}`);
  const midi = rbGraphHzToMidi(220); // A3
  check('220 Hz is midi 57 (A3)', Math.abs(midi - 57) < 0.01, `got ${midi}`);
}

// ── 2. Pitch detector: clean tone, and silence.
{
  const sr = 44100, n = 2048, hz = 196; // G3
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.sin(2 * Math.PI * hz * i / sr);
  const d = rbGraphDetectPitch(buf, sr);
  check('detects a clean 196 Hz tone', d && Math.abs(d.hz - hz) < 1, d ? `${d.hz.toFixed(2)} Hz` : 'null');
  const silent = new Float32Array(n);
  check('reports no pitch on silence', rbGraphDetectPitch(silent, sr) === null);
}

// ── 3. LPC whiten/resynthesize round-trip with unchanged coefficients
// (no shift) should reconstruct the original signal closely - this is
// the same sanity check tools/test-autotune.js runs on the worklet's
// copy of this math, run here against the duplicated copy.
{
  const sr = 44100, n = 4096;
  // A simple resonant "vowel-ish" buffer: impulse train through one
  // damped resonator - enough to give LPC something real to model.
  const buf = new Float32Array(n);
  const f0 = 140, formant = 800, bw = 100;
  const period = sr / f0;
  const r = Math.exp(-Math.PI * bw / sr);
  const theta = 2 * Math.PI * formant / sr;
  const a1 = 2 * r * Math.cos(theta), a2 = -r * r;
  let y1 = 0, y2 = 0, nextImpulse = 0;
  for (let i = 0; i < n; i++) {
    const excite = i >= nextImpulse ? (nextImpulse += period, 1) : 0;
    const y = excite + a1 * y1 + a2 * y2;
    y2 = y1; y1 = y;
    buf[i] = y;
  }
  const coeffs = rbGraphComputeLPC(buf, RB_GRAPH_LPC_ORDER);
  check('rbGraphComputeLPC returns coefficients for a voiced block', !!coeffs);
  if (coeffs) {
    const order = RB_GRAPH_LPC_ORDER;
    const historyIn = new Float64Array(order), historyOut = new Float64Array(order);
    let sumSq = 0, sumOrigSq = 0;
    for (let i = order * 4; i < n; i++) {
      let predIn = 0;
      for (let k = 1; k <= order; k++) predIn += coeffs[k] * historyIn[k - 1];
      const residual = buf[i] - predIn;
      for (let k = order - 1; k > 0; k--) historyIn[k] = historyIn[k - 1];
      historyIn[0] = buf[i];
      let predOut = 0;
      for (let k = 1; k <= order; k++) predOut += coeffs[k] * historyOut[k - 1];
      const y = residual + predOut;
      for (let k = order - 1; k > 0; k--) historyOut[k] = historyOut[k - 1];
      historyOut[0] = y;
      const err = y - buf[i];
      sumSq += err * err; sumOrigSq += buf[i] * buf[i];
    }
    const relErr = Math.sqrt(sumSq / Math.max(1e-9, sumOrigSq));
    check('whiten-then-resynthesize with unchanged coefficients reconstructs the original', relErr < 0.01, `relative RMS error ${(relErr * 100).toFixed(3)}%`);
  }
}

// ── 4. RBGraphPitchShifter moves measured pitch by the requested ratio -
// the same proof tools/test-autotune.js runs for the real-time engine's
// PitchShifter, against this duplicated copy.
{
  const sr = 44100;
  const shifter = new RBGraphPitchShifter(sr, 1.0, 25);
  const hz = 196, ratio = 1.25;
  const warmup = sr * 0.3, measure = 4096;
  const out = new Float32Array(measure);
  let t = 0;
  for (let i = 0; i < warmup; i++) { shifter.writeSample(Math.sin(2 * Math.PI * hz * t / sr)); shifter.readSample(ratio); t++; }
  for (let i = 0; i < measure; i++) { shifter.writeSample(Math.sin(2 * Math.PI * hz * t / sr)); out[i] = shifter.readSample(ratio); t++; }
  const d = rbGraphDetectPitch(out, sr);
  const want = hz * ratio;
  check('RBGraphPitchShifter moves measured pitch by the requested ratio', d && Math.abs(d.hz - want) < want * 0.05, d ? `got ${d.hz.toFixed(1)} Hz, want ~${want.toFixed(1)} Hz` : 'no pitch detected');
}

// ── 5. End-to-end: the exact whiten/shift/resynthesize sequence
// rbGraphApplyEdits() runs inline, fed a steady vowel-like tone (impulse
// train through a resonator - NOT a bare sine: a pure sine is nearly
// perfectly linearly predictable, which leaves almost no LPC residual
// for the shifter to act on and is an unrealistic stand-in for a human
// voice's actual excitation) and an edited target one semitone up,
// should produce audio whose measured pitch sits close to the target -
// not the original, and not some unrelated frequency.
{
  const sr = 44100, n = 8192;
  const startHz = 220; // A3
  const targetMidi = rbGraphHzToMidi(startHz) + 1; // one semitone up
  const targetHz = rbGraphMidiToHz(targetMidi);
  const buf = new Float32Array(n);
  {
    const formant = 900, bw = 90;
    const period = sr / startHz;
    const r = Math.exp(-Math.PI * bw / sr);
    const theta = 2 * Math.PI * formant / sr;
    const a1 = 2 * r * Math.cos(theta), a2 = -r * r;
    let y1 = 0, y2 = 0, nextImpulse = 0;
    for (let i = 0; i < n; i++) {
      const excite = i >= nextImpulse ? (nextImpulse += period, 1) : 0;
      const y = excite + a1 * y1 + a2 * y2;
      y2 = y1; y1 = y;
      buf[i] = y;
    }
  }
  const order = RB_GRAPH_LPC_ORDER;
  const coeffs = rbGraphComputeLPC(buf, order) || new Float64Array(order + 1);
  const shifter = new RBGraphPitchShifter(sr, 1.0, 25);
  const historyIn = new Float64Array(order), historyOut = new Float64Array(order);
  const ratio = targetHz / startHz;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = buf[i];
    let predIn = 0;
    for (let k = 1; k <= order; k++) predIn += coeffs[k] * historyIn[k - 1];
    const residual = x - predIn;
    for (let k = order - 1; k > 0; k--) historyIn[k] = historyIn[k - 1];
    historyIn[0] = x;
    shifter.writeSample(residual);
    const shiftedResidual = shifter.readSample(ratio);
    let predOut = 0;
    for (let k = 1; k <= order; k++) predOut += coeffs[k] * historyOut[k - 1];
    const y = shiftedResidual + predOut;
    for (let k = order - 1; k > 0; k--) historyOut[k] = historyOut[k - 1];
    historyOut[0] = y;
    out[i] = y;
  }
  const d = rbGraphDetectPitch(out.slice(n - 4096), sr);
  check('end-to-end graph-edit pipeline moves a tone to the edited target pitch', d && Math.abs(d.hz - targetHz) < targetHz * 0.03, d ? `got ${d.hz.toFixed(2)} Hz, want ~${targetHz.toFixed(2)} Hz (started at ${startHz} Hz)` : 'no pitch detected');
}

console.log('');
if (fails) { console.log(`✗ ${fails} graph-mode DSP check(s) failed`); process.exit(1); }
console.log('✓ Random Beats Graph Mode DSP: all checks passed');
