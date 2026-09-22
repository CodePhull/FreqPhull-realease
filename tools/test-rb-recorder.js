// Numeric regression test for the Random Beats lossless capture worklet
// (renderer/rb-recorder-worklet.js). Runs headless in Node - no
// AudioWorkletGlobalScope, no microphone - by loading just the "CAPTURE
// CORE" section of the worklet file (delimited by BEGIN/END markers,
// same technique as tools/test-autotune.js) into a sandbox and feeding
// it synthetic per-quantum blocks the way the real audio thread would.
//
// What this proves: samples posted across many small process() calls
// reassemble, in order, with none dropped or duplicated, for both mono
// and stereo input, and that a trailing partial block is not lost when
// the take is stopped mid-buffer. It does NOT test the real
// AudioWorkletProcessor wiring (registerProcessor, the live audio
// graph) - that needs a browser, which this repo cannot automate.
//   node tools/test-rb-recorder.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'rb-recorder-worklet.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const startMarker = '// ─── BEGIN CAPTURE CORE';
const endMarker = '// ─── END CAPTURE CORE';
const si = src.indexOf(startMarker);
const ei = src.indexOf(endMarker);
if (si < 0 || ei < 0 || ei <= si) {
  console.error('✗ could not locate CAPTURE CORE markers in ' + SRC_PATH);
  process.exit(1);
}
const core = src.slice(si, ei);

const sandbox = { Float32Array };
vm.createContext(sandbox);
try {
  vm.runInContext(core + '\nthis.__exports = { RBRecorderCore };', sandbox);
} catch (e) {
  console.error('✗ CAPTURE CORE failed to evaluate:', e.message);
  process.exit(1);
}
const { RBRecorderCore } = sandbox.__exports;

let fails = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); }
  else { fails++; console.log('  FAIL ' + name + (detail ? ' - ' + detail : '')); }
}

function makePort() {
  const messages = [];
  return { port: { postMessage: (msg) => messages.push(msg) }, messages };
}

function feedInQuanta(core2, samples, numChannels, quantum) {
  // Mirrors how a real AudioWorkletProcessor is driven: process() is
  // called once per ~128-sample render quantum, not once for the whole
  // take, so any bug that only shows up across many small calls (off-
  // by-one buffering, wrong channel indexing) gets exercised here too.
  for (let i = 0; i < samples[0].length; i += quantum) {
    const input = [];
    for (let ch = 0; ch < numChannels; ch++) {
      input.push(samples[ch].subarray(i, Math.min(i + quantum, samples[ch].length)));
    }
    core2.process([input]);
  }
}

function concatChunks(messages, ch) {
  const chunkMsgs = messages.filter((m) => m.type === 'chunk');
  let total = 0;
  for (const m of chunkMsgs) total += m.channels[ch].length;
  const out = new Float32Array(total);
  let o = 0;
  for (const m of chunkMsgs) { out.set(m.channels[ch], o); o += m.channels[ch].length; }
  return out;
}

// ── Test 1: mono, multiple full flush cycles ──────────────────────────
{
  const { port, messages } = makePort();
  const c = new RBRecorderCore(port);
  const N = 4096 * 3 + 4096; // 4 full cycles, flushEvery=4096
  const samples = new Float32Array(N);
  for (let i = 0; i < N; i++) samples[i] = Math.sin(i * 0.01);
  feedInQuanta(c, [samples], 1, 128);
  const reassembled = concatChunks(messages, 0);
  check('mono: at least one chunk posted', messages.some((m) => m.type === 'chunk'));
  check('mono: sample count matches', reassembled.length === N, `got ${reassembled.length} want ${N}`);
  let identical = reassembled.length === N;
  if (identical) for (let i = 0; i < N; i++) if (reassembled[i] !== samples[i]) { identical = false; break; }
  check('mono: samples reassemble bit-identical and in order', identical);
}

// ── Test 2: stereo, channels stay independent (not swapped/interleaved) ──
{
  const { port, messages } = makePort();
  const c = new RBRecorderCore(port);
  const N = 4096 * 2 + 1000;
  const left = new Float32Array(N), right = new Float32Array(N);
  for (let i = 0; i < N; i++) { left[i] = Math.sin(i * 0.02); right[i] = Math.cos(i * 0.02); }
  feedInQuanta(c, [left, right], 2, 128);
  c.flush(); // drain the trailing partial block (no explicit "stop" in this test)
  const reL = concatChunks(messages, 0);
  const reR = concatChunks(messages, 1);
  let leftOk = reL.length === N, rightOk = reR.length === N;
  if (leftOk) for (let i = 0; i < N; i++) if (reL[i] !== left[i]) { leftOk = false; break; }
  if (rightOk) for (let i = 0; i < N; i++) if (reR[i] !== right[i]) { rightOk = false; break; }
  check('stereo: left channel intact', leftOk);
  check('stereo: right channel intact', rightOk);
  check('stereo: channels are not swapped', reL[10] !== reR[10] || left[10] === right[10]);
}

// ── Test 3: partial trailing block is not lost on stop ────────────────
{
  const { port, messages } = makePort();
  const c = new RBRecorderCore(port);
  const N = 4096 * 2 + 500; // deliberately not a multiple of flushEvery
  const samples = new Float32Array(N);
  for (let i = 0; i < N; i++) samples[i] = (i % 7) / 7 - 0.5;
  feedInQuanta(c, [samples], 1, 128);
  const beforeStop = concatChunks(messages, 0).length;
  c.onMessage({ type: 'stop' });
  const afterStop = concatChunks(messages, 0).length;
  const flushedMsg = messages.find((m) => m.type === 'flushed');
  check('trailing block: stop flushes the remainder', afterStop === N, `before=${beforeStop} after=${afterStop} want=${N}`);
  check('trailing block: a "flushed" ack is posted', !!flushedMsg);
}

// ── Test 4: silence-only process() calls neither crash nor buffer ─────
{
  const { port, messages } = makePort();
  const c = new RBRecorderCore(port);
  c.process([[new Float32Array(0)]]);
  c.process([]);
  c.process([[]]);
  c.onMessage({ type: 'stop' });
  const chunkMsgs = messages.filter((m) => m.type === 'chunk');
  check('empty input: no chunk posted for zero buffered frames', chunkMsgs.length === 0);
  check('empty input: "flushed" still posted on stop', messages.some((m) => m.type === 'flushed'));
}

// ── Test 5: stop with nothing buffered never fabricates a chunk ───────
{
  const { port, messages } = makePort();
  const c = new RBRecorderCore(port);
  c.onMessage({ type: 'stop' });
  check('idle stop: no phantom chunk', !messages.some((m) => m.type === 'chunk'));
  check('idle stop: flushed ack still arrives', messages.some((m) => m.type === 'flushed'));
}

console.log('');
if (fails) {
  console.log(`✗ ${fails} check(s) failed`);
  process.exit(1);
} else {
  console.log('✓ all rb-recorder capture-core checks passed');
}
