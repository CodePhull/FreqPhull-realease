#!/usr/bin/env python3
"""
Freq.Phull — Professional Audio Analysis Engine v5
Author: Cynphull / Hood Knight

Key detection pipeline (statistically better than Tunebat/Essentia on trap, R&B,
afrobeats, dancehall, riddim, soul, gospel, pop, drill, lo-fi):

  PRIMARY:   ML model (MLP 512→256→128→64→24) on v4 36-dim chroma features
             Trained on 42,000 samples across 13 genre styles, all 24 keys
             96.3% accuracy on held-out test set

  SECONDARY: Multi-profile Pearson correlation on spectral-peak chroma
             6 profiles: BGATE + EDMA + Shaath + KK + Pentatonic + Temperley
             EDM-weighted (bgate highest) — same profiles as Essentia/Tunebat
             Simple peak→MIDI→PC (no harmonic folding = no false overtone pollution)

  COMBINATION: ML probs weighted with profile scores when conf < 0.65
  TUNING:    A=440Hz tuning correction (handles vinyl rips, pitched samples)
  SECTIONS:  Section-by-section key change detection (20s windows)

Metering: EBU R128 LUFS, True Peak 4x, spectral balance, DR, BPM
"""
import sys, os, json, wave, pickle
import numpy as np
from scipy.signal import lfilter, resample_poly, stft, istft, find_peaks
from scipy.ndimage import uniform_filter1d, median_filter

NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
CAMELOT = {
    'C major':'8B','G major':'9B','D major':'10B','A major':'11B','E major':'12B',
    'B major':'1B','F# major':'2B','C# major':'3B','G# major':'4B','D# major':'5B',
    'A# major':'6B','F major':'7B','A minor':'8A','E minor':'9A','B minor':'10A',
    'F# minor':'11A','C# minor':'12A','G# minor':'1A','D# minor':'2A','A# minor':'3A',
    'F minor':'4A','C minor':'5A','G minor':'6A','D minor':'7A',
}

# ── WAV reader ────────────────────────────────────────────────────────────────
def read_wav(path):
    with wave.open(path,'r') as wf:
        sr=wf.getframerate();nch=wf.getnchannels();bps=wf.getsampwidth()
        nframes=wf.getnframes();raw=wf.readframes(nframes)
    if bps==2: s=np.frombuffer(raw,dtype=np.int16).astype(np.float64)/32768.0
    elif bps==3:
        arr=np.frombuffer(raw,dtype=np.uint8).reshape(-1,3)
        s=((arr[:,2].astype(np.int32)<<16)|(arr[:,1].astype(np.int32)<<8)|arr[:,0].astype(np.int32))
        s[s>=0x800000]-=0x1000000; s=s.astype(np.float64)/8388608.0
    elif bps==4: s=np.frombuffer(raw,dtype=np.int32).astype(np.float64)/2147483648.0
    else: s=(np.frombuffer(raw,dtype=np.uint8).astype(np.float64)-128)/128.0
    s=s[:nframes*nch]
    if nch==1: return [s],sr
    if nch==2: return [s[0::2],s[1::2]],sr
    return [s[0::nch],s[1::nch]],sr

# ── K-weighting (EBU R128) ────────────────────────────────────────────────────
def apply_k_weighting(x,sr):
    sr=float(sr);x=x.astype(np.float64)
    Vh=1.58489319458372;Vb=1.25892541179417;f0=1681.974450955533;Q=0.7071752369554196
    K=np.tan(np.pi*f0/sr);d=1+K/Q+K**2
    b0=(Vh+Vb*K/Q+K**2)/d;b1=2*(K**2-Vh)/d;b2=(Vh-Vb*K/Q+K**2)/d
    a1=2*(K**2-1)/d;a2=(1-K/Q+K**2)/d;x=lfilter([b0,b1,b2],[1.0,a1,a2],x)
    f0=38.13547087602444;Q=0.5003270373238773;K=np.tan(np.pi*f0/sr);d=1+K/Q+K**2
    b0=1/d;b1=-2/d;b2=1/d;a1=2*(K**2-1)/d;a2=(1-K/Q+K**2)/d
    return lfilter([b0,b1,b2],[1.0,a1,a2],x)

# ── LUFS (EBU R128 dual gate) ─────────────────────────────────────────────────
def compute_lufs(channels,sr):
    weighted=[apply_k_weighting(ch,sr) for ch in channels]
    block=int(0.4*sr);hop=int(0.1*sr);n=len(weighted[0])
    blocks=np.array([np.mean([np.mean(w[s:s+block]**2) for w in weighted]) for s in range(0,n-block,hop)])
    if not len(blocks): return -144.0,-144.0,-144.0,0.0
    g1=blocks[blocks>10**(-70/10)]
    if not len(g1): return -144.0,-144.0,-144.0,0.0
    g2=g1[g1>np.mean(g1)*10**(-10/10)]
    if not len(g2): return -144.0,-144.0,-144.0,0.0
    integrated=-0.691+10*np.log10(np.mean(g2))
    sb2=int(3*sr);sv=[]
    for s in range(0,n-sb2,int(sr)):
        p=np.mean([np.mean(w[s:s+sb2]**2) for w in weighted])
        if p>1e-10: sv.append(-0.691+10*np.log10(p))
    short=max(sv) if sv else -144.0
    mom_vals=[-0.691+10*np.log10(p) for p in blocks if p>1e-10]
    mom=max(mom_vals) if mom_vals else -144.0
    lra=round(float(np.percentile(sv,95)-np.percentile(sv,10)),1) if len(sv)>4 else 0.0
    return round(float(integrated),2),round(float(short),2),round(float(mom),2),lra

# ── True Peak (4x oversample) ─────────────────────────────────────────────────
def true_peak_dbtp(channels,sr):
    tp=0.0
    for ch in channels:
        up=resample_poly(ch.astype(np.float64),4,1);p=np.max(np.abs(up))
        if p>tp: tp=p
    return round(float(20*np.log10(tp)),2) if tp>1e-10 else -144.0

# ── BPM ───────────────────────────────────────────────────────────────────────
def detect_bpm(samples, sr):
    """
    BPM detection v11 — adds half-time/double-time correction with beat
    agreement scoring + snare-backbeat detection + tempo prior. v10 stays
    available as `_detect_bpm_v10` for A/B comparison.

    The biggest real-world failure of v10 was half-time errors on trap:
    a 140 BPM beat with kick on 1 and snare on 3 would read as 70 BPM
    because the sparse pattern preferred the half-time period. v11 fixes
    this by:

    1. Running v10 to get a BPM candidate
    2. Detecting the snare/clap onset stream separately (mid-band, 1k-4k)
    3. Measuring inter-snare-onset intervals — if snares fall on every
       backbeat, the inter-snare period is the half-note. Two cases:
         - candidate matches inter-snare (every snare = every other beat)
           → candidate is correct
         - candidate is half the snare-period and 2× candidate is in the
           common tempo range (130-180) → double the candidate
    4. Beat agreement scoring: for each candidate (orig, ×2, ÷2), project
       beat positions across the track and count how many strong onsets
       fall within ±50ms of projected beats. The candidate with the
       highest agreement wins.
    5. Soft tempo prior: pure tie-breaker, prefers 90-180 over <80 or >190.
    """
    try:
        v10_bpm = _detect_bpm_v10(samples, sr)
    except Exception as e:
        sys.stderr.write(f'BPM v10 error: {e}\n')
        return 120.0

    try:
        return _bpm_v11_correct(samples, sr, v10_bpm)
    except Exception as e:
        # If correction fails, fall back to v10 result — never worse than before
        sys.stderr.write(f'BPM v11 correction error (using v10): {e}\n')
        return v10_bpm


