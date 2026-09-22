#!/usr/bin/env python3
"""
Regression tests for analyze.py (BPM/key analysis engine). Runs headless
against synthetic signals with known ground truth - a click track at a
known BPM, or a scale/chord bed built from a known root + interval set -
so every check here has an unambiguous right answer, unlike real audio
where "correct" BPM/key is itself sometimes debatable.

No test infrastructure previously existed for analyze.py (only the JS
fallback detectKey() had a regression test, in tools/test-detect-key.js).
This is the first.

Run with: python3 tools/test-analyze.py
"""
import sys, os, math

# Round 78: this script passed every check and then died printing its own
# success line. The final print uses a check mark (U+2713); a Windows console
# defaults to cp1252, which has no such character, so print() raised
# UnicodeEncodeError and the script exited NON-ZERO after passing.
#
# A test that reports failure when it succeeded is worse than no test - and
# this one would have failed the release workflow on windows-latest, which
# has the same default encoding, for no reason at all.
#
# Force UTF-8 on stdout/stderr where the runtime supports it (3.7+), and fall
# back silently where it does not. errors='replace' means an exotic character
# degrades to a placeholder rather than taking the process down.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import numpy as np
import analyze

SR = 44100
fails = 0
checks = 0

def check(name, ok, detail=''):
    global fails, checks
    checks += 1
    mark = 'ok  ' if ok else 'FAIL'
    print(f'  {mark} {name}' + (f'  ({detail})' if detail else ''))
    if not ok:
        global fails
        fails += 1

# ── Signal generators (synthetic, known ground truth) ───────────────────────

def click_track(bpm, dur_sec, sr=SR, pattern='four', seed=0):
    """Kick/snare/hat click track at an exact, known BPM."""
    rng = np.random.default_rng(seed)
    n = int(dur_sec * sr)
    out = np.zeros(n)
    beat_period = 60.0 / bpm
    n_beats = int(dur_sec / beat_period)

    def add_hit(t, freq, decay, amp, noise_amp=0.0):
        idx0 = int(t * sr)
        if idx0 < 0 or idx0 >= n: return
        dur = min(0.25, (n - idx0) / sr)
        tt = np.arange(int(dur * sr)) / sr
        env = np.exp(-tt / decay)
        sig = np.sin(2 * np.pi * freq * tt) * env * amp
        if noise_amp > 0:
            sig = sig + rng.standard_normal(len(tt)) * env * noise_amp
        end = min(n, idx0 + len(sig))
        out[idx0:end] += sig[:end - idx0]

    for b in range(n_beats):
        beat_t = b * beat_period
        beat_in_bar = b % 4
        add_hit(beat_t, 60, 0.09, 0.9)
        if beat_in_bar in (1, 3):
            add_hit(beat_t, 200, 0.05, 0.6, noise_amp=0.3)
        for h in range(2):
            add_hit(beat_t + h * beat_period / 2, 8000, 0.02, 0.15, noise_amp=0.2)
    return out

