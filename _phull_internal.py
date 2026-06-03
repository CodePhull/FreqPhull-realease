# Freq.Phull internal model registry
# Copyright © Real General · Hood Knights — all rights reserved.
#
# This module maps Freq.Phull internal model codenames to the underlying
# model artifacts. Distributing or republishing the contents of this file is
# prohibited under the Freq.Phull license.

import hashlib
import os


# Codename -> real artifact filename. Anywhere else in the codebase, code
# refers to models ONLY by codename. The real names live here.
#
# These constants are kept short and opaque so that grepping the rest of
# the codebase for the strings below returns nothing useful to a reader.
_MODEL_REGISTRY = {
    # Phull-V2: high-SDR vocal isolation (Stage 1)
    "Phull-V2": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    # Phull-V2X: ensemble partner for vocal isolation. Different architecture
    # (MDX-Net family) with complementary failure modes to BS-Roformer.
    # BS-Roformer tends to leak some high-vocal sibilance into instrumental
    # on aggressive screams; MDX-Net handles that cleanly but is slightly
    # weaker on breath transitions. Averaging both outputs cancels each
    # model's specific weakness. Only used when --vocal-ensemble is set.
    # Cost: roughly doubles Stage 1 runtime.
    "Phull-V2X": "MDX23C-8KFFT-InstVoc_HQ.ckpt",
    # Phull-V2L: lead vs backing/sample vocal separation (Stage 1.5, optional)
    # Best public model for separating the main lead vocal from harmonies,
    # ad-libs, and sample vocals on rap/pop. Result quality is "best effort,"
    # not perfect — labeled accordingly in the UI.
    "Phull-V2L": "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
    # Phull-DR: de-reverb / de-echo for an isolated vocal stem.
    # Trained to remove reverb tail and slap echo from already-isolated
    # vocals. Run as optional Stage 1.7 (after Stage 1, after Stage 1.5
    # if active) on the vocals.wav or lead_vocal.wav. Replaces the wet
    # vocal with a dry version. Useful for sampling/remixing vocals that
    # were recorded with heavy ambience.
    # Model: UVR-DeEcho-DeReverb v2 (public, MIT-licensed for inference).
    "Phull-DR": "UVR-DeEcho-DeReverb.pth",
    # Phull-I4: 4-stem instrumental separation (Stage 2, default)
    "Phull-I4": "htdemucs_ft.yaml",
    # Phull-I4F: alternate 4-stem fine-tuned variant, paired with Phull-I4 in
    # ensemble mode to lift SDR on harmonic stems (piano/other/guitar).
    # Running both and averaging their outputs lets us reduce model-specific
    # artifacts: each model has different failure modes (one may leak bass
    # into 'other', the other may miss attack transients in 'piano'), and
    # averaging cancels most uncorrelated errors. Only enabled when quality
    # = 'high' or 'ultra' AND the user toggle 'ensemble' is on. Costs ~+30%
    # to Stage 2 runtime.
    "Phull-I4F": "htdemucs.yaml",
    # Phull-I6: 6-stem instrumental separation (Stage 2, --mode 6)
    "Phull-I6": "htdemucs_6s.yaml",
    # Phull-I6F: alternate 6-stem variant for ensemble averaging (same idea
    # as Phull-I4F but for the 6-stem path). audio-separator currently only
    # ships htdemucs_6s as the 6-stem checkpoint; we re-use it here as a
    # placeholder. When a second 6-stem checkpoint becomes available we
    # swap it in here without touching call sites.
    "Phull-I6F": "htdemucs_6s.yaml",
    # Phull-I: fallback instrumental separator
    "Phull-I":  "htdemucs.yaml",
}


def resolve(codename):
    """Translate a Freq.Phull codename to the real model filename.
    Raises KeyError on unknown codename."""
    return _MODEL_REGISTRY[codename]


def cache_filename(codename):
    """Generate an opaque on-disk filename for a given codename.
    Users browsing ~/.cache/freqphull-models/ see hashes, not model names."""
    h = hashlib.sha256(codename.encode("utf-8")).hexdigest()[:12]
    return "phull_" + h + ".bin"


def is_known_codename(codename):
    return codename in _MODEL_REGISTRY


def all_codenames():
    return list(_MODEL_REGISTRY.keys())