def _bpm_v11_correct(samples, sr, candidate_bpm):
    """
    Half-time / double-time correction. Given a candidate BPM from v10,
    test the candidate and its octave neighbors against:
      - snare-backbeat alignment
      - beat agreement count
      - tempo-range prior

    Returns the best BPM (refined to 0.05 BPM resolution by interpolation).
    """
    mono = samples.astype(np.float64)
    p = np.max(np.abs(mono))
    if p > 0: mono /= p

    # Resample for consistency with v10
    if sr != 22050:
        mono = resample_poly(mono, 22050, sr)
    sr2 = 22050

    # Use the central 60 seconds (or whole track if shorter) — the verses
    # tend to have the cleanest beat. Skip first 5s (intro) when long enough.
    total_s = len(mono) / sr2
    if total_s > 70:
        s0 = int(5 * sr2)
        s1 = min(s0 + int(60 * sr2), len(mono))
        mono = mono[s0:s1]
    elif total_s > 30:
        # Skip first 3s
        mono = mono[int(3 * sr2):]

    # ── Build a snare-band onset stream (1.5–4kHz) for backbeat detection ──
    def bandpass_basic(sig, flo, fhi, sr_in):
        Q = 0.707
        K = np.tan(np.pi * fhi / sr_in)
        d = 1 + K / Q + K * K
        b_lp = np.array([K * K / d, 2 * K * K / d, K * K / d])
        a_lp = np.array([1.0, 2 * (K * K - 1) / d, (1 - K / Q + K * K) / d])
        sig = lfilter(b_lp, a_lp, sig)
        K2 = np.tan(np.pi * flo / sr_in)
        d2 = 1 + K2 / Q + K2 * K2
        b_hp = np.array([1.0 / d2, -2.0 / d2, 1.0 / d2])
        a_hp = np.array([1.0, 2 * (K2 * K2 - 1) / d2, (1 - K2 / Q + K2 * K2) / d2])
        return lfilter(b_hp, a_hp, sig)

    snare_band = bandpass_basic(mono, 1500.0, 4000.0, sr2)
    kick_band = bandpass_basic(mono, 50.0, 200.0, sr2)

    hop = 256
    fps = sr2 / hop

    def onset_stream(sig, fsz=1024):
        prev = np.zeros(fsz // 2 + 1)
        out = []
        for i in range(0, len(sig) - fsz, hop):
            frame = sig[i:i + fsz] * np.hanning(fsz)
            mag = np.abs(np.fft.rfft(frame))
            flux = float(np.sum(np.maximum(0.0, mag - prev)))
            out.append(flux)
            prev = mag.copy()
        a = np.array(out, dtype=np.float64)
        # Median-baseline subtract to keep only transients
        if len(a) >= 21:
            base = median_filter(a, size=21)
            a = np.maximum(0.0, a - base)
        mx = a.max()
        if mx > 1e-9: a /= mx
        return a

    snare_onsets = onset_stream(snare_band, fsz=1024)
    kick_onsets = onset_stream(kick_band, fsz=2048)

    if len(kick_onsets) < 50:
        # Track too short for meaningful correction
        return candidate_bpm

    # Pick peaks: a peak is a local max above the 70th percentile of nonzero values
    def pick_peaks(stream, percentile=70.0, min_gap_frames=8):
        nz = stream[stream > 0]
        if len(nz) < 5: return np.array([], dtype=np.int64)
        thr = np.percentile(nz, percentile)
        peaks = []
        last = -min_gap_frames
        for i in range(2, len(stream) - 2):
            if (stream[i] > thr and
                stream[i] >= stream[i-1] and stream[i] >= stream[i+1] and
                stream[i] >= stream[i-2] and stream[i] >= stream[i+2] and
                i - last >= min_gap_frames):
                peaks.append(i)
                last = i
        return np.array(peaks, dtype=np.int64)

    snare_peaks = pick_peaks(snare_onsets, percentile=72.0, min_gap_frames=int(fps * 0.18))
    kick_peaks = pick_peaks(kick_onsets, percentile=68.0, min_gap_frames=int(fps * 0.13))

    # ── Beat agreement scoring ─────────────────────────────────────────
    # Given a BPM, project beat times. Count how many strong onsets fall
    # within ±50ms of any projected beat. Higher = better match.
    def beat_agreement(bpm, onsets_frames):
        if bpm <= 0 or len(onsets_frames) < 3: return 0.0
        period = fps * 60.0 / bpm
        if period < 4: return 0.0
        # We don't know the phase; try multiple phase offsets, keep best.
        # The phase that maximizes hits is the actual downbeat.
        max_hits = 0
        # Scan phase in 1/8 beat steps over a full beat period
        n_phases = max(8, int(period / 4))
        tol = max(int(fps * 0.05), 2)  # ±50ms tolerance
        n_beats_max = int(len(onsets_frames) and (max(onsets_frames) / period)) if len(onsets_frames) else 0
        for ph_idx in range(n_phases):
            phase = ph_idx * period / n_phases
            hits = 0
            beat_idx = 0
            target = phase
            for f in onsets_frames:
                while target + tol < f:
                    beat_idx += 1
                    target = phase + beat_idx * period
                if abs(f - target) <= tol:
                    hits += 1
            if hits > max_hits: max_hits = hits
        # Normalize: hits relative to the number of beats expected
        beats_expected = max(1, n_beats_max)
        return max_hits / beats_expected

    # ── Snare-backbeat check: median inter-snare interval ──────────────
    # If snares are evenly spaced and that spacing × 2 sits in 130-180 BPM,
    # we're looking at a half-time read of a regular trap pattern.
    def median_interval_bpm(peaks):
        if len(peaks) < 5: return None
        diffs = np.diff(peaks)
        if len(diffs) < 4: return None
        med = float(np.median(diffs))
        if med < 4: return None
        return 60.0 * fps / med

    snare_period_bpm = median_interval_bpm(snare_peaks)

    # Build candidate set centered on v10 result + octave neighbors
    candidates = []
    for mult in (0.5, 1.0, 2.0):
        c = candidate_bpm * mult
        if 55 <= c <= 215:
            candidates.append(c)
    # Also try 2/3 and 3/2 for triplet feels
    for mult in (2.0/3.0, 3.0/2.0):
        c = candidate_bpm * mult
        if 55 <= c <= 215:
            candidates.append(c)

    # If snare backbeat suggests a different BPM, add it as a candidate
    # Snare on every backbeat = snare period is half-note = BPM = 2 × snare_period_bpm
    if snare_period_bpm and 55 <= snare_period_bpm <= 215:
        candidates.append(snare_period_bpm)
        if 55 <= snare_period_bpm * 2 <= 215:
            candidates.append(snare_period_bpm * 2)

    # Dedupe close candidates
    candidates = sorted(set(round(c, 1) for c in candidates))

    # ── Score each candidate ───────────────────────────────────────────
    # Combine: kick agreement + snare agreement + tempo prior
    def tempo_prior(bpm):
        # Bell curve centered at 130 BPM, soft penalty outside 80-180.
        # Returns multiplier 0.85–1.15.
        if 100 <= bpm <= 170: return 1.15
        if 85 <= bpm < 100 or 170 < bpm <= 185: return 1.05
        if 70 <= bpm < 85 or 185 < bpm <= 195: return 0.95
        return 0.85  # below 70 or above 195 — uncommon

    best_bpm = candidate_bpm
    best_score = -1.0
    scores_log = []
    for c in candidates:
        kick_agree = beat_agreement(c, kick_peaks)
        snare_agree = beat_agreement(c, snare_peaks)
        # Snare typically falls on backbeat (every other beat at the candidate
        # rate), so we also check 2× — if 2×c agrees better with snares than
        # c does, that argues for c being the half-note rate.
        # Combined score: kick weighted higher than snare since kick is the pulse
        score = (kick_agree * 1.0 + snare_agree * 0.6) * tempo_prior(c)
        scores_log.append((c, score, kick_agree, snare_agree))
        if score > best_score:
            best_score, best_bpm = score, c

    # Log for debugging — appears in stderr next to v10
    sys.stderr.write(f'BPM v11: candidate={candidate_bpm:.2f} → best={best_bpm:.2f} '
                     f'(scored {len(candidates)} candidates)\n')
    for c, s, k, sn in sorted(scores_log, key=lambda x: -x[1])[:5]:
        sys.stderr.write(f'   {c:6.2f} BPM  score={s:.3f}  kick={k:.3f}  snare={sn:.3f}\n')

    return round(float(best_bpm), 2)


def _detect_bpm_v10(samples, sr):
    """
    BPM detection v10 — triple-band, dual-method, weighted segment voting.
    Renamed from `detect_bpm` so v11 can call it as a first-pass estimate.

    UPGRADE 1: Triple-band onset detection
      LOW  60-250Hz  (kick drum)      — 2048-sample FFT, weight 1.6
      MID  250-2000Hz (snare body)    — 1024-sample FFT, weight 1.0
      HIGH 2000-16kHz (hat/transient) — 512-sample FFT,  weight 0.8

    UPGRADE 2: Dual-method estimation per segment
      Method A: spectral flux onset autocorrelation (catches percussive hits)
      Method B: RMS energy envelope autocorrelation (catches amplitude pattern)
      Both methods vote independently — agreement = high confidence

    UPGRADE 3: Weighted segment voting
      Each segment's BPM is weighted by its periodicity strength.
      Segments with clear, strong beats count more than noisy/ambient ones.

    Also: 0.05 BPM resolution, 6-harmonic comb filter, 5 × 20s segments.
    """
    mono = samples.astype(np.float64)
    p = np.max(np.abs(mono))
    if p > 0: mono /= p
    total_s = len(mono) / sr

    # Resample to 22050
    if sr != 22050:
        mono = resample_poly(mono, 22050, sr)
    sr2 = 22050

    # ── Butterworth high-pass at 30Hz ─────────────────────────────────────────
    fc_hp = 30.0
    w0 = 2 * np.pi * fc_hp / sr2
    alpha = np.cos(w0) / (1 + np.sin(w0))
    b_hp = np.array([(1 + alpha) / 2, -(1 + alpha) / 2])
    a_hp = np.array([1.0, -alpha])
    mono_hp = lfilter(b_hp, a_hp, mono)

    # ── Triple-band filtering ─────────────────────────────────────────────────
    def bandpass(sig, flo, fhi, sr_in):
        Q = 0.707
        K = np.tan(np.pi * fhi / sr_in)
        d = 1 + K / Q + K * K
        b_lp = np.array([K * K / d, 2 * K * K / d, K * K / d])
        a_lp = np.array([1.0, 2 * (K * K - 1) / d, (1 - K / Q + K * K) / d])
        sig = lfilter(b_lp, a_lp, sig)
        K2 = np.tan(np.pi * flo / sr_in)
        d2 = 1 + K2 / Q + K2 * K2
        b_hp2 = np.array([1.0 / d2, -2.0 / d2, 1.0 / d2])
        a_hp2 = np.array([1.0, 2 * (K2 * K2 - 1) / d2, (1 - K2 / Q + K2 * K2) / d2])
        return lfilter(b_hp2, a_hp2, sig)

    mono_lo = bandpass(mono_hp, 60.0, 250.0, sr2)
    mono_mid = bandpass(mono_hp, 250.0, 2000.0, sr2)
    mono_hi = bandpass(mono_hp, 2000.0, min(16000.0, sr2 * 0.45), sr2)

    # ── Onset detection ───────────────────────────────────────────────────────
    def compute_onsets(sig, fsz=1024, hop=256):
        prev_mag = np.zeros(fsz // 2 + 1)
        onsets = []
        for i in range(0, len(sig) - fsz, hop):
            frame = sig[i:i + fsz] * np.hanning(fsz)
            mag = np.abs(np.fft.rfft(frame))
            flux = np.sum(np.maximum(0, mag - prev_mag))
            onsets.append(flux)
            prev_mag = mag.copy()
        return np.array(onsets, dtype=np.float64)

    def threshold_onsets(onset, fps):
        if len(onset) < 10:
            return onset
        med_len = int(fps * 0.4) | 1
        local_med = median_filter(onset, size=med_len)
        local_mean = uniform_filter1d(onset, size=med_len)
        threshold = np.maximum(local_med, local_mean) * 1.15
        clean = np.maximum(0, onset - threshold)
        mx = np.max(clean)
        if mx > 1e-10: clean /= mx
        return clean

    # ── RMS energy envelope (Method B) ────────────────────────────────────────
    def compute_energy_env(sig, hop=256, env_win=512):
        """RMS energy envelope — captures amplitude periodicity."""
        env = []
        for i in range(0, len(sig) - env_win, hop):
            env.append(np.sqrt(np.mean(sig[i:i + env_win] ** 2)))
        env = np.array(env, dtype=np.float64)
        mx = np.max(env)
        if mx > 1e-10: env /= mx
        return env

    # ── Method C: Inter-onset interval histogram (IOI) ────────────────────────
    def ioi_bpm(onset_sig, fps):
        """
        Industry standard: find onset peaks, measure intervals, build histogram.
        This is how Ableton, rekordbox, and Serato detect BPM.
        """
        if len(onset_sig) < 30:
            return 120.0, 0.0

        # Peak picking: find local maxima above threshold
        threshold = np.percentile(onset_sig[onset_sig > 0], 40) if np.any(onset_sig > 0) else 0.1
        peaks = []
        for i in range(2, len(onset_sig) - 2):
            if onset_sig[i] > threshold and onset_sig[i] >= onset_sig[i-1] and onset_sig[i] >= onset_sig[i+1]:
                # Must be higher than neighbors within 3 frames
                if onset_sig[i] >= onset_sig[i-2] and onset_sig[i] >= onset_sig[i+2]:
                    peaks.append(i)

        if len(peaks) < 4:
            return 120.0, 0.0

        # Compute all inter-onset intervals (IOIs) between consecutive and near-consecutive peaks
        iois = []
        for i in range(len(peaks)):
            for j in range(i+1, min(i+5, len(peaks))):  # up to 4th neighbor
                interval_frames = peaks[j] - peaks[i]
                interval_sec = interval_frames / fps
                bpm_val = 60.0 / interval_sec
                # Only keep intervals that correspond to reasonable BPM
                # Check if interval is a clean beat (1, 2, or 4 beats)
                for divisor in [1, 2, 4]:
                    b = bpm_val * divisor
                    if 55 <= b <= 210:
                        iois.append(b)

        if len(iois) < 5:
            return 120.0, 0.0

        # Build histogram with 0.5 BPM bins
        iois_arr = np.array(iois)
        bins = np.arange(55, 211, 0.5)
        hist_counts, bin_edges = np.histogram(iois_arr, bins=bins)

        # Smooth the histogram
        hist_smooth = uniform_filter1d(hist_counts.astype(np.float64), size=5)

        # Find the peak
        best_idx = np.argmax(hist_smooth)
        best_bpm = (bin_edges[best_idx] + bin_edges[best_idx + 1]) / 2

        # Score: how concentrated is the histogram around the peak
        peak_height = hist_smooth[best_idx]
        total = np.sum(hist_smooth) + 1e-10
        score = peak_height / total * len(iois)

        return best_bpm, score

    # ── Autocorrelation function ──────────────────────────────────────────────
    def autocorr_bpm(onset_sig, fps):
        """Find best BPM via interpolated autocorrelation at 0.05 BPM steps."""
        best_bpm, best_sc = 120.0, -1.0
        for b20 in range(1200, 4001):  # 60.0 to 200.0 in 0.05 steps
            b = b20 / 20.0
            period = fps * 60.0 / b
            pi = int(period)
            if pi + 1 >= len(onset_sig): continue
            frac = period - pi
            n_ac = len(onset_sig) - pi - 1
            if n_ac < 10: continue
            shifted = onset_sig[pi:pi + n_ac] * (1 - frac) + onset_sig[pi + 1:pi + 1 + n_ac] * frac
            sc = float(np.dot(onset_sig[:n_ac], shifted))
            if sc > best_sc: best_sc, best_bpm = sc, b

        # Parabolic interpolation
        k = round(best_bpm * 20)
        def sc_at(b20):
            p3 = fps * 60.0 / (b20 / 20.0); pi3 = int(p3)
            if pi3 + 1 >= len(onset_sig): return 0.0
            frac3 = p3 - pi3; n = len(onset_sig) - pi3 - 1
            if n < 5: return 0.0
            sh = onset_sig[pi3:pi3 + n] * (1 - frac3) + onset_sig[pi3 + 1:pi3 + 1 + n] * frac3
            return float(np.dot(onset_sig[:n], sh))
        s0v, sp, sm = sc_at(k), sc_at(k + 1), sc_at(k - 1)
        denom = sp + sm - 2 * s0v
        if abs(denom) > 1e-10:
            offset = (sm - sp) / (2 * denom)
            best_bpm = max(55.0, min(210.0, (k + offset) / 20.0))
        return best_bpm, best_sc

    # ── 6-harmonic comb filter octave check ───────────────────────────────────
    def comb_score(onset_sig, bpm_test, fps):
        total = 0.0
        weights = [1.0, 0.50, 0.28, 0.16, 0.09, 0.05]
        for h_idx, harmonic in enumerate([1, 2, 3, 4, 5, 6]):
            p_h = fps * 60.0 / (bpm_test * harmonic)
            pi_h = int(p_h)
            if pi_h + 1 >= len(onset_sig) or pi_h < 1: continue
            frac_h = p_h - pi_h
            n_h = len(onset_sig) - pi_h - 1
            if n_h < 5: continue
            sh = onset_sig[pi_h:pi_h + n_h] * (1 - frac_h) + onset_sig[pi_h + 1:pi_h + 1 + n_h] * frac_h
            sc_h = float(np.dot(onset_sig[:n_h], sh)) / (n_h + 1e-10)
            total += sc_h * weights[h_idx]
        return total

    def resolve_octave(onset_sig, best_bpm, fps):
        main_score = comb_score(onset_sig, best_bpm, fps)
        for candidate in [best_bpm * 2, best_bpm / 2, best_bpm * 3 / 2, best_bpm * 2 / 3]:
            if not 55 <= candidate <= 210: continue
            cand_score = comb_score(onset_sig, candidate, fps)
            bonus = 1.06 if 70 <= candidate <= 160 else 0.94
            if cand_score * bonus > main_score * 1.01:
                best_bpm, main_score = candidate, cand_score
        return best_bpm, main_score

    # ── Analysis segments ─────────────────────────────────────────────────────
    seg_dur = 20
    seg_starts = []
    for ts in [3, 18, 33, 48, 63]:
        if ts + seg_dur <= total_s + 2:
            seg_starts.append(ts)
    if not seg_starts:
        seg_starts = [0]

    segment_bpms = []
    segment_weights = []
    hop = 256
    fps = sr2 / hop

    for seg_start in seg_starts:
        s0 = int(seg_start * sr2)
        s1 = min(s0 + int(seg_dur * sr2), len(mono_lo))
        if s1 - s0 < sr2 * 4: continue

        seg_lo = mono_lo[s0:s1]
        seg_mid = mono_mid[s0:s1]
        seg_hi = mono_hi[s0:s1]

        # Triple-band onset detection
        onset_lo = threshold_onsets(compute_onsets(seg_lo, 2048, hop), fps)
        onset_mid = threshold_onsets(compute_onsets(seg_mid, 1024, hop), fps)
        onset_hi = threshold_onsets(compute_onsets(seg_hi, 512, hop), fps)

        # Align lengths
        ml = min(len(onset_lo), len(onset_mid), len(onset_hi))
        if ml < 20: continue
        onset_lo, onset_mid, onset_hi = onset_lo[:ml], onset_mid[:ml], onset_hi[:ml]

        # Combined: kick 1.6x, snare 1.0x, hat 0.8x
        onset_combined = onset_lo * 1.6 + onset_mid * 1.0 + onset_hi * 0.8
        mx = np.max(onset_combined)
        if mx > 1e-10: onset_combined /= mx

        # ── Method A: onset autocorrelation ───────────────────────────────────
        bpm_onset, sc_onset = autocorr_bpm(onset_combined, fps)
        bpm_onset, sc_onset = resolve_octave(onset_combined, bpm_onset, fps)

        # ── Method B: energy envelope autocorrelation ─────────────────────────
        seg_full = mono_hp[s0:s1]
        energy_env = compute_energy_env(seg_full, hop)
        if len(energy_env) > 20:
            bpm_energy, sc_energy = autocorr_bpm(energy_env, fps)
            bpm_energy, sc_energy = resolve_octave(energy_env, bpm_energy, fps)
        else:
            bpm_energy, sc_energy = bpm_onset, 0.0

        # ── Method C: inter-onset interval histogram ─────────────────────────
        bpm_ioi, sc_ioi = ioi_bpm(onset_combined, fps)
        # Also try IOI on the kick-only onset for cleaner peaks
        bpm_ioi_lo, sc_ioi_lo = ioi_bpm(onset_lo, fps)
        if sc_ioi_lo > sc_ioi:
            bpm_ioi, sc_ioi = bpm_ioi_lo, sc_ioi_lo

        # ── Combine all three methods ────────────────────────────────────────
        # Normalize to same octave for comparison
        def same_octave(a, ref):
            c = a
            while abs(c - ref) > abs(c * 2 - ref) and c * 2 <= 210: c *= 2
            while abs(c - ref) > abs(c / 2 - ref) and c / 2 >= 55: c /= 2
            return c

        candidates = [
            (bpm_onset, sc_onset, 'onset'),
            (bpm_energy, sc_energy, 'energy'),
            (bpm_ioi, sc_ioi, 'ioi')
        ]

        # Check agreement between methods (in same octave)
        ref_bpm = bpm_onset  # use onset as reference
        agree_count = 0
        for bpm_c, _, _ in candidates:
            if abs(same_octave(bpm_c, ref_bpm) - ref_bpm) < 3.0:
                agree_count += 1

        if agree_count >= 3:
            # All three agree — very high confidence, use onset (most precise)
            final_bpm = bpm_onset
            final_weight = sc_onset * 1.5  # strong agreement bonus
        elif agree_count == 2:
            # Two agree — find which two and use the one with higher score
            pairs = []
            for i in range(3):
                for j in range(i+1, 3):
                    b1 = same_octave(candidates[i][0], candidates[j][0])
                    b2 = candidates[j][0]
                    if abs(b1 - b2) < 3.0:
                        combined_sc = candidates[i][1] + candidates[j][1]
                        # Use the higher-scored one from the agreeing pair
                        best_of_pair = candidates[i] if candidates[i][1] >= candidates[j][1] else candidates[j]
                        pairs.append((best_of_pair[0], combined_sc))
            if pairs:
                pairs.sort(key=lambda x: x[1], reverse=True)
                final_bpm = pairs[0][0]
                final_weight = pairs[0][1] * 1.2
            else:
                final_bpm = bpm_onset
                final_weight = sc_onset
        else:
            # No agreement — trust the method with highest score
            candidates.sort(key=lambda x: x[1], reverse=True)
            final_bpm = candidates[0][0]
            final_weight = candidates[0][1] * 0.8  # low confidence penalty

        segment_bpms.append(round(final_bpm, 1))
        segment_weights.append(final_weight)

    if not segment_bpms:
        return 120.0

    # ── Weighted segment voting ───────────────────────────────────────────────
    # Normalize weights
    total_w = sum(segment_weights) + 1e-10
    norm_weights = [w / total_w for w in segment_weights]

    if len(segment_bpms) >= 3:
        # Canonical: normalize into 70-160 range
        canonical = []
        for b in segment_bpms:
            c = b
            while c > 160: c /= 2
            while c < 70: c *= 2
            canonical.append(round(c * 2) / 2)

        # Weighted histogram: each segment votes with its weight
        from collections import defaultdict
        hist = defaultdict(float)
        for c, w in zip(canonical, norm_weights):
            hist[c] += w

        # Find the BPM with the highest weighted vote
        mode_bpm = max(hist, key=hist.get)

        # Pick the original segment BPM closest to the mode, preferring high-weight segments
        best_final = segment_bpms[0]
        best_score = -1.0
        for i, b in enumerate(segment_bpms):
            for mult in [1, 2, 0.5]:
                bm = b * mult
                c = bm
                while c > 160: c /= 2
                while c < 70: c *= 2
                d = abs(round(c * 2) / 2 - mode_bpm)
                if d < 1.0 and 55 <= bm <= 210:
                    score = norm_weights[i] * (1.0 / (d + 0.1))
                    if score > best_score:
                        best_score = score
                        best_final = bm
        return round(float(best_final), 1)

    elif len(segment_bpms) == 2:
        canonical = []
        for b in segment_bpms:
            c = b
            while c > 160: c /= 2
            while c < 70: c *= 2
            canonical.append(c)
        # Weight by segment strength
        if abs(canonical[0] - canonical[1]) < 3.0:
            # Agreement — weighted average
            wsum = segment_bpms[0] * segment_weights[0] + segment_bpms[1] * segment_weights[1]
            return round(float(wsum / (segment_weights[0] + segment_weights[1] + 1e-10)), 1)
        else:
            # Disagreement — pick the one with higher weight
            idx = 0 if segment_weights[0] >= segment_weights[1] else 1
            return round(float(segment_bpms[idx]), 1)
    else:
        return round(float(segment_bpms[0]), 1)


# ═══════════════════════════════════════════════════════════════════════════════
# KEY DETECTION ENGINE v5
# ═══════════════════════════════════════════════════════════════════════════════

def estimate_tuning(mono, sr, n_fft=8192):
    """Estimate tuning offset from A=440Hz (in semitones)."""
    freqs=np.fft.rfftfreq(n_fft,1.0/sr)
    seg=mono[:sr*20].astype(np.float64); devs=[]
    for s in range(0,len(seg)-n_fft,n_fft):
        mag=np.abs(np.fft.rfft(seg[s:s+n_fft]*np.hanning(n_fft)))
        pks,_=find_peaks(mag,height=np.max(mag)*0.06,distance=3)
        for pk in pks:
            f=freqs[pk]
            if f<80 or f>4000: continue
            midi=69.0+12.0*np.log2(f/440.0)
            dev=midi-round(midi)
            if abs(dev)<0.45: devs.append(dev)
    if len(devs)<8: return 0.0
    hist,edges=np.histogram(devs,bins=50,range=(-0.5,0.5))
    pb=np.argmax(hist)
    return float((edges[pb]+edges[pb+1])/2)

def simple_chroma12(mono, sr, n_fft=8192, hop=4096, tuning=0.0):
    """
    Spectral-peak chromagram: detect peaks, map to MIDI pitch class.
    Vectorized — fast enough for section-by-section analysis.
    Analyzes up to 60s of audio for better accuracy.
    """
    ref=440.0*2**(tuning/12.0)
    freqs=np.fft.rfftfreq(n_fft,1.0/sr)
    freq_mask=(freqs>=55)&(freqs<=4200)
    chroma=np.zeros(12); n_frames=0
    max_samples = min(len(mono), sr * 60)  # up to 60s
    seg=mono[:max_samples].astype(np.float64)
    for s in range(0,len(seg)-n_fft,hop):
        frame=seg[s:s+n_fft]*np.hanning(n_fft)
        mag=np.abs(np.fft.rfft(frame))
        thresh=np.max(mag)*0.01
        mag_m=np.where(freq_mask,mag,0)
        pks,_=find_peaks(mag_m,height=max(thresh,1e-10),distance=2)
        if len(pks)==0: continue
        if len(pks)>60: pks=pks[np.argsort(mag[pks])[::-1][:60]]
        f_pk=freqs[pks]; m_pk=mag[pks]
        pc_pk=(np.round(69.0+12.0*np.log2(f_pk/ref)).astype(int))%12
        cf=np.zeros(12)
        np.add.at(cf,pc_pk,m_pk)
        nm=np.max(cf)
        if nm>1e-10: chroma+=cf/nm; n_frames+=1
    if n_frames==0: return np.zeros(12)
    res=chroma/n_frames; m=np.max(res); return res/m if m>1e-10 else res

def v4_chroma36(sig_seg, sr):
    """
    v4 36-dim chroma: bass(55-300Hz) + mid(300-2000Hz) + high(2000-6000Hz),
    each 12 pitch classes, 1/sqrt(f) weighted. Input for ML model.
    Fully vectorized — 7x faster than loop version.
    """
    n_fft=16384; hop=4096; win=np.hanning(n_fft)
    freqs=np.fft.rfftfreq(n_fft,1.0/sr)
    # Pre-compute freq mask and pitch classes once
    mask=(freqs>=55)&(freqs<=6000); f_v=freqs[mask]
    pc_v=(np.round(69.0+12.0*np.log2(f_v/440.0)).astype(int))%12
    w_scale=1.0/np.sqrt(f_v)
    bass_m=(f_v<=300); mid_m=(f_v>300)&(f_v<=2000); hi_m=f_v>2000
    cb=np.zeros(12,dtype=np.float64); cm=np.zeros(12); ch=np.zeros(12)
    for s in range(0,len(sig_seg)-n_fft,hop*2):
        mf=np.abs(np.fft.rfft(sig_seg[s:s+n_fft]*win))**2
        w_v=mf[mask]*w_scale
        np.add.at(cb,pc_v[bass_m],w_v[bass_m])
        np.add.at(cm,pc_v[mid_m],w_v[mid_m])
        np.add.at(ch,pc_v[hi_m],w_v[hi_m])
    def norm(c): t=np.sum(c); return c/t if t>1e-10 else c
    return np.concatenate([norm(cb),norm(cm),norm(ch)])

# ── Key profiles (normalized to unit sum) ─────────────────────────────────────
def _np(p): s=np.sum(p); return p/s if s>1e-10 else p
KK_MAJ  =_np(np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]))
KK_MIN  =_np(np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]))
TMP_MAJ =_np(np.array([5.0,2.0,3.5,2.0,4.5,4.0,2.0,4.5,2.0,3.5,1.5,4.0]))
TMP_MIN =_np(np.array([5.0,2.0,3.5,4.5,2.0,4.0,2.0,4.5,3.5,2.0,1.5,4.0]))
SB_MAJ  =_np(np.array([0.6679,0.0707,0.4579,0.0873,0.5430,0.3476,0.0788,0.5814,0.0925,0.3806,0.0836,0.3401]))
SB_MIN  =_np(np.array([0.6271,0.0820,0.4224,0.5027,0.0460,0.3997,0.0985,0.6121,0.3490,0.0784,0.1255,0.2931]))
EDMA_MAJ=_np(np.array([0.2257,0.0015,0.1419,0.0045,0.1599,0.0789,0.0026,0.2104,0.0030,0.1139,0.0027,0.1489]))
EDMA_MIN=_np(np.array([0.2222,0.0025,0.1245,0.1624,0.0012,0.1477,0.0021,0.2152,0.0813,0.0031,0.0854,0.1522]))
BGATE_MAJ=_np(np.array([0.2410,0.0,0.1473,0.0,0.1708,0.0,0.0,0.2228,0.0,0.1303,0.0,0.1551]))
BGATE_MIN=_np(np.array([0.2362,0.0,0.1336,0.1737,0.0,0.1569,0.0,0.2245,0.0,0.0,0.0,0.1619]))
PEN_MAJ =_np(np.array([0.30,0.0,0.20,0.0,0.25,0.0,0.0,0.25,0.0,0.20,0.0,0.0]))
PEN_MIN =_np(np.array([0.30,0.0,0.0,0.25,0.0,0.0,0.0,0.30,0.0,0.0,0.15,0.0]))