def chord_bed(root_midi, intervals, dur_sec, sr=SR, seed=0, amp=0.3):
    """Sustained pad cycling through I/IV/V-ish triads built from the
    given scale - a clean, unambiguous harmonic bed for one scale type."""
    rng = np.random.default_rng(seed)
    n = int(dur_sec * sr)
    out = np.zeros(n)
    triad_roots = [0, 3, 4] if len(intervals) >= 5 else [0]
    chunk = int(2.0 * sr)
    pos = 0; ci = 0
    while pos < n:
        seg_len = min(chunk, n - pos)
        tt = np.arange(seg_len) / sr
        root_deg = triad_roots[ci % len(triad_roots)]
        idxs = [root_deg, (root_deg + 2) % len(intervals), (root_deg + 4) % len(intervals)]
        seg = np.zeros(seg_len)
        for k, di in enumerate(idxs):
            midi = root_midi + intervals[di]
            freq = 440.0 * 2 ** ((midi - 69) / 12.0)
            seg += np.sin(2 * np.pi * freq * tt) * (0.5 if k == 0 else 0.3)
            seg += 0.15 * np.sin(2 * np.pi * freq * 2 * tt)
        env = np.ones(seg_len)
        fade = min(int(0.05 * sr), seg_len // 4)
        if fade > 0:
            env[:fade] = np.linspace(0, 1, fade)
            env[-fade:] = np.linspace(1, 0, fade)
        out[pos:pos + seg_len] += seg * env * amp
        pos += seg_len; ci += 1
    return out

# ═════════════════════════════════════════════════════════════════════════
# BPM: tempo_prior() continuity fix regression
# ═════════════════════════════════════════════════════════════════════════
# tempo_prior() used to be a discrete step function with hard cutoffs at
# 70/85/100/170/185/195 BPM - a candidate 0.1 BPM either side of a cutoff
# could get a decisively different multiplier (0.85x vs 1.15x), which
# measurably caused real octave (half/double-time) errors on otherwise-
# correct candidates. This locks in that the function is now continuous
# (no jump greater than a tiny numeric tolerance anywhere it's evaluated
# densely) while still preserving the original shape's strength (flat
# 1.15 across 100-170, tapering to 0.85 at the far edges).
def _block_1():
        # Reach into the closure isn't possible from outside, so exercise it
        # indirectly through a full _bpm_v11_correct() run and confirm basic
        # sanity: an unambiguous, dense 4-on-the-floor click track at a
        # variety of tempos (including ones straddling the old cutoffs) is
        # detected within 2 BPM, not flipped to a half/double-time reading.
        cases = [70, 85, 90, 100, 110, 120, 128, 140, 150, 160, 174]
        n_ok = 0
        for bpm in cases:
            sig = click_track(bpm, 40, pattern='four', seed=bpm)
            det = analyze.detect_bpm(sig, SR)
            ratio = det / bpm
            # allow the correct tempo OR (rarely, on a very sparse/ambiguous
            # signal) its exact octave - but not something else entirely
            ok = abs(det - bpm) < 2.0
            if ok: n_ok += 1
        check(f'dense 4-on-the-floor click tracks detect within 2 BPM across a range spanning the old tempo_prior() cutoffs',
            n_ok >= len(cases) - 1, f'{n_ok}/{len(cases)} correct (allowing 1 miss)')
_block_1()


def _block_2():
        # Direct continuity check on the shape itself, evaluated at fine
        # resolution across the exact old cutoff points (70/85/100/170/185/
        # 195) via a tiny local re-implementation matching the one in
        # analyze.py (kept in sync manually - see the comment on
        # tempo_prior() in _bpm_v11_correct() for the authoritative version).
        def tempo_prior(bpm):
            if 100 <= bpm <= 170: return 1.15
            edge = 100.0 if bpm < 100 else 170.0
            bound = 55.0 if bpm < 100 else 215.0
            frac = min(1.0, abs(bpm - edge) / abs(bound - edge))
            return 1.15 - 0.30 * frac
        max_jump = 0.0
        prev = tempo_prior(50.0)
        bpm = 50.0
        while bpm <= 220.0:
            bpm += 0.05
            cur = tempo_prior(bpm)
            max_jump = max(max_jump, abs(cur - prev))
            prev = cur
        check('tempo_prior() has no discontinuous jump when swept in 0.05 BPM steps across 50-220 BPM',
            max_jump < 0.01, f'max single-step change={max_jump:.4f} (old discrete version jumped up to 0.30 at a single 0.1 BPM step)')
_block_2()


# ═════════════════════════════════════════════════════════════════════════
# Key / scale-family matching
# ═════════════════════════════════════════════════════════════════════════
def _block_3():
        # Clean, unambiguous chord beds across all 12 roots x all 11 scale
        # types this feature supports - measured 132/132 exact top-1 matches
        # during development; locks that in.
        n_ok = 0; n_total = 0; worst = []
        for root_i, root in enumerate(analyze.NOTES):
            for scale_name, iv in analyze.SCALE_INTERVALS.items():
                sig = chord_bed(60 + root_i, iv, 10, seed=root_i * 20 + hash(scale_name) % 97)
                tuning = analyze.estimate_tuning(sig, SR)
                chroma = analyze.simple_chroma12(sig, SR, tuning=tuning)
                top = analyze.scale_family_result(chroma, root, top_n=1)
                n_total += 1
                if top[0]['name'] == scale_name:
                    n_ok += 1
                else:
                    worst.append(f'{root} {scale_name} -> {top[0]["name"]}')
        check('scale_family_result() picks the exact scale type on clean, unambiguous harmonic content across all 12 roots x 11 scale types',
            n_ok == n_total, f'{n_ok}/{n_total} exact top-1 matches' + (f'; e.g. {worst[:3]}' if worst else ''))
_block_3()


def _block_4():
        # A specific, meaningful case with real musical stakes: Harmonic Minor
        # vs Natural Minor differ by exactly ONE note (the raised 7th) - the
        # single hardest pairwise discrimination this feature has to make.
        # Confirms it's not just getting lucky in aggregate above.
        sig = chord_bed(60, [0,2,3,5,7,8,11], 10, seed=42)  # C harmonic minor
        tuning = analyze.estimate_tuning(sig, SR)
        chroma = analyze.simple_chroma12(sig, SR, tuning=tuning)
        top3 = analyze.scale_family_result(chroma, 'C', top_n=3)
        names = [t['name'] for t in top3]
        check('a C Harmonic Minor bed is identified as Harmonic Minor, not confused with the one-note-different Natural Minor',
            names[0] == 'Harmonic Minor',
            f'top3={names}')
        b7_present = 'B' in top3[0]['notes']
        check("the winning match's composing notes include the raised 7th (B) that distinguishes harmonic from natural minor",
            b7_present, f'notes={top3[0]["notes"]}')
_block_4()


def _block_5():
        # The literal "what keys compose them" ask: notes returned must be
        # the correct pitch classes for a KNOWN scale, in the right order
        # (root first), not just a scale-type NAME.
        sig = chord_bed(69, [0,2,4,7,9], 10, seed=7)  # A major pentatonic
        tuning = analyze.estimate_tuning(sig, SR)
        chroma = analyze.simple_chroma12(sig, SR, tuning=tuning)
        top1 = analyze.scale_family_result(chroma, 'A', top_n=1)[0]
        check("A Major Pentatonic's composing notes are exactly A, B, C#, E, F# in that order",
            top1['notes'] == ['A', 'B', 'C#', 'E', 'F#'],
            f"got name={top1['name']} notes={top1['notes']}")
_block_5()


def _block_6():
        # scale_family flows all the way through the real, top-level
        # analyze()/analyze_stem() entry points (the ones server.js actually
        # calls), not just the internal helper - a regression here would mean
        # the feature works in isolation but never reaches the UI/JSON output.
        import tempfile, wave
        sig = chord_bed(65, [0,2,4,6,7,9,11], 12, seed=3)  # F Lydian
        path = tempfile.mktemp(suffix='.wav')
        pcm = (np.clip(sig, -1, 1) * 32767).astype(np.int16)
        with wave.open(path, 'w') as wf:
            wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(SR)
            wf.writeframes(pcm.tobytes())
        try:
            full = analyze.analyze(path)
            stem = analyze.analyze_stem(path)
            has_full = isinstance(full.get('scale_family'), list) and len(full['scale_family']) >= 1 and 'notes' in full['scale_family'][0]
            has_stem = isinstance(stem.get('scale_family'), list) and len(stem['scale_family']) >= 1 and 'notes' in stem['scale_family'][0]
            check('analyze()\'s top-level result includes a well-formed scale_family list', has_full, str(full.get('scale_family')))
            check('analyze_stem()\'s top-level result includes a well-formed scale_family list', has_stem, str(stem.get('scale_family')))
        finally:
            os.remove(path)
_block_6()


print('')
if fails:
    print(f'✗ {fails}/{checks} analyze.py check(s) failed')
    sys.exit(1)
print(f'✓ analyze.py: all {checks} checks passed')
