// Numeric regression test for the AutotuneProcessor AudioWorkletProcessor
// wrapper itself (renderer/autotune-worklet.js) - NOT the AutotuneEngine
// DSP core, which tools/test-autotune.js already covers on its own.
//
// This exists because of two real, user-reported regressions, both
// about which input channel(s) the processor actually reads:
//
// 1) On a multi-channel professional interface (reported against a UA
//    Apollo Twin), the mic sounded fine through the app's raw/dry path,
//    but autotune correction appeared to simply do nothing. Root cause:
//    the processor originally only ever read input channel 0. Which
//    physical input jack a multi-channel interface maps to channel 0
//    vs. 1 is outside this app's control - a mic wired to channel 1
//    left channel 0 silent, and pitch detection (correctly) found
//    nothing to correct there.
// 2) The first fix for #1 averaged every available channel together.
//    That solved the silent-channel case, but a later report of
//    screeching while monitoring on HEADPHONES (ruling out acoustic
//    mic-hears-speaker feedback) pointed at the input itself: if two
//    captured channels aren't perfectly phase-identical, summing them
//    is a comb filter, which can degrade the pitch detector enough to
//    read as screeching. The current approach instead picks ONE channel
//    (sticky - only re-evaluated after a sustained silence on the
//    active channel) rather than blending, which fixes #1 without
//    reintroducing #2.
//
// Runs headless in Node - no AudioContext, no real worklet runtime -
// by stubbing the two AudioWorkletGlobalScope pieces the file actually
// needs (AudioWorkletProcessor base class, registerProcessor, sampleRate)
// and loading the real file directly. Run with:
//   node tools/test-autotune-processor.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'autotune-worklet.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

class StubAudioWorkletProcessor {
  constructor() { this.port = { onmessage: null, postMessage: () => {} }; }
}
const registered = {};
function stubRegisterProcessor(name, cls) { registered[name] = cls; }

const sandbox = { AudioWorkletProcessor: StubAudioWorkletProcessor, registerProcessor: stubRegisterProcessor, sampleRate: 44100, console };
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox);
} catch (e) {
  console.error('✗ autotune-worklet.js failed to evaluate in the stubbed worklet sandbox:', e.message);
  process.exit(1);
}
const AutotuneProcessor = registered['autotune-processor'];
if (!AutotuneProcessor) {
  console.error('✗ autotune-processor was not registered via registerProcessor()');
  process.exit(1);
}

let fails = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); fails++; }
}

function runBlocks(proc, sr, blockSize, totalSamples, channelGens) {
  let sampleIdx = 0;
  let lastOut = new Float32Array(blockSize);
  for (let block = 0; block < Math.floor(totalSamples / blockSize); block++) {
    const inChans = channelGens.map(() => new Float32Array(blockSize));
    for (let i = 0; i < blockSize; i++) {
      channelGens.forEach((gen, c) => { inChans[c][i] = gen(sampleIdx); });
      sampleIdx++;
    }
    const outChans = channelGens.map(() => new Float32Array(blockSize));
    proc.process([inChans], [outChans]);
    lastOut = outChans[0];
  }
  return lastOut;
}

// ── 1. The exact regression scenario: channel 0 silent, channel 1 has a
// real, detuned tone. Correction must still engage - proves the
// processor doesn't blindly trust channel 0 to be where the mic is.
{
  const proc = new AutotuneProcessor();
  proc.port.onmessage({ data: { type: 'params', params: { key: 0, scale: 'major', retuneSpeedMs: 15, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 } } });
  const sr = 44100, hz = 226; // clearly closer to A3 (220) than to the A3/B3 scale-tone midpoint (~233.08 Hz) - this test is about channel routing, not the boundary tie-breaking behavior covered separately in tools/test-autotune.js
  const expectedRatio = 220 / 226;
  const lastOut = runBlocks(proc, sr, 128, sr * 1.5, [
    () => 0,
    (i) => 0.4 * Math.sin(2 * Math.PI * hz * i / sr),
  ]);
  let maxAbs = 0;
  for (let i = 0; i < lastOut.length; i++) maxAbs = Math.max(maxAbs, Math.abs(lastOut[i]));
  check('mic signal on channel 1 (not channel 0) still gets pitch-detected and corrected',
    Math.abs(proc.engine.currentRatio - expectedRatio) < 0.01,
    `currentRatio ${proc.engine.currentRatio.toFixed(5)}, expected ~${expectedRatio.toFixed(5)}`);
  check('output is real signal, not silence, in the channel-1-only scenario',
    maxAbs > 0.05, `max abs sample ${maxAbs.toFixed(4)}`);
}

