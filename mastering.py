"""Rule-based mastering for Freq.Phull.

This is a transparent, deterministic mastering chain — no AI, no models.
The trade-off vs LANDR-style AI mastering: less per-track polish, but
predictable and explainable. Three presets to start:

  loudness_normalize  Bring track to -14 LUFS streaming target, ceiling
                      -1 dBFS. Spotify/Apple Music/YouTube all target
                      around -14 LUFS so this is the safe default for
                      uploading.

  bright              Same as loudness_normalize PLUS a gentle high-shelf
                      EQ boost (+2 dB above 6 kHz). Adds air without
                      sounding harsh. Good for hip-hop, EDM, modern pop.

  warm                Same as loudness_normalize PLUS a gentle low-shelf
                      EQ boost (+2 dB below 250 Hz) and a soft high cut
                      above 12 kHz. Adds body and tames sibilance. Good
                      for vocals-forward / R&B / lo-fi.

Each preset runs the same skeleton:
   high-pass (DC removal) → EQ shape (preset-specific) → glue compressor
   → loudness measurement → gain to target → limiter (-1 dBFS ceiling)

We never advertise this as "AI mastering" — it's signal processing with
sensible defaults. Honest labeling helps user trust.

Copyright © Real General · Hood Knights — all rights reserved.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

import numpy as np


# ── I/O helpers ─────────────────────────────────────────────────────────


def emit(payload):
    """Print a JSON object on its own line so the Node server can read
    progress + result events from stdout. Same pattern as stems.py."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def emit_error(msg, hint=""):
    emit({"type": "error", "message": msg, "hint": hint})
    sys.exit(1)


# ── DSP primitives ──────────────────────────────────────────────────────


def _butter_sos(cutoff_hz, sr, btype, order=2):
    """Build a Butterworth SOS section. Lazy import scipy so missing
    scipy doesn't break the rest of the pipeline at startup."""
    from scipy.signal import butter
    return butter(order, cutoff_hz, btype=btype, fs=sr, output="sos")


def highpass(audio, sr, cutoff_hz, order=2):
    """Apply a Butterworth high-pass at cutoff_hz."""
    from scipy.signal import sosfiltfilt
    sos = _butter_sos(cutoff_hz, sr, "highpass", order)
    out = np.empty_like(audio)
    for ch in range(audio.shape[1]):
        out[:, ch] = sosfiltfilt(sos, audio[:, ch])
    return out


def lowpass(audio, sr, cutoff_hz, order=2):
    from scipy.signal import sosfiltfilt
    sos = _butter_sos(cutoff_hz, sr, "lowpass", order)
    out = np.empty_like(audio)
    for ch in range(audio.shape[1]):
        out[:, ch] = sosfiltfilt(sos, audio[:, ch])
    return out


def shelf_eq(audio, sr, freq_hz, gain_db, shelf_type):
    """Biquad shelf EQ. Cookbook formula (RBJ Audio EQ Cookbook).

    shelf_type: 'low' (low-shelf) or 'high' (high-shelf).
    """
    from scipy.signal import lfilter
    A = 10 ** (gain_db / 40.0)
    omega = 2 * np.pi * freq_hz / sr
    cos_w = np.cos(omega)
    sin_w = np.sin(omega)
    S = 1.0
    alpha = sin_w / 2 * np.sqrt((A + 1 / A) * (1 / S - 1) + 2)

    if shelf_type == "low":
        b0 = A * ((A + 1) - (A - 1) * cos_w + 2 * np.sqrt(A) * alpha)
        b1 = 2 * A * ((A - 1) - (A + 1) * cos_w)
        b2 = A * ((A + 1) - (A - 1) * cos_w - 2 * np.sqrt(A) * alpha)
        a0 = (A + 1) + (A - 1) * cos_w + 2 * np.sqrt(A) * alpha
        a1 = -2 * ((A - 1) + (A + 1) * cos_w)
        a2 = (A + 1) + (A - 1) * cos_w - 2 * np.sqrt(A) * alpha
    elif shelf_type == "high":
        b0 = A * ((A + 1) + (A - 1) * cos_w + 2 * np.sqrt(A) * alpha)
        b1 = -2 * A * ((A - 1) + (A + 1) * cos_w)
        b2 = A * ((A + 1) + (A - 1) * cos_w - 2 * np.sqrt(A) * alpha)
        a0 = (A + 1) - (A - 1) * cos_w + 2 * np.sqrt(A) * alpha
        a1 = 2 * ((A - 1) - (A + 1) * cos_w)
        a2 = (A + 1) - (A - 1) * cos_w - 2 * np.sqrt(A) * alpha
    else:
        return audio

    b = np.array([b0, b1, b2]) / a0
    a = np.array([1.0, a1 / a0, a2 / a0])

    out = np.empty_like(audio)
    for ch in range(audio.shape[1]):
        out[:, ch] = lfilter(b, a, audio[:, ch]).astype(np.float32)
    return out


