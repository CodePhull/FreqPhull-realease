// Round 82: Topliner reverb was metallic, and its Decay knob ran backwards.
//
// The old reverb (four feedback combs + two biquad "allpasses") was measured
// in Electron's real Web Audio engine (OfflineAudioContext) before replacing
// it: echo density 0.18-0.26 (a dense tail is ~1), spectral ringing 21-29 dB
// (a dense tail is ~7), and RT60 3.1 s at decay 0.2 but 0.36 s at 0.5 and
// 0.12 s at 0.8. The new one is a ConvolverNode with a synthesised room
// response; in the same harness: density ~1.2, ringing 7.3 dB, RT60 1.0 /
// 2.1 / 2.9 s.
//
// This test checks the response generator headlessly (no Web Audio needed):
// the real rbBuildReverbIR() + rbReverbParamMap() from renderer/app.js, run
// against a stub AudioBuffer, measured with the same metrics, which are
// first proven on two references (a sparse echo train and dense noise).
//
// Run:  node tools/test-rb-reverb-r82.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const SR = 48000;
const pm = app.slice(app.indexOf('function rbDbToLinear('), app.indexOf('// ─── END RB DSP PARAM MATH'));
const ir = app.slice(app.indexOf('function rbBuildReverbIR('), app.indexOf('function rbCreateReverbUnit(ctx)'));
if (!pm || !ir) throw new Error('reverb code not found in app.js');
const sb = { Math, parseFloat, isFinite, Float32Array };
vm.createContext(sb);
vm.runInContext(pm + '\n' + ir + '\nthis.f = { rbBuildReverbIR, rbReverbParamMap };', sb);
const ctx = { sampleRate: SR, createBuffer: (ch, len) => { const d = [...Array(ch)].map(() => new Float32Array(len)); return { getChannelData: (i) => d[i], length: len }; } };

// ── Metrics ──
function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k], h = i + k + len / 2;
      const vr = re[h] * cr - im[h] * ci, vi = re[h] * ci + im[h] * cr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[h] = ur - vr; im[h] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } }
function ned(x, from, to) { const w = Math.round(0.02 * SR), out = [];
  for (let s = Math.round(from * SR); s + w < Math.round(to * SR); s += w / 2) { let m = 0; for (let i = s; i < s + w; i++) m += x[i] * x[i]; const sd = Math.sqrt(m / w) || 1e-12;
    let c = 0; for (let i = s; i < s + w; i++) if (Math.abs(x[i]) > sd) c++; out.push((c / w) / 0.3173); }
  return out.reduce((a, b) => a + b, 0) / out.length; }
function spectrum(x, from, to) { const N = 65536, re = new Float64Array(N), im = new Float64Array(N); const a = Math.round(from * SR), b = Math.min(x.length, Math.round(to * SR));
  for (let i = a; i < b && i - a < N; i++) re[i - a] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * (i - a) / (b - a)));
  fft(re, im); const db = []; for (let k = 0; k < N / 2; k++) db.push(10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-20)); return { db, N }; }
function ringing(x, from, to) { const { db, N } = spectrum(x, from, to), dev = [];
  for (let k = Math.ceil(200 * N / SR); k < 6000 * N / SR; k++) { const lo = Math.round(k / 1.12), hi = Math.round(k * 1.12); let s = 0; for (let j = lo; j <= hi; j++) s += db[j]; dev.push(db[k] - s / (hi - lo + 1)); }
  dev.sort((p, q) => p - q); return dev[Math.floor(dev.length * 0.95)]; }
function rt60(x) { const e = new Float64Array(x.length); let acc = 0; for (let i = x.length - 1; i >= 0; i--) { acc += x[i] * x[i]; e[i] = acc; }
  const db = (i) => 10 * Math.log10(e[i] / e[0] + 1e-30); let i5 = -1, i25 = -1;
  for (let i = 0; i < x.length; i++) { if (i5 < 0 && db(i) <= -5) i5 = i; if (db(i) <= -25) { i25 = i; break; } }
  return i5 >= 0 && i25 > i5 ? 3 * (i25 - i5) / SR : null; }
// Share of tail energy above 4 kHz, 300-800 ms in (damping should lower it).
function brightness(x) { const { db, N } = spectrum(x, 0.3, 0.8); let hi = 0, all = 0;
  for (let k = Math.ceil(100 * N / SR); k < N / 2; k++) { const p = Math.pow(10, db[k] / 10); all += p; if (k * SR / N > 4000) hi += p; } return hi / all; }

