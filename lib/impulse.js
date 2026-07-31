'use strict';
// Impulse response generation for convolution reverb.
//
// The first version of Slow + Reverb used ffmpeg's aecho, which is an
// echo: a handful of discrete delayed copies. It is cheap and it sounds
// like it - metallic, with audible repeats and a flutter on transients.
// That is fine for a preview and unacceptable on anything anyone intends
// to release.
//
// Convolution is what studio reverbs do: the signal is convolved with a
// recording of a real space. We synthesise that response instead of
// shipping audio files, which keeps room size continuous and adds
// nothing to the download. The model has the three parts a real space
// has:
//
//   * a direct path,
//   * a handful of early reflections - the geometry of the room, which
//     is what tells you how big it is before the tail arrives,
//   * a dense diffuse tail that decays exponentially, with the high
//     frequencies decaying faster than the low ones, because air and
//     soft surfaces absorb treble first. Skipping that damping is the
//     main reason synthetic reverbs sound like a hiss rather than a room.
//
// The two channels are decorrelated so the tail spreads rather than
// sitting in the middle of the image.

const fs = require('fs');

// Room presets: RT60 (seconds to decay 60dB), pre-delay in ms, and how
// aggressively treble is absorbed.
const ROOMS = [
  { name: 'booth',     rt60: 0.45, preDelayMs: 6,  damping: 0.42, earlyCount: 6,  spread: 0.55 },
  { name: 'room',      rt60: 0.95, preDelayMs: 11, damping: 0.34, earlyCount: 9,  spread: 0.70 },
  { name: 'medium',    rt60: 1.80, preDelayMs: 18, damping: 0.26, earlyCount: 12, spread: 0.85 },
  { name: 'hall',      rt60: 3.10, preDelayMs: 28, damping: 0.18, earlyCount: 16, spread: 1.00 },
  { name: 'cathedral', rt60: 5.20, preDelayMs: 42, damping: 0.11, earlyCount: 20, spread: 1.00 },
];

// Deterministic noise: the same room must produce the same response on
// every machine and every run, or a re-render would not match the file
// the user already approved.
function makeRandom(seed) {
  let s = seed >>> 0;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return (s / 4294967296) * 2 - 1;
  };
}

function buildImpulse(roomIndex, sampleRate) {
  const room = ROOMS[Math.max(0, Math.min(ROOMS.length - 1, roomIndex - 1))];
  const sr = sampleRate || 44100;
  const len = Math.max(sr * 0.2 | 0, Math.ceil(sr * (room.rt60 + room.preDelayMs / 1000 + 0.1)));
  const chans = [new Float64Array(len), new Float64Array(len)];
  const preDelay = Math.floor(sr * room.preDelayMs / 1000);

  // Exponential decay to reach -60dB exactly at RT60.
  const decayPerSample = Math.pow(10, -3 / (room.rt60 * sr));

  for (let c = 0; c < 2; c++) {
    const rnd = makeRandom(0x9e3779b9 + roomIndex * 7919 + c * 104729);
    const out = chans[c];

    // Early reflections. Their spacing is what the ear reads as size,
    // so they are spread across the first portion of the tail rather
    // than bunched at the start.
    for (let i = 0; i < room.earlyCount; i++) {
      const frac = (i + 1) / room.earlyCount;
      const jitter = 1 + rnd() * 0.35;
      const pos = preDelay + Math.floor(sr * room.rt60 * 0.09 * frac * jitter * room.spread);
      if (pos >= len) continue;
      const amp = (0.62 / (1 + i * 0.85)) * (rnd() > 0 ? 1 : -1);
      out[pos] += amp;
    }

    // Diffuse tail with frequency-dependent decay. A one-pole lowpass
    // whose coefficient tracks the envelope makes the treble die away
    // ahead of the body, the way absorption behaves.
    let lp = 0;
    let env = 1;
    // 9kHz at the head of the tail; the damped end is where the room's
    // absorption takes it. A booth swallows treble almost immediately,
    // a cathedral keeps some of it for seconds.
    const C_START = Math.min(0.95, 2 * Math.PI * 9000 / sr);
    const cEnd = Math.max(0.012, C_START * Math.exp(-room.damping * 11));
    for (let i = preDelay; i < len; i++) {
      env *= decayPerSample;
      const white = rnd();
      // As the tail ages the filter closes, so less treble survives.
      // The coefficient is derived from a target cutoff rather than
      // picked by feel: for a one-pole, c is about 2*pi*fc/sr. It
      // sweeps from roughly 9kHz at the start of the tail down to the
      // room's damping limit, exponentially, which is how absorption
      // actually behaves. The previous linear version barely closed at
      // all, so every room came out bright and hissy instead of dark.
      const age = (i - preDelay) / (len - preDelay);
      const coeff = C_START * Math.pow(cEnd / C_START, age);
      lp = lp + coeff * (white - lp);
      out[i] += lp * env * 0.5;
    }

    // Remove DC and any subsonic drift the noise leaves behind - it
    // would otherwise pump the low end of everything sent through it.
    let prevIn = 0, prevOut = 0;
    const hpCoeff = 1 - (2 * Math.PI * 22) / sr;
    for (let i = 0; i < len; i++) {
      const x = out[i];
      prevOut = hpCoeff * (prevOut + x - prevIn);
      prevIn = x;
      out[i] = prevOut;
    }
  }

  // Normalise to unit energy, not to peak.
  //
  // Convolution sums the whole response for every output sample, so a
  // long response multiplies loudness: a peak-normalised three-second
  // tail raises a track by roughly twenty LUFS. Correcting that
  // afterwards by pulling the peak down satisfies the meter but not the
  // ear, since the direct sound is attenuated along with the tail.
  //
  // Scaling so the sum of squares is one means convolving with this
  // response leaves loudness roughly where it found it, and the wet
  // control then means what it says.
  for (let c = 0; c < 2; c++) {
    let energy = 0;
    for (let i = 0; i < len; i++) energy += chans[c][i] * chans[c][i];
    if (energy > 1e-12) {
      const g = 1 / Math.sqrt(energy);
      for (let i = 0; i < len; i++) chans[c][i] *= g;
    }
  }
  return { chans, len, sampleRate: sr, room: room.name, rt60: room.rt60 };
}

// 32-bit float WAV: the response feeds a convolution engine, so it is
// kept at full precision rather than quantised on the way in.
function writeImpulseWav(filePath, imp) {
  const { chans, len, sampleRate } = imp;
  const dataBytes = len * 2 * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);              // IEEE float
  buf.writeUInt16LE(2, 22);              // stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2 * 4, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < len; i++) {
    buf.writeFloatLE(chans[0][i], off); off += 4;
    buf.writeFloatLE(chans[1][i], off); off += 4;
  }
  fs.writeFileSync(filePath, buf);
  return filePath;
}

module.exports = { ROOMS, buildImpulse, writeImpulseWav };