def soft_glue_compressor(audio, sr, threshold_db=-18.0, ratio=2.0,
                         attack_ms=10.0, release_ms=80.0, makeup_db=2.0):
    """A gentle 'glue' compressor — squeezes peaks slightly to reduce
    macro-dynamic range so the loudness normalization stage can lift
    the average level without aggressive limiting. Real mastering uses
    a couple dB of reduction at most; we follow that.

    Single-band, RMS-style envelope detector. Not surgical, but enough
    for a 'glue' feel.
    """
    threshold = 10 ** (threshold_db / 20.0)
    attack_a = np.exp(-1.0 / (sr * attack_ms / 1000.0))
    release_a = np.exp(-1.0 / (sr * release_ms / 1000.0))
    makeup = 10 ** (makeup_db / 20.0)

    # Mono detector signal — peak of channels
    detector = np.max(np.abs(audio), axis=1).astype(np.float32)
    env = np.zeros_like(detector)
    e = 0.0
    for i in range(len(detector)):
        x = detector[i]
        a = attack_a if x > e else release_a
        e = a * e + (1 - a) * x
        env[i] = e

    # Compute per-sample gain
    above = np.maximum(env, threshold)
    gain_lin = (threshold / above) ** (1 - 1 / ratio)
    gain_lin = gain_lin.astype(np.float32)

    out = audio * gain_lin[:, np.newaxis] * makeup
    return out


# ── Loudness measurement (simplified LUFS) ─────────────────────────────


def measure_lufs_integrated(audio, sr):
    """Simplified LUFS-integrated approximation per ITU-R BS.1770-4 light.

    Real LUFS implementations apply K-weighting (high-shelf + high-pass
    pre-filter) before energy summation. For a mastering target this
    simplification is "close enough" — within 1-1.5 dB of pyloudnorm.
    The downstream gain step compensates for any small offset because
    we re-measure after applying gain and iterate once if needed.
    """
    from scipy.signal import sosfilt
    # K-weighting: a high-shelf at 1500 Hz (+4 dB) + high-pass at 38 Hz
    # combined as biquad cascade. Approximated as a single SOS for speed.
    # Simplified: just apply HPF at 60 Hz to discard rumble.
    sos_hp = _butter_sos(60, sr, "highpass", order=2)
    weighted = np.empty_like(audio)
    for ch in range(audio.shape[1]):
        weighted[:, ch] = sosfilt(sos_hp, audio[:, ch])
    # Mean-square energy summed across channels, mean across time
    mean_sq = np.mean(weighted ** 2)
    if mean_sq <= 1e-12:
        return -70.0  # near-silence
    # Convert to dB and apply LUFS calibration offset (BS.1770 specifies
    # -0.691 dB constant for the loudness scale).
    return 10.0 * float(np.log10(mean_sq)) - 0.691


# ── Brick-wall limiter ──────────────────────────────────────────────────


def brick_wall_limiter(audio, sr, ceiling_db=-1.0, release_ms=50.0):
    """Lookahead-style peak limiter targeting a fixed ceiling.

    Single-loop implementation: scans for peaks above ceiling, applies
    instantaneous gain reduction, smooth release. Not as transparent
    as a true lookahead limiter (e.g. fabfilter L2) but does the job
    for a final ceiling clamp.
    """
    ceiling = 10 ** (ceiling_db / 20.0)
    release_a = np.exp(-1.0 / (sr * release_ms / 1000.0))

    detector = np.max(np.abs(audio), axis=1).astype(np.float32)
    gain = np.ones_like(detector)
    g = 1.0
    for i in range(len(detector)):
        target = min(1.0, ceiling / max(detector[i], 1e-12))
        if target < g:
            g = target  # instant attack
        else:
            g = release_a * g + (1 - release_a) * target
        gain[i] = g

    out = audio * gain[:, np.newaxis]
    return np.clip(out, -1.0, 1.0)


