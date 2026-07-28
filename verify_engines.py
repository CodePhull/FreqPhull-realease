# Engine verification. Import-checks every tier and prints one JSON
# object describing exactly what works and what is broken, so the
# server can repair the precise packages instead of re-running the
# whole 2GB setup.
#
# Tiers:
#   core    - numpy/scipy/sklearn/soundfile  -> BPM/key analysis
#   stems   - torch/torchaudio + audio_separator -> stem separation
#   whisper - openai-whisper -> transcription
#
# Exit code is always 0 when the script itself ran; the JSON carries
# the verdicts. Non-zero exit means Python itself is broken, which is
# its own diagnostic.

import json
import sys

# Import name -> pip package name (they differ for half of these).
TIERS = {
    "core": {
        "numpy": "numpy>=1.24,<2.1",
        "scipy": "scipy>=1.10",
        "sklearn": "scikit-learn>=1.3",
        "soundfile": "soundfile>=0.12",
        "mutagen": "mutagen>=1.47",
    },
    "stems": {
        "torch": "torch",
        "torchaudio": "torchaudio",
        "audio_separator": "audio-separator[cpu]",
    },
    "whisper": {
        "whisper": "openai-whisper",
    },
}


def check_import(mod):
    try:
        m = __import__(mod)
        # A module that imports but is a broken install (missing native
        # DLLs) usually explodes on first attribute access - poke it.
        getattr(m, "__version__", None)
        if mod == "torch":
            m.tensor([1.0])  # native-lib smoke test (VC++ redist etc.)
        if mod == "whisper":
            assert hasattr(m, "load_model")
        return True, getattr(m, "__version__", "unknown"), None
    except BaseException as e:  # noqa: BLE001 - torch can raise SystemExit
        return False, None, ("%s: %s" % (type(e).__name__, str(e)[:200]))


def main():
    out = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "tiers": {},
        "broken_packages": [],
    }
    for tier, mods in TIERS.items():
        tier_res = {"ok": True, "modules": {}}
        for mod, pip_name in mods.items():
            ok, ver, err = check_import(mod)
            tier_res["modules"][mod] = {"ok": ok, "version": ver, "error": err}
            if not ok:
                tier_res["ok"] = False
                out["broken_packages"].append(pip_name)
        out["tiers"][tier] = tier_res
    print(json.dumps(out))


if __name__ == "__main__":
    main()
