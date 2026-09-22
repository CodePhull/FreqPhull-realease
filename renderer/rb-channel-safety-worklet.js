// ── Random Beats channel-safety processor ────────────────────────────
// Picks whichever input channel actually has live mic signal and
// outputs it as a clean, single, properly-duplicated signal - a small,
// dedicated worklet carrying the exact, already-proven logic that has
// lived inside autotune-worklet.js's AutotuneProcessor.process() for
// several rounds now (see the full rationale there: a multi-channel
// audio interface doesn't always put the live mic on channel 0, and
// naively averaging channels risks a comb-filter if they aren't
// perfectly phase-identical, so the fix is to pick ONE real channel and
// stick with it, with a debounce so a normal breath/pause can't cause a
// mid-take channel flip).
//
// This is a SEPARATE worklet, not a call into that same code, because
// these are two independent AudioWorklet modules the browser loads
// standalone - but critically, it now sits at the very FRONT of every
// record/monitor graph, immediately after the input gain stage, applied
// UNCONDITIONALLY regardless of whether Autotune (monitor or bake) is
// even turned on. Previously this protection only existed when the
// autotune node happened to be in the signal path - a take recorded or
// monitored with Autotune fully off (a completely normal, supported
// workflow) got zero protection, and a stereo mic request that resolves
// to one real channel and one silently-unconnected one would pass
// straight through untouched: heard/recorded as audio in one channel/
// speaker only ("mono, L only"), a real reported symptom this fixes at
// the root rather than only for the autotune-engaged case.
//
// Pure logic below (no AudioWorkletGlobalScope APIs) so
// tools/test-rb-channel-safety.js can verify it headless in Node, same
// technique as every other worklet file in this app.
// ─── BEGIN CHANNEL-SAFETY CORE ──────────────────────────────────────────
class RBChannelSafetyCore {
  constructor() {
    this.activeChannel = 0;
    this.silentBlockStreak = 0;
  }
  // inputChannels: array of Float32Array (one per input channel).
  // outputChannels: array of Float32Array (one per output channel) to
  // fill in place. Returns nothing; mutates outputChannels.
  process(inputChannels, outputChannels) {
    if (!inputChannels || !inputChannels.length || !inputChannels[0] || !outputChannels || !outputChannels[0]) return;
    const numCh = inputChannels.length;
    if (numCh > 1) {
      let activePeak = 0;
      const activeBuf = inputChannels[this.activeChannel] || inputChannels[0];
      for (let i = 0; i < activeBuf.length; i++) { const a = Math.abs(activeBuf[i]); if (a > activePeak) activePeak = a; }
      const SILENCE_FLOOR = 0.0008;
      if (activePeak < SILENCE_FLOOR) {
        this.silentBlockStreak++;
        // ~50ms of continuous silence on the active channel (at a
        // typical 128-sample render quantum) before even considering a
        // switch - see autotune-worklet.js's identical constant for the
        // full rationale.
        if (this.silentBlockStreak > 15) {
          let bestC = this.activeChannel, bestPeak = activePeak;
          for (let c = 0; c < numCh; c++) {
            if (c === this.activeChannel) continue;
            const buf = inputChannels[c];
            let peak = 0;
            for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
            if (peak > bestPeak) { bestPeak = peak; bestC = c; }
          }
          if (bestC !== this.activeChannel && bestPeak >= SILENCE_FLOOR) this.activeChannel = bestC;
          this.silentBlockStreak = 0;
        }
      } else {
        this.silentBlockStreak = 0;
      }
    }
    const inCh = inputChannels[this.activeChannel] || inputChannels[0];
    outputChannels[0].set(inCh);
    for (let c = 1; c < outputChannels.length; c++) outputChannels[c].set(outputChannels[0]);
  }
}
// ─── END CHANNEL-SAFETY CORE ─────────────────────────────────────────────

class RBChannelSafetyProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._core = new RBChannelSafetyCore();
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0] || !output || !output[0]) return true;
    this._core.process(input, output);
    return true;
  }
}
registerProcessor('rb-channel-safety-processor', RBChannelSafetyProcessor);