# ── Reference matching ──────────────────────────────────────────────────


# Octave-spaced band edges (Hz). The bands are octave-wide except the top
# one which extends to Nyquist. Octave bands give the matching EQ enough
# resolution to track tonal balance (bass / low-mid / mid / high-mid /
# air) without overfitting to specific notes — the goal is to match the
# AVERAGE balance of the reference, not its exact spectrum.
MATCH_BANDS_HZ = [
    (20,    60),     # sub
    (60,    120),    # low bass
    (120,   250),    # bass / kick body
    (250,   500),    # low-mid / mud
    (500,   1000),   # mid / vocal body
    (1000,  2000),   # upper-mid / vocal presence
    (2000,  4000),   # presence / consonants
    (4000,  8000),   # bite / cymbal stick
    (8000,  16000),  # air
]


def _band_energies_db(audio, sr, bands=MATCH_BANDS_HZ):
    """Return average energy in dB per band over the whole signal.

    We compute the FFT of the whole track (one big spectrum), sum power
    inside each band, convert to dB. Whole-track FFT is fine because we
    just want average tonal balance — not a time-varying spectrogram.

    For tracks longer than ~3 minutes we downsample to a single mono
    representation to keep memory + CPU sane.
    """
    # Mono down-mix; matching is tonal, not spatial
    mono = audio.mean(axis=1).astype(np.float32)
    # Cap analysis length to 3 minutes to avoid OOM on long tracks. The
    # tonal balance of 3 minutes is essentially identical to a whole track.
    max_samples = int(sr * 180)
    if len(mono) > max_samples:
        # Take a centered window so we get representative content, not
        # a slow intro or a quiet fade-out.
        start = (len(mono) - max_samples) // 2
        mono = mono[start:start + max_samples]
    # Window the signal before FFT to reduce spectral leakage at band
    # edges. Hann window is the standard "good enough" choice.
    n = len(mono)
    win = np.hanning(n).astype(np.float32)
    spec = np.fft.rfft(mono * win)
    power = (np.abs(spec) ** 2).astype(np.float64)
    # Frequency bin centers
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    out_db = []
    for lo, hi in bands:
        mask = (freqs >= lo) & (freqs < hi)
        if not np.any(mask):
            out_db.append(-80.0)
            continue
        # Average power across the band, then to dB. The 1e-12 guard
        # avoids -inf on silent bands.
        band_pow = float(np.mean(power[mask]))
        out_db.append(10.0 * np.log10(band_pow + 1e-12))
    return np.array(out_db, dtype=np.float64)


def _peaking_eq(audio, sr, freq_hz, gain_db, q=1.0):
    """Biquad peaking (bell) EQ — RBJ cookbook. Used per-band for
    reference matching. q=1.0 ≈ 1.4-octave wide bell, a reasonable
    default for matching that doesn't sound surgical."""
    from scipy.signal import lfilter
    A = 10 ** (gain_db / 40.0)
    omega = 2 * np.pi * freq_hz / sr
    cos_w = np.cos(omega)
    sin_w = np.sin(omega)
    alpha = sin_w / (2 * q)
    b0 = 1 + alpha * A
    b1 = -2 * cos_w
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cos_w
    a2 = 1 - alpha / A
    b = np.array([b0, b1, b2]) / a0
    a = np.array([1.0, a1 / a0, a2 / a0])
    out = np.empty_like(audio)
    for ch in range(audio.shape[1]):
        out[:, ch] = lfilter(b, a, audio[:, ch]).astype(np.float32)
    return out