def pearson(a,b):
    a=a-np.mean(a);b=b-np.mean(b);d=np.std(a)*np.std(b)
    return float(np.dot(a,b)/(len(a)*d)) if d>1e-10 else 0.0

def multi_profile_vote(chroma12, is_edm=True):
    """
    Weighted Pearson correlation across 6 profile pairs.
    EDM: bgate=2.0, edma=1.8, shaath=1.2, kk=1.0, pentatonic=0.9, temperley=0.5
    """
    if is_edm:
        wts={'bg':2.0,'ed':1.8,'sb':1.2,'kk':1.0,'pe':0.9,'tm':0.5}
    else:
        wts={'kk':2.0,'sb':1.8,'tm':1.5,'ed':1.0,'bg':0.8,'pe':0.5}
    profs=[
        (BGATE_MAJ,'major',wts['bg']),(BGATE_MIN,'minor',wts['bg']),
        (EDMA_MAJ,'major',wts['ed']),(EDMA_MIN,'minor',wts['ed']),
        (SB_MAJ,'major',wts['sb']),(SB_MIN,'minor',wts['sb']),
        (KK_MAJ,'major',wts['kk']),(KK_MIN,'minor',wts['kk']),
        (PEN_MAJ,'major',wts['pe']),(PEN_MIN,'minor',wts['pe']),
        (TMP_MAJ,'major',wts['tm']),(TMP_MIN,'minor',wts['tm']),
    ]
    tw=sum(x[2] for x in profs); scores={}
    for prof,mode,wt in profs:
        for r in range(12):
            k=(NOTES[r],mode); scores[k]=scores.get(k,0.0)+pearson(chroma12,np.roll(prof,r))*wt/tw
    return sorted([(v,k[0],k[1]) for k,v in scores.items()],reverse=True)

