// Numeric regression test for the Random Beats channel-safety worklet
// (renderer/rb-channel-safety-worklet.js). Runs headless in Node - no
// AudioWorkletGlobalScope, no microphone - by loading just the
// "CHANNEL-SAFETY CORE" section of the worklet file into a sandbox and
// feeding it synthetic per-quantum blocks, the same technique as every
// other worklet test in this repo.
//
// What this proves: given a multi-channel input where only ONE channel
// actually has live signal (a stereo mic request that resolves to one
// real channel and a silently-unconnected other one, or a multi-channel
// interface that doesn't put the mic on channel 0), the output is the
// REAL signal duplicated across every output channel - never silence in
// any channel, and never the wrong (silent) channel picked. Real,
// reported symptom this fixes: "mono (L only)" - a recording/monitor
// signal with genuine audio in one channel and dead silence in the
// other, previously only prevented when Autotune happened to be
// engaged (its own worklet had this same logic baked in already), now
// applied unconditionally regardless of Autotune on/off. It does NOT
// test the real AudioWorkletProcessor wiring (registerProcessor, the
// live audio graph) - that needs a browser, which this repo cannot
// automate.
//   node tools/test-rb-channel-safety.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'rb-channel-safety-worklet.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const startMarker = '// ─── BEGIN CHANNEL-SAFETY CORE';
const endMarker = '// ─── END CHANNEL-SAFETY CORE';
const si = src.indexOf(startMarker);
const ei = src.indexOf(endMarker);
if (si < 0 || ei < 0 || ei <= si) {
  console.error('✗ could not locate CHANNEL-SAFETY CORE markers in ' + SRC_PATH);
  process.exit(1);
}
const core = src.slice(si, ei);

const sandbox = { Math, Float32Array };
vm.createContext(sandbox);
try {
  vm.runInContext(core + '\nthis.__exports = { RBChannelSafetyCore };', sandbox);
} catch (e) {
  console.error('✗ CHANNEL-SAFETY CORE failed to evaluate:', e.message);
  process.exit(1);
}
const { RBChannelSafetyCore } = sandbox.__exports;

let fails = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); }
  else { fails++; console.log('  FAIL ' + name + (detail ? ' - ' + detail : '')); }
}

function tone(n, amp, offset) {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin(2 * Math.PI * (i + offset) / 37);
  return buf;
}
function silence(n) { return new Float32Array(n); }
function makeOutputs(numCh, n) { return Array.from({ length: numCh }, () => new Float32Array(n)); }

// ── Test 1: mono input passes straight through unchanged ──────────────
{
  const core2 = new RBChannelSafetyCore();
  const n = 128;
  const real = tone(n, 0.3, 0);
  const outs = makeOutputs(1, n);
  core2.process([real], outs);
  let identical = true;
  for (let i = 0; i < n; i++) if (outs[0][i] !== real[i]) identical = false;
  check('mono input: passes through unchanged', identical);
}

// ── Test 2: stereo, real signal on channel 0, silent channel 1 -
// output must carry the REAL signal on every output channel, not
// silence on any of them. This is the exact "mono L only" bug shape. ──
{
  const core2 = new RBChannelSafetyCore();
  const n = 128;
  const real = tone(n, 0.3, 0);
  const dead = silence(n);
  const outs = makeOutputs(2, n);
  core2.process([real, dead], outs);
  let ch0Ok = true, ch1Ok = true;
  for (let i = 0; i < n; i++) {
    if (outs[0][i] !== real[i]) ch0Ok = false;
    if (outs[1][i] !== real[i]) ch1Ok = false;
  }
  check('stereo, channel 0 live / channel 1 silent: output channel 0 carries the real signal', ch0Ok);
  check('stereo, channel 0 live / channel 1 silent: output channel 1 ALSO carries the real signal (not left silent)', ch1Ok);
}

// ── Test 3: the mirror case - real signal is on channel 1, channel 0
// is the silent/unconnected one. After enough silent blocks on the
// currently-active channel, it must switch to the one that's actually
// live, not get stuck outputting silence forever. ──
{
  const core2 = new RBChannelSafetyCore();
  const n = 128;
  const dead = silence(n);
  let sawRealOnOutput = false;
  for (let block = 0; block < 25; block++) {
    const outs = makeOutputs(2, n);
    core2.process([dead, tone(n, 0.3, block * n)], outs);
    let hasReal = false;
    for (let i = 0; i < n; i++) if (outs[0][i] !== 0) { hasReal = true; break; }
    if (hasReal) sawRealOnOutput = true;
  }
  check('stereo, channel 0 silent / channel 1 live: eventually switches to the live channel instead of staying silent forever', sawRealOnOutput);
}

// ── Test 4: a normal brief pause/breath on the active channel (a few
// blocks of silence, not the full debounce window) must NOT trigger a
// channel flip - a real vocal take has pauses between lines constantly. ──
{
  const core2 = new RBChannelSafetyCore();
  const n = 128;
  // Establish channel 0 as active with real signal.
  for (let block = 0; block < 5; block++) {
    const outs = makeOutputs(2, n);
    core2.process([tone(n, 0.3, block * n), silence(n)], outs);
  }
  check('active channel picked correctly before any pause', core2.activeChannel === 0);
  // A short pause (well under the 15-block debounce) on channel 0,
  // with channel 1 now having signal instead (simulating crosstalk/
  // bleed, not a real source switch).
  for (let block = 0; block < 5; block++) {
    const outs = makeOutputs(2, n);
    core2.process([silence(n), tone(n, 0.3, block * n)], outs);
  }
  check('a brief pause (under the debounce window) does not flip the active channel', core2.activeChannel === 0);
}

console.log('');
if (fails) { console.log(`✗ ${fails} check(s) failed`); process.exit(1); }
console.log('✓ all rb-channel-safety checks passed');