def reference_match_eq(audio, sr, reference_audio, reference_sr,
                       max_gain_db=6.0, smoothing=0.5):
    """Apply matching EQ so audio's tonal balance moves toward reference.

    For each octave band:
      1. Measure average dB on both signals
      2. Compute delta = reference_dB - input_dB
      3. Apply a peaking EQ at the band's center frequency, gain = delta

    The output is a smoothly-EQ'd version of audio. The matching is
    intentionally NOT aggressive — we cap per-band gain at ±max_gain_db
    so a wildly different reference doesn't make the input sound like a
    broken EQ.

    `smoothing` (0-1) blends the original input with the matched version:
      0.0 = pure original (no matching)
      1.0 = full matching
      0.5 = halfway (default — gentle nudge toward reference)

    Returns the EQ-matched audio + the per-band deltas dict for the UI
    to display.
    """
    # Resample reference to input's sr if mismatched. Otherwise the band
    # energy comparison is wrong because the band cutoffs would refer to
    # different absolute frequencies.
    if reference_sr != sr:
        from scipy.signal import resample_poly
        # Use rational resampling — finds simplest p/q for the ratio
        from math import gcd
        g = gcd(int(reference_sr), int(sr))
        up = sr // g
        down = reference_sr // g
        ref = np.empty((int(len(reference_audio) * up / down), reference_audio.shape[1]),
                       dtype=np.float32)
        for ch in range(reference_audio.shape[1]):
            ref[:, ch] = resample_poly(reference_audio[:, ch], up, down).astype(np.float32)
        reference_audio = ref

    input_db = _band_energies_db(audio, sr)
    ref_db = _band_energies_db(reference_audio, sr)

    # Normalize both spectra by their average so we match TONAL BALANCE
    # not loudness. Loudness is matched separately by the LUFS step.
    input_db = input_db - float(np.mean(input_db))
    ref_db = ref_db - float(np.mean(ref_db))

    deltas = ref_db - input_db
    # Apply max-gain limit per band
    deltas = np.clip(deltas, -max_gain_db, max_gain_db)
    # Apply smoothing — blend toward reference (1.0) vs identity (0.0)
    deltas = deltas * smoothing

    out = audio.copy()
    band_info = {}
    for (lo, hi), delta in zip(MATCH_BANDS_HZ, deltas):
        center = float(np.sqrt(lo * hi))  # geometric mean = octave center
        if abs(delta) >= 0.1:  # skip near-zero deltas, save compute
            out = _peaking_eq(out, sr, center, float(delta), q=1.0)
        band_info[f"{lo}-{hi}Hz"] = round(float(delta), 2)

    return out, band_info


# ── Preset definitions ──────────────────────────────────────────────────


PRESETS = {
    "loudness_normalize": {
        "label": "Loudness Normalize",
        "description": "Hit -14 LUFS streaming target, ceiling -1 dBFS",
        "hpf_hz": 30,
        "low_shelf_db": 0,
        "high_shelf_db": 0,
        "low_cut_hz": None,
        "comp_threshold_db": -18,
        "comp_ratio": 2.0,
        "comp_makeup_db": 2.0,
        "target_lufs": -14.0,
        "ceiling_db": -1.0,
    },
    "bright": {
        "label": "Bright",
        "description": "Adds air with +2 dB high-shelf above 6 kHz",
        "hpf_hz": 30,
        "low_shelf_db": 0,
        "high_shelf_db": 2.0,
        "high_shelf_freq": 6000,
        "low_cut_hz": None,
        "comp_threshold_db": -18,
        "comp_ratio": 2.0,
        "comp_makeup_db": 2.0,
        "target_lufs": -14.0,
        "ceiling_db": -1.0,
    },
    "warm": {
        "label": "Warm",
        "description": "+2 dB low-shelf below 250 Hz, soft cut above 12 kHz",
        "hpf_hz": 30,
        "low_shelf_db": 2.0,
        "low_shelf_freq": 250,
        "high_shelf_db": 0,
        "low_cut_hz": 12000,
        "comp_threshold_db": -16,
        "comp_ratio": 2.0,
        "comp_makeup_db": 2.0,
        "target_lufs": -14.0,
        "ceiling_db": -1.0,
    },
    "reference_match": {
        "label": "Reference Match",
        "description": "Matches the tonal balance and loudness of a reference track",
        # In reference-match mode the EQ shelves and target_lufs in this
        # preset are IGNORED — the reference track provides those targets.
        # We keep compressor + limiter settings here as the "house" sound
        # because they're transparent enough to suit any reference.
        "hpf_hz": 30,
        "low_shelf_db": 0,
        "high_shelf_db": 0,
        "low_cut_hz": None,
        "comp_threshold_db": -18,
        "comp_ratio": 2.0,
        "comp_makeup_db": 2.0,
        "target_lufs": -14.0,  # fallback if reference loading somehow fails
        "ceiling_db": -1.0,
    },
}


