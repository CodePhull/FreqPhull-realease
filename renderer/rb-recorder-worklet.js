// ── Random Beats lossless capture processor ─────────────────────────────
// Plain pass-through AudioWorkletProcessor that buffers raw Float32 audio
// and forwards it to the main thread in small blocks. This exists so
// Random Beats can build a real PCM WAV take instead of running the
// vocal through MediaRecorder's webm/opus encoder - opus is a lossy,
// speech/call-oriented codec and audibly dulls a vocal take before it
// ever reaches the mixdown step. Capturing raw samples here means the
// only lossy step in the whole chain is gone: mic -> (optional autotune)
// -> raw float32 -> 16-bit PCM WAV -> ffmpeg mixdown WAV, matching
// "studio quality" rather than "compressed for a phone call".
//
// The buffering/flush algorithm below is pure - no AudioWorkletGlobalScope
// APIs - specifically so tools/test-rb-recorder.js can run it headless in
// Node and prove chunks reassemble in the right order with no samples
// dropped or duplicated, the same way tools/test-autotune.js verifies the
// autotune DSP core without a browser.
// ─── BEGIN CAPTURE CORE (pure - no AudioWorkletGlobalScope APIs below this
// line until the END marker) ────────────────────────────────────────────
class RBRecorderCore {
  constructor(port) {
    this.port = port;
    this._numChannels = 0;
    this._chunks = null;
    this._bufferedFrames = 0;
    this._flushEvery = 4096; // ~93ms @44.1kHz - keeps postMessage traffic light
  }

  onMessage(data) {
    if (data && data.type === 'stop') {
      this.flush();
      this.port.postMessage({ type: 'flushed' });
    }
  }

  flush() {
    if (!this._chunks || !this._bufferedFrames) return;
    const chans = this._chunks.map((c) => {
      let total = 0;
      for (const a of c) total += a.length;
      const out = new Float32Array(total);
      let o = 0;
      for (const a of c) { out.set(a, o); o += a.length; }
      return out;
    });
    this.port.postMessage(
      { type: 'chunk', channels: chans, numChannels: this._numChannels },
      chans.map((c) => c.buffer)
    );
    this._chunks = this._chunks.map(() => []);
    this._bufferedFrames = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length && input[0] && input[0].length) {
      if (!this._numChannels) {
        this._numChannels = input.length;
        this._chunks = Array.from({ length: this._numChannels }, () => []);
      }
      const n = Math.min(input.length, this._numChannels);
      for (let ch = 0; ch < n; ch++) this._chunks[ch].push(input[ch].slice());
      this._bufferedFrames += input[0].length;
      if (this._bufferedFrames >= this._flushEvery) this.flush();
    }
    return true;
  }
}
// ─── END CAPTURE CORE ───────────────────────────────────────────────────

class RBRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._core = new RBRecorderCore(this.port);
    this.port.onmessage = (e) => this._core.onMessage(e.data);
  }

  process(inputs) {
    return this._core.process(inputs);
  }
}
registerProcessor('rb-recorder-processor', RBRecorderProcessor);