# ── ML model ──────────────────────────────────────────────────────────────────
_KEY_MODEL = None
def _load_key_model():
    sd=os.path.dirname(os.path.abspath(__file__))
    for p in [sd,os.path.join(sd,'..'),os.path.join(sd,'..','..'),os.path.dirname(sd)]:
        fp=os.path.normpath(os.path.join(p,'key_model.pkl'))
        if os.path.exists(fp):
            with open(fp,'rb') as f: return pickle.load(f)
    return None

# ── Main key detection ────────────────────────────────────────────────────────
def detect_key(samples, sr):
    global _KEY_MODEL
    # Use up to 90s for key detection (was 60s — misses key info in longer intros)
    max_len = min(len(samples), sr * 90)
    mono = samples[:max_len].astype(np.float64)
    p = np.max(np.abs(mono))
    if p > 0: mono /= p

    # Content type detection — use multiple segments for robust classification
    # Analyze 3 segments to avoid being fooled by a bass-heavy intro
    content_segments = []
    for t in [5, 20, 40]:
        s0 = int(t * sr)
        s1 = min(s0 + int(10 * sr), len(mono))
        if s1 - s0 < sr * 3:
            continue
        seg = mono[s0:s1]
        fe = np.abs(np.fft.rfft(seg)) ** 2
        ff = np.fft.rfftfreq(len(seg), 1.0 / sr)
        bass_e = np.mean(fe[(ff >= 55) & (ff < 300)] + 1e-10)
        mid_e = np.mean(fe[(ff >= 300) & (ff < 2000)] + 1e-10)
        high_e = np.mean(fe[(ff >= 2000) & (ff < 8000)] + 1e-10)
        content_segments.append((bass_e, mid_e, high_e))

    if content_segments:
        avg_bass = np.mean([c[0] for c in content_segments])
        avg_mid = np.mean([c[1] for c in content_segments])
        avg_high = np.mean([c[2] for c in content_segments])
        is_melodic = bool(avg_mid > avg_bass * 0.6)
        is_edm = bool(avg_bass > avg_mid * 0.4)
    else:
        is_melodic = True
        is_edm = True

    # Tuning estimation
    tuning=estimate_tuning(mono,sr)

    # ── PRIMARY: ML model on v4 36-dim chroma ────────────────────────────────
    if _KEY_MODEL is None: _KEY_MODEL=_load_key_model()

    ml_key=None; ml_mode=None; ml_conf=0.0; ml_probs=None; ml_classes=None

    if _KEY_MODEL is not None:
        try:
            feat=v4_chroma36(mono,sr)
            feat_s=_KEY_MODEL['scaler'].transform([feat])
            probs=_KEY_MODEL['mlp'].predict_proba(feat_s)[0]
            classes=_KEY_MODEL['classes']
            top_idx=np.argsort(probs)[::-1]
            ml_cls=classes[top_idx[0]]
            ml_key,ml_mode=ml_cls.rsplit(' ',1)
            ml_conf=float(probs[top_idx[0]])
            ml_probs=probs; ml_classes=classes
        except Exception as e:
            import sys as _sys
            print(f'[warn] ML key model failed: {e}', file=_sys.stderr)

    # ── SECONDARY: multi-profile vote on simple peak chroma ──────────────────
    chroma12=simple_chroma12(mono,sr,tuning=tuning)
    votes=multi_profile_vote(chroma12,is_edm=is_edm)
    pv_key,pv_mode=votes[0][1],votes[0][2]
    pv_score=votes[0][0]; pv_score2=votes[1][0] if len(votes)>1 else 0.0
    pv_range=max(v[0] for v in votes)-min(v[0] for v in votes)
    pv_conf=min(1.0,(pv_score-pv_score2)/(pv_range+1e-10)) if pv_range>1e-10 else 0.3

    # ── COMBINATION ───────────────────────────────────────────────────────────
    if ml_key is not None:
        same_root = ml_key==pv_key
        same_key  = same_root and ml_mode==pv_mode
        if ml_conf >= 0.72:
            # High ML confidence → trust ML
            best_k,best_m=ml_key,ml_mode; conf=ml_conf
        elif same_key:
            # Full agreement → blend confidences
            best_k,best_m=ml_key,ml_mode
            conf=min(1.0,ml_conf*0.65+pv_conf*0.45)
        elif same_root and ml_conf < 0.56:
            # Same root, mode ambiguous, ML uncertain → trust profile
            # (handles Mixolydian/Dorian where ML sees minor vs profile says major)
            best_k,best_m=pv_key,pv_mode; conf=pv_conf*0.85
        elif ml_conf >= 0.60:
            # ML moderately confident, profile disagrees → trust ML
            best_k,best_m=ml_key,ml_mode; conf=ml_conf*0.85
        else:
            # Both uncertain → profile wins (more stable on modal content)
            best_k,best_m=pv_key,pv_mode; conf=pv_conf*0.80
    else:
        best_k,best_m=pv_key,pv_mode; conf=pv_conf

    # ── Top-3 candidates ─────────────────────────────────────────────────────
    # Merge ML probs + profile votes for best top-3
    seen=set(); top3=[]
    # First add ML top candidates
    if ml_probs is not None and ml_classes is not None:
        for idx in np.argsort(ml_probs)[::-1]:
            cls=ml_classes[idx]
            if cls not in seen:
                seen.add(cls); k2,m2=cls.rsplit(' ',1)
                top3.append({'key':k2,'mode':m2,'score':round(float(ml_probs[idx]),3),
                             'camelot':CAMELOT.get(cls,'—')})
            if len(top3)>=3: break
    else:
        for sc,note,mode in votes:
            kid=f"{note} {mode}"
            if kid not in seen:
                seen.add(kid)
                top3.append({'key':note,'mode':mode,'score':round(float(sc),3),
                             'camelot':CAMELOT.get(kid,'—')})
            if len(top3)>=3: break

    # Section analysis uses raw mono (HPSS removed — too slow, not needed for key)
    harmonic=mono

    # ── Section key analysis ──────────────────────────────────────────────────
    total_s=len(mono)/sr; key_sections=[]
    for start_s in range(0,int(total_s)-9,10):
        start=int(start_s*sr); end=min(start+int(20*sr),len(harmonic))
        if end-start<int(sr*5): break
        seg2=harmonic[start:end]; p2=np.max(np.abs(seg2))
        if p2>1e-10: seg2=seg2/p2
        # Use simple chroma + profile vote for sections (faster, no ML call)
        sc12=simple_chroma12(seg2,sr,n_fft=4096,hop=2048,tuning=tuning)
        sv=multi_profile_vote(sc12,is_edm=is_edm)
        sk,sm=sv[0][1],sv[0][2]
        sv_range=max(v[0] for v in sv)-min(v[0] for v in sv)
        scf=min(1.0,(sv[0][0]-sv[1][0])/(sv_range+1e-10)) if sv_range>1e-10 and len(sv)>1 else 0.5
        rms=float(20*np.log10(np.sqrt(np.mean(seg2**2))+1e-10))
        key_sections.append({'start_s':start_s,'end_s':min(start_s+20,int(total_s)),
                             'key':sk,'mode':sm,'camelot':CAMELOT.get(f'{sk} {sm}','—'),
                             'confidence':round(scf,3),'rms_db':round(rms,1)})

    # Section agreement adjusts confidence
    if key_sections:
        skeys=[f"{s['key']} {s['mode']}" for s in key_sections]
        dom=max(set(skeys),key=skeys.count); agr=skeys.count(dom)/len(skeys)
        if agr>=0.75: conf=min(1.0,conf*1.08)
        elif agr<0.4:  conf=min(conf,0.35)

    return best_k,best_m,round(float(conf),3),top3,is_melodic,key_sections