// ── Sanity gate: the metrics must tell a metallic echo from a dense tail ──
const sparse = new Float32Array(SR * 2); for (let i = 0; i < sparse.length; i += Math.round(0.035 * SR)) sparse[i] = Math.pow(0.85, i / (0.035 * SR));
let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
const dense = new Float32Array(SR * 2); for (let i = 0; i < dense.length; i++) dense[i] = rnd() * Math.pow(10, -3 * (i / SR) / 1.2);
const rs = { ned: ned(sparse, 0.05, 0.5), ring: ringing(sparse, 0.1, 1.1) }, rd = { ned: ned(dense, 0.05, 0.5), ring: ringing(dense, 0.1, 1.1) };
check('gate: sparse echo reads as sparse and ringing', rs.ned < 0.3 && rs.ring > 20, 'ned ' + rs.ned.toFixed(2) + ', ring ' + rs.ring.toFixed(1) + ' dB');
check('gate: dense noise reads as dense and flat', rd.ned > 0.9 && rd.ring < 10, 'ned ' + rd.ned.toFixed(2) + ', ring ' + rd.ring.toFixed(1) + ' dB');

// ── The reverb ──
const prev = [];
for (const decay of [0.2, 0.5, 0.8]) {
  const m = sb.f.rbReverbParamMap({ mix: 1, decay, damping: 0.5, preDelayMs: 0 });
  const x = sb.f.rbBuildReverbIR(ctx, m.rt60, m.damping).getChannelData(0);
  const n = ned(x, 0.05, 0.5), r = ringing(x, 0.1, 1.1), t = rt60(x);
  check('decay ' + decay + ': dense tail', n > 0.9, n.toFixed(2));
  check('decay ' + decay + ': no metallic ringing', r < 10, r.toFixed(1) + ' dB');
  check('decay ' + decay + ': RT60 within 35% of the setting (' + m.rt60.toFixed(2) + ' s)', t && Math.abs(t - m.rt60) / m.rt60 < 0.35, t && t.toFixed(2) + ' s');
  prev.push(t);
}
check('turning Decay up makes the tail longer (the old one got shorter)', prev[0] < prev[1] && prev[1] < prev[2], prev.map((v) => v.toFixed(2)).join(' < '));
const bright = (dm) => { const m = sb.f.rbReverbParamMap({ mix: 1, decay: 0.5, damping: dm }); return brightness(sb.f.rbBuildReverbIR(ctx, m.rt60, m.damping).getChannelData(0)); };
const b0 = bright(0), b1 = bright(1);
check('turning Damping up darkens the tail', b1 < b0 * 0.5, (100 * b0).toFixed(1) + '% -> ' + (100 * b1).toFixed(1) + '% above 4 kHz');
const ir2 = sb.f.rbBuildReverbIR(ctx, 1.5, 0.5);
let dot = 0, e0 = 0, e1 = 0; const L = ir2.getChannelData(0), R = ir2.getChannelData(1);
for (let i = Math.round(0.05 * SR); i < Math.round(0.6 * SR); i++) { dot += L[i] * R[i]; e0 += L[i] * L[i]; e1 += R[i] * R[i]; }
check('left and right are decorrelated (a wide tail, not a mono one)', Math.abs(dot / Math.sqrt(e0 * e1)) < 0.2, (dot / Math.sqrt(e0 * e1)).toFixed(3));
check('the same settings always build the same response (no shimmer on rebuild)', sb.f.rbBuildReverbIR(ctx, 1.5, 0.5).getChannelData(0)[12345] === L[12345]);

// ── Wiring ──
const unit = app.slice(app.indexOf('function rbCreateReverbUnit(ctx)'), app.indexOf('function rbConnectRecordGraph('));
check('the reverb is a convolver now', unit.includes('ctx.createConvolver()') && !unit.includes('combTunings'));
check('live tweaks crossfade between two convolvers (no clicks)', unit.includes('linearRampToValueAtTime(1, now + 0.08)') && unit.includes('linearRampToValueAtTime(0, now + 0.08)'));
check('dispose() releases everything it built, including a pending rebuild', unit.includes('clearTimeout(pending)') && unit.includes('slots.map((s) => s.conv)'));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