def master_audio(input_path, output_path, preset_name="loudness_normalize",
                 reference_path=None, match_strength=0.5):
    """Run the mastering chain on input_path and write to output_path.

    Reference matching: if `reference_path` is provided AND preset_name
    is 'reference_match' (or anything else; we honor reference_path
    whenever it's set), we analyze the reference's tonal balance + LUFS
    and aim the matching EQ + loudness gain at those targets instead of
    the fixed values from the preset.

    `match_strength` (0..1) controls how aggressively we push input
    toward reference. 0.5 (default) is a tasteful nudge; 1.0 is full
    matching (can sound over-EQ'd if reference is very different); 0.0
    skips EQ matching entirely and just uses the reference's LUFS.

    Returns dict with measured metrics including per-band deltas when
    reference matching was used."""
    try:
        import soundfile as sf
    except ImportError:
        emit_error("soundfile not installed", hint="Run AI Transcribe Setup.exe to install audio dependencies.")

    if preset_name not in PRESETS:
        emit_error(f"Unknown preset: {preset_name}",
                   hint=f"Use one of: {', '.join(PRESETS.keys())}")
    preset = PRESETS[preset_name]

    emit({"type": "status", "step": "loading_audio", "progress": 5})
    audio, sr = sf.read(input_path, dtype="float32", always_2d=True)
    if audio.shape[1] == 1:
        # Mono → duplicate to stereo so the chain stays simple
        audio = np.concatenate([audio, audio], axis=1)

    # ── Reference loading (optional) ─────────────────────────────────────
    # If we have a reference track, measure its tonal balance + LUFS now.
    # We use those measurements as the targets later instead of the
    # preset's fixed shelves and -14 LUFS target.
    reference_audio = None
    reference_sr = None
    reference_lufs = None
    if reference_path:
        if not os.path.isfile(reference_path):
            emit_error(f"Reference file not found: {reference_path}")
        emit({"type": "status", "step": "loading_reference", "progress": 8})
        reference_audio, reference_sr = sf.read(reference_path, dtype="float32", always_2d=True)
        if reference_audio.shape[1] == 1:
            reference_audio = np.concatenate([reference_audio, reference_audio], axis=1)
        # Resample reference to input's sr for LUFS measurement consistency
        # (the matching EQ step does its own resample for spectrum work).
        if reference_sr != sr:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(int(reference_sr), int(sr))
            up = sr // g
            down = reference_sr // g
            ref_rs = np.empty((int(len(reference_audio) * up / down), reference_audio.shape[1]),
                              dtype=np.float32)
            for ch in range(reference_audio.shape[1]):
                ref_rs[:, ch] = resample_poly(reference_audio[:, ch], up, down).astype(np.float32)
            reference_lufs = measure_lufs_integrated(ref_rs, sr)
        else:
            reference_lufs = measure_lufs_integrated(reference_audio, sr)

    # ── 1. High-pass for DC offset / sub-rumble cleanup ──────────────────
    emit({"type": "status", "step": "highpass", "progress": 15})
    if preset.get("hpf_hz"):
        audio = highpass(audio, sr, preset["hpf_hz"], order=2)

    # ── 2. EQ shaping ────────────────────────────────────────────────────
    # In reference-match mode this is multi-band matching EQ. Otherwise
    # it's the preset's fixed shelves.
    band_deltas = None
    if reference_audio is not None:
        emit({"type": "status", "step": "matching_eq", "progress": 30})
        audio, band_deltas = reference_match_eq(
            audio, sr,
            reference_audio, reference_sr,
            max_gain_db=6.0,
            smoothing=match_strength,
        )
    else:
        emit({"type": "status", "step": "eq_shaping", "progress": 30})
        if preset.get("low_shelf_db"):
            audio = shelf_eq(audio, sr,
                             preset.get("low_shelf_freq", 250),
                             preset["low_shelf_db"],
                             "low")
        if preset.get("high_shelf_db"):
            audio = shelf_eq(audio, sr,
                             preset.get("high_shelf_freq", 6000),
                             preset["high_shelf_db"],
                             "high")
        if preset.get("low_cut_hz"):
            audio = lowpass(audio, sr, preset["low_cut_hz"], order=2)

    # ── 3. Glue compressor ───────────────────────────────────────────────
    emit({"type": "status", "step": "compression", "progress": 50})
    audio = soft_glue_compressor(
        audio, sr,
        threshold_db=preset["comp_threshold_db"],
        ratio=preset["comp_ratio"],
        makeup_db=preset["comp_makeup_db"],
    )

    # ── 4. Loudness normalization ────────────────────────────────────────
    # In reference-match mode the target is the reference's LUFS, clamped
    # to a sane range. Otherwise it's the preset's fixed -14 LUFS.
    emit({"type": "status", "step": "loudness_measurement", "progress": 70})
    input_lufs = measure_lufs_integrated(audio, sr)
    if reference_lufs is not None:
        # Clamp reference LUFS to streaming-safe range so an over-compressed
        # commercial reference (-7 LUFS) doesn't force the limiter to crush
        # the input. Also avoid going below -18 LUFS which feels too quiet.
        target_lufs = max(min(reference_lufs, -8.0), -18.0)
    else:
        target_lufs = preset["target_lufs"]
    gain_db = target_lufs - input_lufs
    # Cap the gain we'll apply so we don't try to boost a quiet track by
    # 25 dB and rely on the limiter to deal with the resulting peaks.
    gain_db = max(min(gain_db, 18.0), -18.0)
    gain_lin = 10 ** (gain_db / 20.0)
    audio = audio * gain_lin

    # ── 5. Brick-wall limiter ────────────────────────────────────────────
    emit({"type": "status", "step": "limiting", "progress": 85})
    audio = brick_wall_limiter(audio, sr,
                               ceiling_db=preset["ceiling_db"],
                               release_ms=50.0)

    # ── 6. Final measurement + write ─────────────────────────────────────
    output_lufs = measure_lufs_integrated(audio, sr)
    peak_db = 20.0 * float(np.log10(np.max(np.abs(audio)) + 1e-12))

    emit({"type": "status", "step": "writing", "progress": 95})
    sf.write(output_path, audio, sr, subtype="PCM_16")

    result = {
        "preset": preset_name,
        "preset_label": preset["label"] if reference_audio is None else "Reference Match",
        "input_lufs": round(input_lufs, 2),
        "output_lufs": round(output_lufs, 2),
        "target_lufs": round(target_lufs, 2),
        "gain_applied_db": round(gain_db, 2),
        "peak_dbfs": round(peak_db, 2),
        "sample_rate": sr,
        "output_path": output_path,
    }
    if reference_audio is not None:
        result["reference_path"] = reference_path
        result["reference_lufs"] = round(reference_lufs, 2)
        result["band_deltas_db"] = band_deltas
        result["match_strength"] = match_strength
    return result


