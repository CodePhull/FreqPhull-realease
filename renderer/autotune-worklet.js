// Real-time pitch correction for Random Beats' "Record topline" feature.
//
// This is our own pitch-detection + pitch-shifting engine, exposed through
// the same control surface Auto-Tune Pro's Auto Mode uses (Key, Scale,
// Retune Speed, Humanize, Natural Vibrato, Flex-Tune, Formant Correction)
// so the knobs behave the way anyone who has used that plugin expects.
// It is NOT Antares' algorithm - Auto-Tune's actual pitch-tracking and
// PSOLA implementation are proprietary and unavailable to us - this is an
// autocorrelation pitch detector (with parabolic sub-bin interpolation)
// feeding a granular (overlap-add) pitch shifter, tuned to react the same
// way the named controls describe. Formant Correction is a hybrid
// analysis/resynthesis scheme: each analysis hop derives the vocal-tract
// filter (formants) from the UNSHIFTED input via LPC/Levinson-Durbin, the
// engine whitens the signal into a formant-free excitation with it (a
// safe, feed-forward operation - see the Round 44 comment above
// computeCepstralEnvelope() below), pitch-shifts THAT excitation instead
// of the raw waveform, then RESYNTHESIZES it through a separately-derived
// cepstral (homomorphic) spectral-envelope filter - realized as a
// bounded, non-recursive FIR impulse response, not a recursive all-pole
// filter - so the output's formants track the ORIGINAL voice instead of
// dragging along with the pitch shift (the "chipmunk" effect a naive
// shift produces), without the recursive-filter ringing a full all-pole
// round trip could produce (Round 41/44 - see PATCHNOTES).
//
// ─── BEGIN DSP CORE (pure - no AudioWorkletGlobalScope APIs below this
//     line until AutotuneProcessor. Kept dependency-free so
//     tools/test-autotune.js can load just this section in Node and
//     verify pitch-correction behavior numerically.) ───────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Semitone offsets from the root, matching Auto-Tune Pro's Auto-mode
// scale list (Chromatic/Major/Minor plus the common modes and both
// pentatonics it also offers).
const SCALE_INTERVALS = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
};

function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function hzToMidi(hz) { return 69 + 12 * Math.log2(hz / 440); }

// Given a detected pitch in Hz, find the nearest note that belongs to the
// selected key/scale. Returns the target frequency, the MIDI note it
// snapped to, and how far off (in cents) the raw input was from it.
function freqToNearestScaleFreq(hz, keyIndex, intervals, excludedPcs) {
  const midi = hzToMidi(hz);
  const m0 = Math.round(midi);
  const pc0 = ((m0 - keyIndex) % 12 + 12) % 12;
  let best = m0, bestDist = Infinity;
  // excludedPcs (Round 48 - live note view/bypass): a Set of ABSOLUTE
  // pitch classes (0=C..11=B, not relative to key) the user has toggled
  // off in the piano UI - these are skipped as correction targets
  // entirely, same as if they weren't in the scale at all. If every
  // note in the current scale has been excluded (nothing left to
  // correct to), fall back to the unrestricted scale rather than
  // producing no valid target at all - a fully-excluded scale is a
  // degenerate UI state, not something that should silently stop
  // correction from working.
  let anyAllowed = !excludedPcs || excludedPcs.size === 0;
  if (!anyAllowed) {
    for (const iv of intervals) {
      if (!excludedPcs.has((keyIndex + iv) % 12)) { anyAllowed = true; break; }
    }
  }
  for (const iv of intervals) {
    if (anyAllowed && excludedPcs && excludedPcs.size > 0 && excludedPcs.has((keyIndex + iv) % 12)) continue;
    // try the candidate at, one octave below, and one octave above m0's
    // octave so the nearest allowed note is found even across a boundary
    for (const octShift of [-12, 0, 12]) {
      const candidatePc = iv;
      const candidateMidi = m0 - pc0 + candidatePc + octShift;
      const dist = Math.abs(candidateMidi - midi);
      if (dist < bestDist) { bestDist = dist; best = candidateMidi; }
    }
  }
  const targetHz = midiToHz(best);
  const centsOff = 1200 * Math.log2(hz / targetHz);
  return { targetHz, targetMidi: best, centsOff };
}

// Autocorrelation pitch detector over a rolling analysis window. Returns
// null when the signal is too quiet or has no clear periodicity (silence,
// breath, unvoiced consonants) - callers should hold or fade the last
// known correction rather than chase noise.
// In-place iterative radix-2 Cooley-Tukey FFT - used below to compute
// the pitch detector's autocorrelation in O(n log n) instead of a
// direct O(n) sum recomputed from scratch at every one of the ~600+
// candidate lags. This matters because detectPitch() runs once per
// analysis hop directly on the real-time audio thread - measured
// directly, the old direct-sum version took ~2ms per call on fast
// hardware, which is a large fraction of - and on slower or busier real
// end-user machines, can exceed - the ~2.7ms time budget of the single
// 128-sample render quantum it happens to land in. Blowing that budget
// is a real, audible cause of periodic glitches/dropouts: heard as a
// crackly, "robotic", stuttering, quieter-than-it-should-be quality
// (dropped/repeated samples), not a screech - a different failure mode
// than anything the last several rounds were chasing. re/im must be
// same-length Float64Arrays whose length is a power of two; re holds
// real input on entry (im all zero for a real-valued signal) and both
// hold the complex spectrum on return.
function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + half] * curWr - im[i + j + half] * curWi;
        const vi = re[i + j + half] * curWi + im[i + j + half] * curWr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
        const nextWr = curWr * wr - curWi * wi;
        const nextWi = curWr * wi + curWi * wr;
        curWr = nextWr; curWi = nextWi;
      }
    }
  }
}
function nextPow2(v) { let p = 1; while (p < v) p <<= 1; return p; }

function detectPitch(buf, sampleRate, minHz, maxHz) {
  minHz = minHz || 70; maxHz = maxHz || 1000;
  const n = buf.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += buf[i] * buf[i];
  if (energy / n < 1e-6) return null; // near-silence

  const minLag = Math.max(1, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 1, Math.floor(sampleRate / minHz));
  let mean = 0;
  for (let i = 0; i < n; i++) mean += buf[i];
  mean /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = buf[i] - mean;

  // Full-window normalized autocorrelation via FFT (Wiener-Khinchin:
  // ACF = IFFT(|FFT(x)|^2)) instead of a direct sum at every candidate
  // lag - see the comment on fftRadix2 above for why. Zero-padded to at
  // least 2n so the result is the exact LINEAR (non-circular)
  // autocorrelation for every lag up to n-1, with no wraparound
  // contamination - this has to come out identical to the direct sum,
  // not just similar, since every threshold below was tuned against it.
  const nfft = nextPow2(2 * n);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < n; i++) re[i] = x[i];
  fftRadix2(re, im);
  for (let k = 0; k < nfft; k++) { const p = re[k] * re[k] + im[k] * im[k]; re[k] = p; im[k] = 0; }
  // The power spectrum above is real and even (Hermitian |X|^2 of a
  // real signal), so a second forward FFT of it equals nfft times its
  // own inverse FFT - exactly, not approximately, for a real+even
  // input, so a second call to the same fftRadix2 is the entire
  // "inverse transform" this needs.
  fftRadix2(re, im);
  const acfFull = re; // acfFull[lag]/nfft === sum_i x[i]*x[i+lag] for lag=0..n-1

  // norm1(lag)/norm2(lag) are just the windowed energy of the two
  // overlapping spans the direct sum used - both are O(1) prefix-sum
  // lookups once a single O(n) prefix pass is done, instead of being
  // re-summed from scratch at every lag.
  const prefixSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefixSq[i + 1] = prefixSq[i] + x[i] * x[i];
  const totalSq = prefixSq[n];
  function corrAt(lag) {
    const sum = acfFull[lag] / nfft;
    const norm1 = prefixSq[n - lag];
    const norm2 = totalSq - prefixSq[lag];
    const denom = Math.sqrt(norm1 * norm2) || 1e-9;
    return sum / denom;
  }

  // Naive "pick the global max" autocorrelation is prone to octave
  // errors: a periodic signal correlates almost as strongly at 2x, 3x...
  // its true period as at the true period itself, and finite-window edge
  // effects can even push a longer lag's normalized value marginally
  // above the true peak. Standard fix: take the SHORTEST lag whose
  // correlation is close to the global best, rather than the global best
  // lag itself - true pitch periods are never longer than their
  // harmonics' apparent "peaks".
  //
  // vals[] is full float64 precision end to end (it wasn't before -
  // this used to be a Float32Array) specifically because the fallback
  // search a little further down matches against bestVal with exact
  // (===) equality; storing a lower-precision rounding of the same
  // number there meant that comparison could silently never match,
  // which is exactly what was happening for any real, valid pitch whose
  // true peak lag landed at or near the very edge of the search range
  // (e.g. a low male voice near 70Hz) - a latent bug, not something
  // introduced by the periodicity-dip check, but one this rewrite fixes
  // as a side effect of computing everything in one consistent
  // precision throughout.
  const vals = new Float64Array(maxLag - minLag + 1);
  let bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const val = corrAt(lag);
    vals[lag - minLag] = val;
    if (val > bestVal) bestVal = val;
  }
  // A flat confidence gate here turned out not to be able to cleanly
  // separate "genuine but quiet voice" from "noise" - they overlap
  // (measured directly: noise can spuriously reach up to ~0.56
  // confidence; real voice singing softly, or a mic with lower input
  // gain, can measure well under that too - median 0.56 at -36.5dBFS,
  // dropping further from there). Raising this gate high enough to
  // reject noise ended up rejecting real, quiet singing right along
  // with it - a second real, reported bug ("autotune doesn't work now")
  // caused by the previous round's fix to the first one. This function
  // stays a low, permissive floor - just enough to reject obvious
  // silence/non-periodic garbage - and the actual noise-vs-quiet-voice
  // judgment call now happens in AutotuneEngine._analyze(), which has
  // something this pure, stateless function never can: memory of what
  // was actually just being sung, which is exactly what separates a
  // real voice's next 12ms from a noise burst's.
  if (bestVal < 0.3) return null; // not periodic enough to be a clear pitch
  // Take the shortest LOCAL MAXIMUM that clears the threshold, not just
  // the first sample to cross it - the rising edge of a real peak can
  // cross a loose threshold a few lags early, which would otherwise read
  // as a sharper (wrong) pitch than the true fundamental.
  //
  // That alone isn't enough, though: a genuinely periodic signal's
  // normalized autocorrelation DIPS well below its own peak somewhere
  // between lag 0 and the true period (a real vibrating waveform is
  // anti-correlated with itself across roughly half a cycle) before
  // climbing back up to that peak - that dip is what actually proves
  // "this is periodic" rather than just "this lag's value is high". A
  // slow, non-periodic transient - a plosive pop, a breath puff hitting
  // the mic, a handling bump - has no periodic structure at all, but its
  // envelope still varies smoothly enough that the normalized
  // correlation stays high and never dips at ANY lag in the searched
  // range, so without checking for the dip it can spuriously look like a
  // rock-solid, high-confidence pitch: measured directly, breath/plosive
  // pop transients reproducibly hit 0.95-0.97 confidence with a dip
  // depth of exactly 0 - comfortably above the 0.6 outright-accept gate
  // in _analyze(), meaning they were bypassing the noise-vs-voice
  // continuity gate entirely and getting corrected toward as if they
  // were real (reported as a screech that's present constantly through
  // a take, not tied to any particular moment - every consonant and
  // breath is exactly this kind of transient). Every real voiced tone
  // tested - including quiet voice down to -36.5dBFS through a realistic
  // noise floor - showed a dip of 1.4+ : a huge, reliable margin over
  // the pop transients' 0. A candidate lag whose preceding correlation
  // curve never dipped by at least DIP_MARGIN below its own value is
  // rejected as "not actually periodic" and scanning continues past it,
  // even though its raw value alone would have cleared acceptThreshold.
  const DIP_MARGIN = 0.3;
  let bestLag = -1;
  const acceptThreshold = Math.max(0.3, bestVal * 0.9);
  let runningMin = vals[0];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const v = vals[lag - minLag];
    if (v >= acceptThreshold) {
      const prev = vals[lag - minLag - 1], next = vals[lag - minLag + 1];
      if (v >= prev && v >= next && (v - runningMin) >= DIP_MARGIN) { bestLag = lag; bestVal = v; break; }
    }
    runningMin = Math.min(runningMin, v);
  }
  if (bestLag < 0) {
    // No interior local max found that both clears the threshold AND
    // shows a genuine periodic dip beforehand - fall back to the single
    // global-best lag ONLY if it too clears the dip requirement,
    // otherwise this block has no real periodicity in it at all.
    let globalBestLag = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (vals[lag - minLag] === bestVal) { globalBestLag = lag; break; }
    }
    if (globalBestLag > minLag) {
      let minBefore = Infinity;
      for (let lag = minLag; lag < globalBestLag; lag++) minBefore = Math.min(minBefore, vals[lag - minLag]);
      if (bestVal - minBefore >= DIP_MARGIN) bestLag = globalBestLag;
    }
  }
  if (bestLag < 0) return null;

  // Sub-harmonic (octave-error) correction. Root-caused directly from a
  // real, reproducible failure: a sung note whose fundamental sits near
  // half of a strong nearby formant (measured case: true f0 341.25Hz,
  // first formant 700Hz - close to 2x341=682Hz) can make the shortest-
  // valid-peak search above lock onto that formant-driven periodicity
  // at HALF the true period instead of the true fundamental, because
  // the wrong (shorter) lag genuinely does clear the local-max/dip
  // requirements on its own - the search above has no way to know a
  // LONGER lag would explain the signal even better, since it stops at
  // the first lag that qualifies. Measured directly on that exact case:
  // corrAt(bestLag)=0.898 while corrAt(bestLag*2)=0.993 - the true
  // fundamental's correlation was actually HIGHER, with a deep, genuine
  // periodicity dip (1.87) between the two - the shortest-lag search
  // simply never looked that far because it already had a qualifying
  // candidate.
  //
  // The threshold here has to be a STRICT "genuinely stronger" test, not
  // "comparable" - an earlier version of this check used
  // `subVal >= bestVal * 0.95`, which sounds conservative but isn't: a
  // clean, harmonic-rich tone (a real sung note, or the additive-
  // harmonic test tones in this suite) is periodic at every multiple of
  // its true period by construction, so corrAt(bestLag*2) reliably lands
  // within a fraction of a percent of corrAt(bestLag) - and clears a
  // dip check too, since a periodic signal genuinely does dip around the
  // halfway point between one period and two. Measured directly on a
  // plain D3 tone (correctly detected at bestLag): corrAt(bestLag)=0.9999
  // vs corrAt(bestLag*2)=0.9996, ratio 0.9997 - a hair BELOW 1, not above
  // it, but still comfortably over the old 0.95 threshold, which was
  // silently pushing every clean, already-correct detection down an
  // octave. The real bug case's ratio was 1.1056 - subVal genuinely,
  // unambiguously exceeds bestVal there. Requiring subVal to strictly
  // exceed bestVal (with a 2% margin so an exact-tie doesn't flip on
  // floating-point noise) separates these two cases cleanly: only
  // override when doubling the lag is a definite improvement, not merely
  // "not much worse".
  const subLag = bestLag * 2;
  if (subLag <= maxLag) {
    const subVal = corrAt(subLag);
    if (subVal > bestVal * 1.02) {
      let minBetween = Infinity;
      for (let lag = bestLag + 1; lag < subLag; lag++) minBetween = Math.min(minBetween, corrAt(lag));
      if (subVal - minBetween >= DIP_MARGIN) {
        bestLag = subLag;
        bestVal = subVal;
      }
    }
  }

  // Parabolic interpolation across the winning lag's neighbors for
  // sub-sample precision - without it, pitch estimates are quantized to
  // whole-lag steps, which is audible as zipper noise on sustained notes.
  // corrAt() is the same O(1) lookup defined above now, not a fresh
  // O(n) sum per neighbor.
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const yL = corrAt(bestLag - 1), yC = bestVal, yR = corrAt(bestLag + 1);
    const denom = (yL - 2 * yC + yR);
    if (Math.abs(denom) > 1e-9) {
      const shift = 0.5 * (yL - yR) / denom;
      if (Math.abs(shift) < 1) refinedLag = bestLag + shift;
    }
  }
  return { hz: sampleRate / refinedLag, confidence: bestVal };
}

