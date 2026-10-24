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
import os
import re
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

# Round 82 (Sentry ELECTRON-4, 5 events): scikit-learn failed with
# "numpy.dtype size changed, may indicate binary incompatibility. Expected
# 96 from C header, got 88" - built for one numpy major, running on the
# other. Repair reinstalled scikit-learn alone, which can't fix a mismatch
# with numpy, so verification failed again on every launch. A numpy ABI
# error now marks the whole compiled numeric stack for repair, so pip
# reinstalls numpy, scipy and scikit-learn together and resolves versions
# that agree.
NUMPY_ABI_RE = re.compile(
    r"numpy\.dtype size changed|binary incompatib|compiled using NumPy|"
    r"numpy\.core\.multiarray failed to import|_ARRAY_API not found|"
    r"module compiled against (ABI|API) version",
    re.I,
)
NUMERIC_STACK = ["numpy>=1.24,<2.1", "scipy>=1.10", "scikit-learn>=1.3"]


def user_site_dir():
    try:
        import site
        if not getattr(site, "ENABLE_USER_SITE", False):
            return None
        return site.getusersitepackages()
    except Exception:  # noqa: BLE001
        return None


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
        return True, getattr(m, "__version__", "unknown"), None, getattr(m, "__file__", None)
    except BaseException as e:  # noqa: BLE001 - torch can raise SystemExit
        # Where it would have loaded from, even though the import failed.
        where = None
        try:
            import importlib.util
            spec = importlib.util.find_spec(mod)
            where = spec.origin if spec else None
        except BaseException:  # noqa: BLE001
            pass
        return False, None, ("%s: %s" % (type(e).__name__, str(e)[:200])), where


def main():
    usite = user_site_dir()
    out = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "user_site": usite,
        "tiers": {},
        "broken_packages": [],
        "numpy_abi_mismatch": False,
        "user_site_modules": [],
    }
    for tier, mods in TIERS.items():
        tier_res = {"ok": True, "modules": {}}
        for mod, pip_name in mods.items():
            ok, ver, err, where = check_import(mod)
            tier_res["modules"][mod] = {"ok": ok, "version": ver, "error": err, "file": where}
            # A copy in the per-user folder loads before the interpreter's
            # own, so a repair that writes to the interpreter's folder
            # would change nothing. Report it so repair can target it.
            if where and usite and os.path.normcase(os.path.abspath(where)).startswith(os.path.normcase(os.path.abspath(usite))):
                out["user_site_modules"].append(mod)
            if not ok:
                tier_res["ok"] = False
                out["broken_packages"].append(pip_name)
                if err and NUMPY_ABI_RE.search(err):
                    out["numpy_abi_mismatch"] = True
        out["tiers"][tier] = tier_res
    if out["numpy_abi_mismatch"]:
        for pkg in NUMERIC_STACK:
            if pkg not in out["broken_packages"]:
                out["broken_packages"].append(pkg)
    try:
        import numpy  # noqa: F401
        out["numpy_version"] = numpy.__version__
    except BaseException:  # noqa: BLE001
        out["numpy_version"] = None
    print(json.dumps(out))


if __name__ == "__main__":
    main()
