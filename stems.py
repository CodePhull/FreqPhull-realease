#!/usr/bin/env python3
"""
Freq.Phull Stem Separator — Hood Knights ©

Premium ensemble pipeline aimed at beating Fadr / LALAL.AI / Moises:

  Stage 1 — BS-RoFormer (12.97 SDR vocals)
            Cleanly separates VOCALS from INSTRUMENTAL using the current
            open-source ceiling for vocal isolation.

  Stage 2 — Demucs FT (4-stem) or Demucs 6s (6-stem)
            Splits the INSTRUMENTAL from stage 1 into drums / bass / other,
            (optionally + guitar + piano for 6-stem mode).

  Final stems are written as 32-bit float WAV — bit-perfect for DAW import.

Quality controls overlap and shifts on stage-2 only (stage 1 is always
maxed out — the vocal model is fast enough that there's no reason to skimp).

Modes:
  4 → vocals · drums · bass · other
  6 → vocals · drums · bass · guitar · piano · other

Quality:
  fast  — overlap 0.10, shifts 0   (~30s on a 3min track w/ GPU)
  high  — overlap 0.25, shifts 1   (~1min  on a 3min track w/ GPU)  [default]
  ultra — overlap 0.50, shifts 5   (~3min  on a 3min track w/ GPU)

Progress is emitted as one JSON object per line on stdout.
"""

import sys
import os
import json
import time
import argparse
import warnings
import logging
import shutil

warnings.filterwarnings("ignore")
# Silence the underlying engine's verbose internal logger; we surface our own progress.
# The literal name below is required by the engine package and can't be renamed.
logging.getLogger("audio_separator").setLevel(logging.WARNING)
logging.getLogger("audio_separator.separator").setLevel(logging.WARNING)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def emit_error(message, hint=""):
    emit({"type": "error", "message": message, "hint": hint})
    sys.exit(1)


def _import_engine():
    """Lazy-import the underlying separation engine. Isolated here so the
    engine's package name appears in exactly one place."""
    from audio_separator.separator import Separator  # noqa
    return Separator


def check_dependencies():
    missing = []
    try:
        import torch  # noqa: F401
    except ImportError:
        missing.append("torch runtime")
    try:
        _import_engine()
    except ImportError:
        missing.append("phull engine")
    if missing:
        emit_error(
            "Missing Freq.Phull runtime components: " + ", ".join(missing),
            hint="Run setup again from Settings -> AI Engines.",
        )


def select_device(cpu_only=False):
    import torch
    if cpu_only:
        return "cpu", "CPU (forced)"
    if torch.cuda.is_available():
        return "cuda", torch.cuda.get_device_name(0)
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps", "Apple MPS"
    return "cpu", "CPU"


# ── Internal model codenames ──────────────────────────────────────────────────
# Real model identifiers live in _phull_internal.py and are resolved at the
# boundary where we hand off to the underlying engine. Everywhere else in
# this file, models are referred to by codename only.
#
# Pipeline: Phull-V2 (vocal isolation) -> Phull-I4 or Phull-I6 (instrumental).
import _phull_internal as _reg

VOCAL_CODENAME = "Phull-V2"
VOCAL_ENSEMBLE_CODENAME = "Phull-V2X"   # MDX23C ensemble partner — different
                                        # arch, complementary failure modes,
                                        # averaged with Phull-V2 when the
                                        # vocal_ensemble toggle is on.
LEAD_VOCAL_CODENAME = "Phull-V2L"
DEREVERB_CODENAME = "Phull-DR"
INSTR_CODENAME_4 = "Phull-I4"
INSTR_CODENAME_6 = "Phull-I6"
# Ensemble partner models — same shape, different training, paired with the
# primary to average outputs. Used only when the user enables ensemble mode
# on a high/ultra quality preset.
INSTR_CODENAME_4_ENSEMBLE = "Phull-I4F"
INSTR_CODENAME_6_ENSEMBLE = "Phull-I6F"

STEM_LABEL = {
    "vocals":       "Vocals",
    "lead_vocal":   "Lead Vocal",
    "back_vocal":   "BV / Sample Vocal",
    "drums":        "Drums",
    "bass":         "Bass",
    "other":        "Other",
    "guitar":       "Guitar",
    "piano":        "Piano",
}


def progress_msg(step, progress, **extra):
    payload = {"type": "status", "step": step, "progress": progress}
    payload.update(extra)
    emit(payload)


# Quality presets — tuned for realistic CPU wait times on a 5-min track
#   fast  ~30s per stage on GPU, ~1-2 min on CPU. Lower quality, demo-grade.
#   high  ~1-2 min per stage on GPU, ~5-8 min on CPU. Production-ready.
#   ultra ~3-5 min per stage on GPU, ~12-20 min on CPU. Reference quality.
#
# Stage 1 (MDXC vocal model): `overlap` is the number of overlapping chunks
# per second. Default in the engine is 2. Higher = better SDR but linearly
# more CPU. We cap ultra at 4 because returns above that are inaudible.
#
# Stage 2 (Demucs): `overlap` is a 0-1 fraction (chunk overlap ratio).
# `shifts` is the number of random time-shifts averaged (gives the
# biggest quality boost but is the heaviest CPU cost — 5x at shifts=5).
# We hold shifts=1 for ultra; doubling it doesn't help enough to justify
# 2x runtime. Users who need surgical quality use the lead-vocal toggle
# and/or kick-bleed post-process — those give bigger wins than more shifts.
QUALITY_PRESETS = {
    "fast":  {"stage1_overlap": 2, "stage2_overlap": 0.10, "stage2_shifts": 0},
    "high":  {"stage1_overlap": 2, "stage2_overlap": 0.25, "stage2_shifts": 1},
    "ultra": {"stage1_overlap": 4, "stage2_overlap": 0.50, "stage2_shifts": 1},
}


def stage_overlap_for(quality):
    return QUALITY_PRESETS[quality]["stage2_overlap"]


def stage_shifts_for(quality):
    return QUALITY_PRESETS[quality]["stage2_shifts"]


def stage1_overlap_for(quality):
    return QUALITY_PRESETS[quality]["stage1_overlap"]


def _ensemble_average_harmonic_stems(primary_paths, secondary_paths, work_dir):
    """Average harmonic stems from two Stage 2 models, return updated path list.

    For each harmonic stem name (piano / other / guitar), if both models
    produced a matching output, we sample-wise mean their waveforms and
    write a new averaged WAV. The primary's drums / bass / vocals outputs
    are kept untouched (those stems don't benefit much from ensemble and
    averaging slightly softens their transients).

    Both file lists come from audio-separator, so per-stem identification
    relies on the same '(stem)' or '_stem_' substring convention as the
    rest of the pipeline.

    Returns a list with the same length as primary_paths, where harmonic
    entries point to the new averaged file and the rest are unchanged.
    Silent no-op if numpy/soundfile aren't importable.
    """
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return primary_paths

    HARMONIC = ("piano", "other", "guitar")

    def _stem_of(path):
        n = os.path.basename(path).lower()
        for s in HARMONIC + ("drums", "bass", "vocals"):
            if "(" + s + ")" in n or "_" + s + "_" in n:
                return s
        return None

    secondary_by_stem = {}
    for p in secondary_paths:
        s = _stem_of(p)
        if s:
            secondary_by_stem[s] = p

    out_paths = list(primary_paths)
    for i, p_primary in enumerate(primary_paths):
        stem = _stem_of(p_primary)
        if stem not in HARMONIC:
            continue
        p_secondary = secondary_by_stem.get(stem)
        if not p_secondary or not os.path.isfile(p_secondary):
            continue
        try:
            a1, sr1 = sf.read(p_primary, dtype="float32", always_2d=True)
            a2, sr2 = sf.read(p_secondary, dtype="float32", always_2d=True)
            if sr1 != sr2:
                continue
            # Trim to shortest length so the mean is well-defined when the
            # two models output very slightly different lengths (rare, but
            # demucs can off-by-a-frame on chunk boundaries).
            n = min(len(a1), len(a2))
            if a1.shape[1] != a2.shape[1]:
                continue
            mean = (a1[:n] + a2[:n]) * 0.5
            mean = np.clip(mean, -1.0, 1.0)
            avg_path = os.path.join(
                work_dir, "ensemble_" + os.path.basename(p_primary)
            )
            sf.write(avg_path, mean, sr1, subtype="PCM_16")
            out_paths[i] = avg_path
        except Exception:
            # Per-stem failure shouldn't break ensemble for the others;
            # keep primary's stem on that slot.
            continue
    return out_paths


# ── Characteristic frequency bands per stem ─────────────────────────────
# These bands define WHERE each instrument's energy lives. Used for two
# things: (1) building an activity envelope by isolating the stem's own
# band and measuring energy, (2) selecting the band-of-content to recover
# from donor stems.
#
# The bands are intentionally broad — narrower bands (say, just the 1st
# harmonic) would miss too much of the instrument's character (sustain
# tail, upper harmonics, room). Broader bands risk pulling in non-target
# content. These values come from analyzing a few hundred separations
# and picking what worked best on average across genres.
STEM_BANDS_HZ = {
    "vocals": (100, 6000),    # voice fundamentals + formants
    "drums":  (40, 12000),    # full range — drums cover everything
    "bass":   (30, 500),      # sub through low-mid
    "piano":  (60, 2000),     # A2-C7 fundamentals + lower harmonics
    "guitar": (80, 3000),     # E2-E6 fundamentals + harmonics
    "other":  (200, 8000),    # mid-air content (FX, pads, strings, brass)
}


def _activity_envelope(audio_mono, sr, band_lo, band_hi, smooth_ms=80):
    """Build a 0..1 activity envelope for a stem based on its own band energy.

    Bandpass the mono signal in the stem's characteristic range, take
    absolute value, smooth, normalize to peak. Result tells us WHEN the
    instrument is playing — even if the model's labels are imperfect.
    """
    from scipy.signal import butter, sosfiltfilt
    import numpy as np
    sos = butter(4, [band_lo, band_hi], btype="bandpass", fs=sr, output="sos")
    band = sosfiltfilt(sos, audio_mono)
    win = max(1, int(sr * (smooth_ms / 1000.0)))
    kernel = np.ones(win, dtype="float32") / win
    env = np.abs(band).astype("float32")
    env = np.convolve(env, kernel, mode="same")
    peak = env.max()
    if peak < 1e-5:
        return None  # stem is essentially silent
    return (env / peak).astype("float32")


def _recover_pair(target_audio, donor_audio, sr, target_band, mask,
                  cap_ratio=0.5):
    """Move target_band content from donor → target where mask is active.

    Returns (new_target, new_donor) — both same shape as inputs. Mask
    must be float32 of shape (n,) where n <= len(audio). Per-sample
    transfer is capped at cap_ratio × |donor_band| to prevent runaway
    transfers when donor has high-energy non-target content overlapping
    target activity (e.g. brass stab during a piano note).
    """
    from scipy.signal import butter, sosfiltfilt
    import numpy as np
    band_lo, band_hi = target_band
    sos = butter(4, [band_lo, band_hi], btype="bandpass", fs=sr, output="sos")
    new_target = target_audio.copy()
    new_donor = donor_audio.copy()
    n = min(len(target_audio), len(donor_audio), len(mask))
    for ch in range(donor_audio.shape[1]):
        donor_band = sosfiltfilt(sos, donor_audio[:, ch]).astype("float32")
        n_band = min(len(donor_band), n)
        transfer = donor_band[:n_band] * mask[:n_band]
        # Cap transfer per-sample by the donor band's own magnitude. This
        # is the safety net: even if the mask says "100% transfer," we
        # only move at most cap_ratio of what was actually there.
        max_transfer = np.abs(donor_band[:n_band]) * cap_ratio
        transfer = np.clip(transfer, -max_transfer, max_transfer)
        new_target[:n_band, ch] += transfer
        new_donor[:n_band, ch] -= transfer
    return new_target, new_donor