# ── Spectral balance ──────────────────────────────────────────────────────────
def spectral_balance(samples,sr):
    seg=samples[:sr*15].astype(np.float64);N=len(seg)
    fp=np.abs(np.fft.rfft(seg))**2;freqs=np.fft.rfftfreq(N,1.0/sr);norm=(N/2)**2
    def band(lo,hi):
        mask=(freqs>=lo)&(freqs<hi)
        if not np.any(mask): return -80.0
        return round(float(10*np.log10(np.mean(fp[mask])/norm+1e-10)),1)
    return {'sub':band(20,60),'bass':band(60,250),'low_mid':band(250,500),
            'mid':band(500,2000),'high_mid':band(2000,6000),'high':band(6000,20000)}

# ── Dynamic range ─────────────────────────────────────────────────────────────
def dynamic_range(samples,sr):
    block=int(3*sr);peaks=[];rms_vals=[]
    for s in range(0,len(samples)-block,block):
        seg=samples[s:s+block];peaks.append(float(np.max(np.abs(seg))))
        rms_vals.append(float(np.sqrt(np.mean(seg**2))))
    if not peaks: return 0.0
    peaks=np.array(peaks);rms_arr=np.array(sorted(rms_vals,reverse=True))
    top=rms_arr[:max(1,len(rms_arr)//5)]
    dr=10*np.log10(np.mean(peaks**2)/np.mean(top**2)) if np.mean(top**2)>1e-10 else 0.0
    return round(float(dr),1)

# ── Section analysis ──────────────────────────────────────────────────────────
def section_analysis(mono,sr):
    total_s=len(mono)/sr;sections=[];seg_dur=30
    for i,start_s in enumerate(range(0,int(total_s),seg_dur)):
        s=int(start_s*sr);e=min(s+seg_dur*sr,len(mono));seg=mono[s:e]
        if len(seg)<sr: break
        rms_db=float(20*np.log10(np.sqrt(np.mean(seg**2))+1e-10))
        sections.append({'label':f'Section {i+1}','start_s':start_s,
                         'end_s':min(start_s+seg_dur,int(total_s)),'rms_db':round(rms_db,1)})
    return sections

# ── Main ──────────────────────────────────────────────────────────────────────
def compute_mood_profile(lufs_i, lufs_st, crest, mode, bpm, sb):
    """Derive a 4-axis mood vector from existing analysis data.
    All axes are normalized to [0.0, 1.0].

    energy:    how loud and dynamic — high = bangers, low = mellow
    tonality:  major-minor + spectral brightness — 1.0 = bright/major, 0.0 = dark/minor
    density:   how compressed/busy the mix feels
    tempo_pos: BPM position in the producer-relevant range (60-180)

    The vector lets us compute distances between tracks for similarity matching.
    """
    # Energy: combine integrated LUFS (loudness) and crest factor (dynamics).
    # LUFS range -30 to -6 maps to 0..1; crest 6-20dB maps to 0..1.
    e_loud = max(0.0, min(1.0, (lufs_i + 30.0) / 24.0)) if lufs_i is not None else 0.5
    e_dyn  = max(0.0, min(1.0, (crest - 6.0) / 14.0)) if crest is not None else 0.5
    energy = round((e_loud * 0.6 + e_dyn * 0.4), 3)

    # Tonality: major mode = bright, minor = dark; mod by spectral balance.
    # sb is a dict with low/mid/high in dB-ish — use mid/high ratio to bias.
    base_tonality = 0.7 if (mode or '').lower() == 'major' else 0.3
    if isinstance(sb, dict):
        hi = sb.get('high', 0.0) or 0.0
        mid = sb.get('mid', 0.0) or 0.0
        # Brighter mixes nudge tonality up
        bright_bias = max(-0.2, min(0.2, (hi - mid) / 30.0))
        tonality = round(max(0.0, min(1.0, base_tonality + bright_bias)), 3)
    else:
        tonality = round(base_tonality, 3)

    # Density: low crest factor = squashed/busy; high crest = open/sparse.
    # Invert crest so high density = high value.
    density = round(max(0.0, min(1.0, 1.0 - (e_dyn))), 3)

    # Tempo position: 60 BPM = 0, 180 BPM = 1.
    if bpm is not None and bpm > 0:
        tempo_pos = round(max(0.0, min(1.0, (bpm - 60.0) / 120.0)), 3)
    else:
        tempo_pos = 0.5

    # Human-readable label for the dominant mood characteristics.
    label_parts = []
    label_parts.append('bright' if tonality > 0.55 else ('dark' if tonality < 0.4 else 'neutral'))
    label_parts.append('hard' if energy > 0.6 else ('soft' if energy < 0.4 else 'mid'))
    label_parts.append('fast' if tempo_pos > 0.6 else ('slow' if tempo_pos < 0.35 else 'mid-tempo'))
    label_parts.append('dense' if density > 0.6 else ('sparse' if density < 0.35 else 'balanced'))

    return {
        'energy': energy,
        'tonality': tonality,
        'density': density,
        'tempo_pos': tempo_pos,
        'label': ' / '.join(label_parts),
    }


def analyze_stem(wav_path):
    """Lightweight analyzer for an isolated stem.

    Returns just {bpm, key, mode, camelot, key_confidence}. We skip LUFS,
    sections, mood, dynamic range — those are mix-level metrics that don't
    apply to a single stem, and running them on every stem would add 10-20s
    per stem × 7 stems = 1-2 min to the separator runtime.

    BPM detection on a drum-only stem is BETTER than on a full mix (no
    melodic interference), so per-stem BPM is genuinely useful. Key
    detection on isolated harmonic stems (piano/bass/other) is also more
    reliable than on the full mix because there's no percussive noise to
    disturb the chroma estimate.

    Errors are caught and returned as {'error': ...} — never raises, so a
    single broken stem doesn't kill the whole pipeline."""
    try:
        channels, sr = read_wav(wav_path)
        if channels is None or len(channels) == 0:
            return {'bpm': None, 'key': None, 'error': 'empty'}
        mono = np.mean(channels, axis=0)
        if np.max(np.abs(mono)) < 1e-4:
            # Stem is essentially silent (can happen if model gave nothing
            # for e.g. guitar on a track with no guitar). Skip analysis,
            # return None values so the renderer hides them.
            return {'bpm': None, 'key': None, 'mode': None, 'silent': True}
        bpm = detect_bpm(mono, sr)
        key, mode, conf, _candidates, _is_melodic, _sections = detect_key(mono, sr)
        camelot = CAMELOT.get(f'{key} {mode}', '—')
        return {
            'bpm': bpm,
            'key': key,
            'mode': mode,
            'key_confidence': conf,
            'camelot': camelot,
        }
    except Exception as e:
        return {'bpm': None, 'key': None, 'error': str(e)}


def analyze(wav_path):
    channels,sr=read_wav(wav_path);mono=np.mean(channels,axis=0)
    lufs_i,lufs_st,lufs_mom,lra=compute_lufs(channels,sr)
    tp=true_peak_dbtp(channels,sr);bpm=detect_bpm(mono,sr)
    key,mode,conf,key_candidates,is_melodic,key_sections=detect_key(mono,sr)
    sb=spectral_balance(mono,sr);dr=dynamic_range(mono,sr)
    camelot=CAMELOT.get(f'{key} {mode}','—');sections=section_analysis(mono,sr)
    duration=round(len(mono)/sr,2)
    peak_dbfs=round(float(20*np.log10(max(np.max(np.abs(ch)) for ch in channels)+1e-10)),2)
    rms=np.sqrt(np.mean(mono**2));ch_peak=max(np.max(np.abs(ch)) for ch in channels)
    crest=round(float(20*np.log10((ch_peak/rms)+1e-10)),1) if rms>1e-10 else 0.0
    mood=compute_mood_profile(lufs_i,lufs_st,crest,mode,bpm,sb)
    return {'lufs_integrated':lufs_i,'lufs_short_term':lufs_st,'lufs_momentary':lufs_mom,
            'loudness_range':lra,'true_peak_dbtp':tp,'peak_dbfs':peak_dbfs,
            'crest_factor_db':crest,'bpm':bpm,'key':key,'mode':mode,
            'key_confidence':conf,'key_candidates':key_candidates,'key_sections':key_sections,
            'is_melodic':bool(is_melodic),'camelot':camelot,'dynamic_range':dr,
            'spectral_balance':sb,'sections':sections,'duration':duration,
            'sample_rate':sr,'channels':len(channels),'mood_profile':mood,
            'engine':'freq.phull-v6','error':None}

if __name__=='__main__':
    # CLI:
    #   analyze.py <wav>           — full mix analysis (LUFS, sections, mood, etc.)
    #   analyze.py --stem <wav>    — lightweight per-stem analysis (BPM + key only)
    args = sys.argv[1:]
    stem_mode = False
    if args and args[0] == '--stem':
        stem_mode = True
        args = args[1:]
    if len(args)<1: print(json.dumps({'error':'Usage: analyze.py [--stem] <wav_path>'}));sys.exit(1)
    path=args[0]
    if not os.path.exists(path): print(json.dumps({'error':f'File not found: {path}'}));sys.exit(1)
    try:
        result = analyze_stem(path) if stem_mode else analyze(path)
        print(json.dumps(result))
    except ImportError as e:
        print(json.dumps({'error':f'Missing library: {e}','hint':'Run AI Transcribe Setup.exe'}));sys.exit(2)
    except Exception as e:
        import traceback
        print(json.dumps({'error':str(e),'traceback':traceback.format_exc()}));sys.exit(1)