// ── 2. Sanity check the reverse: channel 0 has the tone, channel 1 is
// silent (today's actual common case) - must still work exactly as before.
{
  const proc = new AutotuneProcessor();
  proc.port.onmessage({ data: { type: 'params', params: { key: 0, scale: 'major', retuneSpeedMs: 15, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 } } });
  const sr = 44100, hz = 226; // see note above - kept off the A3/B3 midpoint deliberately
  const expectedRatio = 220 / 226;
  runBlocks(proc, sr, 128, sr * 1.5, [
    (i) => 0.4 * Math.sin(2 * Math.PI * hz * i / sr),
    () => 0,
  ]);
  check('mic signal on channel 0 (the common case) still gets corrected the same way',
    Math.abs(proc.engine.currentRatio - expectedRatio) < 0.01,
    `currentRatio ${proc.engine.currentRatio.toFixed(5)}, expected ~${expectedRatio.toFixed(5)}`);
}

// ── 3. Identical signal duplicated on both channels (the typical
// single-mic-into-a-stereo-declared-input case) must sound the same as
// a single mono channel - averaging two identical values changes nothing.
{
  const procMono = new AutotuneProcessor();
  procMono.port.onmessage({ data: { type: 'params', params: { key: 0, scale: 'major', retuneSpeedMs: 15, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 } } });
  const procStereo = new AutotuneProcessor();
  procStereo.port.onmessage({ data: { type: 'params', params: { key: 0, scale: 'major', retuneSpeedMs: 15, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 } } });
  const sr = 44100, hz = 233;
  const gen = (i) => 0.4 * Math.sin(2 * Math.PI * hz * i / sr);
  const outMono = runBlocks(procMono, sr, 128, sr * 1.5, [gen]);
  const outStereo = runBlocks(procStereo, sr, 128, sr * 1.5, [gen, gen]);
  let maxDiff = 0;
  for (let i = 0; i < outMono.length; i++) maxDiff = Math.max(maxDiff, Math.abs(outMono[i] - outStereo[i]));
  check('a single mono channel and two identical duplicated channels produce the same output',
    maxDiff < 1e-9, `max sample difference ${maxDiff.toExponential(3)}`);
}

// ── 4. The regression #2 scenario: two channels carrying the SAME tone
// but phase-shifted relative to each other (channel 1 delayed by a few
// samples) - simulating imperfect "duplicate mono to satisfy a stereo
// request" up-mixing. If these were still being averaged, this would
// partially cancel at the shifted frequency (a comb filter) and the
// output amplitude would measurably drop below a single clean channel's.
// Selecting one channel outright must be unaffected by the other
// channel's content entirely.
{
  const sr = 44100, hz = 300, delaySamples = 7;
  const gen = (i) => 0.4 * Math.sin(2 * Math.PI * hz * i / sr);
  const genDelayed = (i) => (i < delaySamples ? 0 : gen(i - delaySamples));

  const procClean = new AutotuneProcessor();
  procClean.port.onmessage({ data: { type: 'params', params: { key: 0, scale: 'chromatic', retuneSpeedMs: 15, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0, bypass: true } } });
  const procPhaseShifted = new AutotuneProcessor();
  procPhaseShifted.port.onmessage({ data: { type: 'params', params: { key: 0, scale: 'chromatic', retuneSpeedMs: 15, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0, bypass: true } } });

  const outClean = runBlocks(procClean, sr, 128, sr * 0.5, [gen, gen]);
  const outShifted = runBlocks(procPhaseShifted, sr, 128, sr * 0.5, [gen, genDelayed]);

  const rms = (buf) => Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
  const rmsClean = rms(outClean), rmsShifted = rms(outShifted);
  check('a phase-shifted second channel does not attenuate the output (no comb filtering from averaging)',
    rmsShifted > rmsClean * 0.95,
    `rms clean ${rmsClean.toFixed(4)} vs rms with phase-shifted 2nd channel ${rmsShifted.toFixed(4)}`);
}