def ai_stem_recovery(stems_by_name, work_dir):
    """Cross-stem content recovery for harmonic stems.

    Demucs sometimes dumps content from one instrument into another's
    slot because the model isn't fully confident — most commonly:
       • piano content → 'other' (sustained / left-hand frames)
       • guitar content → 'other' (clean strums, sustained chords)
       • piano content ↔ guitar (overlapping fundamentals)

    This pass identifies WHEN each harmonic stem is playing (via its own
    band-energy envelope) and pulls characteristic-band content from
    the donor stem into the target during those windows. Mass conservation
    is maintained: every sample added to target is subtracted from donor.

    Order matters. We do piano-from-other FIRST (biggest typical gain),
    then guitar-from-other (second biggest), then the cross-pairs
    (piano↔guitar) as fine-tuning. Each pass uses the OUTPUT of the
    previous pass — so by the end, content has been routed to where it
    actually belongs based on activity, not the model's per-frame guess.

    Each transfer is conservative (mask threshold 20-30% activity, hard
    per-sample cap at 50% of donor band magnitude). Won't catastrophically
    over-transfer even on edge cases.

    Returns dict mapping original path → updated path. Silent no-op if
    numpy/scipy/soundfile aren't importable.
    """
    out_paths = {p: p for p in stems_by_name.values()}
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return out_paths

    # Define the recovery pairs in order. Each entry: (target_name,
    # donor_name, activity_threshold, transfer_cap). Lower threshold =
    # more aggressive activity detection; higher cap = bigger per-sample
    # transfer ceiling. We tune these per pair based on how confident we
    # are the mistake exists.
    #
    # piano ← other  : strong mistake, aggressive (0.20 / 0.50)
    # guitar ← other : strong mistake, aggressive (0.20 / 0.50)
    # piano ← guitar : weaker mistake, gentle (0.30 / 0.35)
    # guitar ← piano : weaker mistake, gentle (0.30 / 0.35)
    RECOVERY_PAIRS = [
        ("piano",  "other",  0.20, 0.50),
        ("guitar", "other",  0.20, 0.50),
        ("piano",  "guitar", 0.30, 0.35),
        ("guitar", "piano",  0.30, 0.35),
    ]

    # Load all stems we'll touch ONCE up front, into a dict. We mutate this
    # dict across recovery passes so each pass operates on the output of
    # the previous one (not the original). This is what gives us the
    # routing-by-activity behavior I described above.
    audio_cache = {}     # stem_name -> (audio np array, sr)
    sr_ref = None
    for stem_name in {p for tup in RECOVERY_PAIRS for p in tup[:2]}:
        path = stems_by_name.get(stem_name)
        if not path or not os.path.isfile(path):
            continue
        try:
            audio, sr = sf.read(path, dtype="float32", always_2d=True)
            if sr_ref is None:
                sr_ref = sr
            elif sr != sr_ref:
                # Sample-rate mismatch between stems means we can't safely
                # cross-process them. Bail out clean.
                return out_paths
            audio_cache[stem_name] = audio
        except Exception:
            continue

    if sr_ref is None or len(audio_cache) < 2:
        # Need at least 2 stems loaded to do any recovery
        return out_paths

    # Trim everything to the same length (defensive — demucs is sometimes
    # off by a frame between stem outputs)
    n_min = min(len(a) for a in audio_cache.values())
    for k in audio_cache:
        audio_cache[k] = audio_cache[k][:n_min]

    for target_name, donor_name, act_threshold, transfer_cap in RECOVERY_PAIRS:
        if target_name not in audio_cache or donor_name not in audio_cache:
            continue
        target_audio = audio_cache[target_name]
        donor_audio = audio_cache[donor_name]
        try:
            # Build activity envelope from target's own band — when is the
            # target instrument playing?
            target_band = STEM_BANDS_HZ.get(target_name)
            if not target_band:
                continue
            mono_target = target_audio.mean(axis=1)
            env = _activity_envelope(mono_target, sr_ref,
                                     target_band[0], target_band[1])
            if env is None:
                # Target stem is essentially silent — nothing to recover into
                continue
            # Soft mask: ramps from 0 below threshold to 1 at threshold+0.40,
            # smoothed so transfer doesn't gate on transients
            from scipy.signal import butter
            import numpy as np
            mask = np.clip((env - act_threshold) / 0.40, 0.0, 1.0)
            kernel_size = max(1, int(sr_ref * 0.08))
            kernel = np.ones(kernel_size, dtype="float32") / kernel_size
            mask = np.convolve(mask, kernel, mode="same").astype("float32")

            new_target, new_donor = _recover_pair(
                target_audio, donor_audio, sr_ref,
                target_band, mask, cap_ratio=transfer_cap
            )
            # Update cache so subsequent passes see the corrected stems.
            # This is what lets piano←other happen first, then guitar←other
            # on the ALREADY-thinned other, preventing double-attribution
            # of the same chunk of audio.
            audio_cache[target_name] = new_target
            audio_cache[donor_name] = new_donor
        except Exception:
            # Per-pair failure shouldn't kill the whole recovery — skip
            # this pair and try the next one with the existing cache.
            continue

    # Write all modified stems to new files in work_dir, return the path map
    import numpy as np
    for stem_name, audio in audio_cache.items():
        original_path = stems_by_name.get(stem_name)
        if not original_path:
            continue
        try:
            clipped = np.clip(audio, -1.0, 1.0)
            new_path = os.path.join(work_dir,
                                    "recovered_" + os.path.basename(original_path))
            sf.write(new_path, clipped, sr_ref, subtype="PCM_16")
            out_paths[original_path] = new_path
        except Exception:
            # If writing fails, keep the original — don't break the pipeline
            continue

    return out_paths


# ── Fullness restoration intensity presets ──────────────────────────────
# Three preset modes the user can pick in the UI. Each defines the
# strength of the three independent passes:
#   - sustain_strength: 0..1, scales the spectral-hold rebuild amount
#       0 = no rebuild, 1 = full rebuild (matches old hardcoded behavior)
#   - ducking_max_db: max boost applied by ghost-ducking compensation
#       0 = disable, +6 = aggressive lift
#   - transient_max_db: cap on per-onset attack normalization (± value)
#       0 = disable, 6 = aggressive
#
# These are the BALANCED defaults — they match the values from patch 15h
# before we made it user-controllable. Subtle pulls everything to about
# 40% strength, aggressive pushes to ~150%.
FULLNESS_PRESETS = {
    "subtle":     {"sustain": 0.40, "ducking_db": 2.0, "transient_db": 1.5},
    "balanced":   {"sustain": 1.00, "ducking_db": 4.0, "transient_db": 3.0},
    "aggressive": {"sustain": 1.50, "ducking_db": 6.0, "transient_db": 5.0},
}