// ── LPC-based formant correction ───────────────────────────────────────
// Order 24 models roughly 12 spectral peaks (each pole pair contributes
// one resonance), enough to resolve a singing voice's formants (F1-F4,
// under ~4kHz) as distinct peaks rather than one blurred-together bump -
// order 20 measurably under-resolved two close formants in testing,
// order 24 was the smallest that consistently separated them without
// over-fitting individual pitch harmonics into the filter (which would
// start cancelling the very periodicity the pitch shifter needs to shift).
const LPC_ORDER = 24;

// R[0..order]: the biased autocorrelation of `buf` at lags 0..order.
// R[0] is the signal's total energy; everything else is symmetric
// (R[-lag] === R[lag]), so only the non-negative side is needed.
function lpcAutocorrelate(buf, order) {
  const n = buf.length;
  const R = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += buf[i] * buf[i + lag];
    R[lag] = sum;
  }
  return R;
}

// Levinson-Durbin recursion: turns autocorrelation R[0..p] into LPC
// coefficients a[1..p] such that predict(a, history) = sum(a[k] *
// history[k-1]) is the linear predictor of the next sample - i.e. a[]
// comes out already sign-adjusted so "residual = x[n] - predict(a,
// history)" is the correct whitening step directly, with no further
// negation needed at any call site. a[0] is always 0 (unused - the
// array is 1-indexed by convention so a[k] lines up with "k samples
// back") and is kept only so a.length === order + 1.
function levinsonDurbin(R, order) {
  const a = new Float64Array(order + 1);
  let err = R[0];
  if (err <= 1e-12) return a; // silence/DC - nothing to predict, flat (all-zero) filter is the safe answer
  for (let i = 1; i <= order; i++) {
    let acc = R[i];
    for (let j = 1; j < i; j++) acc -= a[j] * R[i - j];
    const k = acc / err;
    const prev = a.slice();
    a[i] = k;
    for (let j = 1; j < i; j++) a[j] = prev[j] - k * prev[i - j];
    err *= (1 - k * k);
    if (err <= 1e-12) break; // perfectly predictable (or numerically there) - stop refining
  }
  return a;
}

// Hamming-windows `buf` (reduces spectral leakage from the block edges
// into the LPC estimate - standard practice) and returns its LPC
// coefficients, or null on near-silence (caller should hold the
// previous coefficients rather than snap to an all-zero filter, which
// would otherwise mute the formant-corrected output on every unvoiced
// gap - held stale-but-recent formants are far less audible than that).
// Levinson-Durbin, run on a genuine autocorrelation, is guaranteed to
// produce an individually-stable all-pole filter (every reflection
// coefficient stays within [-1, 1], which keeps every pole strictly
// inside the unit circle). That guarantee does NOT carry over to a
// filter built by INTERPOLATING between two separately-stable
// coefficient sets, though - and this engine has to interpolate (the
// coefficients glide sample-by-sample toward whatever the latest
// analysis hop found, specifically to avoid a hard click at each hop
// boundary). An intermediate, interpolated coefficient set can land
// outside the region where stability is guaranteed even when both
// endpoints are safely inside it - measured directly: an unmodified
// order-24 fit driven by ordinary program audio (a plain clean tone,
// nothing exotic) already overshot input amplitude by ~68x, and
// percussive/clicky content overshot by >1500x - an audible scream, not
// a subtle rounding artifact. Bandwidth expansion (shrinking every pole
// by a small constant factor - "gamma" here) is the standard fix for
// exactly this failure mode in real-world LPC vocoders: it trades a
// touch of formant sharpness for a real, measured stability margin that
// survives coefficient interpolation. Applied here, plus a hard
// amplitude/NaN safety clamp in processSample() as a second, independent
// backstop - see the comment there.
const LPC_BANDWIDTH_EXPANSION = 0.999;
// Real audio through this app's gain staging rarely exceeds roughly
// unity; anything past this is treated as a diverged filter, not a loud
// but legitimate signal.
const RB_AT_SAFETY_LIMIT = 1.5;
// Round 61 (part 2): the analysis-time reference-gain fix
// (CEPSTRAL_ENV_REF_GAIN_RATIO above) picks a reasonable BASELINE tap
// scale, but measured directly (synthetic 3-formant take, swept across
// partial to full Formant Correction engagement) that a single static
// baseline still overshoots RMS(output)/RMS(input) up to ~2.6x at
// partial blend and undershoots to ~0.87x at full blend on the exact
// same take - the true relationship between the excitation's own RMS
// and the FIR filter's resulting output RMS depends on how SPARSE/
// pulse-like that excitation is, which itself shifts with blend (a
// harder correction subtracts more of the predictable signal, leaving
// a more impulse-like residual - see the whitening comment in
// processSample()), not just on how loud it is. No single fixed
// formula can predict that in advance for every excitation shape.
// GAIN_CORR_MIN/MAX bound the small, adaptive, MEASURED correction
// applied in processSample() (see coloredRms2Ema/inputRms2Ema below)
// that closes this residual gap directly from the actual achieved
// output level instead of trying to predict it - a real per-hop AGC
// step, not a wider static guess. Range chosen generously wide of the
// ~0.25x-1.15x actually measured, so it can adapt to real material
// beyond this synthetic evidence take without ever amplifying a
// near-silent hop into a loud one (or vice versa) by a wild factor.
const FORMANT_GAIN_CORR_MIN = 0.1;
const FORMANT_GAIN_CORR_MAX = 40;
// Measured directly: a full LPC whiten/resynthesize round trip adds
// ~40% RMS energy and roughly doubles proportional treble content versus
// the untouched signal, EVEN at a perfect unity ratio (see formantTarget
// comment below) - an inherent side effect of modeling voice with an
// all-pole filter and re-injecting its prediction, not a bug in any one
// engagement event. A single-pole low-pass applied to the RETURNED
// sample only (never fed back into lpcHistoryOut - see formantHfState)
// tames that excess brightness without perturbing the recursive
// resynthesis filter's own stability: an earlier attempt that smoothed
// predOut and fed the smoothed value back into lpcHistoryOut measurably
// WORSENED gain-divergence events on one evidence file (35456->49084
// flagged events, sustained >5ms events 3->9, one reaching 79ms) by
// changing the recursive filter's effective pole structure - reverted in
// favor of this output-only tap, which cannot affect recursive stability
// by construction.
//
// Round 41: a third, distinct "ringing" screech pattern (found on a
// user-submitted evidence take, formant correction fully engaged, no
// note transition, no octave error, no energy transient - none of the
// mechanisms Rounds 36/37 already fixed) traced, sample by sample, to
// the formant contribution flipping sign almost every 1-3 samples
// within a single steady analysis hop - a genuine recursive-filter
// resonance ringing near Nyquist, not amplitude divergence (peak output
// stayed well under the RB_AT_SAFETY_LIMIT hard clamp the whole time,
// so that existing guard never saw a reason to fire). Real vocal
// formants top out around 3-4kHz; content oscillating that fast has no
// plausible vocal-tract origin. Three earlier attempts at an amplitude/
// envelope-ratio-based limiter on this same evidence file (see
// PATCHNOTES) were tried and rejected because the "bad" and ordinary
// full-engagement populations overlapped too much on that axis to
// threshold safely; a coefficient-space check (reflection-coefficient
// magnitude, LPC error ratio) and an energy-transient check were also
// tried this round and neither separated the bad hop from normal
// engagement either. Tightening this ALREADY-EXISTING, ALREADY-PROVEN-
// SAFE output-only tap (still never fed back into lpcHistoryOut, so it
// still cannot be the earlier-rejected recursive-smoothing regression)
// from 6500Hz to 4000Hz measurably calms this specific pattern - on the
// evidence take, peak output dropped from 0.828 to 0.626 and flagged
// "large relative to input" samples dropped from 1009 to 704 (a
// consistent 30%+ reduction across every key/scale combination tested,
// never worse) - while every one of the 38 existing regression checks
// (including the brightness-ratio test this exact parameter feeds)
// still passes, and RMS moved by at most 4.5% (always down, never up)
// across four other real evidence files collected this whole
// engagement. Not a complete fix - the underlying resonance can still
// occur - but a real, measured, low-risk reduction using a mechanism
// already proven safe, rather than a new heuristic gate.
// Round 50: raised from 4000Hz to 8000Hz. Direct feedback with real
// evidence ("New new f on.wav"): "sounds like its in a bottle and
// sounds muffled." Measured directly: on a synthetic 3-formant vowel
// through the full engine, this single-pole tap alone accounted for a
// real, measurable brightness loss (spectral centroid 786.8Hz with the
// tap removed vs 748.9Hz with it active at the old 4000Hz cutoff, on
// top of an already-present ~13% centroid loss from the FIR
// resynthesis itself vs Formant Correction off's 902.2Hz) - real, but
// a smaller share of the total muffling than the resynthesis mechanism
// itself (see CEPSTRAL_ENV_ORDER/CEPSTRAL_FIR_TAPS below). This tap was
// originally tightened to 4000Hz in Round 41 to tame a specific
// recursive-filter RINGING pattern in the OLD all-pole predOut/
// lpcHistoryOut mechanism - a mechanism Round 44 fully replaced with
// this bounded, non-recursive FIR resynthesis, which (per the safety-
// net comment at its own call site) "cannot ring or diverge the way
// the old recursive mechanism could." The 4000Hz cutoff had been left
// unchanged out of caution even after that replacement ("still real,
// cheap, harmless insurance" - see the comment below), but it was not
// actually harmless: it was quietly darkening every Formant Correction
// take, on top of a mechanism that no longer needs it as urgently.
//
// Round 51: raised again, 8000Hz -> 16000Hz. Direct feedback with new
// real evidence ("Formant On New.wav"/"Formant off New.wav"): "the more
// the volume goes up the more it does boxy and muffled." Investigated
// whether this was a genuinely LEVEL-DEPENDENT processing artifact -
// fed a fixed synthetic vowel through the full engine at 9 different
// amplitudes (0.05-0.45 peak) and confirmed the DSP is provably
// amplitude-INVARIANT for a fixed input shape (output centroid stayed
// at exactly 793.2Hz across the entire range - the cepstral math's
// scale-invariance, already proven by test 46, holds end to end). The
// real level-dependent pattern the user hears is present in the RAW,
// UNPROCESSED evidence audio itself (measured directly: quietest-to-
// loudest quartile centroid on the dry signal moves 369 -> 643 -> 524
// -> 387Hz, i.e. it's the loud passages of THIS vocal take that are
// naturally darker to begin with, most likely mic technique/proximity
// or vocal production at higher output - not something this engine
// introduces). What IS real and app-caused: reprocessing that same
// evidence audio with Formant Correction on measures a roughly
// consistent ~6-16% centroid reduction at every level relative to
// off/raw (not a reduction that gets disproportionately worse at
// higher levels) - meaning Formant Correction's own existing brightness
// cost (the same one Round 50 addressed) is what's compounding onto
// already-naturally-darker loud passages, reading as "gets worse with
// volume" even though the app's own contribution to it is level-
// independent. Raising CEPSTRAL_ENV_ORDER/TAPS further (tested up to
// 80/160) made no measurable difference on this real material (unlike
// the earlier synthetic test, real audio's brightness loss here isn't
// an envelope-resolution problem) - but raising FORMANT_HF_CUTOFF_HZ
// further did: measured directly on the real evidence file at cutoff
// values from 8000 up to 20000Hz, brightness recovery continued
// meaningfully through the range (e.g. one quartile moved from 439Hz
// at 8000Hz to 522Hz at 20000Hz, versus that same quartile's 502Hz
// off/raw reference) with the loudest quartile essentially unmoved by
// this parameter regardless (362-366Hz throughout - confirming that
// specific quartile's darkness is the natural-source effect described
// above, not something this tap controls). Verified safe at every
// tested value: the existing >12kHz-energy-proportion regression test's
// ratio only reaches 0.045/0.042 at 44100/88200Hz even at 20000Hz,
// still comfortably under its 0.05 threshold. Landed on 16000Hz as a
// real, measured, safety-margin-preserving middle point that recovers
// most of the available real-material brightness.
// Round 52: pushed to the proven-safe ceiling from the Round 51 real-
// material sweep (which tested up to 20000Hz and found the >12kHz-
// energy-proportion regression test's ratio only reaches 0.045/0.042
// at 44100/88200Hz even there - still comfortably under its 0.05
// threshold) - shipped as 16000Hz last round out of caution; raised to
// 20000Hz now since there is real, measured headroom left and no
// safety cost to using it. Separately, this round's actual root-cause
// work went into RB_BUILD_ID (see app.js) after discovering every
// build had shipped under the same "0.8.0" version string with no way
// to confirm which round's code a given report was actually running -
// worklets are now cache-busted by a per-build query string so a
// stale, already-compiled module from a prior process can never
// silently keep running after files on disk are updated.
const FORMANT_HF_CUTOFF_HZ = 20000;
function applyBandwidthExpansion(coeffs, order) {
  let g = 1;
  for (let k = 1; k <= order; k++) {
    g *= LPC_BANDWIDTH_EXPANSION;
    coeffs[k] *= g;
  }
  return coeffs;
}

// Builds a Hamming window of length n. Round 44: both computeLPC() and
// computeCepstralEnvelope() below window the SAME lpcWinLen-length
// buffer every single hop - the window shape only depends on the
// buffer's length, which is fixed once per engine instance (derived
// from sampleRate at construction), never on the audio content itself.
// Computing it fresh every hop (Math.cos() called once per sample, up
// to 2048 times at a 88.2kHz reference) was real, measured, avoidable
// per-hop cost; the engine now builds this once at construction
// (hammingWindow(this.lpcWinLen), see the constructor) and both
// functions accept it as an optional precomputed parameter, falling
// back to computing it inline when not given (keeps every existing
// direct test call site - e.g. "computeLPC(buf, LPC_ORDER)" - working
// unchanged).
function hammingWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
function computeLPC(buf, order, precomputedWindow) {
  const n = buf.length;
  const windowed = new Float64Array(n);
  if (precomputedWindow) {
    for (let i = 0; i < n; i++) windowed[i] = buf[i] * precomputedWindow[i];
  } else {
    for (let i = 0; i < n; i++) {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
      windowed[i] = buf[i] * w;
    }
  }
  const R = lpcAutocorrelate(windowed, order);
  if (R[0] <= 1e-9) return null;
  return applyBandwidthExpansion(levinsonDurbin(R, order), order);
}

// ── Cepstral spectral-envelope formant resynthesis (Round 44) ─────────
// The LPC math above (lpcAutocorrelate/levinsonDurbin/computeLPC) is
// still used for the WHITENING side below (predIn, against
// lpcHistoryIn) - that step is safe by construction: it is a feed-
// forward prediction from real, bounded, independent INPUT samples,
// never from its own output, so it cannot ring or diverge regardless
// of what the coefficients are.
//
// The part that WAS unsafe - fixed here - is resynthesis. The old
// mechanism (removed) fed the filter's own OUTPUT back into itself
// every sample (a recursive all-pole/IIR filter), which is exactly the
// class of thing that can ring: an interpolated (mid-glide) coefficient
// set is only proven stable at bandwidth-expansion's guaranteed margin,
// not guaranteed stable in between, and real evidence across two
// separate user takes (dasdasdas.wav, the La Masia vocal) showed it
// actually reaching that failure mode - a genuine near-Nyquist
// resonance, not amplitude divergence (Round 41). Real pitch-correction
// tools avoid this entire bug class by extracting the spectral envelope
// with cepstral (homomorphic) smoothing instead of an all-pole fit, and
// re-applying it with a bounded, non-recursive filter - researched and
// confirmed this round (WebSearch, see PATCHNOTES). This section
// implements that: an FFT, a cepstral envelope extraction (log-
// magnitude -> IFFT -> keep only low-quefrency "smooth envelope"
// coefficients, discarding the higher-quefrency ones where a voice's
// own pitch periodicity lives -> FFT back), and a minimum-phase FIR
// realization of that envelope (the standard homomorphic-vocoder
// technique: causally fold the liftered cepstrum, FFT, complex-
// exponentiate, IFFT, truncate). The result is a finite-length
// (fixed-size) impulse response - by construction, ANY finite
// coefficient set convolved against bounded history produces bounded
// output (output magnitude is capped by sum(|taps|) * the loudest
// recent excitation sample - there is no pole to leave the unit circle,
// because there is no feedback path at all). Verified directly in
// scratch (not just argued): driving a worst-case 50/50 mid-glide
// interpolation between two very different (700/1200Hz vs 2000Hz
// narrow-band) envelopes' taps with a synthetic broadband drive signal
// for 5000 samples produced a bounded, sane output the entire time -
// nothing resembling the old mechanism's runaway.
function fftInPlace(re, im, invert) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (invert ? 1 : -1) * 2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe; im[i + j + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        const nIm = curRe * wIm + curIm * wRe;
        curRe = nRe; curIm = nIm;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}