// ── 5. A brief mid-take silence (a breath, a pause between lines) on
// the active channel must NOT trigger a channel switch - only a
// sustained silence should. Active channel starts on 0 (has signal),
// goes briefly silent for less than the debounce window, then resumes -
// channel 1 stays silent throughout, so a wrongful switch would leave
// the output silent too.
{
  const proc = new AutotuneProcessor();
  proc.port.onmessage({ data: { type: 'params', params: { key: 0, scale: 'chromatic', retuneSpeedMs: 15, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0, bypass: true } } });
  const sr = 44100, hz = 300;
  const pauseStart = 0.3, pauseEnd = 0.32; // 20ms pause - short vs. the ~50ms debounce
  const gen = (i) => {
    const t = i / sr;
    if (t >= pauseStart && t < pauseEnd) return 0;
    return 0.4 * Math.sin(2 * Math.PI * hz * i / sr);
  };
  const lastOut = runBlocks(proc, sr, 128, sr * 0.6, [gen, () => 0]);
  let maxAbs = 0;
  for (let i = 0; i < lastOut.length; i++) maxAbs = Math.max(maxAbs, Math.abs(lastOut[i]));
  check('a brief pause on the active channel does not trigger a channel switch',
    maxAbs > 0.1, `max abs sample after the pause ${maxAbs.toFixed(4)} (would be ~0 if it wrongly switched to the silent channel)`);
}

// ── 6. Fault fallback: if the engine ever throws or hands back a
// non-finite sample - anything not caught by the engine's own numeric
// safety nets - the processor must not go silently and permanently
// silent for the rest of the take. It should fall back to the dry
// input for whatever's left of the affected block(s), keep working on
// the next block, and tell the main thread via a 'fault' port message
// (which app.js surfaces through the activity log and a one-time
// notice) instead of swallowing it. This directly guards against a
// real, reported failure mode: "less screeching, but now no voice
// comes through" is exactly what a processor stuck in a bad state (or
// silently disabled by an uncaught exception) would sound like.
{
  const sr = 44100, hz = 240;
  const proc = new AutotuneProcessor();
  proc.port.onmessage({ data: { type: 'params', params: { key: 0, scale: 'major', retuneSpeedMs: 15, formantCorrection: false, humanize: 0, naturalVibrato: 0, flexTune: 0 } } });
  const messages = [];
  proc.port.postMessage = (m) => messages.push(m);
  let callCount = 0;
  const realProcessSample = proc.engine.processSample.bind(proc.engine);
  proc.engine.processSample = function (x) {
    callCount++;
    if (callCount >= 300 && callCount < 300 + 128) throw new Error('synthetic fault for testing');
    return realProcessSample(x);
  };
  let sampleIdx = 0;
  let lastBlockMaxAbs = 0;
  for (let b = 0; b < 8; b++) {
    const inChans = [new Float32Array(128)];
    for (let i = 0; i < 128; i++) { inChans[0][i] = 0.4 * Math.sin(2 * Math.PI * hz * sampleIdx / sr); sampleIdx++; }
    const outChans = [new Float32Array(128)];
    proc.process([inChans], [outChans]);
    if (b === 7) { for (let i = 0; i < 128; i++) lastBlockMaxAbs = Math.max(lastBlockMaxAbs, Math.abs(outChans[0][i])); }
  }
  check('a synthetic fault inside processSample does not permanently silence later blocks',
    lastBlockMaxAbs > 0.05, `max abs sample in a block well after the fault: ${lastBlockMaxAbs.toFixed(4)}`);
  check('a fault is reported to the main thread via a port message',
    messages.some((m) => m.type === 'fault'), `messages seen: ${JSON.stringify(messages)}`);
}

console.log('');
if (fails) { console.log(`✗ ${fails} autotune-processor check(s) failed`); process.exit(1); }
console.log('✓ autotune processor: all checks passed');