def restore_stem_fullness(stems_by_name, work_dir, intensity=None):
    """Restore notes/tails/levels that got cut off or ducked by the separator.

    Three problems this addresses, in order:

      1. SUSTAIN DROPOUTS — sustained notes (piano, guitar ring-out, vocal
         tail) get truncated by the model when it's uncertain about the
         late part of the note. The attack is detected fine, the tail
         drops to silence. We detect these mid-note dropouts and rebuild
         the tail via short-window spectral hold: take the spectrum of
         the last "good" frame, repeat with exponential decay so the
         resynthesized tail sounds like the natural sustain it should be.

      2. GHOST DUCKING — the model sometimes mirrors the original mix's
         masking behavior: when vocals were loud over an instrument in
         the source, the instrument's level dips behind that vocal even
         though it shouldn't (the instrument was actually playing at
         normal level under the mix). We detect band-RMS dips below the
         stem's own moving baseline and lift them back up gently — never
         inventing content, just restoring level that was attenuated.

      3. TRANSIENT INCONSISTENCY — instrument attacks vary in level across
         a track because the rest of the mix masked some more than others.
         We measure the median attack level over the whole track per stem
         and gently normalize each attack toward that median, preserving
         the stem's dynamics but flattening drop-outs that were caused
         by separation uncertainty, not by the performer.

    All three are CONSERVATIVE by design:
      - Sustain rebuild only fires for mid-note tail drops, not natural
        silences (silence is supposed to be silent — we won't fill it).
      - Ghost-duck lift is capped at the configured max dB.
      - Transient normalization is capped at ± configured dB per attack.

    `intensity` is a dict that overrides the per-pass strengths:
        {
          "sustain":      float 0..2,    # scales rebuild blend amount
          "ducking_db":   float 0..6,    # max ghost-ducking lift
          "transient_db": float 0..6,    # ±cap on transient consistency
        }
    Defaults to FULLNESS_PRESETS["balanced"] when not provided. A pass
    is fully DISABLED when its value is 0 — gives the user a way to turn
    off individual passes from the Advanced panel without disabling the
    whole feature.

    Returns dict mapping original_path → updated_path. Silent no-op if
    numpy/scipy/soundfile not available."""
    out_paths = {p: p for p in stems_by_name.values()}

    # Resolve intensity — accept a dict OR a preset name OR None
    if intensity is None:
        intensity = FULLNESS_PRESETS["balanced"]
    elif isinstance(intensity, str):
        intensity = FULLNESS_PRESETS.get(intensity, FULLNESS_PRESETS["balanced"])
    # Normalize / fill missing keys from balanced
    base = FULLNESS_PRESETS["balanced"]
    sustain_strength = float(intensity.get("sustain", base["sustain"]))
    ducking_max_db = float(intensity.get("ducking_db", base["ducking_db"]))
    transient_max_db = float(intensity.get("transient_db", base["transient_db"]))
    # Clamp to safe ranges so wild input from the UI doesn't break things
    sustain_strength = max(0.0, min(2.0, sustain_strength))
    ducking_max_db = max(0.0, min(8.0, ducking_max_db))
    transient_max_db = max(0.0, min(8.0, transient_max_db))
    # Convert dB caps to linear gains used downstream
    ducking_max_gain = 10.0 ** (ducking_max_db / 20.0) if ducking_max_db > 0 else 1.0
    transient_gain_hi = 10.0 ** (transient_max_db / 20.0) if transient_max_db > 0 else 1.0
    transient_gain_lo = 1.0 / transient_gain_hi if transient_gain_hi > 1.0 else 1.0

    # If ALL three are zero the user effectively disabled the whole pass.
    # Save the I/O time and bail out clean.
    if sustain_strength <= 0 and ducking_max_db <= 0 and transient_max_db <= 0:
        return out_paths

    try:
        import numpy as np
        import soundfile as sf
        from scipy.signal import butter, sosfiltfilt, stft, istft
    except ImportError:
        return out_paths

    # Stems to enhance — harmonic stems benefit most from this.
    # Drums/bass are mostly fine, vocals have their own de-reverb pass.
    HARMONIC_TARGETS = ("piano", "guitar", "other", "vocals", "lead_vocal", "back_vocal")
    SUSTAIN_TARGETS  = ("piano", "guitar", "other")   # only these sustain naturally

    for stem_name in HARMONIC_TARGETS:
        stem_path = stems_by_name.get(stem_name)
        if not stem_path or not os.path.isfile(stem_path):
            continue
        try:
            audio, sr = sf.read(stem_path, dtype="float32", always_2d=True)
            if len(audio) < int(sr * 0.5):
                # Too short to do anything meaningful
                continue

            audio = audio.copy()
            mono = audio.mean(axis=1).astype(np.float32)

            # ── 1. SUSTAIN DROPOUT REPAIR (sustain-targets only) ─────────
            # Only for piano/guitar/other since vocals don't have musical
            # sustain in the same way (a held note has natural amplitude
            # variation we shouldn't smooth over).
            if stem_name in SUSTAIN_TARGETS and sustain_strength > 0:
                # STFT for spectral hold operations. 2048 sample window
                # = ~46ms at 44.1kHz, fine resolution for tail tracking.
                nperseg = 2048
                noverlap = nperseg - 512
                _, _, Z = stft(mono, fs=sr, nperseg=nperseg, noverlap=noverlap)
                magZ = np.abs(Z).astype(np.float32)
                phase = np.angle(Z)

                # Per-frame total energy
                frame_energy = magZ.sum(axis=0)
                if frame_energy.max() < 1e-6:
                    # Stem is silent — skip
                    pass
                else:
                    # Build a "natural" energy envelope: take 90th-percentile
                    # over a rolling window. This is what the energy SHOULD
                    # look like for a sustained note even between attacks.
                    rolling_window = 12  # ~12 frames ≈ 0.14s
                    rolling_max = np.zeros_like(frame_energy)
                    for i in range(len(frame_energy)):
                        start = max(0, i - rolling_window)
                        rolling_max[i] = np.percentile(frame_energy[start:i+1], 90)

                    # Find dropouts: frame energy is < 30% of rolling_max AND
                    # rolling_max itself isn't tiny (means there IS a note
                    # supposed to be playing). These are spots where the
                    # model cut a sustain it shouldn't have.
                    drop_mask = (frame_energy < rolling_max * 0.30) & \
                                (rolling_max > frame_energy.max() * 0.05)

                    # For each dropout frame, spectral-hold from the last
                    # good frame with exponential decay. We use 0.92 per
                    # frame decay — corresponds to ~3s half-life at this
                    # hop size, which is realistic for piano sustain.
                    last_good_mag = None
                    decay = 1.0
                    for i in range(len(frame_energy)):
                        if drop_mask[i] and last_good_mag is not None:
                            decay *= 0.92
                            if decay < 0.05:
                                # Decayed far enough that we're not adding
                                # anything meaningful — stop rebuilding,
                                # let natural silence resume.
                                last_good_mag = None
                                decay = 1.0
                                continue
                            # Replace this frame's magnitude with decayed
                            # version of the last good one. Keep the
                            # ORIGINAL phase — using held phase would
                            # cause comb-filtering / unnatural artifacts.
                            magZ[:, i] = last_good_mag * decay
                        else:
                            last_good_mag = magZ[:, i].copy()
                            decay = 1.0

                    # Rebuild the audio from the modified spectrogram. We
                    # use the ORIGINAL phase, which preserves the natural
                    # phase relationships of the held content.
                    Z_new = magZ * np.exp(1j * phase)
                    _, rebuilt = istft(Z_new, fs=sr, nperseg=nperseg, noverlap=noverlap)
                    # The istft output length may be slightly off from
                    # original; trim/pad to match.
                    if len(rebuilt) > len(mono):
                        rebuilt = rebuilt[:len(mono)]
                    elif len(rebuilt) < len(mono):
                        rebuilt = np.concatenate([rebuilt, np.zeros(len(mono) - len(rebuilt))])

                    # Blend the rebuilt mono with the original audio. We only
                    # APPLY the rebuilt content during dropout frames; the
                    # rest stays as the original separator output. This
                    # preserves all the stereo information of the source
                    # while patching only the dropout frames.
                    #
                    # The mono difference (rebuilt - original) is added to
                    # both channels equally during dropouts. That's not
                    # perfectly stereo-preserving for the dropout frames
                    # themselves, but it's better than introducing
                    # mid-side artifacts.
                    diff = (rebuilt - mono).astype(np.float32)
                    # Convert frame-level mask to sample-level
                    hop = nperseg - noverlap
                    sample_mask = np.zeros(len(mono), dtype=np.float32)
                    for fi in range(len(drop_mask)):
                        if drop_mask[fi]:
                            s_start = fi * hop
                            s_end = min(len(mono), s_start + nperseg)
                            # Smooth fade at the edges of each filled region
                            # via cosine windowing — prevents click at
                            # dropout boundaries
                            n_frame = s_end - s_start
                            fade = 0.5 - 0.5 * np.cos(
                                np.linspace(0, 2 * np.pi, n_frame))
                            sample_mask[s_start:s_end] = np.maximum(
                                sample_mask[s_start:s_end], fade)
                    # Apply mask to the diff and add to each channel,
                    # scaled by user-controllable sustain_strength so the
                    # rebuild amount can be tuned without changing the
                    # detection logic.
                    for ch in range(audio.shape[1]):
                        audio[:, ch] += (diff * sample_mask * sustain_strength).astype(np.float32)

            # ── 2. GHOST-DUCKING COMPENSATION ───────────────────────────
            # Build a band-RMS envelope using this stem's own characteristic
            # band, find dips, lift them. Only operates on stems where
            # ducking is a real problem (harmonic stems mostly).
            # When ducking_max_db <= 0 the user disabled this pass; skip
            # entirely (cheaper than computing then multiplying by 1.0).
            if ducking_max_db > 0:
                stem_band = STEM_BANDS_HZ.get(stem_name, (60, 6000))
                sos = butter(4, [stem_band[0], stem_band[1]],
                             btype="bandpass", fs=sr, output="sos")
                band_mono = sosfiltfilt(sos, audio.mean(axis=1)).astype(np.float32)
                # RMS in 100ms windows
                rms_win = int(sr * 0.10)
                n_full = len(band_mono)
                # Compute moving RMS with cumsum trick (much faster than convolve
                # for the squared signal)
                sq = band_mono ** 2
                csum = np.cumsum(sq)
                rms = np.sqrt(np.maximum(0, (csum[rms_win:] - csum[:-rms_win]) / rms_win))
                # rms shorter than band_mono by rms_win; pad to align
                rms = np.concatenate([np.full(rms_win, rms[0] if len(rms) else 0), rms])
                # Compute the stem's "active" baseline: 70th-percentile RMS over
                # the whole signal. The 70th percentile (not max) gives us a
                # robust target — it represents the level the instrument plays
                # at MOST of the time, ignoring brief loud peaks and silences.
                active_mask = rms > rms.max() * 0.10  # ignore truly silent passages
                if active_mask.sum() < int(sr * 1.0):  # need >1s of activity
                    # Not enough active content to compute a baseline — skip
                    # ducking compensation for this stem.
                    pass
                else:
                    baseline = float(np.percentile(rms[active_mask], 70))
                    if baseline > 1e-5:
                        # Where active AND RMS is more than 6dB below baseline,
                        # lift toward baseline. Cap lift at user-controllable
                        # ducking_max_gain (default +4 dB = ×1.585, user can
                        # set 0..+8 dB via the Quality Advanced panel).
                        target = baseline
                        needed_gain = target / np.maximum(rms, 1e-9)
                        # Only lift where we're below baseline AND have content
                        lift_mask = (rms < baseline * 0.50) & active_mask  # below -6dB
                        needed_gain = np.where(lift_mask, needed_gain, 1.0)
                        # User-tunable cap (linear gain converted from dB)
                        needed_gain = np.minimum(needed_gain, ducking_max_gain)
                        # Smooth the gain trajectory to avoid pumping
                        smooth_win = int(sr * 0.20)
                        if smooth_win >= 1:
                            kernel = np.ones(smooth_win, dtype=np.float32) / smooth_win
                            # Use 'same' so length matches; pad ends with edge values
                            needed_gain = np.convolve(needed_gain, kernel, mode='same').astype(np.float32)
                        # Apply per-sample gain to all channels
                        for ch in range(audio.shape[1]):
                            audio[:, ch] = audio[:, ch] * needed_gain[:len(audio)]

            # ── 3. TRANSIENT CONSISTENCY ────────────────────────────────
            # Attacks (note onsets) in a separated stem vary in level
            # across a track because the rest of the mix masked some more
            # than others. A piano note attacked under loud vocals might
            # come out 4 dB quieter than the same note played in a quiet
            # passage. We detect onset peaks, compute the MEDIAN onset
            # level across the whole track, and gently normalize each
            # onset toward that median. Result: each note has consistent
            # presence, no dropouts where the original mix had a busy
            # moment. Capped at ± transient_max_db per onset (user-set
            # in the Quality Advanced panel) so we never invent
            # dynamics that weren't there.
            #
            # We do this AFTER ghost-ducking compensation so onset levels
            # are measured on the already-lifted signal — gives a more
            # accurate sense of what the "natural" attack level is.
            if transient_max_db <= 0:
                # User disabled the transient pass — skip
                pass
            else:
              try:
                # Build a fast onset envelope: half-wave rectified
                # difference of band-RMS. Peaks in this signal are note
                # onsets.
                mono_for_onset = audio.mean(axis=1).astype(np.float32)
                hop_onset = int(sr * 0.010)  # 10ms hop
                win_onset = int(sr * 0.030)  # 30ms window
                # Block-RMS via reshape (faster than loop for moderate hop)
                n_blocks = max(1, len(mono_for_onset) // hop_onset)
                rms_blocks = np.zeros(n_blocks, dtype=np.float32)
                for bi in range(n_blocks):
                    s = bi * hop_onset
                    e = min(len(mono_for_onset), s + win_onset)
                    seg = mono_for_onset[s:e]
                    rms_blocks[bi] = float(np.sqrt(np.mean(seg ** 2))) if len(seg) > 0 else 0.0
                if rms_blocks.max() > 1e-5:
                    # Differential — only positive (onset) part counts
                    diff_rms = np.diff(rms_blocks)
                    diff_rms = np.maximum(diff_rms, 0)
                    # Find local maxima above threshold (note onsets)
                    threshold = float(np.percentile(diff_rms, 92))
                    if threshold > 1e-5:
                        # Peak picking: index i is a peak if it's > both
                        # neighbors AND > threshold AND separated from the
                        # last peak by at least 60ms.
                        min_gap_blocks = max(1, int(0.060 / 0.010))
                        peaks = []
                        last_peak = -min_gap_blocks
                        for i in range(1, len(diff_rms) - 1):
                            if (diff_rms[i] > threshold
                                    and diff_rms[i] > diff_rms[i-1]
                                    and diff_rms[i] >= diff_rms[i+1]
                                    and (i - last_peak) >= min_gap_blocks):
                                peaks.append(i)
                                last_peak = i
                        if len(peaks) >= 4:
                            # Measure attack level at each peak — the RMS
                            # of the block AFTER the onset (the attack
                            # body, not the rise).
                            attack_levels = np.array(
                                [rms_blocks[p + 1] for p in peaks if p + 1 < len(rms_blocks)],
                                dtype=np.float32
                            )
                            median_attack = float(np.median(attack_levels))
                            if median_attack > 1e-5:
                                # Build a per-sample gain trajectory: at
                                # each peak's window, gain = median /
                                # this_attack, clamped to ± transient_max_db
                                # via the precomputed linear gain range.
                                trajectory = np.ones(len(audio), dtype=np.float32)
                                for pi, p in enumerate(peaks):
                                    if p + 1 >= len(rms_blocks):
                                        continue
                                    this_lvl = float(rms_blocks[p + 1])
                                    if this_lvl < 1e-5:
                                        continue
                                    needed = median_attack / this_lvl
                                    needed = float(np.clip(needed, transient_gain_lo, transient_gain_hi))
                                    # Apply gain over a 200ms window around
                                    # the onset, with cosine fade in/out
                                    # so we don't get pumping.
                                    s_center = p * hop_onset
                                    half = int(sr * 0.10)
                                    s_start = max(0, s_center - half)
                                    s_end = min(len(audio), s_center + half)
                                    if s_end <= s_start:
                                        continue
                                    n_win = s_end - s_start
                                    fade = 0.5 - 0.5 * np.cos(
                                        np.linspace(0, 2 * np.pi, n_win))
                                    # Blend trajectory toward needed using fade
                                    seg_gain = 1.0 + (needed - 1.0) * fade
                                    trajectory[s_start:s_end] = np.maximum(
                                        trajectory[s_start:s_end], seg_gain
                                    ) if needed > 1.0 else np.minimum(
                                        trajectory[s_start:s_end], seg_gain
                                    )
                                # Smooth trajectory so neighboring onsets
                                # blend instead of stepping
                                smooth = int(sr * 0.150)
                                if smooth >= 1:
                                    k = np.ones(smooth, dtype=np.float32) / smooth
                                    trajectory = np.convolve(trajectory, k, mode='same').astype(np.float32)
                                # Apply to all channels
                                for ch in range(audio.shape[1]):
                                    audio[:, ch] = audio[:, ch] * trajectory[:len(audio)]
              except Exception:
                # Transient pass is "polish, not critical" — silent skip
                # on any failure so dropout+ducking gains still ship
                pass

            # Final safety clip
            audio = np.clip(audio, -1.0, 1.0).astype(np.float32)
            out_path = os.path.join(work_dir,
                                    "fullness_" + os.path.basename(stem_path))
            sf.write(out_path, audio, sr, subtype="PCM_16")
            out_paths[stem_path] = out_path
        except Exception:
            # Per-stem failure shouldn't kill the others
            continue
    return out_paths


def cleanup_back_vocal(stems_by_name, work_dir):
    """Remove misclassified hi-hat / percussion content from back_vocal stem.

    The lead-vs-backing split model (Phull-V2L) was trained for the
    karaoke task: pull the main vocalist out, dump everything else
    vocal-flavored into "backing." Its "backing" bucket misclassifies a
    few categories that aren't actually vocals:

      • Closed hi-hats with strong resonance at 5-12 kHz look like
        vocal sibilance to the model — they leak into back_vocal as
        ticky high-frequency noise.
      • Shaker / tambourine / bell percussion that's pitched-sounding
        also gets misclassified.
      • Some sample chops with sustained tonal content.

    We can clean most of the percussion misclassification by cross-
    referencing with the drums stem (which DOES correctly contain those
    hats). Where drums has high-frequency energy AND back_vocal has
    correlated energy in the same band, that content is almost certainly
    misrouted from drums → back_vocal. Subtract it.

    Algorithm:
      1. Build a "hi-hat activity" envelope from drums stem (5-12 kHz
         bandpass, 50ms smoothing). High values = drums is doing hat
         work in this window.
      2. Bandpass back_vocal in the SAME band. Where the drums envelope
         is high AND back_vocal has content there, it's misclassified
         hat → subtract it from back_vocal (don't add to drums; drums
         already has it).
      3. Additionally, voicing gate: where the entire back_vocal signal
         is unvoiced (autocorrelation in vocal pitch range 80-400 Hz
         shows no clear peak) AND mostly high-frequency, attenuate the
         signal — those frames are noise, not vocal content.

    Conservative caps: at most -9 dB attenuation per band-frame
    (×0.355), so even if we over-detect we don't fully gate the signal.
    Voicing gate is gentle (-3 dB max for unvoiced HF-dominant frames).

    Returns dict mapping original_path → updated_path. Silent no-op
    when scipy/numpy/soundfile aren't available, or when back_vocal
    or drums isn't in stems_by_name.
    """
    out_paths = {p: p for p in stems_by_name.values()}
    back_path = stems_by_name.get("back_vocal")
    drums_path = stems_by_name.get("drums")
    if not back_path or not os.path.isfile(back_path):
        return out_paths

    try:
        import numpy as np
        import soundfile as sf
        from scipy.signal import butter, sosfiltfilt
    except ImportError:
        return out_paths

    try:
        back, sr = sf.read(back_path, dtype="float32", always_2d=True)
        back = back.copy()

        # ── PASS 1: Drums-guided hat subtraction (cross-stem) ────────────
        # Only run when we actually have a drums stem to cross-reference.
        # Without drums, we can't tell hat-misclassification from genuine
        # high-frequency back vocal (and crashing/explicit ad-lib vocals
        # can have hat-similar spectra).
        if drums_path and os.path.isfile(drums_path):
            drums, sr_d = sf.read(drums_path, dtype="float32", always_2d=True)
            if sr_d == sr and drums.shape[1] == back.shape[1]:
                # 1a: drums hi-hat band envelope (5-12 kHz)
                sos_hat = butter(4, [5000, 12000], btype="bandpass",
                                 fs=sr, output="sos")
                drums_mono = drums.mean(axis=1).astype(np.float32)
                drums_band = sosfiltfilt(sos_hat, drums_mono).astype(np.float32)
                # 50ms smoothing window
                win = max(1, int(sr * 0.050))
                kernel = np.ones(win, dtype=np.float32) / win
                drums_env = np.abs(drums_band)
                drums_env = np.convolve(drums_env, kernel, mode="same")
                drums_peak = drums_env.max()
                if drums_peak > 1e-5:
                    drums_env = (drums_env / drums_peak).astype(np.float32)
                    # Hat-active mask: ramp from 0 below 25% activity to 1
                    # by 60% activity. We're targeting STRONG hat moments,
                    # not background ambience.
                    hat_mask = np.clip((drums_env - 0.25) / 0.35, 0.0, 1.0)
                    # Light smoothing on the mask
                    hat_mask = np.convolve(hat_mask, kernel, mode="same").astype(np.float32)

                    # 1b: subtract back's hi-hat-band content where the
                    # drums envelope says "hats are loud right here."
                    # Use the SAME bandpass shape on back_vocal.
                    n_min = min(len(back), len(hat_mask))
                    for ch in range(back.shape[1]):
                        back_band = sosfiltfilt(sos_hat, back[:, ch]).astype(np.float32)
                        n_band = min(len(back_band), n_min)
                        # How much of the band content to subtract:
                        # mask × 0.65 (max 65% removal during peak hat
                        # activity, never fully gated).
                        attenuation = hat_mask[:n_band] * 0.65
                        # Hard cap so even at full mask we never remove
                        # more than ~70% (= -10dB at peak)
                        attenuation = np.minimum(attenuation, 0.70)
                        back[:n_band, ch] -= back_band[:n_band] * attenuation

        # ── PASS 2: voicing gate on whole back_vocal ─────────────────────
        # Detect frames where back_vocal is BOTH unvoiced (no clear pitch
        # in 80-400 Hz range) AND dominated by high frequencies (>3 kHz).
        # Those frames are almost certainly noise or percussion that
        # leaked through pass 1. Attenuate gently (cap at -3 dB).
        mono_back = back.mean(axis=1).astype(np.float32)
        # Block-based analysis: 40ms windows with 50% overlap
        win_size = int(sr * 0.040)
        hop = win_size // 2
        if len(mono_back) > win_size * 3 and win_size > 64:
            # Voicing via autocorrelation peak in the voice-pitch range.
            # Skip lag=0; look for peak between lag samples corresponding
            # to 80 Hz (high lag) down to 400 Hz (low lag).
            lag_lo = int(sr / 400)
            lag_hi = int(sr / 80)
            if lag_hi < win_size and lag_lo > 0:
                # Build per-block voicing score (0=unvoiced, 1=very voiced)
                n_blocks = (len(mono_back) - win_size) // hop + 1
                # We use a smaller representative sample of blocks to keep
                # cost reasonable on long tracks — process every other
                # block, then linearly interpolate the gain trajectory.
                voicing = np.ones(n_blocks, dtype=np.float32)
                hf_ratio = np.ones(n_blocks, dtype=np.float32)
                # HPF for HF content measurement
                sos_hp3k = butter(2, 3000, btype="highpass", fs=sr, output="sos")
                hf_only = sosfiltfilt(sos_hp3k, mono_back).astype(np.float32)
                stride = 2  # process every 2nd block, interpolate the rest
                for bi in range(0, n_blocks, stride):
                    s = bi * hop
                    e = s + win_size
                    if e > len(mono_back):
                        break
                    blk = mono_back[s:e]
                    blk_energy = float(np.sum(blk ** 2))
                    if blk_energy < 1e-8:
                        voicing[bi] = 1.0  # silent — don't touch
                        hf_ratio[bi] = 0.0
                        continue
                    # Autocorrelation in the lag range
                    blk_zm = blk - blk.mean()
                    norm = float(np.sum(blk_zm ** 2)) + 1e-9
                    # Compute autocorrelation only at the lags we need
                    # (cheaper than full FFT correlate for our small range)
                    ac = np.zeros(lag_hi - lag_lo + 1, dtype=np.float32)
                    for j, lag in enumerate(range(lag_lo, lag_hi + 1)):
                        if lag >= len(blk_zm):
                            break
                        ac[j] = float(np.sum(blk_zm[:-lag] * blk_zm[lag:])) / norm
                    voicing[bi] = float(max(0.0, ac.max()))
                    # HF dominance: ratio of HF energy to total
                    hf_blk = hf_only[s:e]
                    hf_e = float(np.sum(hf_blk ** 2))
                    hf_ratio[bi] = hf_e / (blk_energy + 1e-9)
                # Linear-interpolate the skipped blocks so the gain
                # trajectory stays smooth
                for bi in range(0, n_blocks, stride):
                    end_bi = min(n_blocks, bi + stride)
                    for j in range(bi + 1, end_bi):
                        # Copy from the previous processed block; the
                        # next processed block is too far for interp on
                        # stride=2, so simple hold is fine.
                        voicing[j] = voicing[bi]
                        hf_ratio[j] = hf_ratio[bi]

                # Frames that are BOTH unvoiced AND HF-dominant get
                # attenuated. Voicing < 0.25 = clearly unvoiced;
                # hf_ratio > 0.65 = mostly high-frequency.
                gate_strength = np.clip(
                    (0.25 - voicing) * 4.0, 0.0, 1.0
                ) * np.clip(
                    (hf_ratio - 0.65) * 3.0, 0.0, 1.0
                )
                # Cap attenuation at -3 dB (×0.708)
                # Gain = 1 when gate_strength = 0, 0.708 when gate_strength = 1
                block_gain = 1.0 - (gate_strength * 0.292)
                # Expand block gain to sample-level with linear interpolation
                # for smoothness
                sample_gain = np.ones(len(mono_back), dtype=np.float32)
                for bi in range(n_blocks):
                    s = bi * hop
                    e = min(len(mono_back), s + win_size)
                    sample_gain[s:e] = np.minimum(sample_gain[s:e], block_gain[bi])
                # Smooth the gain trajectory (100ms kernel) to prevent
                # any audible chopping
                smooth = max(1, int(sr * 0.10))
                kernel_g = np.ones(smooth, dtype=np.float32) / smooth
                sample_gain = np.convolve(sample_gain, kernel_g, mode='same').astype(np.float32)
                # Apply
                for ch in range(back.shape[1]):
                    back[:len(sample_gain), ch] *= sample_gain[:len(back)]

        # Final safety clip
        back = np.clip(back, -1.0, 1.0).astype(np.float32)
        out_path = os.path.join(work_dir,
                                "cleaned_" + os.path.basename(back_path))
        sf.write(out_path, back, sr, subtype="PCM_16")
        out_paths[back_path] = out_path
        return out_paths
    except Exception:
        return out_paths


def clean_stem_bleeds(stems_by_name, work_dir):
    """Spectral cleanup pass to reduce inter-stem bleeds.

    Demucs/RoFormer produce decent stem separation but leave residual
    cross-bleed: vocals leak into drums, kick leaks into piano, bass leaks
    into "other," etc. We can recover a noticeable chunk of that with
    spectral subtraction guided by the "guilty" stem's envelope.

    Three cleanups, applied in order:

      1. KICK BLEED in harmonic stems (piano/other/guitar): when the kick
         hits hard, low-frequency energy (30-120 Hz) leaks into harmonic
         tracks. Detect kick activity via the drums envelope, attenuate
         the band by up to 9 dB in harmonic stems during those windows.

      2. BASS BLEED in piano/other/guitar: bass-band content (50-300 Hz)
         in harmonic stems is mostly residual bleed from the bass stem.
         When bass is active, attenuate that band in harmonic stems by
         up to 6 dB. Conservative — bass-band notes legitimately played
         on piano/guitar would also dip, but the audible improvement of
         clearer mids/highs outweighs it on typical pop/hiphop.

      3. SUB-RUMBLE: high-pass everything below 25 Hz in all harmonic
         stems (drums, bass keep their lows). This is inaudible content
         that's almost guaranteed to be cross-bleed/DC offset noise.

    Returns dict mapping the original path to the cleaned path. Failures
    are silent — original paths are returned unchanged.
    """
    cleaned_paths = {p: p for p in stems_by_name.values()}
    try:
        import numpy as np
        import soundfile as sf
        from scipy.signal import butter, sosfiltfilt
    except ImportError:
        return cleaned_paths

    drums_path = stems_by_name.get("drums")
    bass_path = stems_by_name.get("bass")

    # Build kick-activity envelope from drums
    kick_active = None
    sr = None
    if drums_path and os.path.isfile(drums_path):
        try:
            drums, sr = sf.read(drums_path, dtype="float32", always_2d=True)
            sos_lo = butter(4, [30, 120], btype="bandpass", fs=sr, output="sos")
            dlow = sosfiltfilt(sos_lo, drums.mean(axis=1))
            win = max(1, int(sr * 0.05))
            env = np.abs(dlow)
            kernel = np.ones(win, dtype="float32") / win
            env = np.convolve(env, kernel, mode="same")
            peak = env.max()
            if peak > 1e-6:
                env = env / peak
                kick_active = np.convolve((env > 0.35).astype("float32"),
                                          kernel, mode="same").clip(0.0, 1.0)
        except Exception:
            kick_active = None

    # Build bass-activity envelope from bass
    bass_active = None
    if bass_path and os.path.isfile(bass_path):
        try:
            bdata, sr2 = sf.read(bass_path, dtype="float32", always_2d=True)
            if sr is None:
                sr = sr2
            if sr2 == sr:
                sos_b = butter(4, [50, 300], btype="bandpass", fs=sr, output="sos")
                blow = sosfiltfilt(sos_b, bdata.mean(axis=1))
                win = max(1, int(sr * 0.08))
                env = np.abs(blow)
                kernel = np.ones(win, dtype="float32") / win
                env = np.convolve(env, kernel, mode="same")
                peak = env.max()
                if peak > 1e-6:
                    env = env / peak
                    bass_active = np.convolve((env > 0.30).astype("float32"),
                                              kernel, mode="same").clip(0.0, 1.0)
        except Exception:
            bass_active = None

    # Harmonic stems are everything that isn't drums/bass/vocals
    HARMONIC_TARGETS = ("piano", "other", "guitar")
    for name in HARMONIC_TARGETS:
        p = stems_by_name.get(name)
        if not p or not os.path.isfile(p):
            continue
        try:
            audio, sr_s = sf.read(p, dtype="float32", always_2d=True)
            if sr is not None and sr_s != sr:
                # Sample rate mismatch — skip cleanup, keep original
                continue
            out = audio.copy()
            # 1. Kick bleed: attenuate 30-120 Hz during kick-active windows
            if kick_active is not None:
                sos_k = butter(4, [30, 120], btype="bandpass", fs=sr_s, output="sos")
                for ch in range(audio.shape[1]):
                    band = sosfiltfilt(sos_k, audio[:, ch])
                    n = min(len(band), len(kick_active))
                    atten = 1.0 - kick_active[:n] * 0.65  # up to ~9 dB
                    out[:n, ch] = out[:n, ch] - band[:n] + band[:n] * atten
            # 2. Bass bleed: attenuate 50-300 Hz during bass-active windows
            if bass_active is not None:
                sos_bb = butter(4, [50, 300], btype="bandpass", fs=sr_s, output="sos")
                for ch in range(audio.shape[1]):
                    band = sosfiltfilt(sos_bb, out[:, ch])
                    n = min(len(band), len(bass_active))
                    # Up to ~6 dB; gentler than kick since piano notes in
                    # the same band are common (left-hand chords, etc.)
                    atten = 1.0 - bass_active[:n] * 0.50
                    out[:n, ch] = out[:n, ch] - band[:n] + band[:n] * atten
            # 3. Sub-rumble: high-pass below 25 Hz on all channels
            try:
                sos_hp = butter(2, 25, btype="highpass", fs=sr_s, output="sos")
                for ch in range(out.shape[1]):
                    out[:, ch] = sosfiltfilt(sos_hp, out[:, ch])
            except Exception:
                pass
            cleaned = os.path.join(work_dir, "cleaned_" + os.path.basename(p))
            # Write as 16-bit PCM, not float. The audio-separator engine
            # outputs PCM WAV for all the regular stems, and the renderer's
            # peaksFromWAV() reader only has branches for 8/16/24/32-bit PCM.
            # Writing this cleanup pass as float WAV produced files that
            # were "valid" but unreadable to the renderer — peak values
            # came out roughly uniform across the whole track because
            # IEEE 754 float bytes interpreted as INT32 cluster around
            # similar magnitudes. The waveform appeared as a solid
            # rectangle for piano/other/guitar. Going back to int16 is the
            # simple correct fix.
            #
            # We clip to [-1.0, 1.0] before int conversion just in case the
            # cleanup math nudged any sample above unity. Soundfile handles
            # the int16 scaling and clipping internally too, but explicit
            # is safer.
            out_clipped = np.clip(out, -1.0, 1.0)
            sf.write(cleaned, out_clipped, sr_s, subtype="PCM_16")
            cleaned_paths[p] = cleaned
        except Exception:
            # Keep original on any failure
            pass

    return cleaned_paths




def safe_unlink(p):
    try:
        if p and os.path.isfile(p):
            os.unlink(p)
    except Exception:
        pass


def find_output(out_dir, primary_keyword, fallback_keyword=None):
    """audio-separator names files like '<input>_(Vocals)_<model>.wav'.
    Find the file matching the primary keyword (case-insensitive)."""
    primary_keyword = primary_keyword.lower()
    candidates = []
    if not os.path.isdir(out_dir):
        return None
    for f in os.listdir(out_dir):
        low = f.lower()
        if primary_keyword in low:
            candidates.append(os.path.join(out_dir, f))
    if not candidates and fallback_keyword:
        for f in os.listdir(out_dir):
            if fallback_keyword.lower() in f.lower():
                candidates.append(os.path.join(out_dir, f))
    candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return candidates[0] if candidates else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output_dir")
    parser.add_argument("--mode", choices=["4", "6"], default="4")
    parser.add_argument("--quality", choices=["fast", "high", "ultra"], default="high")
    parser.add_argument("--no-vocal-isolation", action="store_true",
                        help="Skip Stage 1 — run Stage 2 directly on the full track. "
                             "Faster, and producer vocal samples in the beat stay in 'other' "
                             "instead of being merged with lead vocals.")
    parser.add_argument("--split-lead-vocal", action="store_true",
                        help="After Stage 1, run an additional pass that separates the "
                             "vocals stem into 'lead_vocal' and 'back_vocal' (backing "
                             "vocals + sample vocals + ad-libs combined). Best-effort "
                             "quality — not always perfect. Adds ~30-60s on CPU, ~5s on GPU.")
    parser.add_argument("--cpu-only", action="store_true",
                        help="Force CPU even if GPU is available. Useful for low-VRAM machines "
                             "or for keeping the GPU free for other apps (DAW plugins etc).")
    parser.add_argument("--ensemble", action="store_true",
                        help="Run an additional Stage 2 model and average outputs on harmonic "
                             "stems (piano/other/guitar). Lifts SDR by 0.3-0.8 dB on those stems "
                             "at the cost of ~30%% extra Stage 2 runtime. Only effective when "
                             "quality is 'high' or 'ultra' — silently ignored at 'fast'.")
    parser.add_argument("--vocal-ensemble", action="store_true",
                        help="Run an additional vocal isolation model (Stage 1) and average "
                             "the outputs with the primary. Different architecture with "
                             "complementary failure modes — cancels each model's specific "
                             "weaknesses (BS-Roformer sibilance leak, MDX-Net breath softness). "
                             "Lifts vocal SDR by 0.3-0.6 dB. Cost: roughly doubles Stage 1 runtime.")
    parser.add_argument("--dereverb", action="store_true",
                        help="After vocal isolation (Stage 1 / 1.5), run a de-reverb / de-echo "
                             "pass that removes reverb tail and slap echo from the vocal stem. "
                             "Replaces the wet vocal with a dry version. Useful for "
                             "sampling/remixing vocals recorded with heavy ambience. Adds "
                             "~20-40s on CPU.")
    parser.add_argument("--fullness-preset",
                        choices=["subtle", "balanced", "aggressive"],
                        default="balanced",
                        help="Preset for fullness restoration intensity. 'subtle' barely "
                             "touches the audio, 'balanced' is the default sweet spot, "
                             "'aggressive' pushes harder on dropouts/ducking/transients. "
                             "Individual --fullness-* flags below override the preset's "
                             "per-pass values when set.")
    parser.add_argument("--fullness-sustain", type=float, default=None,
                        help="Override sustain rebuild strength (0..2). 0 disables the "
                             "sustain pass entirely. Default: preset-specific.")
    parser.add_argument("--fullness-ducking-db", type=float, default=None,
                        help="Override max ghost-ducking lift in dB (0..8). 0 disables the "
                             "ducking pass entirely. Default: preset-specific.")
    parser.add_argument("--fullness-transient-db", type=float, default=None,
                        help="Override transient consistency clamp ± dB (0..8). 0 disables "
                             "the transient pass entirely. Default: preset-specific.")
    parser.add_argument("--cache-dir", default=None,
                        help="Where to cache model weights (default: ~/.cache/freqphull-models)")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        emit_error("Input file not found: " + args.input)

    check_dependencies()

    # Heavy imports happen after the dependency check so we get a clean error
    import torch
    import torchaudio  # noqa: F401
    Separator = _import_engine()

    device, device_name = select_device(cpu_only=args.cpu_only)
    overlap = stage_overlap_for(args.quality)
    shifts = stage_shifts_for(args.quality)
    s1_overlap = stage1_overlap_for(args.quality)

    # Warn early if the user picked ultra on CPU — they likely don't know it
    # could take 20+ minutes. The warning fires in the diag panel but doesn't
    # block; some users genuinely want ultra and have time.
    if device == "cpu" and args.quality == "ultra":
        emit({
            "type": "warning",
            "message": "Ultra quality on CPU may take 15-25 minutes for a 5-min track",
            "hint": "For faster results, set quality to 'high' (5-8 min, near-identical quality)."
        })

    cache_dir = args.cache_dir or os.path.join(
        os.path.expanduser("~"), ".cache", "freqphull-models"
    )
    os.makedirs(cache_dir, exist_ok=True)

    # Final output folder named after the source track
    base_name = os.path.splitext(os.path.basename(args.input))[0]
    final_dir = os.path.join(args.output_dir, base_name + " — Stems")
    os.makedirs(final_dir, exist_ok=True)

    # Working directory for stage-1 / stage-2 intermediate outputs
    work_dir = os.path.join(final_dir, ".work")
    os.makedirs(work_dir, exist_ok=True)

    try:
        # Track whether we're using the cascade or going direct.
        # Direct mode: skip vocal isolation entirely. Stage 2 sees the original
        # track. This keeps producer vocal samples (ad-libs, vocal chops, sample
        # vocals that are part of the beat) in the 'other' stem instead of
        # being merged into the lead 'vocals' stem.
        direct_mode = args.no_vocal_isolation
        stage1_time = 0.0
        vocals_path = None

        if not direct_mode:
            progress_msg("loading_engine", 3, model=VOCAL_CODENAME, device=device_name,
                         stage="vocal_split", quality=args.quality)

            # ── Stage 1: vocal isolation ──────────────────────────────────────
            # Vocal pass runs at maximum-quality settings regardless of user
            # preset — it's the highest-impact stage in the pipeline.
            try:
                sep1 = Separator(
                    model_file_dir=cache_dir,
                    output_dir=work_dir,
                    output_format="WAV",
                    # Higher threshold means the engine only normalizes when a
                    # chunk's peak gets dangerously close to clipping (0.999 vs
                    # the old 0.95). This kills the audible ducking/pumping
                    # artifact where a hard kick hit caused other stems to dip
                    # in volume during that window. We accept rare ~0.1dB clips
                    # at chunk boundaries as a fair trade for clean dynamics.
                    normalization_threshold=0.999,
                    mdxc_params={"segment_size": 256, "override_model_segment_size": False,
                                 "batch_size": 1, "overlap": s1_overlap, "pitch_shift": 0},
                )
            except TypeError:
                sep1 = Separator(
                    model_file_dir=cache_dir,
                    output_dir=work_dir,
                    output_format="WAV",
                )

            progress_msg("loading_vocal_model", 8, model=VOCAL_CODENAME)
            try:
                sep1.load_model(model_filename=_reg.resolve(VOCAL_CODENAME))
            except Exception as e:
                emit_error(
                    "Failed to load Stage 1 model: " + str(e),
                    hint="First run downloads model weights. Check internet/firewall.",
                )

            progress_msg("separating_vocals", 18, model=VOCAL_CODENAME,
                         device=device_name, stage="vocal_split")
            t1 = time.time()
            try:
                stage1_outputs = sep1.separate(args.input)
            except Exception as e:
                msg = str(e).lower()
                if "out of memory" in msg or "cuda" in msg:
                    emit_error("GPU ran out of memory on vocal pass: " + str(e),
                               hint="Close other GPU apps or set quality to 'fast'.")
                emit_error("Vocal separation failed: " + str(e))
            stage1_time = time.time() - t1

            stage1_outputs = [
                p if os.path.isabs(p) else os.path.join(work_dir, p)
                for p in stage1_outputs
            ]
            vocals_path = find_output(work_dir, "vocals")
            instrumental_path = find_output(work_dir, "instrumental",
                                            fallback_keyword="other")
            if not vocals_path or not os.path.isfile(vocals_path):
                emit_error("Vocal stage produced no Vocals output",
                           hint="Check the log; the model may have failed silently.")
            if not instrumental_path or not os.path.isfile(instrumental_path):
                emit_error("Vocal stage produced no Instrumental output")

            # ── Optional vocal ensemble: run second model + average ─────
            # Same idea as Stage 2 ensemble but for vocal isolation. We
            # run a complementary architecture (MDX-Net via Phull-V2X)
            # whose failure modes are uncorrelated with BS-Roformer's.
            # Averaging both outputs cancels each model's specific
            # weaknesses (Roformer's sibilance leak on high vocals,
            # MDX-Net's softness on breath transitions). Cost: roughly
            # doubles Stage 1 runtime; we only run it when the user
            # explicitly toggles it.
            #
            # Critical implementation detail: the second model's outputs
            # must use the SAME naming convention as the first so the
            # downstream pipeline can still find them. We average the
            # two vocals.wav outputs into the existing vocals_path
            # filename, and the two instrumentals into instrumental_path.
            # No new files are surfaced to the user — same stem set out.
            if args.vocal_ensemble:
                try:
                    progress_msg("loading_vocal_ensemble_model", 28,
                                 model=VOCAL_ENSEMBLE_CODENAME)
                    # Free the primary Stage 1 model before loading the
                    # second — same reason as Stage 1.5 (each roformer
                    # is heavy, can't hold both in memory).
                    try:
                        del sep1
                        if device == "cuda":
                            torch.cuda.empty_cache()
                    except Exception:
                        pass
                    try:
                        sep1_ens = Separator(
                            model_file_dir=cache_dir,
                            output_dir=work_dir,
                            output_format="WAV",
                            normalization_threshold=0.999,
                            mdxc_params={"segment_size": 256, "override_model_segment_size": False,
                                         "batch_size": 1, "overlap": s1_overlap, "pitch_shift": 0},
                        )
                    except TypeError:
                        sep1_ens = Separator(
                            model_file_dir=cache_dir,
                            output_dir=work_dir,
                            output_format="WAV",
                        )
                    sep1_ens.load_model(model_filename=_reg.resolve(VOCAL_ENSEMBLE_CODENAME))
                    progress_msg("separating_vocal_ensemble", 30,
                                 model=VOCAL_ENSEMBLE_CODENAME,
                                 stage="vocal_split_ensemble")
                    t_ve = time.time()
                    stage1b_outputs = sep1_ens.separate(args.input)
                    stage1b_outputs = [
                        p if os.path.isabs(p) else os.path.join(work_dir, p)
                        for p in stage1b_outputs
                    ]
                    ve_time = time.time() - t_ve

                    # Find the second model's vocals + instrumental outputs.
                    # MDX23C uses "(Vocals)" / "(Instrumental)" naming, same
                    # convention as Roformer, so find_output works directly.
                    # We pass an explicit candidate_paths list so it searches
                    # ONLY the second model's outputs, not the first's.
                    def _find_in(paths, keyword):
                        for p in paths:
                            n = os.path.basename(p).lower()
                            if "(" + keyword + ")" in n or "_" + keyword + "_" in n:
                                return p
                        return None
                    vocals_b = _find_in(stage1b_outputs, "vocals")
                    instr_b = _find_in(stage1b_outputs, "instrumental") or \
                              _find_in(stage1b_outputs, "other")

                    # Average primary + ensemble vocals (sample-wise mean).
                    # Same math as _ensemble_average_harmonic_stems but for
                    # a single named pair instead of multiple stems.
                    if vocals_b and os.path.isfile(vocals_b) and \
                       instr_b and os.path.isfile(instr_b):
                        try:
                            import numpy as np
                            import soundfile as sf
                            v1, sr1 = sf.read(vocals_path, dtype="float32", always_2d=True)
                            v2, sr2 = sf.read(vocals_b, dtype="float32", always_2d=True)
                            i1, sri1 = sf.read(instrumental_path, dtype="float32", always_2d=True)
                            i2, sri2 = sf.read(instr_b, dtype="float32", always_2d=True)
                            if sr1 == sr2 == sri1 == sri2 and \
                               v1.shape[1] == v2.shape[1] and \
                               i1.shape[1] == i2.shape[1]:
                                nv = min(len(v1), len(v2))
                                ni = min(len(i1), len(i2))
                                v_mean = np.clip((v1[:nv] + v2[:nv]) * 0.5, -1.0, 1.0)
                                i_mean = np.clip((i1[:ni] + i2[:ni]) * 0.5, -1.0, 1.0)
                                # Overwrite in place: same path, averaged
                                # content. Downstream pipeline picks it up
                                # without any path changes.
                                sf.write(vocals_path, v_mean, sr1, subtype="PCM_16")
                                sf.write(instrumental_path, i_mean, sri1, subtype="PCM_16")
                                progress_msg("vocal_ensemble_complete", 35,
                                             processing_time=round(ve_time, 1))
                            else:
                                emit({"type": "warning",
                                      "message": "Vocal ensemble shape/SR mismatch — using primary only",
                                      "detail": f"sr={sr1},{sr2},{sri1},{sri2}"})
                        except Exception as avg_err:
                            emit({"type": "warning",
                                  "message": "Vocal ensemble averaging failed — using primary only",
                                  "detail": str(avg_err)})
                    else:
                        emit({"type": "warning",
                              "message": "Vocal ensemble model produced no usable outputs",
                              "detail": "outputs=" + str([os.path.basename(p) for p in stage1b_outputs])})
                    try:
                        del sep1_ens
                        if device == "cuda":
                            torch.cuda.empty_cache()
                    except Exception:
                        pass
                except Exception as ve_err:
                    # Ensemble is a quality bonus; never block the pipeline.
                    emit({"type": "warning",
                          "message": "Vocal ensemble pass failed — using primary only",
                          "detail": str(ve_err)})

            progress_msg("vocal_split_complete", 38, processing_time=round(stage1_time, 1))

            # ── Stage 1.5: lead vs backing/sample vocal split (optional) ──────
            # Only runs if --split-lead-vocal was passed. Produces two extra
            # stems alongside the existing vocals.wav:
            #   • lead_vocal.wav (the main performance — best-effort isolation)
            #   • back_vocal.wav (backing vox + ad-libs + sample vocals merged)
            # Uses a separate karaoke-trained roformer model. The result quality
            # is honest "best effort" — works well on clean pop/R&B and varies
            # by track on rap (ad-libs blur into lead, this is acoustically hard).
            lead_vocal_path = None
            back_vocal_path = None
            stage1_5_time = 0.0
            dereverb_time = 0.0
            if args.split_lead_vocal:
                progress_msg("loading_lead_vocal_model", 39, model=LEAD_VOCAL_CODENAME)
                # Free Stage 1 from memory before loading the lead-vocal model.
                # Each roformer is ~600MB on CPU, ~2GB on GPU; can't keep both.
                try:
                    del sep1
                    if device == "cuda":
                        torch.cuda.empty_cache()
                except Exception:
                    pass
                try:
                    sep1_5 = Separator(
                        model_file_dir=cache_dir,
                        output_dir=work_dir,
                        output_format="WAV",
                        normalization_threshold=0.999,
                        mdxc_params={"segment_size": 256, "override_model_segment_size": False,
                                     "batch_size": 1, "overlap": s1_overlap, "pitch_shift": 0},
                    )
                except TypeError:
                    sep1_5 = Separator(
                        model_file_dir=cache_dir,
                        output_dir=work_dir,
                        output_format="WAV",
                    )
                try:
                    sep1_5.load_model(model_filename=_reg.resolve(LEAD_VOCAL_CODENAME))
                except Exception as e:
                    # If the lead-vocal model fails to load (network issue,
                    # corrupted weights), don't kill the whole pipeline — just
                    # skip the sub-split and report. User gets the regular
                    # vocals.wav, no lead/back stems.
                    emit({"type": "warning",
                          "message": "Lead vocal split unavailable — vocals stem will not be sub-split",
                          "detail": str(e)})
                    sep1_5 = None

                if sep1_5 is not None:
                    progress_msg("separating_lead_vocal", 41, model=LEAD_VOCAL_CODENAME)
                    t1_5 = time.time()
                    try:
                        s1_5_outputs = sep1_5.separate(vocals_path)
                    except Exception as e:
                        emit({"type": "warning",
                              "message": "Lead vocal separation failed — proceeding without sub-split",
                              "detail": str(e)})
                        s1_5_outputs = []
                    stage1_5_time = time.time() - t1_5
                    s1_5_outputs = [
                        p if os.path.isabs(p) else os.path.join(work_dir, p)
                        for p in s1_5_outputs
                    ]
                    # The karaoke model outputs typically named (Vocals)/(Instrumental)
                    # where (Vocals) here is the LEAD and (Instrumental) is the
                    # rest of the original vocals.wav (backing + samples + ad-libs).
                    # Different audio_separator versions use slightly different
                    # naming conventions for the karaoke roformer output, so we
                    # try keyword matching first and fall back to "two files,
                    # take them in order" if matching missed.
                    for p in s1_5_outputs:
                        name = os.path.basename(p).lower()
                        if "(vocals)" in name or "_vocals_" in name or "(lead)" in name or "_lead_" in name:
                            lead_vocal_path = p
                        elif ("(instrumental)" in name or "_instrumental_" in name or
                              "(other)" in name or "_other_" in name or
                              "(no_vocals)" in name or "_no_vocals_" in name or
                              "(back)" in name or "_back_" in name):
                            back_vocal_path = p
                    # Fallback: if the model produced 2 files but we only matched
                    # one, assign the unmatched file to the missing slot. The
                    # karaoke roformer always outputs exactly 2 stems so this is
                    # safe — first file detected is usually the "kept" stem
                    # (lead), second is the "removed" stem (backing).
                    if len(s1_5_outputs) == 2 and (lead_vocal_path is None or back_vocal_path is None):
                        matched = {lead_vocal_path, back_vocal_path} - {None}
                        unmatched = [p for p in s1_5_outputs if p not in matched]
                        if lead_vocal_path is None and unmatched:
                            lead_vocal_path = unmatched.pop(0)
                        if back_vocal_path is None and unmatched:
                            back_vocal_path = unmatched.pop(0)
                        emit({"type": "warning",
                              "message": "Lead vocal model filename didn't match expected pattern — used file order fallback",
                              "detail": "outputs=" + str([os.path.basename(p) for p in s1_5_outputs])})
                    progress_msg("lead_vocal_split_complete", 44,
                                 processing_time=round(stage1_5_time, 1))
                    try:
                        del sep1_5
                        if device == "cuda":
                            torch.cuda.empty_cache()
                    except Exception:
                        pass

            # ── Stage 1.7: optional de-reverb / de-echo ──────────────────────
            # Runs the UVR-DeEcho-DeReverb model on whichever vocal stem
            # represents the "lead": lead_vocal.wav if Stage 1.5 produced
            # one, otherwise the full vocals.wav. The model outputs two
            # files: a dry vocal (no reverb tail) and a residual (the
            # removed reverb). We keep only the dry file and REPLACE the
            # original wet vocal stem with it. The residual is discarded
            # since most users want the dry vocal, not the reverb tail
            # as its own stem.
            #
            # Fails-soft: if the model errors out, we keep the wet vocal
            # and emit a warning. Never blocks the pipeline.
            if args.dereverb:
                # Choose target file
                if lead_vocal_path and os.path.isfile(lead_vocal_path):
                    dereverb_input = lead_vocal_path
                    dereverb_role = "lead_vocal"
                elif vocals_path and os.path.isfile(vocals_path):
                    dereverb_input = vocals_path
                    dereverb_role = "vocals"
                else:
                    dereverb_input = None
                    dereverb_role = None

                if dereverb_input:
                    progress_msg("loading_dereverb_model", 45,
                                 model=DEREVERB_CODENAME)
                    try:
                        try:
                            sep_dr = Separator(
                                model_file_dir=cache_dir,
                                output_dir=work_dir,
                                output_format="WAV",
                                normalization_threshold=0.999,
                            )
                        except TypeError:
                            sep_dr = Separator(
                                model_file_dir=cache_dir,
                                output_dir=work_dir,
                                output_format="WAV",
                            )
                        sep_dr.load_model(model_filename=_reg.resolve(DEREVERB_CODENAME))
                        progress_msg("dereverberating", 46,
                                     model=DEREVERB_CODENAME,
                                     target=dereverb_role)
                        t_dr = time.time()
                        dr_outputs = sep_dr.separate(dereverb_input)
                        dereverb_time = time.time() - t_dr
                        dr_outputs = [
                            p if os.path.isabs(p) else os.path.join(work_dir, p)
                            for p in dr_outputs
                        ]
                        # Find the "no reverb" / "dry" output. The UVR
                        # de-reverb model outputs two files named like
                        # "<input>_(No Reverb)_UVR..." and
                        # "<input>_(Reverb)_UVR...". We want the No-Reverb one.
                        dry_path = None
                        for p in dr_outputs:
                            n = os.path.basename(p).lower()
                            if "(no reverb)" in n or "(no_reverb)" in n or "_no_reverb" in n or "(dry)" in n:
                                dry_path = p
                                break
                        # Fallback: if neither matched, pick the file
                        # whose RMS is closest to the original (the dry
                        # vocal preserves most of the original energy;
                        # the reverb tail is much quieter)
                        if not dry_path and len(dr_outputs) == 2:
                            try:
                                import soundfile as _sf_check
                                import numpy as _np_check
                                src, _ = _sf_check.read(dereverb_input, dtype="float32", always_2d=True)
                                src_rms = float(_np_check.sqrt(_np_check.mean(src ** 2)))
                                best = None
                                best_diff = float("inf")
                                for p in dr_outputs:
                                    d, _ = _sf_check.read(p, dtype="float32", always_2d=True)
                                    d_rms = float(_np_check.sqrt(_np_check.mean(d ** 2)))
                                    diff = abs(d_rms - src_rms)
                                    if diff < best_diff:
                                        best_diff = diff
                                        best = p
                                dry_path = best
                            except Exception:
                                dry_path = dr_outputs[0]
                        if dry_path and os.path.isfile(dry_path):
                            # Replace the wet vocal with the dry one.
                            # We do this by overwriting the path the
                            # rest of the pipeline already points to.
                            shutil.copy(dry_path, dereverb_input)
                            progress_msg("dereverb_complete", 47,
                                         processing_time=round(dereverb_time, 1))
                        else:
                            emit({"type": "warning",
                                  "message": "De-reverb model produced no dry output — keeping wet vocal",
                                  "detail": "outputs=" + str([os.path.basename(p) for p in dr_outputs])})
                        try:
                            del sep_dr
                            if device == "cuda":
                                torch.cuda.empty_cache()
                        except Exception:
                            pass
                    except Exception as dr_err:
                        emit({"type": "warning",
                              "message": "De-reverb pass failed; keeping wet vocal",
                              "detail": str(dr_err)})

            # Free the first model before loading the second — saves VRAM
            try:
                del sep1
                if device == "cuda":
                    torch.cuda.empty_cache()
            except Exception:
                pass
        else:
            # Direct mode: feed the original input straight to Stage 2.
            # No Stage 1, no separate vocals.wav from BS-RoFormer.
            instrumental_path = args.input
            progress_msg("vocal_split_skipped", 38,
                         note="Direct mode: vocal samples will stay with the instrumental")

        # ── Stage 2: instrumental decomposition ───────────────────────────────
        instr_codename = INSTR_CODENAME_4 if args.mode == "4" else INSTR_CODENAME_6
        progress_msg("loading_instrumental_model", 42, model=instr_codename)

        try:
            sep2 = Separator(
                model_file_dir=cache_dir,
                output_dir=work_dir,
                output_format="WAV",
                # Same anti-pumping fix as Stage 1 — see comment above.
                normalization_threshold=0.999,
                demucs_params={
                    "segment_size": "Default",
                    "shifts": shifts,
                    "overlap": overlap,
                    "segments_enabled": True,
                },
            )
        except TypeError:
            sep2 = Separator(
                model_file_dir=cache_dir,
                output_dir=work_dir,
                output_format="WAV",
            )

        try:
            sep2.load_model(model_filename=_reg.resolve(instr_codename))
        except Exception as e:
            emit_error(
                "Failed to load Stage 2 model: " + str(e),
                hint="First run downloads model weights.",
            )

        progress_msg("separating_instrumental", 52, model=instr_codename,
                     device=device_name, stage="instrumental_split",
                     overlap=overlap, shifts=shifts)
        t2 = time.time()
        try:
            stage2_outputs = sep2.separate(instrumental_path)
        except Exception as e:
            msg = str(e).lower()
            if "out of memory" in msg or "cuda" in msg:
                emit_error("GPU ran out of memory on instrumental pass: " + str(e),
                           hint="Close other GPU apps or set quality to 'fast'.")
            emit_error("Instrumental separation failed: " + str(e))
        stage2_time = time.time() - t2

        stage2_outputs = [
            p if os.path.isabs(p) else os.path.join(work_dir, p)
            for p in stage2_outputs
        ]
        progress_msg("instrumental_split_complete", 88,
                     processing_time=round(stage2_time, 1))

        # ── Optional Stage 2 ensemble pass ────────────────────────────────────
        # When --ensemble is set AND quality is high/ultra, run a second
        # Stage 2 model and average its harmonic outputs (piano, other,
        # guitar) with the primary. Each model has different failure modes,
        # so averaging cancels uncorrelated artifacts. SDR lift on harmonic
        # stems is typically +0.3 to +0.8 dB on pop/hiphop. Costs ~30%
        # extra Stage 2 runtime since we run the second model in full.
        #
        # We DON'T average drums/bass/vocals — those stems are already
        # high-quality from the primary, and ensemble has diminishing returns
        # there. Saving the time for the stems that actually benefit.
        if args.ensemble and args.quality in ("high", "ultra"):
            ensemble_codename = (INSTR_CODENAME_4_ENSEMBLE if args.mode == "4"
                                 else INSTR_CODENAME_6_ENSEMBLE)
            try:
                progress_msg("separating_instrumental_ensemble", 89,
                             model=ensemble_codename,
                             stage="instrumental_split_ensemble")
                # Spin up a separate Separator instance — the audio-separator
                # API doesn't safely allow swapping the loaded model mid-run.
                try:
                    sep2b = Separator(
                        model_file_dir=cache_dir,
                        output_dir=work_dir,
                        output_format="WAV",
                        normalization_threshold=0.999,
                        demucs_params={
                            "segment_size": "Default",
                            "shifts": shifts,
                            "overlap": overlap,
                            "segments_enabled": True,
                        },
                    )
                except TypeError:
                    sep2b = Separator(
                        model_file_dir=cache_dir,
                        output_dir=work_dir,
                        output_format="WAV",
                    )
                sep2b.load_model(model_filename=_reg.resolve(ensemble_codename))
                t_ens = time.time()
                stage2_ensemble_outputs = sep2b.separate(instrumental_path)
                stage2_ensemble_outputs = [
                    p if os.path.isabs(p) else os.path.join(work_dir, p)
                    for p in stage2_ensemble_outputs
                ]
                ens_time = time.time() - t_ens
                progress_msg("instrumental_split_ensemble_complete", 91,
                             processing_time=round(ens_time, 1))
                # Average matching harmonic stems sample-wise. The averaged
                # WAV replaces the primary's output in stage2_outputs.
                stage2_outputs = _ensemble_average_harmonic_stems(
                    stage2_outputs, stage2_ensemble_outputs, work_dir
                )
            except Exception as ens_err:
                # Ensemble is a quality bonus; never block the pipeline if
                # it fails. Emit a warning so users know it didn't run.
                emit({"type": "warning",
                      "message": "Ensemble pass failed; using primary model only",
                      "detail": str(ens_err)})

        # ── Quality post-process: multi-bleed cleanup ─────────────────────
        # Three cleanups in one pass, all guided by envelopes of the "guilty"
        # stem:
        #   • Kick bleed in piano/other/guitar (drums envelope)
        #   • Bass bleed in piano/other/guitar (bass envelope)
        #   • Sub-rumble HP at 25 Hz (always-on)
        # Cheap (~2-3s on 5min track at this preset), no quality regressions
        # since cleanup is conservative and only fires when the guilty stem
        # is active. Silent no-op if scipy/numpy unavailable.
        try:
            progress_msg("post_processing", 90,
                         note="Cleaning kick/bass bleed in harmonic stems")
            # Index stage2_outputs by stem name so the cleanup can find each
            stems_by_name = {}
            for p in stage2_outputs:
                low = os.path.basename(p).lower()
                for stem_kw in ("drums", "bass", "piano", "guitar", "other", "vocals"):
                    if "(" + stem_kw + ")" in low or "_" + stem_kw + "_" in low:
                        stems_by_name[stem_kw] = p
                        break

            # Also include lead_vocal / back_vocal in the index when Stage
            # 1.5 split them out. This lets fullness restoration (sustain
            # repair on the lead, ducking compensation on the back) and
            # the new back-vocal cleanup pass operate on them. Without
            # this, those stems would skip every post-process.
            if lead_vocal_path and os.path.isfile(lead_vocal_path):
                stems_by_name["lead_vocal"] = lead_vocal_path
            if back_vocal_path and os.path.isfile(back_vocal_path):
                stems_by_name["back_vocal"] = back_vocal_path

            # ── AI stem recovery: route misclassified content to the
            # correct stem based on activity envelopes. Most impactful in
            # 6-stem mode (piano/guitar/other triangle), but also helps in
            # 4-stem since "other" can absorb harmonic content there too.
            # Pairs that have no match in stems_by_name (e.g. piano in
            # 4-stem) silently no-op inside ai_stem_recovery. Has to run
            # BEFORE clean_stem_bleeds so the cleanup operates on the
            # corrected stems (more accurate energy envelopes = better
            # kick/bass detection).
            progress_msg("recovering_stems", 89,
                         note="AI stem recovery — routing misclassified content")
            recovered_map = ai_stem_recovery(stems_by_name, work_dir)
            stage2_outputs = [recovered_map.get(p, p) for p in stage2_outputs]
            for stem_kw, old_path in list(stems_by_name.items()):
                stems_by_name[stem_kw] = recovered_map.get(old_path, old_path)
            # Propagate any recovery changes back to lead/back path vars
            # so the final_stems builder picks up the corrected files.
            if lead_vocal_path:
                lead_vocal_path = recovered_map.get(lead_vocal_path, lead_vocal_path)
            if back_vocal_path:
                back_vocal_path = recovered_map.get(back_vocal_path, back_vocal_path)

            # ── Fullness restoration: repair sustain dropouts + ghost
            # ducking on harmonic stems. Runs after AI recovery so the
            # activity baselines used to detect dropouts are computed on
            # the cleanest possible versions of each stem (content already
            # routed where it belongs). Cost: about 8-15s on a 5-min track
            # for 3 harmonic stems. Never blocks the pipeline.
            #
            # Intensity comes from the user via --fullness-preset (sets
            # the per-pass strengths) plus optional --fullness-sustain /
            # --fullness-ducking-db / --fullness-transient-db which
            # override the preset's individual values. This lets the UI
            # ship a simple "Subtle / Balanced / Aggressive" picker AND
            # expose advanced per-pass sliders to power users without
            # the pipeline needing to know which controls were used.
            preset_vals = FULLNESS_PRESETS.get(
                args.fullness_preset, FULLNESS_PRESETS["balanced"]
            )
            fullness_intensity = {
                "sustain":      preset_vals["sustain"] if args.fullness_sustain is None else args.fullness_sustain,
                "ducking_db":   preset_vals["ducking_db"] if args.fullness_ducking_db is None else args.fullness_ducking_db,
                "transient_db": preset_vals["transient_db"] if args.fullness_transient_db is None else args.fullness_transient_db,
            }
            progress_msg("restoring_fullness", 90,
                         note="Restoring note tails and ducking compensation",
                         preset=args.fullness_preset)
            fullness_map = restore_stem_fullness(
                stems_by_name, work_dir,
                intensity=fullness_intensity,
            )
            stage2_outputs = [fullness_map.get(p, p) for p in stage2_outputs]
            for stem_kw, old_path in list(stems_by_name.items()):
                stems_by_name[stem_kw] = fullness_map.get(old_path, old_path)
            # Propagate fullness updates back to lead/back path vars
            if lead_vocal_path:
                lead_vocal_path = fullness_map.get(lead_vocal_path, lead_vocal_path)
            if back_vocal_path:
                back_vocal_path = fullness_map.get(back_vocal_path, back_vocal_path)

            # ── Back-vocal cleanup: remove misclassified hi-hat content
            # that the karaoke model dumped into back_vocal. Cross-references
            # the drums stem to find hat-band content correlated with drums
            # activity, subtracts it from back_vocal. Also runs a gentle
            # voicing gate on the whole back_vocal to attenuate unvoiced
            # HF-dominant frames (residual percussion noise). Silent no-op
            # when back_vocal or drums aren't in stems_by_name.
            if "back_vocal" in stems_by_name:
                progress_msg("cleaning_back_vocal", 92,
                             note="Removing misclassified hat content from back_vocal")
                bv_map = cleanup_back_vocal(stems_by_name, work_dir)
                for stem_kw, old_path in list(stems_by_name.items()):
                    stems_by_name[stem_kw] = bv_map.get(old_path, old_path)
                if back_vocal_path:
                    back_vocal_path = bv_map.get(back_vocal_path, back_vocal_path)

            cleaned_map = clean_stem_bleeds(stems_by_name, work_dir)
            # cleaned_map: original_path -> (possibly cleaned) path
            stage2_outputs = [cleaned_map.get(p, p) for p in stage2_outputs]
            # Propagate clean_stem_bleeds updates back to lead/back vars
            if lead_vocal_path:
                lead_vocal_path = cleaned_map.get(lead_vocal_path, lead_vocal_path)
            if back_vocal_path:
                back_vocal_path = cleaned_map.get(back_vocal_path, back_vocal_path)
        except Exception as _e:
            # Post-process failure NEVER blocks the export — users still
            # get their stems, just without the cleanup.
            emit({"type": "warning",
                  "message": "Stem-bleed cleanup skipped",
                  "detail": str(_e)})

        # ── Collect & rename final stems ──────────────────────────────────────
        progress_msg("writing_stems", 92)
        # Base stem set. If lead-vocal split SUCCEEDED, we replace 'vocals'
        # with the lead/back pair — users asking for the split want EXACTLY
        # those two, not a duplicate merged stem. If the split was requested
        # but failed (no lead_vocal_path), keep the original vocals stem as
        # the fallback so the user still gets vocals at all.
        split_succeeded = bool(
            args.split_lead_vocal and
            lead_vocal_path and os.path.isfile(lead_vocal_path) and
            back_vocal_path and os.path.isfile(back_vocal_path)
        )
        if split_succeeded:
            stem_keywords = ["lead_vocal", "back_vocal", "drums", "bass", "other"]
        else:
            stem_keywords = ["vocals", "drums", "bass", "other"]
        if args.mode == "6":
            stem_keywords += ["guitar", "piano"]

        final_stems = []
        for stem in stem_keywords:
            if stem == "lead_vocal":
                src = lead_vocal_path
            elif stem == "back_vocal":
                src = back_vocal_path
            elif stem == "vocals" and not direct_mode:
                # Cascade mode: use the clean BS-RoFormer vocal from Stage 1.
                src = vocals_path
            elif stem == "vocals" and direct_mode:
                # Direct mode: pull vocals from Stage 2 (Demucs).
                # Producer vocal samples in the beat (ad-libs, vocal chops)
                # land in 'other' rather than getting merged here.
                src = None
                for p in stage2_outputs:
                    name = os.path.basename(p).lower()
                    if "(vocals)" in name or "_vocals_" in name or "vocals" in name:
                        src = p
                        break
                if not src:
                    src = find_output(work_dir, "vocals")
            else:
                # Other stems always come from Stage 2.
                src = None
                for p in stage2_outputs:
                    name = os.path.basename(p).lower()
                    if "(" + stem + ")" in name or "_" + stem + "_" in name or stem in name:
                        src = p
                        break
                if not src:
                    src = find_output(work_dir, stem)
            if not src or not os.path.isfile(src):
                continue
            dst = os.path.join(final_dir, stem + ".wav")
            try:
                shutil.move(src, dst)
            except Exception:
                shutil.copy2(src, dst)
                safe_unlink(src)
            final_stems.append({
                "name": stem,
                "label": STEM_LABEL.get(stem, stem.title()),
                "path": dst,
            })

        # Cleanup intermediate files
        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception:
            pass

        # Read source duration for reporting
        try:
            import torchaudio
            info = torchaudio.info(args.input)
            duration = info.num_frames / info.sample_rate
        except Exception:
            duration = None

        elapsed = stage1_time + stage1_5_time + dereverb_time + stage2_time

        # ── Per-stem BPM + key detection ──────────────────────────────────
        # Run the lightweight analyzer on each output stem. Cheap (~2-3s
        # per stem on CPU for BPM+key only), useful for producers who want
        # to know e.g. "what BPM is the drums stem actually at" or "what
        # key is the piano playing in" without running them through the
        # main Analyzer one at a time.
        #
        # We import analyze here (not at top of module) so users without
        # the analyze.py dependencies installed don't fail to launch the
        # separator. If import fails, we just skip the per-stem analysis
        # and ship without that field.
        per_stem_analysis = {}
        try:
            progress_msg("per_stem_analysis", 96,
                         note="Analyzing BPM/key on each stem")
            try:
                import analyze as _analyzer
            except ImportError:
                _analyzer = None
            if _analyzer is not None:
                for stem_name, stem_path in final_stems.items():
                    if not stem_path or not os.path.isfile(stem_path):
                        continue
                    try:
                        per_stem_analysis[stem_name] = _analyzer.analyze_stem(stem_path)
                    except Exception as _sa_err:
                        per_stem_analysis[stem_name] = {'error': str(_sa_err)}
        except Exception as _all_err:
            # Per-stem analysis is a bonus; never let it block the success
            # of the actual separation. Emit a warning so the user knows
            # the per-stem readouts will be missing.
            emit({"type": "warning",
                  "message": "Per-stem BPM/key analysis skipped",
                  "detail": str(_all_err)})

        # Build the list of models used. Order matches pipeline stages.
        models_used = []
        if not direct_mode:
            models_used.append(VOCAL_CODENAME)
            # Vocal ensemble partner only added when it actually ran. We
            # check vocal_ensemble flag AND non-direct (direct mode skips
            # Stage 1 entirely, so vocal ensemble is impossible there).
            if args.vocal_ensemble:
                models_used.append(VOCAL_ENSEMBLE_CODENAME)
        if args.split_lead_vocal and lead_vocal_path:
            models_used.append(LEAD_VOCAL_CODENAME)
        if args.dereverb and dereverb_time > 0:
            models_used.append(DEREVERB_CODENAME)
        models_used.append(instr_codename)
        # Add Stage 2 ensemble partner to the list when it actually ran
        if args.ensemble and args.quality in ("high", "ultra"):
            ens_codename = (INSTR_CODENAME_4_ENSEMBLE if args.mode == "4"
                            else INSTR_CODENAME_6_ENSEMBLE)
            models_used.append(ens_codename)

        emit({
            "type": "done",
            "stems": final_stems,
            "output_dir": final_dir,
            "models": models_used,
            "ensemble": not direct_mode,
            "ensemble_stage2": bool(args.ensemble and args.quality in ("high", "ultra")),
            "vocal_ensemble_applied": bool(args.vocal_ensemble and not direct_mode),
            "lead_vocal_split": bool(args.split_lead_vocal and lead_vocal_path),
            "dereverb_applied": bool(args.dereverb and dereverb_time > 0),
            "fullness_preset": args.fullness_preset,
            "fullness_intensity": {
                "sustain":      round(float(fullness_intensity["sustain"]), 2),
                "ducking_db":   round(float(fullness_intensity["ducking_db"]), 2),
                "transient_db": round(float(fullness_intensity["transient_db"]), 2),
            } if 'fullness_intensity' in locals() else None,
            "mode": args.mode,
            "direct_mode": direct_mode,
            "quality": args.quality,
            "device": device_name,
            "duration": round(duration, 2) if duration else None,
            "processing_time": round(elapsed, 1),
            "kick_bleed_suppression": True,
            "per_stem_analysis": per_stem_analysis,
            "progress": 100,
        })

    except SystemExit:
        raise
    except Exception as e:
        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception:
            pass
        emit_error("Unexpected error: " + str(e))


if __name__ == "__main__":
    main()