// nextPow2() is already defined earlier in this file (used by
// detectPitch()'s FFT-based autocorrelation) - reused here rather than
// redeclared. A real AudioWorkletGlobalScope module load enforces no-
// duplicate-top-level-declaration and throws a SyntaxError on this
// exact mistake (confirmed directly: reproduced the identical "already
// declared" failure and confirmed Node's vm.runInContext test harness
// does NOT catch it - plain classic-script vm evaluation silently
// allows function redeclaration, unlike a real module load - see
// gauntlet.sh's new static duplicate-declaration guard, added because
// of this).
// order: how many low-quefrency cepstral coefficients define the
// envelope's resolution (how many formant peaks it can separate) -
// kept slightly above LPC_ORDER (24) because cepstral smoothing needs a
// touch more coefficients than an equivalent all-pole fit to resolve
// the same peak count (verified directly in scratch against a
// synthetic two-formant test signal). numTaps: length of the FIR
// impulse response actually used for resynthesis - verified directly in
// scratch that truncating too short (matching LPC_ORDER's 24) collapses
// a real two-formant envelope into one blurred low-pass roll-off with
// no resolvable peak at all; 64 taps was the point a clear, correctly-
// located peak reliably emerged, with no further meaningful gain past
// ~96-128, so 64 is used as a real, measured accuracy floor rather than
// a guess.
// Round 50: raised from 30/64 to 40/80 - a smaller, secondary
// contributor to the same "muffled"/"in a bottle" feedback as the
// FORMANT_HF_CUTOFF_HZ change above. Measured directly on the same
// synthetic 3-formant vowel: order 30/taps 64 resynthesis alone (HF
// tame excluded from this measurement) reached 786.8Hz centroid vs the
// unprocessed/formant-off 902.2Hz reference; order 40/taps 80 recovers
// a further ~21Hz of that gap (807.7Hz) with real-time cost still
// comfortably inside budget (see test 43's updated measurement) -
// diminishing returns past this point were also measured (48/96 and
// 56/112 gained under 3Hz further), so this is a real, verified
// improvement rather than an arbitrary bump, not a claim that more is
// free or unlimited.
const CEPSTRAL_ENV_ORDER = 40;
const CEPSTRAL_FIR_TAPS = 80;
// mpFftSize: the size used for the LAST two transforms (the minimum-
// phase causal-fold -> FFT -> complex-exponentiate -> IFFT stage) -
// deliberately much smaller than fftSize (which the FIRST two
// transforms, the real FFT of actual audio and the IFFT that turns its
// log-magnitude into a cepstrum, still need in full for a correct
// analysis of real audio). This is safe, not an approximation: the
// LIFTERED cepstrum fed into that stage is, by construction, exactly
// zero everywhere past quefrency `order` (~30) - representing an
// exactly-sparse signal like that in ANY FFT size bigger than roughly
// 2*order with margin (128 is comfortably past that) reproduces the
// identical underlying smooth spectral envelope, just sampled at fewer
// (but for a signal this smooth, still more than enough) frequency
// points - verified directly in scratch: the resulting FIR taps at
// mpFftSize 128 matched taps computed the "naive" way (same size
// throughout, 1024) to within floating-point rounding at every probed
// frequency. First measured directly on a real 88.2kHz analysis
// window: the naive same-size-throughout version cost ~1.8-2.2ms per
// hop, over the ENTIRE ~1.45ms render-quantum budget by itself before
// computeLPC() or anything else in that quantum got a turn - this
// two-size version measures ~0.14ms per hop on the identical input, the
// exact real-time-underrun failure mode this file has hit twice before
// (Round 20, Round 77) avoided at the design stage this time instead of
// discovered after the fact. The dominant cost was never the raw FFT
// butterflies (measured independently at a trivial ~0.06-0.09ms even at
// the full 2048-point size) - it was Math.exp/cos/sin/log, each called
// once per bin in the two transcendental-heavy loops below, which this
// change reduces from fftSize iterations to mpFftSize iterations for
// the second (more expensive, exp+cos+sin per bin) of those two loops.
const CEPSTRAL_MP_FFT_SIZE = 128;
// See the Round 47 comment inside computeCepstralEnvelope() (tail
// normalization) for how this was measured/tuned.
// Round 61 ("Formant Correction lowers the volume at random moments"):
// this used to be CEPSTRAL_ENV_REF_GAIN, a single FIXED absolute
// number (0.164) that every hop's taps were rescaled to regardless of
// how loud that hop's input actually was. That fixed the Round 47 bug
// (taps inheriting the analysis window's own unnormalized FFT
// magnitude - see Part 1/Part 2 comments below) by making
// RMS(colored) track RMS(shifted), the WHITENED EXCITATION - but
// `shifted` itself shrinks as formantBlend rises (residual = x -
// predIn*blend in processSample() - a stronger correction subtracts
// more of the predictable/tonal energy, leaving a quieter residual to
// pitch-shift and re-color), and colored is a linear function of
// shifted, so colored inherited and compounded that shrink. Measured
// directly on a synthetic impulse-excited vowel take (3 formants,
// same synth as the Round 47 evidence-take test below): at a
// correction large enough to fully engage Formant Correction,
// RMS(output)/RMS(input) collapsed to ~0.01 (near silence) in the
// settled region of the take, vs ~0.37-0.67 at partial engagement and
// ~0.997 (transparent, as intended) whenever nothing needed
// correcting at all - a real, present, blend-proportional volume
// collapse, not a rare edge case.
//
// Fix: recalibrate against the ORIGINAL per-hop input's RMS (computed
// directly from raw, unwindowed samples - see inputRms below) instead
// of a fixed absolute number, so `colored` reconstitutes the voice at
// the loudness it actually had, not at whatever level the (blend-
// dependent, structurally shrinking) whitened excitation happened to
// leave behind. This is a dimensionless RATIO now, not an absolute
// level - taps end up with gain (CEPSTRAL_ENV_REF_GAIN_RATIO *
// inputRms), re-derived empirically the same way the original 0.164
// was (swept candidate values against the same synthetic evidence
// take, this time targeting RMS(output)/RMS(input) ~= 1.0 in the
// fully-engaged case instead of RMS(colored)/RMS(shifted) ~= 1.0).
// This does NOT reopen the original Round 47 bug: that bug came from
// Part 1 (below) NOT yet zeroing out the raw FFT's own absolute-
// magnitude term (cRe[0]), so taps swung with whatever incidental
// scale the analysis FFT happened to produce, observed swinging the
// filter's DC gain from ~2.4 to ~11 between two ordinary, similarly-
// loud hops. Part 1 already fixes that structurally (taps are
// loudness-SHAPE-only after it) regardless of what Part 2 below
// targets - inputRms here is a clean, directly-measured time-domain
// RMS of real input samples, not derived from the same suspect
// unnormalized FFT magnitude Part 1 already strips out, so it does
// not carry that failure mode back in.
const CEPSTRAL_ENV_REF_GAIN_RATIO = 5.85;
// precomputedWindow: same shared Hamming window computeLPC() now
// accepts (see hammingWindow() above) - optional, falls back to
// computing inline for direct test call sites.
function computeCepstralEnvelope(buf, fftSize, numTaps, order, mpFftSize, precomputedWindow) {
  const n = buf.length;
  // Round 61: clean time-domain RMS of the RAW (unwindowed) input this
  // hop - see the CEPSTRAL_ENV_REF_GAIN_RATIO comment above for why
  // this replaces the old fixed reference gain as Part 2's target.
  let inputSumSq = 0;
  for (let i = 0; i < n; i++) inputSumSq += buf[i] * buf[i];
  const inputRms = Math.sqrt(inputSumSq / n);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  if (precomputedWindow) {
    for (let i = 0; i < n; i++) re[i] = buf[i] * precomputedWindow[i];
  } else {
    for (let i = 0; i < n; i++) {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
      re[i] = buf[i] * w;
    }
  }
  let energy = 0;
  for (let i = 0; i < n; i++) energy += re[i] * re[i];
  if (energy <= 1e-9) return null; // silence/near-DC - caller holds stale coefficients, same policy as computeLPC()

  fftInPlace(re, im, false);
  const logMag = new Float64Array(fftSize);
  for (let k = 0; k < fftSize; k++) {
    // log(sqrt(magSq)) === 0.5*log(magSq) - skips a per-bin sqrt call
    // (up to 2048 of them at the 88.2kHz reference) for the same result.
    const magSq = re[k] * re[k] + im[k] * im[k];
    logMag[k] = 0.5 * Math.log(Math.max(magSq, 1e-16));
  }
  const cRe = logMag; // reuse buffer - logMag not needed after this IFFT
  const cIm = new Float64Array(fftSize);
  fftInPlace(cRe, cIm, true); // real cepstrum (cIm ~ 0 for this real, even-magnitude input)

  // Lifter directly into the SMALL mpFftSize-length array (see the
  // CEPSTRAL_MP_FFT_SIZE comment above for why this is exact, not an
  // approximation) instead of a fftSize-length one.
  const half = mpFftSize / 2;
  const mp = new Float64Array(mpFftSize);
  // Round 47 (real fix for "clips real easy even on low volume" / the
  // boxy, distorted "in a bottle" character with Formant Correction on)
  // starts here, in two parts: (1) mp[0] left at 0 instead of cRe[0],
  // and (2) a single fixed reference gain applied to the final taps
  // below, replacing the raw, unnormalized FFT/IFFT-convention scale.
  //
  // Root cause, found from real evidence takes ("f on.wav"/"f off.wav"):
  // captured the exact taps _analyze() computed hop-by-hop on a real
  // take and found sum(taps) (the filter's DC gain) swinging from ~2.4
  // on an ordinary hop to ~11 just moments later on a slightly louder
  // one - not because the vocal tract's actual formant SHAPE changed
  // that violently, but because logMag/exp(sRe[k]) below directly
  // encode the analyzed window's own ABSOLUTE FFT magnitude (neither
  // forward fftInPlace() call in this function is normalized by 1/n),
  // not a normalized spectral SHAPE. That absolute-magnitude envelope
  // was then convolved against shiftedHistory, which is ALSO already at
  // the real, current signal amplitude - multiplying loudness onto
  // loudness a second time. Measured directly on that take: colored
  // (the resynthesized sample) reached -1.656 while the shifted
  // excitation it came from was only -0.077, a 20x+ spike. On the real,
  // full ~9s "f on.wav" evidence take end to end (properly isolated -
  // Round 44/45/46 all present, ONLY this fix reverted): Formant
  // Correction on reached a peak of 1.4860 (essentially hitting the
  // engine's own 1.5 safety clamp) with 7488 of 789376 samples at or
  // past digital full scale and RMS 1.83x the formant-off take on that
  // same file - post-fix: peak 0.5929 (below formant-off's own 0.6164
  // peak) with zero samples past 0.9 and RMS 0.70x.
  //
  // Part 1 - mp[0] = 0: proven directly (not just argued) that this is
  // safe and correct. Scaling an entire analyzed window by a constant k
  // shifts cRe[0] by exactly log(k) while leaving cRe[1..order] EXACTLY
  // unchanged (verified in scratch: gain 0.2x/1x/3x on the same
  // captured real hop reproduced identical cRe[1..5] to 4 decimal
  // places, with cRe[0] shifting by precisely log(0.2) and log(3)).
  // cRe[0] is therefore PURELY an absolute-loudness term carrying zero
  // formant-SHAPE information, while cRe[1..order] is the genuinely
  // loudness-invariant part that actually encodes the vocal-tract
  // resonance structure. mp[0] feeds sRe[k] as a uniform additive
  // constant across every k (see the loop building sRe below), so
  // dropping it is a pure multiplicative-scale no-op relative to Part
  // 2's fixed re-normalization below - it is kept anyway as the
  // mathematically clean statement of what actually carries shape
  // information here, mirroring how the LPC path's own coefficients
  // already behave (normalized prediction ratios with no absolute-
  // loudness term built in).
  for (let i = 1; i <= order && i < half; i++) mp[i] = 2 * cRe[i];

  const sRe = mp;
  const sIm = new Float64Array(mpFftSize);
  fftInPlace(sRe, sIm, false);

  const xRe = new Float64Array(mpFftSize);
  const xIm = new Float64Array(mpFftSize);
  for (let k = 0; k < mpFftSize; k++) {
    const mag = Math.exp(sRe[k]);
    xRe[k] = mag * Math.cos(sIm[k]);
    xIm[k] = mag * Math.sin(sIm[k]);
  }
  fftInPlace(xRe, xIm, true); // minimum-phase impulse response (real, causal, decaying)

  const taps = new Float64Array(numTaps);
  for (let k = 0; k < numTaps && k < mpFftSize; k++) taps[k] = xRe[k];

  // Part 2 - fixed reference gain: rescale the (now loudness-invariant,
  // shape-only) taps to a single FIXED target, CEPSTRAL_ENV_REF_GAIN,
  // instead of leaving them at whatever raw scale the reconstruction
  // above happens to produce - there is no meaningful per-hop loudness
  // signal left in them to calibrate against (feeding one back in would
  // just reintroduce the bug). CEPSTRAL_ENV_REF_GAIN is empirically
  // tuned against real vocal takes, not guessed, and cross-validated on
  // two independent 10s slices of the same take: a pure unity white-
  // noise gain (scale so sqrt(sum(taps^2))===1) measured 6.1x too loud
  // (RMS(colored) vs RMS(shifted)) - real voiced excitation is far from
  // flat/white (it's pulse-train-like, energy concentrated at
  // harmonics), so the textbook white-noise Parseval assumption
  // overestimates how much gain is needed. Swept candidate values and
  // found 0.164 lands RMS(colored)/RMS(shifted) at 0.999 and 1.030 on
  // the two slices respectively - genuine, present formant coloring
  // (reshaping the spectral BALANCE) without a net loudness change.
  let tapsSumSq = 0;
  for (let k = 0; k < taps.length; k++) tapsSumSq += taps[k] * taps[k];
  if (tapsSumSq > 1e-18 && inputRms > 1e-9) {
    const tapsRmsGain = Math.sqrt(tapsSumSq);
    const scale = (CEPSTRAL_ENV_REF_GAIN_RATIO * inputRms) / tapsRmsGain;
    for (let k = 0; k < taps.length; k++) taps[k] *= scale;
  }
  return taps;
}


