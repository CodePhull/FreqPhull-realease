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
deal with packaging. The hash uses only numpy/scipy/soundfile, which the
engine setup installs as its core tier
so this approach is install-free.
"""

import sys
import json
import os
import warnings

# numpy can be loud about numerical edge cases on near-silent audio.
warnings.filterwarnings("ignore")


def _load_chunk(path, start_s, dur_s, target_sr=22050):
    """Read a mono chunk. soundfile handles wav/flac/ogg natively; anything
    else (mp3, m4a, aac) is decoded through ffmpeg, which the app ships."""
    import numpy as np
    try:
        import soundfile as sf
        info = sf.info(path)
        sr = info.samplerate
        start_frame = int(start_s * sr)
        frames = int(dur_s * sr)
        data, sr = sf.read(path, start=start_frame, frames=frames,
                           dtype="float32", always_2d=True)
        y = data.mean(axis=1)
    except Exception:
        y, sr = _ffmpeg_chunk(path, start_s, dur_s, target_sr)
    # Cheap decimation to roughly target_sr; exact rate does not matter as
    # long as it is consistent, since the hash only compares bands to each
    # other within the same track.
    if sr > target_sr:
        step = max(1, int(round(sr / target_sr)))
        y = y[::step]
        sr = sr // step
    return np.asarray(y, dtype="float32"), sr


def _ffmpeg_chunk(path, start_s, dur_s, target_sr):
    """Decode a chunk to raw mono float32 through ffmpeg."""
    import subprocess
    import numpy as np
    exe = os.environ.get("FREQPHULL_FFMPEG") or "ffmpeg"
    cmd = [exe, "-v", "quiet", "-ss", str(start_s), "-t", str(dur_s),
           "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(target_sr), "-"]
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         check=True).stdout
    return np.frombuffer(out, dtype="<f4").copy(), target_sr


def _total_duration(path):
    try:
        import soundfile as sf
        info = sf.info(path)
        return info.frames / float(info.samplerate)
    except Exception:
        pass
    import subprocess
    exe = os.environ.get("FREQPHULL_FFPROBE") or "ffprobe"
    out = subprocess.run(
        [exe, "-v", "quiet", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True).stdout
    return float(out.decode().strip())


def _log_band_energies(y, sr, n_bands=32, n_fft=1024, hop=512):
    """Mean per-band energy in dB over the chunk, on log-spaced bands.

    This replaces librosa's mel spectrogram with numpy's rfft so the
    fingerprinter runs on the numerical stack the app already installs
    (numpy/scipy/soundfile) instead of pulling in librosa, numba and
    llvmlite for one hash.
    """
    import numpy as np
    if len(y) < n_fft:
        y = np.pad(y, (0, n_fft - len(y)))
    window = np.hanning(n_fft).astype("float32")
    n_frames = 1 + (len(y) - n_fft) // hop
    spec = np.empty((n_frames, n_fft // 2 + 1), dtype="float32")
    for i in range(n_frames):
        seg = y[i * hop:i * hop + n_fft] * window
        spec[i] = np.abs(np.fft.rfft(seg)).astype("float32")
    power = spec ** 2
    # Log-spaced band edges from 40Hz to just under Nyquist.
    f_min, f_max = 40.0, min(sr / 2.0 - 1.0, 10000.0)
    edges = np.geomspace(f_min, f_max, n_bands + 1)
    bin_hz = (sr / 2.0) / (n_fft // 2)
    bands = np.zeros(n_bands, dtype="float64")
    for b in range(n_bands):
        lo = int(edges[b] / bin_hz)
        hi = max(lo + 1, int(edges[b + 1] / bin_hz))
        hi = min(hi, power.shape[1])
        if lo >= hi:
            bands[b] = 0.0
        else:
            bands[b] = power[:, lo:hi].mean()
    return 10.0 * np.log10(bands + 1e-12)


def fingerprint(path):
    """Compute a 512-bit perceptual hash. Returns (hex_hash, duration_sec)."""
    import numpy as np

    duration = _total_duration(path)
    if duration < 1.0:
        raise RuntimeError("Audio too short to fingerprint")

    n_chunks = 16
    chunk_dur = 1.5
    if duration <= chunk_dur:
        starts = [0.0] * n_chunks
    else:
        max_start = max(0.0, duration - chunk_dur)
        starts = [i * max_start / (n_chunks - 1) for i in range(n_chunks)]

    bits = []
    for st in starts:
        y, sr = _load_chunk(path, st, chunk_dur)
        if len(y) < 256:
            y = np.pad(y, (0, 256 - len(y)))
        band_db = _log_band_energies(y, sr)
        # Compare adjacent bands -> 31 bits per chunk. Comparing neighbours
        # keeps the hash stable across volume changes and re-encodes.
        bits.extend(1 if band_db[i] > band_db[i - 1] else 0
                    for i in range(1, len(band_db)))

    while len(bits) % 8 != 0:
        bits.append(0)
    while len(bits) < 512:
        bits.append(0)

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
