#!/usr/bin/env python3
"""
fingerprint.py — Generate a perceptual hash for an audio file.

Called from server.js after a download completes or on-demand from the
"Find duplicates" workflow. Reads the file, computes a compact fingerprint,
prints it as a hex string.

Usage:
    python fingerprint.py /path/to/audio.wav

Stdout (success):
    {"ok": true, "hash": "a3f2...", "duration": 213.4}

Stdout (failure):
    {"ok": false, "error": "reason"}

Approach
--------
Mel-spectrum hash. For each 1.5-second chunk of audio (we sample 16 chunks
across the track to handle different durations), compute a 32-band mel
spectrogram, normalize, and threshold it to bits. Hash is the concatenation.

This catches:
  • Same audio in different formats (mp3 vs flac vs ogg)
  • Same audio at different bitrates / sample rates
  • Same audio with different volume levels (normalized internally)
  • Same song uploaded by different YouTube channels (re-uploads, mirrors)
  • Audio with minor encoding artifacts that don't change the spectrum

This does NOT catch:
  • Same song, different mix (radio edit vs album, remix vs original)
  • Snippets vs full versions (different chunk coverage)
  • Pitch-shifted versions

A "match" in the duplicate-detection sense is hamming distance below a
threshold (~10% of bits flipped). The renderer's duplicate-finder endpoint
does the comparison server-side.

Why not chromaprint?
chromaprint would be more accurate, but it requires a binary install
(fpcalc) which means we'd need to bundle a platform-specific .exe and
deal with packaging. librosa is already a transitive dep of audio-separator
so this approach is install-free.
"""

import sys
import json
import os
import warnings

# librosa is loud about deprecations and numerical edge cases; suppress.
warnings.filterwarnings("ignore")


def fingerprint(path):
    """Compute a 512-bit perceptual hash. Returns (hex_hash, duration_sec)."""
    try:
        import librosa
        import numpy as np
    except ImportError as e:
        raise RuntimeError("librosa not available: " + str(e))

    # Load at 22050 Hz mono — plenty of resolution for spectral fingerprinting
    # and ~4x faster than 44100. Use offset/duration probe first for total
    # length, then sample chunks across the track.
    duration = librosa.get_duration(path=path)
    if duration < 1.0:
        raise RuntimeError("Audio too short to fingerprint")

    # 16 chunks of 1.5s each. For tracks shorter than 24s we'd run out of
    # non-overlapping chunks, so clamp the spacing.
    n_chunks = 16
    chunk_dur = 1.5
    # Equally spaced start points across [0, duration - chunk_dur]
    if duration <= chunk_dur:
        starts = [0.0] * n_chunks  # all chunks point to the same content
    else:
        max_start = max(0.0, duration - chunk_dur)
        starts = [i * max_start / (n_chunks - 1) for i in range(n_chunks)]

    bits = []
    for s in starts:
        y, sr = librosa.load(path, sr=22050, mono=True, offset=s, duration=chunk_dur)
        if len(y) < 256:
            # Pad short reads (last chunk near EOF) so the mel spec doesn't fail
            y = np.pad(y, (0, 256 - len(y)))
        # 32-band mel spectrogram. Power → dB so quiet stuff stays meaningful.
        S = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=32, n_fft=1024, hop_length=512)
        S_db = librosa.power_to_db(S, ref=np.max)
        # Time-average each band → 32 numbers per chunk
        band_means = S_db.mean(axis=1)
        # Compare adjacent bands → 31 bits per chunk (32 - 1)
        chunk_bits = [1 if band_means[i] > band_means[i - 1] else 0 for i in range(1, len(band_means))]
        bits.extend(chunk_bits)

    # We get 16 * 31 = 496 bits. Pad to 512 for clean hex.
    while len(bits) % 8 != 0:
        bits.append(0)
    while len(bits) < 512:
        bits.append(0)

    # Pack bits into bytes
    byts = bytearray()
    for i in range(0, len(bits), 8):
        b = 0
        for j in range(8):
            if bits[i + j]:
                b |= (1 << (7 - j))
        byts.append(b)
    return byts.hex(), float(duration)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "no path argument"}))
        return 1
    path = sys.argv[1]
    if not os.path.isfile(path):
        print(json.dumps({"ok": False, "error": "file not found: " + path}))
        return 1
    try:
        h, dur = fingerprint(path)
        print(json.dumps({"ok": True, "hash": h, "duration": dur}))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": type(e).__name__ + ": " + str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