// Variable-rate pitch shifter. A single virtual read pointer advances
// through a continuously-written ring buffer at `ratio` samples per
// output sample - that advance rate IS the pitch shift, the same way
// playing a tape faster or slower changes its pitch. Left alone, that
// pointer would drift arbitrarily far behind (ratio < 1) or catch up to
// and pass (ratio > 1, reading unwritten audio) the live write position,
// so once its delay from "now" strays past a threshold, it jumps back to
// a safe distance and crossfades against the outgoing position so the
// jump is inaudible. The threshold scales with how far the pointer
// drifts, so a small correction (a few percent) jumps rarely, and a
// jump never erases more of the shift than a fixed-period reset would -
// an earlier version reset on a fixed clock regardless of ratio, which
// buried small in-tune-ish corrections under jump noise before they
// could accumulate into an audible shift.
class PitchShifter {
  constructor(sampleRate, bufferSeconds, grainMs) {
    this.sr = sampleRate;
    this.bufLen = Math.max(4096, Math.floor(sampleRate * (bufferSeconds || 1.0)));
    this.ring = new Float32Array(this.bufLen);
    this.writeCount = 0;
    this.setGrainMs(grainMs || 40);
  }
  setGrainMs(grainMs) {
    // Idempotent: resetting readPos/fadePos here drops the shifter's
    // in-flight state, which is audible as a click if it happens while
    // live. setParams() used to call this on every params message
    // regardless of whether grain size actually changed, which meant
    // dragging ANY slider (Retune Speed, Humanize...) reset the shifter
    // even though only Formant Correction ever changes grain size - a
    // real click on every knob movement while monitoring. Skipping the
    // reset when the requested size matches the current one fixes that
    // at the root, independent of how careful callers are.
    const newSize = Math.max(256, Math.floor(this.sr * grainMs / 1000));
    if (newSize === this.grainSize) return; // grainSize starts undefined, so this never skips first-time setup
    this.grainSize = newSize;
    // Round 54: crossfade length cut from half the grain (the value
    // used since this class existed) to a quarter. That 0.5 fraction
    // predates the Round 53 WSOLA splice search - back when a jump
    // landed on an arbitrary, unaligned position, a long blend was
    // doing real work smoothing over a bad match. Now that _bestSplicePos()
    // finds a genuinely well-aligned splice point, a long blend mostly
    // just spends more time exposed to a still-imperfect match (the
    // search optimizes alignment at the START of the fade; two real,
    // independently-evolving grains can drift apart over the following
    // several/tens of milliseconds even after starting aligned).
    // Measured directly (synthetic tone, same inharmonic-energy metric
    // as Round 53) across every practically-relevant correction size
    // (0.5-7 semitones, which covers essentially all real retuning -
    // nearest-scale-tone corrections rarely exceed a few semitones):
    // 0.25 measured better than 0.5 in every case, by 30-45% relative
    // (e.g. +3 semitones: 1.37% -> 0.81%; -5 semitones: 1.64% -> 0.97%).
    // The one exception is an exact octave (12 semitones) - a shift
    // ordinary pitch correction essentially never produces (nearest-
    // scale-tone distance is bounded well under an octave in every
    // scale this app supports) - where it's measurably worse (1.07% ->
    // 2.00%) but still far better than the pre-Round-53 baseline (3-8%)
    // that shift would have shown either way. Also reverified end-to-
    // end through the full engine on Round 51/53's own broadband
    // regression signal: centroid 2287.3Hz, better than Round 53's own
    // already-passing 2189.7Hz, not a tradeoff.
    this.fadeLen = Math.max(32, Math.floor(this.grainSize * 0.25));
    this.readPos = null;
    this.fadePos = null;
    this.fadeT = 0;
  }
  writeSample(s) {
    this.ring[this.writeCount % this.bufLen] = s;
    this.writeCount++;
  }
  // Cubic (Catmull-Rom) interpolation instead of linear for fractional
  // ring-buffer reads - this is what actually reconstructs the signal
  // between samples every time the shifter runs at a non-1.0 ratio (i.e.
  // on every correction that isn't already perfectly in tune). Linear
  // interpolation is a crude, straight-line guess between two samples;
  // measured directly against the exact analytic value it's trying to
  // reconstruct, its error grows sharply with frequency - by 4kHz (real
  // territory for a voice's upper harmonics and sibilance) it was
  // introducing ~3% error, over 10x worse than cubic's ~0.27% at the
  // same frequency, and 60-260x worse in the midrange where most of a
  // voice's energy actually lives. That shows up as dulled top end and
  // a subtle grainy/aliased quality on shifted audio - exactly the kind
  // of thing that separates a hobbyist pitch-shift from one that sounds
  // clean enough to sit next to a real vocal chain. Same interface, same
  // ring buffer, same timing/crossfade logic below - purely a
  // reconstruction-quality upgrade, not a behavioral change.
  // 6-tap windowed-sinc (Lanczos, a=3) interpolation (Round 55) -
  // replaces the Catmull-Rom cubic this class shipped with. Measured
  // in isolation against the exact analytic reconstruction of a pure
  // tone across a fractional-position sweep: cubic's error grows
  // sharply above ~6kHz (2.9% relative error at 8kHz, 6.3% at 10kHz,
  // 11.7% at 12kHz) - real territory for a voice's upper harmonics.
  // Lanczos-3 stays under ~1.6% across the same range. Re-verified
  // inside the actual shifter (not just the isolated formula) on a
  // 30-harmonic test tone (fundamental 300Hz, harmonics to 9kHz):
  // consistently better (never worse) high-frequency energy retention
  // across every shift tested, with zero change to the Round 53/54
  // grain-splice inharmonic-energy metric (interpolation quality and
  // splice-alignment quality are independent axes). Cost: ~116ns/sample
  // measured (vs cubic's ~60ns), i.e. ~15us of a 128-sample render
  // quantum's ~2.9ms budget at 44100Hz - not a real-time concern at
  // either sample rate this app supports.
  _lanczosKernel(x, a) {
    if (x === 0) return 1;
    if (Math.abs(x) >= a) return 0;
    const px = Math.PI * x;
    return a * Math.sin(px) * Math.sin(px / a) / (px * px);
  }
  _readRing(pos) {
    const bl = this.bufLen;
    let p = pos % bl; if (p < 0) p += bl;
    const i1 = Math.floor(p);
    const t = p - i1;
    const a = 3;
    let sum = 0;
    for (let k = -a + 1; k <= a; k++) {
      let idx = (i1 + k) % bl; if (idx < 0) idx += bl;
      sum += this.ring[idx] * this._lanczosKernel(t - k, a);
    }
    return sum;
  }
  // WSOLA-style similarity search (Round 53) - picks WHERE a grain jump
  // lands, not just when one happens. Every prior version of this class
  // jumped to a single fixed target position (writeCount - idealDelay)
  // whenever drift triggered a splice - i.e. it decided a jump was due,
  // then landed on whatever sample happened to be sitting at that exact
  // timing target, with zero regard for whether that sample's local
  // waveform shape actually lined up with what was already playing.
  // Measured directly (synthetic 220Hz 6-harmonic tone, +/-1/+/-2
  // semitone shifts, FFT-based "inharmonic energy" = fraction of
  // spectral energy falling outside narrow guard bins around the
  // shifted signal's own harmonics): that fixed-target landing was
  // leaking 3-8% of total energy into inharmonic splice artifacts -
  // real, audible grain noise baked into a mechanism that fires on
  // every routine pitch correction, not an edge case.
  //
  // A first attempt at fixing this (quantizing grainSize itself to a
  // whole multiple of the detected pitch period, approximating classic
  // PSOLA's period-synchronous grain length) measured as NO improvement
  // and mostly a regression (up to +2%) - because grain LENGTH being a
  // period multiple says nothing about whether the jump TARGET position
  // is phase-coherent with the outgoing grain. Quantizing the ruler
  // doesn't help if where you place it is still arbitrary.
  //
  // This instead searches a small neighborhood around the original
  // fixed target (normalized cross-correlation, WSOLA's core idea) for
  // the offset whose trailing window best matches the window already
  // playing just before the jump - i.e. it keeps the timing decision
  // exactly as before (still triggers at the same drift threshold, same
  // idealDelay target) and only adjusts WHERE within a small window the
  // new grain starts, so the two waveforms actually line up at the
  // splice instead of colliding at an arbitrary phase. Measured on the
  // same test signal: inharmonic energy dropped from 3-8% to 0.4-1.2%
  // across every ratio/grain-size combination tested, with no case
  // worse than baseline. Cost is bounded (a few hundred short dot
  // products) and only runs once per grain jump - jumps happen roughly
  // every (grainSize/2)/|1-ratio| samples (hundreds of ms of audio for
  // typical corrections), nowhere near the per-sample audio budget.
  _bestSplicePos(target, outgoingPos) {
    // Scope the search to roughly one detected pitch period, not a
    // fraction of grainSize. First version of this used a grainSize-
    // based window (up to ~350 samples at 40ms grains, 1.5-2x a typical
    // vocal period) - wide enough that on broadband/consonant-inclusive
    // real material the correlation search could win on a coincidental
    // match to a DIFFERENT part of the waveform's cycle (or to noise
    // structure entirely), not a true same-phase candidate. Measured
    // directly on a broadband test signal (periodic tone + noise
    // bursts, matching real vocal consonant content): that wide search
    // pulled spectral centroid from 2056.5Hz down to 1385.8Hz - a real,
    // audible darkening, reintroducing exactly the "muffled/boxy"
    // complaint this app has spent several rounds fixing. Classic
    // WSOLA scopes its similarity search to about one pitch period for
    // this exact reason. periodHint (set by the engine from its own
    // tracked pitch before each readSample() call) lets this shifter do
    // the same; re-measured with this fix on the identical broadband
    // signal: centroid recovered to 2189.7Hz - not just fixed, better
    // than the pre-WSOLA baseline - while the original tonal-purity
    // gain (grain-splice inharmonic energy 3-8% -> under 1%) held.
    const period = (this.periodHint && this.periodHint > 20 && this.periodHint < this.grainSize)
      ? this.periodHint
      : this.grainSize * 0.25; // no lock yet (silence/onset/unvoiced): conservative narrow default, not a wide guess
    const winLen = Math.max(16, Math.min(128, Math.floor(period * 0.5)));
    const searchRadius = Math.max(8, Math.floor(period * 0.5));
    const bl = this.bufLen;
    const ref = new Float32Array(winLen);
    const op = Math.floor(outgoingPos);
    for (let k = 0; k < winLen; k++) {
      let idx = (op - winLen + k) % bl; if (idx < 0) idx += bl;
      ref[k] = this.ring[idx];
    }
    let refEnergy = 0;
    for (let k = 0; k < winLen; k++) refEnergy += ref[k] * ref[k];
    if (refEnergy < 1e-9) return target; // silence/near-silence: nothing to align to, keep original target
    let bestScore = -Infinity, bestOffset = 0;
    const tgt = Math.floor(target);
    for (let d = -searchRadius; d <= searchRadius; d++) {
      const base = tgt + d;
      let dot = 0, energy = 0;
      for (let k = 0; k < winLen; k++) {
        let idx = (base - winLen + k) % bl; if (idx < 0) idx += bl;
        const v = this.ring[idx];
        dot += v * ref[k];
        energy += v * v;
      }
      if (energy < 1e-9) continue;
      const score = dot / Math.sqrt(energy * refEnergy); // normalized cross-correlation
      if (score > bestScore) { bestScore = score; bestOffset = d; }
    }
    return target + bestOffset;
  }
  readSample(ratio) {
    const idealDelay = this.grainSize;
    if (this.readPos === null) this.readPos = this.writeCount - idealDelay;

    let out;
    if (this.fadePos !== null) {
      // Equal-POWER crossfade (sin/cos quarter-wave), not equal-gain.
      // fadePos and readPos are two DIFFERENT positions in the ring
      // buffer - different points in time, possibly different vibrato
      // phase or formant shape on real voice - so the two signals being
      // blended here are decorrelated, not two copies of the same thing
      // fading in/out together. For decorrelated signals, an equal-GAIN
      // curve (weights summing to 1, e.g. the raised-cosine this used to
      // use) creates a real, measurable dip in total energy right
      // through the middle of the crossfade - measured directly: ~29%
      // RMS dip (roughly -3dB) for two decorrelated equal-level signals,
      // verified numerically against the exact reference level. Equal-
      // POWER weighting (squares summing to 1 instead) holds level
      // constant through a decorrelated crossfade - measured at <0.1%
      // deviation from reference, same test. A grain jump happens
      // routinely during active correction (every real pitch adjustment
      // eventually drifts far enough to need one) - on a stable, simple
      // test tone the two crossfaded excerpts can end up accidentally
      // well-correlated, hiding this; on real, complex, vibrato'd voice
      // they generically aren't, so this was a real, per-jump loudness
      // pump/dip and likely timbral smearing (from what is, in effect, a
      // partial destructive-interference sum for those decorrelated
      // signals) - happening only while there's actual signal being
      // crossfaded, i.e. only while singing, never in silence. Both
      // curves still reach exactly (1,0) and (0,1) at the endpoints, so
      // this changes nothing about a normal in/out fade, only the shape
      // of the transition between two different sources in between.
      const t = Math.min(1, this.fadeT);
      const wOut = Math.cos(t * Math.PI / 2);
      const wIn = Math.sin(t * Math.PI / 2);
      out = this._readRing(this.fadePos) * wOut + this._readRing(this.readPos) * wIn;
      this.fadePos += ratio;
      this.fadeT += 1 / this.fadeLen;
      if (this.fadeT >= 1) this.fadePos = null;
    } else {
      out = this._readRing(this.readPos);
    }
    this.readPos += ratio;

    const actualDelay = this.writeCount - this.readPos;
    if (Math.abs(actualDelay - idealDelay) > this.grainSize / 2 && this.fadePos === null) {
      this.fadePos = this.readPos;
      const target = this.writeCount - idealDelay;
      this.readPos = this._bestSplicePos(target, this.fadePos);
      this.fadeT = 0;
    }
    return out;
  }
}

