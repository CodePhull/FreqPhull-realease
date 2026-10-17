// Recorded-take diagnostic: what in the RECORDING CHAIN is shaping a take.
//
// A take is app output, and with no dry copy there is no clean control - so
// this deliberately measures only things that do NOT need one:
//
//   1. LEVEL / LIMITING. The print path always ends in rbCreateLimiter():
//      DynamicsCompressor at -6dBFS, 20:1, 1ms attack, 100ms release, then a
//      tanh soft-clip from 0.7 (-3.1dBFS). Crest factor (peak vs RMS per
//      short window) shows how hard that is working. A natural sung vocal
//      sits roughly 12-20dB; single digits means it is being flattened.
//
//   2. REVERB FINGERPRINT. rbCreateReverbUnit() is four parallel combs at
//      exactly 1422/1491/1557/1617 samples (@44.1k), offset by the pre-delay,
//      with only biquad allpasses after them - phase shifters, no echo
//      density - so any baked reverb is four discrete resonant echoes. An
//      echo at a fixed delay leaves a cepstral peak at that quefrency that
//      survives averaging across frames, while pitch-related peaks move with
//      the melody and smear out. So: average the cepstrum over the take and
//      scan every pre-delay for that exact four-peak pattern.
//
//   3. SHORT COMB (the physical "bottle"). A signal summed with a copy of
//      itself delayed by a fraction of a millisecond to a couple of ms is a
//      comb filter - evenly spaced notches, the tube/bottle sound. Same
//      averaged cepstrum, looking at 0.25-2.2ms: below this singer's pitch
//      periods (82-140Hz is 7-12ms), so a strong fixed peak there is not
//      the voice.
//
//   4. CHANNELS. Channel-safety duplicates one channel, so a stereo take
//      should be two identical channels. Anything else is worth knowing.
//
//   5. LONG-TERM SPECTRUM, relative to 250-630Hz - reported, not judged.
//      Without a control there is no "correct" shape to compare against.
//
// Run:  node tools/diag-take.js [path-to.wav]
//       (no argument: newest .wav in the session's uploads folder)
'use strict';
const fs = require('fs');
const path = require('path');

// ── Locate the file ──────────────────────────────────────────────────────
let file = process.argv[2];
if (!file) {
  const up = path.resolve(__dirname, '..', '..', '..', '..', 'uploads');
  try {
    const wavs = fs.readdirSync(up).filter((f) => /\.wav$/i.test(f))
      .map((f) => ({ f: path.join(up, f), t: fs.statSync(path.join(up, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (wavs.length) file = wavs[0].f;
  } catch (e) {}
}
if (!file || !fs.existsSync(file)) {
  console.log('No .wav found. Pass a path:  node tools/diag-take.js "C:\\path\\to\\take.wav"');
  process.exit(1);
}

// ── WAV parse (PCM 16/24/32, float 32, WAVE_FORMAT_EXTENSIBLE) ───────────
function readWav(p) {
  const b = fs.readFileSync(p);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = b.readUInt16LE(body);
      const channels = b.readUInt16LE(body + 2);
      const sampleRate = b.readUInt32LE(body + 4);
      const bits = b.readUInt16LE(body + 14);
      if (format === 0xFFFE && len >= 26) format = b.readUInt16LE(body + 24);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      dataOff = body; dataLen = Math.min(len, b.length - body);
    }
    off = body + len + (len & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt or data chunk');
  const { format, channels, bits } = fmt;
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  const ch = [];
  for (let c = 0; c < channels; c++) ch.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * bps;
      let v;
      if (format === 3 && bits === 32) v = b.readFloatLE(o);
      else if (bits === 16) v = b.readInt16LE(o) / 32768;
      else if (bits === 24) v = ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bits === 32) v = b.readInt32LE(o) / 2147483648;
      else throw new Error('unsupported: format ' + format + ', ' + bits + ' bit');
      ch[c][i] = v;
    }
  }
  return { ...fmt, frames, ch };
}

// ── Iterative radix-2 FFT (in place) ─────────────────────────────────────
const twiddle = new Map();
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  let tw = twiddle.get(n);
  if (!tw) {
    tw = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) { tw.c[k] = Math.cos(-2 * Math.PI * k / n); tw.s[k] = Math.sin(-2 * Math.PI * k / n); }
    twiddle.set(n, tw);
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = tw.c[k * step], wi = tw.s[k * step];
        const a = i + k, b2 = a + half;
        const tr = re[b2] * wr - im[b2] * wi, ti = re[b2] * wi + im[b2] * wr;
        re[b2] = re[a] - tr; im[b2] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function median(a) { return pct(a, 0.5); }

const w = readWav(file);
const sr = w.sampleRate;
console.log('Take diagnostic - ' + path.basename(file));
console.log('  ' + sr + 'Hz, ' + w.channels + 'ch, ' + w.bits + '-bit' + (w.format === 3 ? ' float' : '') +
            ', ' + (w.frames / sr).toFixed(1) + 's');

// ── 4. Channels ──────────────────────────────────────────────────────────
if (w.channels > 1) {
  const a = w.ch[0], b = w.ch[1];
  let maxDiff = 0, sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < w.frames; i++) {
    const d = Math.abs(a[i] - b[i]); if (d > maxDiff) maxDiff = d;
    sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i];
  }
  const corr = sab / Math.sqrt(saa * sbb + 1e-20);
  console.log('\nCHANNELS');
  console.log('  L/R correlation ' + corr.toFixed(4) + ', max sample difference ' + maxDiff.toExponential(2) +
              (maxDiff < 1e-4 ? '  -> identical (expected: channel-safety duplicates one channel)'
                              : '  -> NOT identical - the channels carry different signals'));
}
const x = w.ch[0];

