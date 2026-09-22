// Regression test for the Round 73 capture sample-rate fix.
//
// The bug: rbEnsureWorklets() constructed the AudioContext with no options,
// so it inherited Chromium's default rate - and that default follows the
// OUTPUT device, not the microphone. A user with a Focusrite clocked at
// 44100 ended up with a context at 88200, so Chromium resampled the mic 2x
// on the way IN and every take was rendered, corrected and written at a
// rate the interface never produced.
//
// Confirmed from the artifact, not assumed: the recorder worklet runs inside
// this context, and the user's recorded WAVs carried an 88200 header while
// their interface was set to 44100.
//
// Why it is worth a test rather than a shrug - measured against a clean
// synthetic reference (tools/diag-rate-formant.js):
//   44100: formant boxiness +5.2dB, engine cost 0.24x realtime
//   88200: formant boxiness +7.2dB, engine cost 0.43x realtime
// So the pointless upsample was costing ~2dB of the exact coloration being
// reported, and double the CPU, while adding no information at all.
//
// This is a static source guard: the real behaviour lives in an Electron
// renderer with a live MediaStream and there is no headless Web Audio here
// to drive it (same limitation Rounds 59/68/70 hit). What can be pinned
// down exactly is that the wiring is present and correct.
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── The helper that reads the mic's real rate ──
check('Round 73: rbStreamSampleRate() exists to read the rate off the mic track',
  /function rbStreamSampleRate\(stream\)/.test(src));
check('Round 73: it reads getSettings().sampleRate from the audio track',
  /getAudioTracks\(\)\[0\][\s\S]{0,200}getSettings/.test(src));
check('Round 73: it returns null rather than guessing when the browser will not say',
  /function rbStreamSampleRate\(stream\)[\s\S]{0,400}return null/.test(src));

// ── The context must be constructible at an explicit rate ──
check('Round 73: rbEnsureWorklets takes a desiredRate',
  /async function rbEnsureWorklets\(desiredRate\)/.test(src));
check('Round 73: the context is constructed with an explicit sampleRate when one is known',
  /new Ctor\(\{ sampleRate: desiredRate \}\)/.test(src));
check('Round 73: a refused rate falls back to a default context instead of failing to record',
  /catch \(e\) \{[\s\S]{0,400}rbAudioCtx = new Ctor\(\);/.test(src));
check('Round 73: the bare no-options construction is no longer the only path',
  !/if \(!rbAudioCtx\) rbAudioCtx = new \(window\.AudioContext \|\| window\.webkitAudioContext\)\(\);/.test(src));

// ── Rebuilding on mismatch, but never mid-session ──
check('Round 73: an existing context at the wrong rate is rebuilt',
  /Math\.abs\(rbAudioCtx\.sampleRate - desiredRate\) > 1/.test(src));
check('Round 73: rebuilding is skipped while recording or monitoring (closing a live context would kill the take)',
  /if \(rbRecording \|\| rbMonitoring\) \{[\s\S]{0,400}leaving it until the next start/.test(src));
check('Round 73: a rebuild resets all three worklet-ready flags, or the new context would never load its modules',
  /rbAutotuneWorkletReady = false;[\s\S]{0,200}rbRecorderWorkletReady = false;[\s\S]{0,200}rbChannelSafetyWorkletReady = false;/.test(src));

// ── Every path that has a live mic stream must pass its rate ──
check('Round 73: the RECORD path passes the mic rate',
  /rbEnsureWorklets\(rbStreamSampleRate\(stream\)\), 8000, 'worklet load'/.test(src));
check('Round 73: the ARM/preview path passes the mic rate',
  /rbEnsureWorklets\(rbStreamSampleRate\(result\.stream\)\)/.test(src));
check('Round 73: the MONITOR path passes the mic rate',
  /Round 73[\s\S]{0,300}await rbEnsureWorklets\(rbStreamSampleRate\(stream\)\);/.test(src));

// The record path only knows the rate because the stream is already open -
// if someone moves the worklet call above getUserMedia this silently breaks.
const recordIdx = src.indexOf("rbEnsureWorklets(rbStreamSampleRate(stream)), 8000, 'worklet load'");
const streamIdx = src.lastIndexOf('stream = result.stream;', recordIdx);
check('Round 73: the record path still opens the mic BEFORE building the context (the rate is unknowable otherwise)',
  streamIdx !== -1 && recordIdx !== -1 && streamIdx < recordIdx);

// ── Paths with no mic must NOT invent a rate ──
check('Round 73: the key-detection path (no mic involved) still uses the default context',
  /if \(!rbAudioCtx\) await rbEnsureWorklets\(\);/.test(src));

// ── The log line is the only way to diagnose this from a user's machine ──
check('Round 73: the context rate and the mic rate are both logged, so a future mismatch is visible in the diagnostic log',
  /Audio context running at[\s\S]{0,160}mic reports/.test(src));

console.log('');
if (fails) { console.log(`✗ ${fails} context-rate check(s) failed`); process.exit(1); }
console.log('✓ context-rate: all checks passed');