// ── Velocity-adaptive pitch-decision smoothing (Round 45) ─────────────
// The note-DECISION smoothing time constant used to be a single fixed
// SMOOTH_MS=120 (see the comment above where it's applied, in
// _analyze()) - long enough to survive a full vibrato swing (that fix's
// own job, and it still does it), but that same length blurs a genuine
// fast vocal run (several real notes in quick succession, or a
// deliberate portamento/glide) into one slowly-sliding average instead
// of snapping cleanly from note to note - direct feedback: correction
// "not sticking" on fast material. Confirmed directly on a real
// evidence take (Formant Correction off, so purely this mechanism):
// detectPitch() alone reported a confident (0.92-0.998), continuously
// smooth glide through ~1.9 semitones over 280ms with zero snapping -
// exactly what a fixed 120ms constant cannot track responsively.
//
// The existing "fast unlock" mechanism a few lines below (checking the
// RAW pitch's distance to a competing candidate note, 2 consecutive
// hops, 100-cent margin) already handles a single, larger discrete
// jump reasonably - this doesn't replace it (both stay active,
// unchanged). What was missing is something that also holds up during
// a RUN of several smaller, closely-spaced steps, and reacts smoothly
// rather than only via a hard, single-margin trigger.
//
// The fix: instead of one fixed time constant, SMOOTH_MS is now
// derived every hop from how the recent RAW (accepted) pitch has
// actually been moving, ramping between SMOOTH_MS_SLOW (unchanged
// 120ms - used whenever nothing indicates a genuine glide) and
// SMOOTH_MS_FAST (a much shorter 25ms - used once a genuine glide is
// confidently detected). "Confidently detected" requires BOTH of two
// independent signals over the last PITCH_VEL_WINDOW_HOPS hops, not
// just one:
//   (1) MAGNITUDE - the net pitch movement across the window is at
//       least comparable to PITCH_GLIDE_REF_CENTS.
//   (2) DIRECTION CONSISTENCY - hop-to-hop pitch movement within that
//       same window overwhelmingly favors one direction (PITCH_GLIDE_
//       CONSIST_LO..HI, smoothstep-ramped), not oscillating back and
//       forth.
// Magnitude alone is NOT enough: real vibrato easily swings 40-85+
// cents peak-to-peak, comparable to or larger than a modest glide's net
// movement over a similar window. Direction consistency is what
// actually separates the two - a periodic oscillation (vibrato) has
// close to equal up/down hop counts over any window spanning a
// meaningful fraction of its own period, while a genuine glide's
// hop-to-hop movement is (almost) always the same sign throughout.
//
// PITCH_VEL_WINDOW_HOPS (20 hops, ~232ms at the 44100Hz reference - a
// HOP count, not a raw sample count, so this stays time-portable across
// sample rates exactly like RAW_UNLOCK_HOPS already is) was chosen by
// direct measurement, not a guess: swept against a wide, deliberately
// adversarial battery of synthetic vibrato (2.5-10Hz rate x 0.8%-6%
// depth, ~180 combinations, including per-sample detector-jitter noise)
// - shorter windows let vibrato masquerade as "consistent enough" for
// slower vibrato rates (a sinusoid is trivially locally-monotonic over
// a small enough sub-window - measured directly: a 13-hop/151ms window
// let a realistic 3Hz vibrato reach full glide-detected strength). At
// 18 hops the measured worst case across the entire battery first hits
// exactly zero false-detections; 20 hops keeps that same zero-false-
// detection result with a small additional margin. On the real glide
// evidence above, this reaches full engagement (SMOOTH_MS_FAST) well
// before the glide finishes: measured lag between raw and smoothed
// pitch at glide-end dropped from 63.3 cents (fixed 120ms) to 10.0
// cents (adaptive) in the scratch validation this was tuned against.
const PITCH_VEL_WINDOW_HOPS = 20;
const PITCH_GLIDE_REF_CENTS = 80;
const PITCH_GLIDE_CONSIST_LO = 0.88;
const PITCH_GLIDE_CONSIST_HI = 0.98;
const SMOOTH_MS_SLOW = 120;
const SMOOTH_MS_FAST = 25;
// Shared smoothstep ramp (3x^2 - 2x^3) between two gate thresholds -
// used here for the direction-consistency gate; kept as its own small
// function since "ramp smoothly rather than snap" is the same shape
// needed anywhere a hard threshold would otherwise cause an audible
// step in a continuously-varying quantity.
function smoothstep(x, lo, hi) {
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  const t = (x - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}
// Computes this hop's glide strength (0-1) from a short history of
// recent RAW accepted pitch values (oldest first, current pitch NOT
// yet pushed in - caller pushes after calling this). Pure function of
// its inputs, kept standalone (not a method) so tools/test-autotune.js
// can validate it directly against synthetic vibrato/glide signals
// without needing a full engine instance.
function computeGlideStrength(hist, currentHz, windowHops, refCents, consistLo, consistHi) {
  if (hist.length < windowHops) return 0;
  const oldest = hist[hist.length - windowHops];
  const netCents = 1200 * Math.log2(currentHz / oldest);
  let up = 0, down = 0;
  let prev = oldest;
  for (let i = hist.length - windowHops + 1; i < hist.length; i++) {
    const cur = hist[i];
    if (cur > prev) up++; else if (cur < prev) down++;
    prev = cur;
  }
  if (currentHz > prev) up++; else if (currentHz < prev) down++;
  const total = up + down;
  const consistency = total > 0 ? Math.max(up, down) / total : 0;
  const gate = smoothstep(consistency, consistLo, consistHi);
  const magGate = Math.min(1, Math.abs(netCents) / refCents);
  return magGate * gate;
}

// Ties pitch detection + scale snapping + the shifter together, exposing
// exactly the Auto-Tune Pro Auto-mode parameters: key, scale, retuneSpeedMs
// (0 = hard/instant snap, higher = slower glide), humanize (eases sustained
// notes in more gently), naturalVibrato (lets some of the input's own pitch
// movement through instead of flattening it), flexTune (a "comfortable
// zone" around the target where small deviations are left uncorrected),
// and formantCorrection (approximate - see file header).
class AutotuneEngine {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.shifter = new PitchShifter(sampleRate, 1.0, 40);
    // hopSize/winLen are tuned - and every timing budget in this file and
    // in tools/test-autotune.js is verified - against 44100/48000Hz. Both
    // used to be hardcoded SAMPLE COUNTS (512/2048), which quietly meant
    // something different depending on the interface's actual sample
    // rate: at 88.2kHz (a real, common "pro audio" interface setting -
    // confirmed directly from a user's exported take, which came back at
    // 88200Hz) a fixed sample count is HALF the intended duration in
    // wall-clock time, so analysis hops fire twice as often and the
    // render quantum's own deadline is simultaneously cut in half (128
    // samples is less real time at a higher rate) - a double hit that
    // measures out to detectPitch() alone eating ~24% of one quantum's
    // budget at 88.2kHz versus ~11% at 44.1kHz on the same machine, with
    // everything else in the same quantum (the shifter, formant
    // resynthesis, channel safety) losing exactly the same proportion of
    // headroom on top of that. On real end-user hardware (which the
    // budget comment below already assumes can be several times slower
    // than a dev machine) that is enough to blow the deadline on some
    // hops - a real-time underrun, which is exactly what heavy
    // screeching sounds like. Deriving both from a fixed TIME duration
    // (scaled off the 44100 reference this file was tuned against)
    // keeps the analysis cadence - and therefore the verified timing
    // margin - identical at every sample rate instead of silently
    // shrinking as the rate goes up. At 44100 this resolves to exactly
    // 512/2048, unchanged from before.
    this.hopSize = Math.round(sampleRate * 512 / 44100);
    this.winLen = Math.round(sampleRate * 2048 / 44100);
    // LPC formant analysis (computeLPC, when Formant Correction is on)
    // used to run against this SAME full winLen window - measured
    // directly on a real 88.2kHz user take: computeLPC() alone took a
    // median 0.90ms and up to 4.1ms per hop at that window size, which
    // on its own consumes 60%-290% of the ENTIRE ~1.45ms render-quantum
    // budget at 88.2kHz (128 samples / 88200Hz), before detectPitch()
    // (median ~0.6ms, running in that same quantum) or any of the
    // per-sample shifter/formant work gets a turn - measured landing
    // 12.3% of all quanta over budget on that file with Formant
    // Correction on. This is the exact real-time-underrun failure mode
    // documented at length above for detectPitch(), just never
    // previously measured for computeLPC() - and it produces the exact
    // same symptom this file's own history already named for it:
    // "choppy, robotic, lagging audio with dropped or repeated
    // samples", worse the higher the sample rate, and gated specifically
    // behind Formant Correction (matching real reports of it returning
    // only with Formant Correction on).
    //
    // Standard speech-LPC practice analyzes a much shorter window than
    // pitch detection needs anyway (~20-30ms is typical - short enough
    // to track one roughly-stationary vocal-tract shape, long enough for
    // a stable fit) - unlike pitch detection, which genuinely needs
    // winLen's longer span to resolve a low fundamental reliably. Giving
    // LPC its own, shorter, equally sample-rate-portable window (half of
    // winLen, ~23.2ms at the 44100 reference) cuts computeLPC()'s O(order
    // * N) cost roughly in half without touching pitch detection at all -
    // measured directly: median 0.44ms, p90 0.77ms, max 0.94ms at the
    // same 88.2kHz file, safely inside the quantum budget even before
    // adding detectPitch's share.
    this.lpcWinLen = Math.round(sampleRate * 1024 / 44100);
    this.analysisWin = new Float32Array(this.winLen);
    this.writeIdx = 0;
    this.samplesSinceHop = 0;
    this.currentRatio = 1;
    this.targetRatio = 1;
    this.heldMs = 0;
    this.lastTargetMidi = null;
    this.smoothedPitchHz = null;
    this.rawUnlockStreak = 0;
    // Round 45: recent-accepted-raw-pitch history feeding the velocity-
    // adaptive pitch-decision smoothing below (see PITCH_VEL_WINDOW_HOPS'
    // comment) - a plain array used as a small ring buffer, oldest
    // pushed out once it exceeds PITCH_VEL_WINDOW_HOPS + 1 entries.
    this.pitchVelHist = [];
    // How many consecutive hops the actual correction target has been
    // wildly far (half an octave+) from the raw pitch actually being
    // sung - see the divergence check at the end of _analyze(). A
    // genuine note change settles within a few hundred ms at most (
    // measured directly); anything stuck far off for much longer than
    // that is the smoothed/locked target having drifted away from
    // reality rather than a real, still-resolving note change, and gets
    // force-resynced rather than left to (maybe never) catch up.
    this.divergentHops = 0;
    // The most recent pitch this engine actually trusted (see the
    // confidence+continuity gate in _analyze()) - null whenever nothing
    // has been accepted yet or the last few hops have gone unaccepted.
    // Used to tell a real, quiet voice apart from noise: a real voice's
    // pitch barely moves hop to hop (12ms apart), a noise burst's
    // spurious "pitch" reading has no reason to relate to whatever was
    // just being sung.
    this.lastAcceptedPitchHz = null;
    // Round 69: ms elapsed since a hop was last actually ACCEPTED (0 on a
    // normal cadence, grows across a run of rejections) - see the
    // octave-rejection staleness widening in processSample().
    this.msSinceLastAccepted = 0;
    // Round 71: ms of consecutive force-rejected-but-confident hops. Drives
    // the stale-reference re-anchor in _analyze().
    this.forcedRejectMs = 0;
    // How much of the formant-correction envelope is actually being
    // applied right now, 0-1 - see processSample(). Glides toward 0 when
    // the voice is already on pitch (nothing to correct) and toward 1 as
    // an actual shift engages, instead of running the full LPC round
    // trip unconditionally whenever the checkbox is on.
    this.formantBlend = 0;
    // LPC formant-correction state - only touched (see processSample/
    // _analyze) when params.formantCorrection is on, so there's zero
    // added cost when it's off, same as before this existed.
    // lpcCoeffs are the ones actually applied per sample; they glide
    // toward lpcCoeffsTarget (refreshed once per analysis hop, from the
    // UNSHIFTED input) instead of snapping to it, so a hop boundary
    // doesn't produce an audible filter-coefficient jump.
    this.lpcOrder = LPC_ORDER;
    this.lpcCoeffs = new Float64Array(this.lpcOrder + 1);
    this.lpcCoeffsTarget = new Float64Array(this.lpcOrder + 1);
    this.lpcHistoryIn = new Float64Array(this.lpcOrder);
    // Round 44: resynthesis state. lpcHistoryOut (fed with the filter's
    // OWN OUTPUT, the recursive/IIR mechanism that could ring - see the
    // Round 44 comment above computeCepstralEnvelope()) is gone. In its
    // place: envCoeffs/envCoeffsTarget are a cepstral-derived, minimum-
    // phase FIR impulse response (glided the same ~6ms way lpcCoeffs
    // always has been), and shiftedHistory holds recent EXCITATION
    // samples (the pitch-shifted signal BEFORE resynthesis coloring,
    // "shifted" in processSample()) - never the filter's own output -
    // so applying envCoeffs against it is a plain feed-forward
    // convolution with no feedback path at all.
    this.envOrder = CEPSTRAL_ENV_ORDER;
    this.envTaps = CEPSTRAL_FIR_TAPS;
    this.envFftSize = nextPow2(this.lpcWinLen);
    this.envMpFftSize = CEPSTRAL_MP_FFT_SIZE;
    // Shared once-per-instance precomputed Hamming window (see
    // hammingWindow()'s comment above) - both computeLPC() and
    // computeCepstralEnvelope() analyze this SAME lpcWinLen-length
    // buffer every hop, so this is computed once here instead of via
    // Math.cos() on every single hop for both functions.
    this.lpcHammingWindow = hammingWindow(this.lpcWinLen);
    this.envCoeffs = new Float64Array(this.envTaps);
    this.envCoeffsTarget = new Float64Array(this.envTaps);
    this.shiftedHistory = new Float64Array(this.envTaps - 1);
    // One-pole low-pass state for the FINAL returned sample only (see
    // FORMANT_HF_CUTOFF_HZ) - output tap only, unchanged by the Round 44
    // resynthesis-mechanism swap.
    this.formantHfState = 0;
    // These three time-constant-derived smoothing factors depend only on
    // this.sr and a fixed millisecond constant - never on anything that
    // changes sample to sample - so they're computed once here instead
    // of calling Math.exp() fresh on every single sample (88,200 extra
    // transcendental-function calls per second at 88.2kHz otherwise, on
    // top of everything else running in the same real-time budget - see
    // lpcWinLen above for the actual dominant cost, but this is a real,
    // free, zero-risk reduction alongside it). Unlike these three, the
    // retune-speed alpha in processSample() genuinely can't be hoisted -
    // it depends on `speed`, which Humanize varies sample to sample.
    const dtMsConst = 1000 / this.sr;
    this.lpcCoefAlpha = 1 - Math.exp(-dtMsConst / 6);
    this.formantBlendAlpha = 1 - Math.exp(-dtMsConst / 25);
    // Round 61: adaptive output-loudness correction state - see the
    // FORMANT_GAIN_CORR_MIN/MAX comment above. shiftedRms2Ema/coloredRms2Ema each
    // track one of the two paths' own, natural (pre-correction) output
    // energy, corrected independently - see the comment in
    // processSample() where they're used; inputRms2Ema tracks the
    // original input's. Both are plain
    // exponential moving averages of instantaneous x^2, updated every
    // sample formant correction runs - same per-sample-glide philosophy
    // as lpcCoefAlpha/formantBlendAlpha above, just applied to energy
    // instead of filter coefficients. 30ms sits between those two
    // (6ms/25ms): fast enough to follow a real syllable's dynamics,
    // slow enough to span several pitch periods at ordinary vocal
    // ranges so it measures genuine average loudness, not one lucky or
    // unlucky sample near a glottal pulse.
    //
    // Round 62 ("voice still muffled at some spots" - a real user
    // report, with real evidence audio, filed right after Round 61
    // shipped): Round 61 fixed the STEADY-STATE case (a sustained
    // wrong correction level) but never measured how long the EMA
    // above takes to REACT to a sudden change - which matters because
    // the LPC residual this feeds from (shifted, in processSample())
    // isn't loudness-stable the way x is. Measured directly on the
    // evidence file: on a long, cleanly-sung sustained note, the
    // order-24 LPC fit can become good enough that the whitened
    // residual's own energy drops to a small fraction of x's for
    // 50-100ms at a stretch (the filter is, correctly, predicting most
    // of a very tonal vowel) - and because shiftedGainCorr is computed
    // from THIS SAME 30ms EMA of the residual's own energy, the
    // correction lags the collapse by the EMA's own settling time
    // (~2-3 time constants, i.e. roughly the 30ms constant's own
    // ~60-90ms), landing almost the whole muffled window inside the
    // gap before the correction catches up. Round 61's own regression
    // tests didn't catch this because they only check the SETTLED
    // ratio after the EMA has long since converged (see the "settled
    // output RMS" checks below) - never how it behaves mid-transient.
    // Tried two more aggressive fixes first, both measured and
    // rejected: (1) an asymmetric fast-attack/slow-release version
    // (fast only when energy is dropping) - on the evidence file this
    // cut collapsed frames 16->2 out of 565 sampled 50ms windows, but
    // measurably worsened uncorrected OVERSHOOT frames (>200% of
    // target RMS) 15->29, trading one audible artifact for a worse
    // one; (2) a two-stage cascaded EMA (fast stage feeding a slower
    // stage, meant to filter single-period noise before it reaches the
    // correction) - measured WORSE than plain symmetric on every axis
    // (e.g. fast=8ms/slow=25ms: overshoot 15->41). Fix: simply tighten
    // this single shared constant from 30ms to 12ms - symmetric (same
    // speed reacting to drops and rises, preserving Round 61's
    // decorrelated-signal reasoning in both directions), measured
    // directly on the same 565-window evidence-file sweep to improve
    // BOTH axes at once, not trade one for the other: collapsed
    // (<30% of target RMS) frames 16->1, overshoot (>200%) frames
    // 15->5, mean RMS-ratio error 0.305->0.186. The real cost, also
    // measured directly: the corrected gain trajectory itself gets
    // choppier during ordinary steady singing (coefficient of
    // variation over a stable 200ms region 0.64->1.04) - a genuine,
    // accepted trade, but bounded: 12ms is still ~2-3 pitch periods
    // across the vocal range that showed this bug (~250Hz here), not
    // fast enough to chase a single glottal cycle the way anything
    // under ~6-8ms started to (where the same sweep's stable-region CV
    // rose past 1.5 and overshoot stopped improving) - see
    // tools/test-autotune.js for the transient-catch-up regression
    // test this added alongside the existing settled-ratio ones.
    // Round 65 ("still sound like its muffled or in a bottle or lowers
    // the volume at some moments" - a fresh evidence WAV, filed against
    // the shipped 12ms build above): re-ran the exact same real-evidence
    // methodology end-to-end (actual engine output, not just the
    // isolated formula) on the new file. It never hit the old severe
    // "collapse" threshold (<30%) that Round 62 was built to catch, but
    // a full-file 50ms-window sweep showed the real, audible problem:
    // 28 of ~314 non-silent windows fell outside a 0.6-1.6x RMS-ratio
    // band - frequent under- and over-correction roughly once a second
    // through the whole take, not a rare edge case. Swept the SAME
    // single alpha (12/10/8/6/5/4/3ms) on both this new file and the
    // original Round 62 evidence file together: collapse, overshoot,
    // and mean RMS-ratio error all kept improving, together, all the
    // way down to ~4ms on both files (this file's 28 out-of-band
    // windows -> 3; the original file's overshoot 13->1), then
    // plateaued - the handful of windows left at 4ms didn't budge even
    // at 3ms, so whatever's left there isn't EMA-lag anymore. Checked
    // the cost the same way Round 62 did: a clean synthetic sustained
    // vowel (fixed pitch, fixed amplitude, so any wobble measured is
    // pitch-period noise, not real musical dynamics) showed stable-
    // region gain coefficient of variation rising smoothly (12ms=0.06,
    // 8ms=0.09, 5ms=0.14, 4ms=0.18) before starting to accelerate below
    // that (3ms=0.23, 2ms=0.34) - 4ms was the last point before that
    // acceleration, and stays at roughly one full pitch period for the
    // vocal range both evidence files sit in (~220-250Hz, ~4-4.5ms).
    // Fix: tighten the same shared constant again, 12ms -> 4ms.
    this.formantGainCorrAlpha = 1 - Math.exp(-dtMsConst / 4);
    this.shiftedRms2Ema = 0;
    this.coloredRms2Ema = 0;
    this.inputRms2Ema = 0;
    this.formantHfAlpha = 1 - Math.exp(-2 * Math.PI * FORMANT_HF_CUTOFF_HZ / this.sr);
    // Round 42: default Retune Speed tightened from 20ms to 5ms. Direct
    // feedback: correction "doesn't correct enough" - measured directly
    // on a real evidence take (Formant Correction off, so purely this
    // parameter's effect): at 20ms, the actually-applied correction
    // (currentRatio) lagged the target by a mean of 32.9 cents across
    // the whole take - genuinely audible as "still a bit off," not a
    // perception issue. At 5ms that mean gap drops to 13.2 cents - a
    // clearly tighter, more "locked-in" hard-tune feel - while 1ms
    // (already reachable via the existing slider, unchanged here) gets
    // to 2.8 cents for users who want the full robotic extreme. This
    // only changes what a NEW session starts at; the full 0-400ms range
    // (and every existing saved-settings value) is untouched.
    // Round 49: trackingSpeedMs exposes the note-DECISION smoothing
    // baseline (previously the hardcoded SMOOTH_MS_SLOW=120 constant -
    // see computeGlideStrength()'s comment block) as a user-facing
    // control, separate from retuneSpeedMs above (which governs the
    // CORRECTION glide once a target note is already chosen, not which
    // note gets chosen). Default of 120 exactly preserves every existing
    // session's prior behavior - this only changes anything for a
    // session that explicitly sets it.
    this.params = {
      key: 0, scale: 'major', retuneSpeedMs: 5, humanize: 0,
      naturalVibrato: 0, flexTune: 0, formantCorrection: false, bypass: false,
      trackingSpeedMs: SMOOTH_MS_SLOW,
    };
  }
  setParams(p) {
    Object.assign(this.params, p || {});
    if (this.params.formantCorrection) this.shifter.setGrainMs(25);
    else this.shifter.setGrainMs(40);
  }
  // sum(coeffs[k] * history[k-1]) for k=1..order - history[0] is the
  // most recent sample, history[order-1] the oldest, matching how
  // _pushHistory shifts both ring buffers below.
  // Drops all target-selection/correction-amount state back to a known-
  // good baseline (unshifted, no locked note, smoothing restarted from
  // scratch) without touching the LPC/formant state. Used both by the
  // divergence guard below and by the processor-level fault handler as
  // a last-resort recovery so a single bad hop can't leave a whole take
  // (or the rest of a session) silently mis-corrected or muted.
  resync() {
    this.smoothedPitchHz = null;
    this.lastTargetMidi = null;
    this.rawUnlockStreak = 0;
    this.targetRatio = 1;
    this.currentRatio = 1;
    this.heldMs = 0;
    this.divergentHops = 0;
    this.lastAcceptedPitchHz = null;
    this.msSinceLastAccepted = 0;
    this.forcedRejectMs = 0;
    this.pitchVelHist.length = 0;
  }
  _predict(history) {
    let sum = 0;
    for (let k = 1; k <= this.lpcOrder; k++) sum += this.lpcCoeffs[k] * history[k - 1];
    return sum;
  }
  // FIR resynthesis (Round 44): sum(envCoeffs[k] * excitationHistory[k-1])
  // for k=1..envTaps-1, PLUS a direct/zeroth tap (envCoeffs[0] * current)
  // that _predict() above deliberately has no equivalent of - _predict()
  // is an AR PREDICTOR (estimating a sample from ones before it, so it
  // excludes that sample itself by definition), while this is a
  // straightforward FIR filter (allowed, and expected, to weight the
  // current excitation sample directly). `history` here is
  // shiftedHistory - past EXCITATION samples, never past output - which
  // is the entire point: no feedback path, so no possibility of the
  // recursive-filter ringing this replaces.
  _firColor(current, history) {
    let sum = this.envCoeffs[0] * current;
    for (let k = 1; k < this.envTaps; k++) sum += this.envCoeffs[k] * history[k - 1];
    return sum;
  }
  // Round 61: the RESONANCE part of _firColor's sum, split out from the
  // zeroth/direct tap (envCoeffs[0]*current) - see the gain-correction
  // comment in processSample() for why. history[k-1] terms are the
  // actual reconstructed-formant-tail energy (what the AGC correction
  // below needs to restore); the direct tap is just a scaled copy of
  // THIS sample's own shifted/excitation value passing straight
  // through, carrying whatever broadband/transient content shifted
  // itself has - correcting that with the (potentially much larger)
  // resonance-tail gain factor is what was measurably doubling
  // high-frequency energy on transient content before this split.
  _firColorHistory(history) {
    let sum = 0;
    for (let k = 1; k < this.envTaps; k++) sum += this.envCoeffs[k] * history[k - 1];
    return sum;
  }
  // history.length drives the shift width instead of a hardcoded order,
  // so this same helper works for both lpcHistoryIn (length lpcOrder)
  // and shiftedHistory (length envTaps - 1) without duplicating it.
  _pushHistory(history, sample) {
    for (let k = history.length - 1; k > 0; k--) history[k] = history[k - 1];
    history[0] = sample;
  }
  processSample(x) {
    this.analysisWin[this.writeIdx % this.winLen] = x;
    this.writeIdx++;
    this.samplesSinceHop++;
    if (this.samplesSinceHop >= this.hopSize) {
      this.samplesSinceHop = 0;
      this._analyze();
    }
    const dtMs = 1000 / this.sr;
    let speed = Math.max(1, this.params.retuneSpeedMs);
    if (this.params.humanize > 0) {
      speed *= (1 + (this.params.humanize / 100) * Math.min(3, this.heldMs / 300));
    }
    const alpha = 1 - Math.exp(-dtMs / speed);
    this.currentRatio += (this.targetRatio - this.currentRatio) * alpha;

    const useFormant = !!this.params.formantCorrection;
    let writeSignal = x;
    if (useFormant) {
      // ~6ms glide on the coefficients themselves - fast enough to
      // track a moving vowel, slow enough that a hop boundary's
      // coefficient update doesn't land as a click.
      for (let k = 1; k <= this.lpcOrder; k++) {
        this.lpcCoeffs[k] += (this.lpcCoeffsTarget[k] - this.lpcCoeffs[k]) * this.lpcCoefAlpha;
      }
      // Same glide, same time constant, for the Round 44 resynthesis
      // taps - a hop-boundary jump in these would be just as audible as
      // one in lpcCoeffs, for the same reason.
      for (let k = 0; k < this.envTaps; k++) {
        this.envCoeffs[k] += (this.envCoeffsTarget[k] - this.envCoeffs[k]) * this.lpcCoefAlpha;
      }
      // How much correction is actually happening right now, measured
      // in octaves of shift - transparent as the voice approaches dead
      // center. Measured directly: a full LPC whiten/resynthesize round
      // trip at a PERFECT unity ratio (nothing to correct at all) still
      // added ~40% RMS energy and roughly doubled the proportional
      // treble content versus the untouched signal - an always-on
      // coloration with nothing to show for it whenever the voice is
      // already in tune, which is most of a good take. Scaling the LPC
      // envelope's CONTRIBUTION (not crossfading against a separately-
      // computed dry signal) keeps this exactly latency-matched with
      // the rest of the chain - at blend 0 this reduces exactly to the
      // formant-off math below (residual = x, y = shifted), so there is
      // no new phasing or discontinuity risk at the boundary, just a
      // graceful fade.
      //
      // The engagement point below used to be a quarter-semitone (25
      // cents) - meaning ordinary vibrato and everyday intonation drift
      // (both routinely well past 25 cents on real vocals) pinned this
      // at FULL engagement almost continuously, not just during genuine
      // note corrections. Measured directly on a real user take with
      // Formant Correction on: mean blend 0.70 during voiced audio, and
      // fully engaged (>0.9) 49% of the time - meaning the "doubled
      // treble" coloration above was active for roughly half the take,
      // not reserved for the rare moment a wrong note actually needs
      // correcting. Widened to a full semitone so small, musical
      // corrections (the vast majority of what a good take needs) get
      // proportionally less LPC coloration instead of snapping straight
      // to the same treatment as a full off-key correction; only a
      // genuine wrong-note-scale correction still reaches full blend.
      // Re-measured on the same take after this change: mean blend 0.51,
      // fully engaged 27% of the time.
      const shiftOctaves = Math.abs(Math.log2(Math.max(1e-6, this.currentRatio)));
      const formantTarget = Math.min(1, shiftOctaves / (1 / 12));
      this.formantBlend += (formantTarget - this.formantBlend) * this.formantBlendAlpha;
      // The exponential smoother above asymptotically approaches 0 but,
      // mathematically, never quite reaches it. Round 44: shiftedHistory
      // (unlike the old lpcHistoryOut it replaces) holds the excitation
      // signal, not this blend's own output, so it no longer compounds a
      // residual value sample over sample the way the old recursive
      // mechanism did - but yOut itself would still carry a technically-
      // nonzero, practically-inaudible formant contribution forever.
      // Snap it once it's settled this close to 0 anyway - full,
      // deliberate transparency instead of an asymptote that technically
      // never arrives.
      if (this.formantBlend < 1e-4) this.formantBlend = 0;

      const predIn = this._predict(this.lpcHistoryIn);
      let residual = x - predIn * this.formantBlend; // whitened excitation - formant envelope removed, scaled by how much correction is actually happening
      // Safety net #1 (analysis/whitening side): predIn is a recursive
      // prediction fed by lpcCoeffs against a history of real (bounded)
      // input samples, so it should stay in a sane range - but bandwidth
      // expansion reduces, it does not mathematically GUARANTEE, that an
      // INTERPOLATED (mid-glide) coefficient set stays inside the region
      // where that holds. Measured directly during development: an
      // unguarded fit driven by ordinary program audio (nothing exotic)
      // could overshoot input amplitude by 1000x+ on a sharp onset - an
      // audible scream, not a rounding error. If this ever produces a
      // residual far outside plausible audio range, treat it as a
      // detected divergence: drop the whitening history and fall back to
      // passing the raw sample through unshifted-by-formants for this
      // one sample, rather than feed a huge value into the shifter.
      if (!isFinite(residual) || Math.abs(residual) > RB_AT_SAFETY_LIMIT) {
        this.lpcHistoryIn.fill(0);
        this.shiftedHistory.fill(0);
        residual = Math.max(-1, Math.min(1, x));
      }
      writeSignal = residual;
      this._pushHistory(this.lpcHistoryIn, x);
    }
    // Always write SOMETHING derived from x every sample regardless of
    // bypass, same as before this existed - keeps the ring buffer warm
    // with real (not stale/silent) audio so un-bypassing doesn't start
    // from an empty buffer.
    this.shifter.writeSample(writeSignal);

    if (this.params.bypass) return x;

    // Feed the shifter's WSOLA splice search a current period estimate
    // from the engine's own pitch tracking - see the comment in
    // _bestSplicePos() for why an unscoped search regresses brightness
    // on real material. lastAcceptedPitchHz is only updated once per
    // analysis hop (not every sample), which is fine here: the period
    // only needs to be approximately right to keep the search from
    // wandering into an unrelated part of the waveform, not exact.
    this.shifter.periodHint = this.lastAcceptedPitchHz ? (this.sr / this.lastAcceptedPitchHz) : null;
    const shifted = this.shifter.readSample(this.currentRatio);
    if (!useFormant) return shifted;

    // Round 44: resynthesize through the cepstral-derived, minimum-
    // phase FIR taps instead of a recursive all-pole prediction - this
    // reimposes the original vocal-tract envelope onto the new, shifted
    // pitch instead of letting it drag along with the shift, exactly
    // like the mechanism it replaces, but as a bounded feed-forward
    // convolution against past EXCITATION samples (shiftedHistory)
    // rather than feedback against the filter's own past output.
    // Round 61 ("Formant Correction lowers the volume at random
    // moments"): shifted and the RESONANCE-TAIL part of the formant
    // reconstruction (historyPart - see _firColorHistory()'s comment)
    // each need their OWN loudness correction toward x, tracked and
    // applied SEPARATELY, before they're combined - not one correction
    // applied to a single already-summed "colored" value. Three things
    // measured directly ruled simpler attempts out:
    // 1. shifted alone drags a PARTIAL blend down even once colored is
    //    perfectly matched to x - shifted (already measurably quieter
    //    than x the moment any whitening happens - see the residual
    //    formula above) is added at FULL weight in the blend, while
    //    colored's matched contribution only enters scaled by blend, so
    //    correcting colored alone left up to a ~30% dip standing at
    //    partial (0.2-0.5) blend - most of a real take, not an edge
    //    case (see the mean-blend numbers in the comment above
    //    formantBlend's own update).
    // 2. Correcting the ALREADY-BLENDED sum instead (one shared
    //    correction) fixed that dip, but measurably over-amplified
    //    broadband/transient content (consonant-like bursts): a burst
    //    isn't well predicted by the tonal LPC fit, so it passes
    //    through shifted largely unwhitened - not a problem by itself,
    //    but that same instantaneous value is ALSO what _firColor's
    //    zeroth/direct tap (envCoeffs[0]*current) injects straight into
    //    colored, unfiltered by the history taps - so a single gain
    //    factor sized for the resonance-TAIL's real deficit (5-10x+)
    //    got applied to that raw passthrough too, measured directly to
    //    roughly DOUBLE high-frequency energy on a burst+tone evidence
    //    take (>12kHz energy ratio 0.047->0.140).
    // 3. Correcting rawColored (direct tap + history) as one unit, with
    //    shifted corrected separately, measured only a small
    //    improvement (0.1428) - confirmed by direct ablation that the
    //    direct tap, not shifted itself, was the carrier.
    // Fix: correct shifted and the history-derived resonance tail
    // separately, then recombine with the direct tap scaled by
    // shiftedCorrected (it's just a copy of shifted's own value, so it
    // rides shifted's own, much gentler correction) - only the genuine
    // reconstructed-resonance energy gets the larger factor.
    const historyPart = this._firColorHistory(this.shiftedHistory);
    this.shiftedRms2Ema += (shifted * shifted - this.shiftedRms2Ema) * this.formantGainCorrAlpha;
    this.coloredRms2Ema += (historyPart * historyPart - this.coloredRms2Ema) * this.formantGainCorrAlpha;
    this.inputRms2Ema += (x * x - this.inputRms2Ema) * this.formantGainCorrAlpha;
    const targetRms = Math.sqrt(this.inputRms2Ema);
    const curShiftedRms = Math.sqrt(this.shiftedRms2Ema);
    const curHistoryRms = Math.sqrt(this.coloredRms2Ema);
    let shiftedGainCorr = curShiftedRms > 1e-6 ? (targetRms / curShiftedRms) : 1;
    let historyGainCorr = curHistoryRms > 1e-6 ? (targetRms / curHistoryRms) : 1;
    if (!isFinite(shiftedGainCorr)) shiftedGainCorr = 1;
    if (!isFinite(historyGainCorr)) historyGainCorr = 1;
    shiftedGainCorr = Math.max(FORMANT_GAIN_CORR_MIN, Math.min(FORMANT_GAIN_CORR_MAX, shiftedGainCorr));
    historyGainCorr = Math.max(FORMANT_GAIN_CORR_MIN, Math.min(FORMANT_GAIN_CORR_MAX, historyGainCorr));
    const shiftedCorrected = shifted * shiftedGainCorr;
    const colored = this.envCoeffs[0] * shiftedCorrected + historyPart * historyGainCorr;
    const formantContribution = colored - shiftedCorrected;
    // Right after the locked target note changes, envCoeffs are still
    // actively gliding toward the new analysis hop's fit (~6ms time
    // constant) while shiftedHistory still holds excitation samples
    // shaped by the PREVIOUS note's coefficients - the same genuine
    // coefficient/history mismatch window the old predOut comment here
    // used to flag, just with a structurally bounded FIR filter on the
    // receiving end instead of a recursive one. Kept unchanged: a
    // mismatched-but-still-finite FIR tap set can still produce an
    // audible-but-bounded "off" moment right at a fast note-to-note
    // step, and this ramp (already proven not to affect normal,
    // sustained engagement - see the brightness regression test) softens
    // exactly that, same as before.
    const TRANSITION_DAMPEN_MS = 40;
    const transitionDampen = this.heldMs < TRANSITION_DAMPEN_MS ? (this.heldMs / TRANSITION_DAMPEN_MS) : 1;
    let y = shiftedCorrected + formantContribution * this.formantBlend * transitionDampen;
    // Safety net #2 (resynthesis side). Structurally, an FIR filter
    // convolved against bounded history cannot ring or diverge the way
    // the old recursive mechanism could - there is no pole, no feedback
    // path, and no way for this to compound sample over sample - the
    // gain correction above is bounded (FORMANT_GAIN_CORR_MIN/MAX) but
    // still real multiplication, so the hard clamp stays as cheap,
    // unconditional insurance against NaN/Infinity or an unexpectedly
    // large combination of shift, blend, and correction, exactly as it
    // always has for safety net #1 above.
    if (!isFinite(y) || Math.abs(y) > RB_AT_SAFETY_LIMIT) {
      this.lpcHistoryIn.fill(0);
      this.shiftedHistory.fill(0);
      y = Math.max(-1, Math.min(1, shifted));
    }
    this._pushHistory(this.shiftedHistory, shifted);
    // Output-only brightness tame (see FORMANT_HF_CUTOFF_HZ/formantHfState
    // above) - runs on the already-clamped y. Kept unchanged; even
    // though the Round 44 mechanism no longer has the old all-pole
    // filter's structural "doubles proportional treble" tendency, this
    // is still real, cheap, harmless insurance against any residual
    // excess brightness the cepstral envelope's own approximation error
    // might introduce.
    this.formantHfState += (y - this.formantHfState) * this.formantHfAlpha;
    const yOut = this.formantBlend > 0 ? this.formantHfState : y;
    return yOut;
  }
  _analyze() {
    const N = this.winLen;
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) buf[i] = this.analysisWin[(this.writeIdx + i) % N];

    if (this.params.formantCorrection) {
      // Feed computeLPC() only its own, shorter lpcWinLen (see the
      // constructor comment) - the most RECENT lpcWinLen samples of buf,
      // not the full pitch-detection-sized window. Same already-
      // populated analysis buffer, no extra ring-buffer bookkeeping.
      const lpcBuf = buf.subarray(N - this.lpcWinLen, N);
      const coeffs = computeLPC(lpcBuf, this.lpcOrder, this.lpcHammingWindow);
      // On a too-quiet block, hold the last good coefficients rather
      // than snapping to a flat filter - a held, slightly-stale formant
      // shape is far less audible than the output muting/coloring
      // oddly on every brief unvoiced gap.
      if (coeffs) this.lpcCoeffsTarget.set(coeffs);
      // Round 44: same lpcBuf, same once-per-hop cadence, feeding the
      // NEW resynthesis mechanism instead (see the Round 44 comment
      // above computeCepstralEnvelope()). One extra FFT-based analysis
      // per hop (a handful of size-envFftSize FFTs, ~1024 points at the
      // 44100Hz reference) alongside the existing computeLPC() call -
      // measured directly (see PATCHNOTES) to stay comfortably inside
      // the same real-time budget computeLPC() itself was already
      // tuned against (Round 77/20's lpcWinLen halving).
      const envCoeffs = computeCepstralEnvelope(lpcBuf, this.envFftSize, this.envTaps, this.envOrder, this.envMpFftSize, this.lpcHammingWindow);
      if (envCoeffs) this.envCoeffsTarget.set(envCoeffs);
    }

    const pitch = detectPitch(buf, this.sr);
    // Two-tier accept: a flat confidence number alone can't cleanly
    // separate genuine-but-quiet voice from noise - they measurably
    // overlap (noise can spuriously reach ~0.56 confidence; real voice
    // sung softly, or captured at lower input gain, regularly measures
    // well under that too). A previous attempt at a single higher gate
    // fixed noise screeching but broke correction on anything short of
    // a loud, close, hot take - a second real, reported regression.
    // Above CONF_HIGH, a read is strong enough to trust outright (noise
    // essentially never gets this confident). Between CONF_LOW and
    // CONF_HIGH, only trust it if it's close (in cents) to the pitch
    // most recently trusted - a real voice's pitch barely moves in
    // 12ms, while a noise burst's spurious reading has no relationship
    // to whatever was just being sung and will almost always land far
    // outside that window. Below CONF_LOW, never trust it regardless of
    // continuity - too close to indistinguishable from noise on its own.
    const CONF_HIGH = 0.6;
    const CONF_LOW = 0.35;
    const CONTINUITY_CENTS = 200;
    // Absolute outlier ceiling, checked before either tier above and
    // NOT overridden by CONF_HIGH - measured directly against a real
    // take (a vocal that screeches intermittently through an otherwise
    // clean recording): the detector occasionally reports a single hop
    // 2-3 OCTAVES away from whatever was just playing (e.g. 144Hz then
    // 957Hz then back to 165Hz across 3 consecutive ~11.6ms hops, right
    // on a consonant/transient), and that reading's OWN confidence was
    // above CONF_HIGH - so the "trust it outright above CONF_HIGH"
    // branch let it straight through with no continuity check at all.
    // A human voice cannot legitimately move 2-3 octaves in 11.6ms
    // regardless of how confidently periodic the detector judged that
    // one window to be - RATIO_CLAMP further down already encodes
    // exactly this assumption ("essentially never [moves] by a full
    // octave") for the CORRECTION ratio, but did nothing to stop the
    // bad raw value from being accepted as lastAcceptedPitchHz and fed
    // into smoothedPitchHz regardless. Because smoothedPitchHz uses a
    // 120ms time constant, one bad hop that gets in still takes several
    // hundred ms to fully decay back out - which is what actually
    // produced the SUSTAINED (measured: 15-250ms, some tracks over 2.5s
    // total across a take) large-ratio stretches the granular shifter
    // renders as an audible screech, not just a single-hop click.
    // Rejecting the outlier before it ever reaches lastAcceptedPitchHz
    // or smoothedPitchHz - not just clamping the ratio after the fact -
    // is what actually stops the multi-hundred-ms tail. MAX_JUMP_CENTS
    // matches RATIO_CLAMP's own one-octave ceiling, so nothing this
    // rejects would have survived RATIO_CLAMP anyway - this only
    // changes WHEN it gets rejected (before poisoning the smoother)
    // rather than WHAT gets rejected.
    const MAX_JUMP_CENTS = 1200;
    // Octave-error band: autocorrelation pitch detectors' single most
    // common failure mode is reporting a subharmonic or harmonic of the
    // true pitch - i.e. landing on almost EXACTLY double or half the
    // real F0 - rather than a random wrong value. Measured directly on
    // a real take that still screeched after every other fix this
    // session: 16 hops out of 378 (4.2% of the WHOLE take) landed
    // between 1000-1250 cents from the last accepted pitch, with
    // ratios clustering tightly around 0.51-0.54 and 1.79-1.90 - the
    // unmistakable signature of octave doubling/halving, not a real
    // voice actually leaping that far. A few of these read back with
    // confidence above CONF_HIGH (up to 0.855), which lets them straight
    // through the branch below with NO continuity check at all (that
    // branch exists to trust a genuinely confident, continuous read
    // outright) - and MAX_JUMP_CENTS's single hard cutoff at exactly
    // 1200 let several through by a matter of tens of cents (measured:
    // 1153.8, 1099.7, 1075.1 cents, all comfortably under 1200 but all
    // clear octave errors by ratio). A blanket wider cutoff would also
    // catch legitimate large corrections; checking the RATIO specifically
    // for "suspiciously close to exactly 2x or 0.5x" targets the actual
    // failure signature instead - real pitch movement has no reason to
    // cluster there, only a harmonic/subharmonic detection error does.
    const OCTAVE_UP_MIN = 1.82, OCTAVE_UP_MAX = 2.20;     // ~1038-1366 cents from 2x
    const OCTAVE_DOWN_MIN = 0.455, OCTAVE_DOWN_MAX = 0.549; // ~1038-1366 cents from 0.5x
    // Round 69: the band above was measured against SHORT gaps between
    // accepted hops (a hop or two at most). lastAcceptedPitchHz is only
    // ever written on acceptance - it does NOT decay or reset while a run
    // of hops gets rejected, so after a longer gap it's comparing the new
    // candidate against an increasingly OLD reference. Found on a real
    // report ("vocal goes up and down, sounds like its in a bottle"):
    // direct instrumentation of this exact engine's accept/reject log on
    // the evidence file showed an 8-hop (~93ms) run of rejections, after
    // which a genuine octave-error candidate (92.71Hz against a true
    // ~185Hz) measured a ratio of 0.5628 against the stale 164.75Hz
    // reference - just 42.8 cents outside OCTAVE_DOWN_MAX's edge (0.549 -
    // 995.4c vs the 1038.1c boundary) - and slipped through untouched,
    // both mistuning that stretch AND (via shifter.periodHint, derived
    // from lastAcceptedPitchHz) feeding a wrong period into the
    // formant/WSOLA resynthesis for the same stretch, which is what reads
    // as the reported "in a bottle" timbral wobble as well as the pitch
    // blip. A real voice's pitch drift during a gap is bounded by how
    // long the gap ran; a genuine octave-error candidate's ratio doesn't
    // become LESS suspicious just because the reference is old - so
    // rather than holding the band fixed, widen it proportionally to how
    // long it's been since a hop was last actually accepted. msSinceLastAccepted
    // is 0 on a normal hop-to-hop cadence (no widening - GRACE_MS covers
    // one or two ordinary rejected hops without loosening anything), and
    // grows only across a genuine run of rejections, capped so it can
    // never widen the band into meaninglessness.
    const OCTAVE_STALENESS_GRACE_MS = 20;         // ~1-2 hops - an ordinary short gap, not itself suspicious
    const OCTAVE_STALENESS_WIDEN_CENTS_PER_MS = 0.75;
    // Capped at 65c (not the whole 150-1200c theoretical range) -
    // measured directly against this file's own worst case (the 5-hop
    // 92Hz stretch above needed 42.8-46c of widening to catch its
    // tightest margin; 65c covers that with headroom) and checked
    // against the WHOLE track: lowering the cap further, to 50c, caught
    // the exact same 11 hops as 65c did - so 65c is already the
    // effective ceiling for this file, not an arbitrarily large blanket
    // widening that would risk delaying reacquisition of a genuinely new
    // note after a long pause (a rejected hop just holds and retries
    // next hop - far cheaper than letting an octave error through).
    const OCTAVE_STALENESS_MAX_WIDEN_CENTS = 65;
    // Round 71: how long the detector may keep handing us trustworthy
    // pitches that all get force-rejected before we conclude the
    // REFERENCE is the thing that's wrong and re-anchor. Chosen by sweep
    // on the real evidence takes (see PATCHNOTES): long enough that it
    // never fires on the brief, legitimate rejection runs that ordinary
    // consonants and octave-error bursts produce - the Round 49/51/69
    // octave tests all work in single-hop and ~8-hop gaps, far under this
    // - and short enough that a genuinely stuck reference costs a fraction
    // of a second rather than the multi-second dropouts measured here.
    const STALE_REANCHOR_MS = 300;
    // This hop's own duration has now elapsed since whatever was last
    // accepted (unconditional, once per hop, BEFORE the check below reads
    // it - so a candidate is judged against the staleness that's actually
    // true as of right now, not the staleness as of one hop ago). Reset
    // to 0 below the moment something is actually accepted.
    this.msSinceLastAccepted = (this.msSinceLastAccepted || 0) + (this.hopSize / this.sr) * 1000;
    if (pitch && this.lastAcceptedPitchHz !== null) {
      const jumpCentsSigned = 1200 * Math.log2(pitch.hz / this.lastAcceptedPitchHz);
      const jumpCents = Math.abs(jumpCentsSigned);
      const staleMs = this.msSinceLastAccepted;
      const widenCents = Math.min(
        OCTAVE_STALENESS_MAX_WIDEN_CENTS,
        Math.max(0, staleMs - OCTAVE_STALENESS_GRACE_MS) * OCTAVE_STALENESS_WIDEN_CENTS_PER_MS
      );
      const octaveUpMinCents = 1200 * Math.log2(OCTAVE_UP_MIN) - widenCents;
      const octaveUpMaxCents = 1200 * Math.log2(OCTAVE_UP_MAX) + widenCents;
      const octaveDownMinCents = 1200 * Math.log2(OCTAVE_DOWN_MIN) - widenCents;
      const octaveDownMaxCents = 1200 * Math.log2(OCTAVE_DOWN_MAX) + widenCents;
      const looksLikeOctaveError =
        (jumpCentsSigned > octaveUpMinCents && jumpCentsSigned < octaveUpMaxCents) ||
        (jumpCentsSigned > octaveDownMinCents && jumpCentsSigned < octaveDownMaxCents);
      const forceReject = jumpCents > MAX_JUMP_CENTS || looksLikeOctaveError;
      // ─── BEGIN STALE REFERENCE RE-ANCHOR ───
      // Round 71 ("its has now no autotune even if key is good and formant
      // off"): every rejection path above measures the candidate against
      // lastAcceptedPitchHz, and lastAcceptedPitchHz ONLY ever updates on
      // acceptance. So once a run of rejections starts, the reference
      // freezes - and if the voice has genuinely moved away from it, every
      // subsequent hop measures a huge jump from that frozen value and is
      // rejected for it, which keeps the reference frozen. A closed loop
      // with no way out: the engine stops correcting entirely and passes
      // the dry signal through, which is exactly "no autotune".
      //
      // This was named as a theoretical risk when the staleness widening
      // shipped and judged unlikely to matter on real audio. That was
      // wrong. Measured on the evidence take for this report: 802 of 1238
      // hops force-rejected on MAX_JUMP_CENTS alone, 597 of all
      // force-rejections were high-confidence reads the engine should have
      // trusted, the longest unbroken rejection run was 148 hops (~1.7
      // SECONDS), and the reference went as stale as 3529ms. From t=1.07s
      // the detector reports a rock-steady ~700Hz at confidence 0.65-0.77
      // for hop after hop while the reference sits frozen near 100Hz, so
      // all of it reads as a ~3400-cent jump and every single hop is
      // thrown away.
      //
      // The existing divergence safety net cannot help here: it lives at
      // the end of this method, past the `if (!accepted) return;` guard,
      // so it only ever runs on hops that were ACCEPTED - by construction
      // it never executes during the deadlock it would need to break.
      //
      // Fix: if the detector keeps producing pitches we could otherwise
      // trust and they keep getting force-rejected for long enough, the
      // conclusion is that the REFERENCE is wrong, not the input. Re-anchor
      // via the existing resync() (which nulls lastAcceptedPitchHz, so the
      // very next hop is judged on its own confidence with no jump check,
      // and also clears the smoother/target so nothing carries the bad
      // state forward). Only reads at or above CONF_LOW count toward the
      // streak - genuine silence returns no pitch at all and must never
      // trip this.
      if (forceReject && pitch.confidence >= CONF_LOW) {
        this.forcedRejectMs = (this.forcedRejectMs || 0) + (this.hopSize / this.sr) * 1000;
      } else if (!forceReject) {
        this.forcedRejectMs = 0;
      }
      if (this.forcedRejectMs >= STALE_REANCHOR_MS) {
        this.forcedRejectMs = 0;
        this.resync();
        // resync() nulled the reference, so nothing below can reject this
        // hop on a jump it can no longer measure - let it through on its
        // own confidence and re-anchor the engine from here.
        this.msSinceLastAccepted = 0;
      } else if (forceReject) {
        pitch.confidence = 0; // force rejection below, regardless of tier
      }
      // ─── END STALE REFERENCE RE-ANCHOR ───
    }
    let accepted = false;
    if (pitch) {
      if (pitch.confidence >= CONF_HIGH) {
        accepted = true;
      } else if (pitch.confidence >= CONF_LOW && this.lastAcceptedPitchHz !== null) {
        const centsFromLast = Math.abs(1200 * Math.log2(pitch.hz / this.lastAcceptedPitchHz));
        if (centsFromLast < CONTINUITY_CENTS) accepted = true;
      }
    }
    if (!accepted) {
      this.targetRatio += (1 - this.targetRatio) * 0.05; // no clear/trusted pitch - ease back to unshifted
      this.heldMs = 0;
      // msSinceLastAccepted (distinct from heldMs above, which tracks how
      // long the current target NOTE has been held) was already advanced
      // for this hop above, before the octave-rejection check ran.
      return;
    }
    this.lastAcceptedPitchHz = pitch.hz;
    this.msSinceLastAccepted = 0;
    const intervals = SCALE_INTERVALS[this.params.scale] || SCALE_INTERVALS.chromatic;
    // Round 48: excludedNotes is an array of ABSOLUTE pitch classes
    // (0=C..11=B) the live piano UI has toggled off - rebuilt as a Set
    // once per hop (cheap - at most 12 entries) rather than per-sample.
    const excludedPcs = (this.params.excludedNotes && this.params.excludedNotes.length) ? new Set(this.params.excludedNotes) : null;
    // Which note gets targeted is decided from a SMOOTHED pitch estimate,
    // not the raw, instantaneous one - a plain per-hop hysteresis margin
    // was tried first and measured to not actually be enough: a sung
    // note sitting almost exactly between two allowed scale tones (not a
    // rare corner case - it happens on ordinary singing constantly)
    // combined with completely normal vocal vibrato (a few percent of
    // pitch wobble, easily 40+ cents peak) means the RAW pitch genuinely
    // crosses the midpoint between those two notes on every vibrato
    // cycle - any hysteresis margin small enough to not cripple real
    // note-change responsiveness turned out to be too small to survive a
    // full vibrato swing. Smoothing the pitch used for the note DECISION
    // (with a time constant longer than a typical vibrato period, ~120ms)
    // averages the wobble out before ever asking "which note is this",
    // while the actual correction amount below still uses the RAW,
    // instantaneous pitch - so vibrato still gets fully corrected/
    // tightened exactly as before, only the choice of WHICH note to
    // correct toward is stable. Measured directly with a vibrato'd
    // off-scale test tone sitting almost exactly between two scale
    // notes: the target flipped on 13% of hops before this, 0% after.
    // Round 45: SMOOTH_MS is no longer one fixed constant - see the
    // "Velocity-adaptive pitch-decision smoothing" comment block above
    // computeGlideStrength() for the full reasoning and validation. A
    // genuine, confidently-detected glide/run shortens the effective
    // time constant toward SMOOTH_MS_FAST; anything else (including
    // full vibrato, by design/validation) leaves it at the baseline.
    //
    // Round 49: that baseline is now this.params.trackingSpeedMs (user-
    // adjustable "Tracking Speed" control) instead of the hardcoded
    // SMOOTH_MS_SLOW constant directly - SMOOTH_MS_SLOW remains the
    // DEFAULT value of that param (see the constructor), so an unset/
    // untouched session computes byte-for-byte the same SMOOTH_MS as
    // before this round. Clamped to stay comfortably above
    // SMOOTH_MS_FAST so the adaptive glide shortening below always has
    // real room to act, even if a user drags the slider to its fastest
    // setting.
    const trackingBaselineMs = Math.max(SMOOTH_MS_FAST + 5, this.params.trackingSpeedMs || SMOOTH_MS_SLOW);
    const glideStrength = computeGlideStrength(this.pitchVelHist, pitch.hz, PITCH_VEL_WINDOW_HOPS, PITCH_GLIDE_REF_CENTS, PITCH_GLIDE_CONSIST_LO, PITCH_GLIDE_CONSIST_HI);
    const SMOOTH_MS = trackingBaselineMs - (trackingBaselineMs - SMOOTH_MS_FAST) * glideStrength;
    this.pitchVelHist.push(pitch.hz);
    if (this.pitchVelHist.length > PITCH_VEL_WINDOW_HOPS + 2) this.pitchVelHist.shift();
    const hopMs = (this.hopSize / this.sr) * 1000;
    const smoothAlpha = 1 - Math.exp(-hopMs / SMOOTH_MS);
    this.smoothedPitchHz = (this.smoothedPitchHz == null) ? pitch.hz : this.smoothedPitchHz + (pitch.hz - this.smoothedPitchHz) * smoothAlpha;
    // Smoothing alone gets rid of the big, vibrato-width swings but
    // doesn't fully solve the exact-midpoint case: if the sung note's
    // AVERAGE pitch itself sits right on the boundary between two scale
    // tones, the smoothed estimate still dithers back and forth across
    // that boundary from ordinary detector jitter, just with much
    // smaller amplitude than raw vibrato. A second, small hysteresis
    // margin applied to the (already-smoothed) estimate absorbs that
    // residual dither. Because it's measured against the smoothed value
    // rather than the raw one, this margin only has to be wide enough to
    // cover leftover jitter (a few cents) rather than a full vibrato
    // swing (tens of cents) - so it doesn't meaningfully slow down a
    // real note change, which moves the smoothed estimate by 100+ cents.
    const HYSTERESIS_CENTS = 30;
    const naive = freqToNearestScaleFreq(this.smoothedPitchHz, this.params.key, intervals, excludedPcs);
    let targetMidi = naive.targetMidi, targetHz = naive.targetHz;
    if (this.lastTargetMidi !== null && this.lastTargetMidi !== naive.targetMidi) {
      const centsToPrev = Math.abs(1200 * Math.log2(this.smoothedPitchHz / midiToHz(this.lastTargetMidi)));
      const centsToNaive = Math.abs(naive.centsOff);
      if (centsToPrev - centsToNaive < HYSTERESIS_CENTS) {
        targetMidi = this.lastTargetMidi;
        targetHz = midiToHz(this.lastTargetMidi);
      }
    }
    // Fast unlock: a genuine, fast melodic glide can cover a full scale
    // step in well under the ~120ms SMOOTH_MS takes to settle - during
    // that window the lock above (deliberately slow, to survive
    // vibrato) is stale, dragging the correction toward a note the
    // voice has already left, which is heard as a large, growing,
    // wrong-direction pull. Checked against the RAW pitch with a much
    // wider margin than the smoothed-pitch hysteresis above uses -
    // ordinary vibrato (tens of cents of swing) can never put a
    // DIFFERENT note's raw-pitch distance 100+ cents closer than the
    // locked target's, only a genuine step-change spanning most of a
    // scale step can, so this can't reopen the vibrato flip-flop the
    // smoothed path exists to prevent. Requiring 2 consecutive hops
    // (~23ms) filters a single noisy/transient hop without waiting
    // anywhere near the full smoothing window.
    const rawNaive = freqToNearestScaleFreq(pitch.hz, this.params.key, intervals, excludedPcs);
    if (this.lastTargetMidi !== null && rawNaive.targetMidi !== this.lastTargetMidi) {
      const rawCentsToPrev = Math.abs(1200 * Math.log2(pitch.hz / midiToHz(this.lastTargetMidi)));
      const rawCentsToNaive = Math.abs(rawNaive.centsOff);
      const RAW_UNLOCK_MARGIN_CENTS = 100;
      this.rawUnlockStreak = (rawCentsToPrev - rawCentsToNaive > RAW_UNLOCK_MARGIN_CENTS) ? (this.rawUnlockStreak || 0) + 1 : 0;
    } else {
      this.rawUnlockStreak = 0;
    }
    const RAW_UNLOCK_HOPS = 2;
    if (this.rawUnlockStreak >= RAW_UNLOCK_HOPS) {
      targetMidi = rawNaive.targetMidi;
      targetHz = rawNaive.targetHz;
      this.smoothedPitchHz = pitch.hz;
      this.rawUnlockStreak = 0;
    }
    const centsOff = 1200 * Math.log2(pitch.hz / targetHz);

    const flexThreshold = (this.params.flexTune / 100) * 50; // up to 50 "comfortable" cents
    let strength = 1;
    if (Math.abs(centsOff) < flexThreshold) strength = Math.abs(centsOff) / Math.max(1, flexThreshold);

    const vibratoLeak = (this.params.naturalVibrato / 100) * 0.6;
    const correctedHz = pitch.hz * Math.pow(2, (-centsOff / 1200) * strength * (1 - vibratoLeak));
    const rawRatio = correctedHz / pitch.hz;
    // Hard ceiling on any single correction: legitimate autotune moves a
    // voice by cents to a few semitones, essentially never by a full
    // octave. The autocorrelation detector above is solid on clean
    // signal but real vocals (sibilance, plosives, breath, room noise)
    // do occasionally hand it an octave-wrong or otherwise bogus pitch
    // for a hop or two - without this clamp, one bad hop can whip
    // targetRatio to a wild value and the pitch shifter tracks it
    // straight into a screech. RATIO_CLAMP of 2 = one octave either way
    // is generous enough to never touch a real correction while still
    // catching every misdetection this severe.
    const RATIO_CLAMP = 2;
    this.targetRatio = Math.max(1 / RATIO_CLAMP, Math.min(RATIO_CLAMP, rawRatio));

    if (targetMidi !== this.lastTargetMidi) this.heldMs = 0;
    else this.heldMs += (this.hopSize / this.sr) * 1000;
    this.lastTargetMidi = targetMidi;

    // Divergence safety net: a real note change resolves within a few
    // hundred ms even in the worst case (measured directly: ~270ms for
    // a full octave jump, well under half a second) once the smoothed
    // estimate catches up. If the actual correction target is still
    // half an octave or more away from where the raw pitch actually is
    // after a full second of that being continuously true, the smoothed
    // target isn't "still resolving a real change" anymore - it's stuck
    // away from reality (whatever the original cause), and would
    // otherwise hold the pitch shifter near its RATIO_CLAMP ceiling
    // indefinitely, which is heard as the voice being buried under a
    // heavy, constant pitch shift rather than corrected. Force a resync
    // rather than trust it to recover on its own.
    if (Math.abs(centsOff) > 600) this.divergentHops++; else this.divergentHops = 0;
    const HOP_MS = (this.hopSize / this.sr) * 1000;
    if (this.divergentHops * HOP_MS > 1000) this.resync();
  }
}