// ── Voice-active regions ─────────────────────────────────────────────────
const WIN = Math.round(sr * 0.05);
const winStats = [];
let globalPeak = 0;
for (let i = 0; i + WIN <= x.length; i += WIN) {
  let pk = 0, e = 0;
  for (let k = 0; k < WIN; k++) { const v = x[i + k]; const a = Math.abs(v); if (a > pk) pk = a; e += v * v; }
  const rms = Math.sqrt(e / WIN);
  winStats.push({ i, pk, rms });
  if (pk > globalPeak) globalPeak = pk;
}
const loudRms = pct(winStats.map((s) => s.rms), 0.95);
const active = winStats.filter((s) => s.rms > loudRms * Math.pow(10, -30 / 20));
const activeSec = active.length * 0.05;

// ── 1. Level / limiting ──────────────────────────────────────────────────
let n95 = 0, n98 = 0;
for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a >= 0.95) n95++; if (a >= 0.98) n98++; }
const crest = active.map((s) => db(s.pk) - db(s.rms));
const pinned = active.filter((s) => s.pk >= 0.9).length / Math.max(1, active.length);
let ae = 0; for (const s of active) ae += s.rms * s.rms;
console.log('\n1. LEVEL / LIMITING   (voice active ' + activeSec.toFixed(1) + 's of ' + (w.frames / sr).toFixed(1) + 's)');
console.log('  peak ' + db(globalPeak).toFixed(1) + ' dBFS, active RMS ' + db(Math.sqrt(ae / Math.max(1, active.length))).toFixed(1) + ' dBFS');
console.log('  samples >= 0.95: ' + n95 + ',  >= 0.98 (at the limiter ceiling): ' + n98);
// The first version of this section judged limiting from per-50ms crest
// factor against a 12-20dB "natural" band. That band belongs to crest factor
// measured over whole phrases; within 50ms a sustained vowel is naturally
// 6-10dB (a pure sine is 3dB), so it called a normal take "HEAVILY
// flattened". Retracted. What can be read honestly is how often the level
// reaches the limiter's range at all. It sits on the OUTPUT, so a window that
// peaks above its knee is one the limiter had authority over; below the
// knee it did nothing.
console.log('  crest factor per 50ms window: median ' + median(crest).toFixed(1) + ' dB  (6-10dB is normal for sung vowels at this window size)');
const aboveKnee = active.filter((s) => s.pk >= Math.pow(10, -9 / 20)).length / Math.max(1, active.length);
const aboveThr  = active.filter((s) => s.pk >= Math.pow(10, -6 / 20)).length / Math.max(1, active.length);
console.log('  active windows peaking above -9 dBFS (limiter knee starts): ' + (100 * aboveKnee).toFixed(0) + '%');
console.log('  active windows peaking above -6 dBFS (limiter threshold):   ' + (100 * aboveThr).toFixed(0) + '%');
console.log('  active windows peaking above -0.9 dBFS:                      ' + (100 * pinned).toFixed(0) + '%');
console.log('  -> ' + (aboveThr > 0.5 ? 'the limiter (20:1) is acting on most of the take - turn Input Gain down.'
                     : aboveKnee > 0.25 ? 'the limiter is acting on the louder phrases.'
                     : 'the limiter is rarely reached.'));

// ── Averaged cepstrum over voiced frames ─────────────────────────────────
// Frame long enough to contain the longest reverb lag we scan for:
// pre-delay up to 150ms + the 1617-sample comb, twice over.
const maxPre = Math.round(0.15 * sr);
const combLag = [1422, 1491, 1557, 1617].map((s) => Math.round(s * sr / 44100));
const needQ = maxPre + Math.max(...combLag) + 200;
let N = 1; while (N < needQ * 2) N <<= 1;
const HOP = N >> 1;
const cep = new Float64Array(N / 2);
let frames = 0;
const activeSet = new Set(active.map((s) => Math.floor(s.i / WIN)));
const hann = new Float64Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
const ltas = new Float64Array(N / 2);
for (let pos = 0; pos + N <= x.length; pos += HOP) {
  // Only frames that are mostly voice.
  let act = 0, tot = 0;
  for (let k = pos; k < pos + N; k += WIN) { tot++; if (activeSet.has(Math.floor(k / WIN))) act++; }
  if (act / tot < 0.6) continue;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = x[pos + i] * hann[i];
  fft(re, im);
  const lre = new Float64Array(N), lim = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const p2 = re[k] * re[k] + im[k] * im[k];
    if (k < N / 2) ltas[k] += p2;
    lre[k] = Math.log(p2 + 1e-20);
  }
  fft(lre, lim);
  for (let q = 0; q < N / 2; q++) cep[q] += lre[q] / N;
  frames++;
}
if (!frames) { console.log('\nNot enough voiced audio for the echo/comb analysis.'); process.exit(0); }
for (let q = 0; q < N / 2; q++) cep[q] /= frames;