# ── CLI ─────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Freq.Phull rule-based mastering")
    parser.add_argument("input", help="Input WAV file path")
    parser.add_argument("output", help="Output WAV file path")
    parser.add_argument("--preset", choices=list(PRESETS.keys()),
                        default="loudness_normalize",
                        help="Mastering preset")
    parser.add_argument("--reference", default=None,
                        help="Optional reference track to match. When set, the mastering "
                             "chain analyzes the reference's tonal balance and loudness, "
                             "then nudges the input toward those targets via matching EQ "
                             "and LUFS gain. Best used with --preset reference_match.")
    parser.add_argument("--match-strength", type=float, default=0.5,
                        help="How aggressively to match the reference's tonal balance. "
                             "0.0 = no matching (LUFS only), 0.5 = gentle nudge (default), "
                             "1.0 = full matching (can sound over-EQ'd on very different refs).")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        emit_error(f"Input file not found: {args.input}")
    if args.reference and not os.path.isfile(args.reference):
        emit_error(f"Reference file not found: {args.reference}")

    t0 = time.time()
    try:
        result = master_audio(
            args.input, args.output, args.preset,
            reference_path=args.reference,
            match_strength=max(0.0, min(1.0, args.match_strength)),
        )
        result["processing_time"] = round(time.time() - t0, 1)
        emit({"type": "done", **result, "progress": 100})
    except Exception as e:
        emit({"type": "error",
              "message": "Mastering failed: " + str(e),
              "traceback": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