// ─── END DSP CORE ────────────────────────────────────────────────────────

class AutotuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new AutotuneEngine(sampleRate);
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'params') this.engine.setParams(e.data.params);
    };
    // Which input channel is actually being fed to the engine right
    // now - see the channel-selection comment in process() for why this
    // is a sticky choice rather than either "always channel 0" or an
    // average of every channel.
    this.activeChannel = 0;
    this.silentBlockStreak = 0;
    // Round 48 (live note view): report the engine's current locked
    // target note + raw detected pitch to the main thread so the piano
    // UI can highlight it live, matching a real hardware/plugin
    // autotune's note display. Throttled to a fixed wall-clock interval
    // (not every render quantum, which would flood postMessage several
    // hundred times a second for no perceptible UI benefit) -
    // accumulates elapsed samples and fires at NOTE_REPORT_INTERVAL_MS.
    this.noteReportAccumSamples = 0;
    this.lastReportedTargetMidi = undefined;
    this.lastReportedVoiced = undefined;
    // Last-resort fault handling: if the engine ever throws or hands
    // back a non-finite sample - anything not caught by the numeric
    // safety nets inside the engine itself - the alternative is either
    // an uncaught exception (which stops this node from ever being
    // called again, i.e. silence for the rest of the take/session with
    // no explanation) or NaN samples reaching the output (Web Audio
    // treats a non-finite output as effectively silent too). Neither is
    // recoverable on its own. Falling back to the raw dry signal for
    // the rest of the affected block, resyncing the engine, and telling
    // the main thread what happened turns "mysteriously and permanently
    // silent" into "one bad moment, logged, then back to normal."
    this.faultCount = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0] || !output || !output[0]) return true;
    const outCh = output[0];
    const numCh = input.length;
    // Some multi-channel interfaces don't put the live mic signal on
    // channel 0 - which physical jack a stereo-capable audio interface
    // (an Apollo Twin, for example) maps to index 0 vs. 1 isn't
    // something this app controls, and reading only input[0] means a
    // mic wired to the OTHER input silently feeds this engine nothing
    // to detect a pitch from at all.
    //
    // This used to be fixed by averaging every available channel into
    // one mono sample. That solved the silent-channel case, but traded
    // it for a subtler one: a real user report of screeching while
    // monitoring on HEADPHONES (ruling out acoustic mic-hears-speaker
    // feedback) pointed at the input itself - if the two captured
    // channels aren't perfectly phase-identical (not guaranteed even
    // for "one mic duplicated to satisfy a stereo request", depending on
    // the audio stack), summing them is a textbook comb filter, which
    // degrades exactly the pitch detector this engine depends on and
    // can plausibly read as screeching once a confused pitch estimate
    // starts whipping the shifter around.
    //
    // Selecting ONE channel outright - instead of blending - removes
    // that risk entirely while still solving the original silent-
    // channel problem: pick whichever channel actually has signal, and
    // stick with it (a many-consecutive-silent-blocks debounce before
    // ever switching) so a normal quiet moment in a vocal take - a
    // breath, a pause between lines - can't cause a mid-take channel
    // flip and the tiny discontinuity that would come with one.
    if (numCh > 1) {
      let activePeak = 0;
      const activeBuf = input[this.activeChannel] || input[0];
      for (let i = 0; i < activeBuf.length; i++) { const a = Math.abs(activeBuf[i]); if (a > activePeak) activePeak = a; }
      const SILENCE_FLOOR = 0.0008;
      if (activePeak < SILENCE_FLOOR) {
        this.silentBlockStreak++;
        // ~50ms of continuous silence on the active channel (at a
        // typical 128-sample render quantum) before even considering a
        // switch - long enough that no normal breath/pause in a vocal
        // take triggers it, short enough to actually recover if this
        // channel really is the wrong one.
        if (this.silentBlockStreak > 15) {
          let bestC = this.activeChannel, bestPeak = activePeak;
          for (let c = 0; c < numCh; c++) {
            if (c === this.activeChannel) continue;
            const buf = input[c];
            let peak = 0;
            for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
            if (peak > bestPeak) { bestPeak = peak; bestC = c; }
          }
          if (bestC !== this.activeChannel && bestPeak >= SILENCE_FLOOR) {
            this.activeChannel = bestC;
          }
          this.silentBlockStreak = 0;
        }
      } else {
        this.silentBlockStreak = 0;
      }
    }
    const inCh = input[this.activeChannel] || input[0];
    try {
      for (let i = 0; i < outCh.length; i++) {
        const s = this.engine.processSample(inCh[i]);
        outCh[i] = Number.isFinite(s) ? s : inCh[i];
        if (!Number.isFinite(s)) throw new Error('non-finite sample from processSample');
      }
    } catch (err) {
      // Fall back to dry signal for whatever's left of this block so
      // the take isn't silent for even one full render quantum, then
      // reset the engine's correction state so the NEXT block starts
      // clean instead of carrying forward whatever went wrong.
      for (let i = 0; i < outCh.length; i++) outCh[i] = inCh[i];
      this.engine.resync();
      this.faultCount++;
      // Throttled, not per-occurrence - a genuinely pathological input
      // could fault every block, and flooding the main thread/activity
      // log with thousands of identical messages would itself become a
      // performance problem.
      if (this.faultCount === 1 || this.faultCount % 200 === 0) {
        try {
          this.port.postMessage({ type: 'fault', message: String((err && err.message) || err), count: this.faultCount });
        } catch (e2) {}
      }
    }
    // Mono in, mono out is enough for a vocal take - mirror to any extra
    // output channels so stereo destinations still get signal on both.
    for (let c = 1; c < output.length; c++) {
      output[c].set(outCh);
    }
    // Round 48: throttled live-note report (see the constructor comment
    // above for why this isn't sent every render quantum). ~80ms is
    // fast enough to feel live/responsive on a piano UI but coarse
    // enough that this is at most ~12 messages/sec, not several
    // hundred. "voiced" reflects whether the engine currently has a
    // locked target at all (lastTargetMidi !== null) - the UI dims the
    // display rather than showing a stale note during silence/breaths.
    const NOTE_REPORT_INTERVAL_MS = 80;
    this.noteReportAccumSamples += outCh.length;
    if (this.noteReportAccumSamples >= (NOTE_REPORT_INTERVAL_MS / 1000) * sampleRate) {
      this.noteReportAccumSamples = 0;
      const targetMidi = this.engine.lastTargetMidi;
      const voiced = targetMidi !== null && targetMidi !== undefined;
      if (targetMidi !== this.lastReportedTargetMidi || voiced !== this.lastReportedVoiced) {
        this.lastReportedTargetMidi = targetMidi;
        this.lastReportedVoiced = voiced;
        try {
          this.port.postMessage({
            type: 'note',
            targetMidi: voiced ? targetMidi : null,
            rawHz: this.engine.smoothedPitchHz || null,
            voiced,
          });
        } catch (e3) {}
      }
    }
    return true;
  }
}

registerProcessor('autotune-processor', AutotuneProcessor);
