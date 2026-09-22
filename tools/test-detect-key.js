// Numeric regression test for detectKey() (renderer/app.js) - the
// beat-key-detection function used by both the main Analyze tab and
// Random Beats' "Match beat automatically". Runs headless in Node by
// extracting the function (and its fftRadix2 helper) directly out of
// the real source file via a line-range slice, and evaluating it in a
// sandboxed context.
//
// This exists because of a real, measured performance bug: detectKey()
// used to run a brute-force direct DFT (a k-bin x n-sample double loop)
// per analysis frame instead of an FFT - for a 30-second beat, that
// measured out to well over ten seconds of unbroken main-thread work,
// which is exactly what "opening the settings panel freezes the screen"
// looks like (the panel calls detectKey() on whatever random beat is
// showing, if it hasn't already been analyzed this session). Fixed with
// a real radix-2 FFT plus a periodic yield. What this test proves:
// (1) the FFT-based rewrite still detects the correct key on an
// unambiguous synthetic signal, matching what the original brute-force
// version would have found, and (2) it does so fast - a regression back
// to the O(bins*fftSize) approach would make this test take orders of
// magnitude longer, which the timing assertion below catches.
//
// Run with: node tools/test-detect-key.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'app.js');
const lines = fs.readFileSync(SRC_PATH, 'utf8').split('\n');

function extractFn(startPattern) {
  const startIdx = lines.findIndex((l) => startPattern.test(l));
  if (startIdx < 0) throw new Error('start pattern not found: ' + startPattern);
  let depth = 0, started = false, endIdx = -1;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    if (started && depth === 0) { endIdx = i; break; }
  }
  if (endIdx < 0) throw new Error('matching closing brace not found for: ' + startPattern);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