// Robust local z-score of the cepstrum at quefrency q.
function zAt(q, halfWin, guard) {
  const nb = [];
  for (let d = -halfWin; d <= halfWin; d++) {
    if (Math.abs(d) <= guard) continue;
    const j = q + d; if (j > 0 && j < cep.length) nb.push(cep[j]);
  }
  const m = median(nb);
  const mad = median(nb.map((v) => Math.abs(v - m))) * 1.4826 + 1e-12;
  return (cep[q] - m) / mad;
}

// ── 2. Reverb fingerprint ────────────────────────────────────────────────
console.log('\n2. REVERB FINGERPRINT   (' + frames + ' voiced frames of ' + (N / sr * 1000).toFixed(0) + 'ms averaged)');
const qLo = Math.min(...combLag), qHi = maxPre + Math.max(...combLag);
const zc = new Float64Array(qHi + 2);
for (let q = qLo; q <= qHi; q++) zc[q] = zAt(q, 80, 3);
const scores = [];
let best = { p: 0, s: -Infinity };
for (let p = 0; p <= maxPre; p++) {
  // Peak within +-1 sample: the comb delays are rounded to samples and the
  // pre-delay is continuous.
  let s = 0;
  for (const L of combLag) { const q = p + L; s += Math.max(zc[q - 1] || 0, zc[q], zc[q + 1] || 0); }
  scores.push(s);
  if (s > best.s) best = { p, s };
}
const sm = scores.reduce((a, b) => a + b, 0) / scores.length;
const ssd = Math.sqrt(scores.reduce((a, b) => a + (b - sm) * (b - sm), 0) / scores.length) + 1e-12;
const standout = (best.s - sm) / ssd;
const perPeak = combLag.map((L) => { const q = best.p + L; return Math.max(zc[q - 1] || 0, zc[q], zc[q + 1] || 0); });
console.log('  best match at pre-delay ' + (best.p / sr * 1000).toFixed(1) + 'ms: comb peaks z = ' + perPeak.map((v) => v.toFixed(1)).join(' / '));
console.log('  that match stands ' + standout.toFixed(1) + ' SD above every other pre-delay tried');
const reverbFound = standout >= 5 && perPeak.filter((v) => v >= 3).length >= 3;
console.log('  -> ' + (reverbFound
  ? 'PRESENT. The app\'s reverb is baked into this take (4 comb echoes, no diffusion - a tube/bottle colour on its own).'
  : 'not detected. This take does not carry the app\'s reverb.'));

// ── 3. Short comb (the physical "bottle") ────────────────────────────────
console.log('\n3. SHORT COMB 0.25-2.2ms   (below this singer\'s 7-12ms pitch periods)');
const sLo = Math.round(0.00025 * sr), sHi = Math.round(0.0022 * sr);
const cands = [];
for (let q = sLo; q <= sHi; q++) cands.push({ q, z: zAt(q, 25, 2) });
cands.sort((a, b) => b.z - a.z);
const top = cands[0];
console.log('  strongest fixed peak: ' + (top.q / sr * 1000).toFixed(3) + 'ms (z=' + top.z.toFixed(1) +
            '), which would put notches every ' + (sr / top.q).toFixed(0) + 'Hz');
console.log('  next: ' + cands.slice(1, 4).map((c) => (c.q / sr * 1000).toFixed(3) + 'ms z=' + c.z.toFixed(1)).join(', '));
console.log('  -> ' + (top.z >= 8 ? 'A STRONG fixed short-delay comb. Something sums the signal with a delayed copy of itself.'
                     : top.z >= 5 ? 'a weak fixed comb - worth a second take to confirm.'
                     : 'none. No short-delay comb in this take.'));

// ── 5. Long-term spectrum ────────────────────────────────────────────────
function bandDb(lo, hi) {
  let s = 0, c = 0;
  for (let k = 1; k < N / 2; k++) { const f = k * sr / N; if (f >= lo && f < hi) { s += ltas[k]; c++; } }
  return 10 * Math.log10(s / Math.max(1, c) + 1e-30);
}
const ref = bandDb(250, 630);
console.log('\n5. LONG-TERM SPECTRUM, dB relative to 250-630Hz (reported, not judged - no control)');
for (const [lo, hi] of [[80, 250], [630, 1500], [1500, 4000], [4000, 8000], [8000, 12000], [12000, 16000]]) {
  if (hi > sr / 2) continue;
  const v = bandDb(lo, hi) - ref;
  console.log('  ' + (lo + '-' + hi + 'Hz').padEnd(14) + (v >= 0 ? '+' : '') + v.toFixed(1));
}
