// Clean control on a REAL voice.
//
// Every evidence file so far has been app output, and every synthetic test
// is a synthetic voice. This closes the gap: take ONE dry recording (Topliner
// with "bake autotune" and "bake reverb" OFF - the recorder then writes the
// gain-staged mic untouched), run that exact performance through the actual
// shipped engine offline, and compare. Same singer, same mic, same room,
// same notes - the only difference between the files is the engine.
//
// Writes three renders next to the input, so the comparison can be heard
// and not just read:
//     <name>__NEW.wav          current engine (Round 80), your settings
//     <name>__LEGACY.wav       pre-Round-80 engine, same settings
//     <name>__FORMANT_OFF.wav  current engine, formant correction off
// and prints each one's band levels MINUS the dry take's, over voiced audio.
// 0.0 everywhere = the engine left the tone alone.
//
// Run:  node tools/render-take.js "C:\path\to\dry.wav" [--key=G] [--scale=minor]
//                                  [--retune=0] [--tracking=30]
// Defaults are the settings from your screenshots (G minor, retune 0ms,
// tracking 30ms). The key only decides which notes get corrected; set it to
// the beat's key for a like-for-like render.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
let file = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const a = args.find((s) => s.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
// No path given: newest .wav in the session's uploads folder that is not one
// of this tool's own renders. The first version of these instructions showed
// a placeholder path, which is not something anyone can run.
if (!file) {
  const up = path.resolve(__dirname, '..', '..', '..', '..', 'uploads');
  try {
    const wavs = fs.readdirSync(up).filter((f) => /\.wav$/i.test(f) && !/__(NEW|LEGACY|FORMANT_OFF)\.wav$/i.test(f))
      .map((f) => ({ f: path.join(up, f), t: fs.statSync(path.join(up, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (wavs.length) file = wavs[0].f;
  } catch (e) {}
}
if (!file || !fs.existsSync(file)) {
  console.log('No dry take found. Record one with Autotune "Bake" and Reverb "Bake" OFF, upload it, then:');
  console.log('  node tools/render-take.js                      (uses the newest upload)');
  console.log('  node tools/render-take.js "C:\\full\\path\\to\\take.wav" --key=G --scale=minor');
  process.exit(1);
}
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
let key = NOTES.indexOf(opt('key', 'G').toUpperCase());
if (key < 0) { const flat = { DB: 1, EB: 3, GB: 6, AB: 8, BB: 10 }[opt('key', 'G').toUpperCase()]; key = flat === undefined ? 7 : flat; }
const P = {
  key, scale: opt('scale', 'minor'),
  retuneSpeedMs: +opt('retune', 0), trackingSpeedMs: +opt('tracking', 30),
  humanize: 0, naturalVibrato: 0, flexTune: 0,
};

// ── Engine builds (same reconstruction test-splitband-r80.js verifies) ──
const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'autotune-worklet.js'), 'utf8');
function patchOnce(src, a, b) {
  const n = src.split(a).length - 1;
  if (n !== 1) throw new Error('engine anchor matched ' + n + ' times: ' + a);
  return src.replace(a, () => b);
}
function build(legacy) {
  let src = SRC;
  if (legacy) {
    src = patchOnce(src, 'this.shifter.writeSample(x, writeSignal);', 'this.shifter.writeSample(writeSignal, writeSignal);');
    src = patchOnce(src, 'let y = lpC + (rawShifted - lpR);', 'let y = yCorr;');
  }
  const core = src.slice(src.indexOf('// ─── BEGIN DSP CORE'), src.indexOf('// ─── END DSP CORE'));
  const sb = { console, Math, Float32Array, Int16Array, Float64Array };
  vm.createContext(sb);
  vm.runInContext(core + '\nthis.__exports = { AutotuneEngine };', sb);
  return sb.__exports.AutotuneEngine;
}

// ── WAV in/out ───────────────────────────────────────────────────────────
function readWav(p) {
  const b = fs.readFileSync(p);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null, dOff = -1, dLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') {
      let format = b.readUInt16LE(body);
      if (format === 0xFFFE && len >= 26) format = b.readUInt16LE(body + 24);
      fmt = { format, channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') { dOff = body; dLen = Math.min(len, b.length - body); }
    off = body + len + (len & 1);
  }
  const { format, channels, bits } = fmt, bps = bits / 8;
  const frames = Math.floor(dLen / (bps * channels));
  const x = new Float32Array(frames);                 // channel 0 - channel-safety duplicates it anyway
  for (let i = 0; i < frames; i++) {
    const o = dOff + i * channels * bps;
    if (format === 3 && bits === 32) x[i] = b.readFloatLE(o);
    else if (bits === 16) x[i] = b.readInt16LE(o) / 32768;
    else if (bits === 24) x[i] = ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8 >> 8) / 8388608;
    else if (bits === 32) x[i] = b.readInt32LE(o) / 2147483648;
    else throw new Error('unsupported WAV: format ' + format + ', ' + bits + '-bit');
  }
  return { sr: fmt.sampleRate, x };
}
function writeWavFloat(p, x, sr) {
  const b = Buffer.alloc(44 + x.length * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 4, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 4, 40);
  for (let i = 0; i < x.length; i++) b.writeFloatLE(x[i], 44 + i * 4);
  fs.writeFileSync(p, b);
}

// ── Spectrum over voiced frames ──────────────────────────────────────────
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, ang = -2 * Math.PI / size;
    for (let i = 0; i < n; i += size) for (let k = 0; k < half; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = i + k, c = a + half;
      const tr = re[c] * wr - im[c] * wi, ti = re[c] * wi + im[c] * wr;
      re[c] = re[a] - tr; im[c] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
const N = 8192;
function voicedFrames(x) {
  const rms = [];
  for (let p = 0; p + N <= x.length; p += N / 2) { let e = 0; for (let i = 0; i < N; i++) e += x[p + i] * x[p + i]; rms.push({ p, r: Math.sqrt(e / N) }); }
  const loud = [...rms].sort((a, b) => a.r - b.r)[Math.floor(rms.length * 0.95)].r;
  return rms.filter((f) => f.r > loud * 0.0316).map((f) => f.p);   // within 30dB of the loud end
}
function ltas(x, frames) {
  const acc = new Float64Array(N / 2);
  for (const p of frames) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[p + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
  }
  return acc;
}
const BANDS = [[80, 250], [250, 630], [630, 1500], [1500, 4000], [4000, 8000], [8000, 12000], [12000, 16000]];
function bandDb(acc, sr, lo, hi) {
  let s = 0, c = 0;
  for (let k = 1; k < N / 2; k++) { const f = k * sr / N; if (f >= lo && f < hi) { s += acc[k]; c++; } }
  return 10 * Math.log10(s / Math.max(1, c) + 1e-30);
}

// ── Run ──────────────────────────────────────────────────────────────────
const { sr, x } = readWav(file);
console.log('Rendering ' + path.basename(file) + ' - ' + sr + 'Hz, ' + (x.length / sr).toFixed(1) + 's');
// Running this on a take that already went through the engine renders the
// engine twice and measures nothing useful - the exact mistake behind
// Rounds 61-65. It cannot be detected from the audio, so say it every time.
console.log('This must be a DRY take (Autotune Bake OFF). A take that already went through');
console.log('the engine makes every number below meaningless.');
console.log('Settings: key ' + NOTES[P.key] + ' ' + P.scale + ', retune ' + P.retuneSpeedMs + 'ms, tracking ' + P.trackingSpeedMs + 'ms\n');

function render(AE, formant, label) {
  const e = new AE(sr);
  e.setParams({ ...P, formantCorrection: formant });
  const y = new Float32Array(x.length);
  const t0 = Date.now();
  for (let i = 0; i < x.length; i++) y[i] = e.processSample(x[i]);
  console.log('  ' + label.padEnd(14) + 'rendered in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  return y;
}
const NEW = build(false), LEG = build(true);
const outs = [
  ['NEW', render(NEW, true, 'NEW')],
  ['LEGACY', render(LEG, true, 'LEGACY')],
  ['FORMANT_OFF', render(NEW, false, 'FORMANT_OFF')],
];

const base = file.replace(/\.wav$/i, '');
for (const [tag, y] of outs) writeWavFloat(base + '__' + tag + '.wav', y, sr);
console.log('\nWrote ' + outs.map(([t]) => path.basename(base) + '__' + t + '.wav').join(', '));

const frames = voicedFrames(x);
const dry = ltas(x, frames);
console.log('\nBAND LEVEL vs YOUR DRY TAKE, dB   (' + frames.length + ' voiced frames; 0.0 = tone untouched)');
console.log('  ' + ''.padEnd(13) + BANDS.filter(([, h]) => h <= sr / 2).map(([l, h]) => ((l >= 1000 ? l / 1000 + 'k' : l) + '-' + (h >= 1000 ? h / 1000 + 'k' : h)).padStart(10)).join(''));
for (const [tag, y] of outs) {
  const s = ltas(y, frames);
  console.log('  ' + tag.padEnd(13) + BANDS.filter(([, h]) => h <= sr / 2).map(([l, h]) => {
    const d = bandDb(s, sr, l, h) - bandDb(dry, sr, l, h);
    return ((d >= 0 ? '+' : '') + d.toFixed(1)).padStart(10);
  }).join(''));
}
console.log('\nRead: a dip in 1.5k-4k with a rise at 250-630 is the "bottle". Whatever NEW');
console.log('shows here is what the engine does to YOUR voice - no synthetic stand-in.');