const fftSrc = extractFn(/^function fftRadix2\(re, im\) \{/);
const detectKeySrc = extractFn(/^async function detectKey\(buf\) \{/);
// Round 62: detectKey() now calls matchScaleFamily(), which reads the
// RB_KEY_SCALE_INTERVALS table - both declared separately at module
// scope in app.js (not nested inside detectKey), so the extraction has
// to pull them in too or detectKey() throws ReferenceError the moment
// it's actually called.
const scaleIntervalsSrc = extractFn(/^const RB_KEY_SCALE_INTERVALS = \{/);
const matchScaleFamilySrc = extractFn(/^function matchScaleFamily\(chroma12, rootIdx, topN\) \{/);

const sandbox = { console, Math, Promise, setTimeout, Float64Array, Array, Object };
vm.createContext(sandbox);
try {
  vm.runInContext(fftSrc + '\n' + scaleIntervalsSrc + '\n' + matchScaleFamilySrc + '\n' + detectKeySrc + '\nthis.__exports = { fftRadix2, detectKey, matchScaleFamily, RB_KEY_SCALE_INTERVALS };', sandbox);
} catch (e) {
  console.error('✗ detectKey/fftRadix2 failed to evaluate:', e.message);
  process.exit(1);
}
const { fftRadix2, detectKey, matchScaleFamily, RB_KEY_SCALE_INTERVALS } = sandbox.__exports;

let fails = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); fails++; }
}

function makeBuf(sr, samples) {
  return { sampleRate: sr, getChannelData: () => samples };
}

// ── 1. FFT correctness: spot-check against a brute-force DFT on a
// smaller synthetic frame (same check as the diagnostic used during
// development, kept here permanently).
{
  const n = 1024;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(2 * Math.PI * 37 * i / n) + 0.5 * Math.sin(2 * Math.PI * 101 * i / n);
  const reCopy = Float64Array.from(re);
  fftRadix2(re, im);
  let maxDiff = 0;
  for (let k = 0; k < n; k++) {
    let bre = 0, bim = 0;
    const w = 2 * Math.PI * k / n;
    for (let s = 0; s < n; s++) { bre += reCopy[s] * Math.cos(w * s); bim -= reCopy[s] * Math.sin(w * s); }
    maxDiff = Math.max(maxDiff, Math.abs(re[k] - bre), Math.abs(im[k] - bim));
  }
  check('fftRadix2 matches a brute-force DFT to within numerical precision', maxDiff < 1e-6, `max diff ${maxDiff.toExponential(3)}`);
}

// ── 2. detectKey() finds an unambiguous key correctly and quickly.
// A pure C-major triad (C4/E4/G4) repeated with the fundamentals and a
// couple of overtones, 10 seconds - should land on C major with no
// ambiguity, and should NOT take anywhere close to what the old
// brute-force approach would have.
(async () => {
  const sr = 44100, dur = 10;
  const n = sr * dur;
  const samples = new Float32Array(n);
  const freqs = [261.63, 329.63, 392.0]; // C4, E4, G4
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const f of freqs) { s += 0.3 * Math.sin(2 * Math.PI * f * i / sr); s += 0.1 * Math.sin(2 * Math.PI * f * 2 * i / sr); }
    samples[i] = s / freqs.length;
  }
  const buf = makeBuf(sr, samples);
  const t0 = Date.now();
  const result = await detectKey(buf);
  const elapsedMs = Date.now() - t0;
  check('detectKey finds C major on an unambiguous C major triad', result.key === 'C' && result.mode === 'major',
    `got ${result.key} ${result.mode} (confidence ${result.confidence})`);
  // The old brute-force approach measured multiple seconds for a 30s
  // clip in this same Node environment; a 10s clip here finishing in
  // well under a second is a strong signal the FFT path is actually
  // being used, not a regression back to the direct DFT.
  check('detectKey on a 10s clip completes quickly (FFT path, not brute-force DFT)', elapsedMs < 3000, `took ${elapsedMs}ms`);

  check('detectKey()\'s result includes a scaleFamily list (Round 62 - "closest matching scale/key combo" feature)',
    Array.isArray(result.scaleFamily) && result.scaleFamily.length > 0 && Array.isArray(result.scaleFamily[0].notes),
    JSON.stringify(result.scaleFamily && result.scaleFamily[0]));

  // ── matchScaleFamily(): mirrors analyze.py's Python-side regression
  // tests (tools/test-analyze.py) - same table, same combined
  // correlation*coverage scoring, so both sides of the fallback should
  // agree on an unambiguous synthetic case.
  {
    const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    function scaleTemplateChroma(rootIdx, intervals) {
      const c = new Array(12).fill(0.02); // small noise floor, not exactly zero
      for (const iv of intervals) c[(rootIdx + iv) % 12] = 1.0;
      return c;
    }
    let nOk = 0, nTotal = 0;
    for (let rootIdx = 0; rootIdx < 12; rootIdx++) {
      for (const [name, iv] of Object.entries(RB_KEY_SCALE_INTERVALS)) {
        const chroma = scaleTemplateChroma(rootIdx, iv);
        const top = matchScaleFamily(chroma, rootIdx, 1)[0];
        nTotal++;
        if (top.name === name) nOk++;
      }
    }
    check('matchScaleFamily() picks the exact scale type on a clean synthetic chroma across all 12 roots x 11 scale types',
      nOk === nTotal, `${nOk}/${nTotal} exact top-1 matches`);
  }
  {
    // Harmonic minor vs natural minor differ by exactly one note (the
    // raised 7th) - the hardest pairwise case, same as the Python test.
    const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const harmMinorIv = RB_KEY_SCALE_INTERVALS['Harmonic Minor'];
    const chroma = new Array(12).fill(0.02);
    for (const iv of harmMinorIv) chroma[iv % 12] = 1.0; // root = C (idx 0)
    const top = matchScaleFamily(chroma, 0, 3)[0];
    check('matchScaleFamily() identifies C Harmonic Minor correctly, not confused with the one-note-different Natural Minor',
      top.name === 'Harmonic Minor', `got ${top.name}`);
    check("the winning match's notes include the raised 7th (B)", top.notes.includes('B'), JSON.stringify(top.notes));
  }

  console.log('');
  if (fails) { console.log(`✗ ${fails} detectKey check(s) failed`); process.exit(1); }
  console.log('✓ detectKey: all checks passed');
})();
