#!/usr/bin/env python3
"""
write_tags.py — Stamp BPM and musical key into audio file metadata.

Called from server.js after BPM/key analysis completes successfully.
Reads JSON command on argv:

    python write_tags.py '{"path":"...","bpm":140,"key_note":"C","key_mode":"minor"}'

Why this exists
---------------
Freq.Phull's BPM/key analysis is stored in its SQLite DB. Other tools
(FL Studio, Mixed In Key, Rekordbox, Spotify Music Library, Apple Music,
foobar2000, Beatport's tools) read the audio FILE's embedded tags, not
our DB. So when you drag a Freq.Phull-analyzed track into FL Studio, FL
sees no BPM. Mixed In Key shows no key. Spotify metadata is blank.

Writing standard tags fixes this. Producers can do their full analysis
inside Freq.Phull, then move tracks anywhere with the data already baked
into the file. Backward-compatible: no app or library is going to
*remove* a tag it doesn't recognize, and the tags we use are the
exact ones the music ecosystem standardized on years ago.

Tag scheme
----------
We use the most widely-supported standard for each format:

  MP3 (ID3v2.4):
    TBPM = integer BPM (rounded; ID3 spec is integer only)
    TKEY = musical key in 3-character notation: "Cm", "F#", "Bbm"
           (ID3v2.4 §4.2.3 specifies this exact format)

  FLAC / OGG (Vorbis comments):
    BPM      = integer BPM
    KEY      = key in the same 3-char notation as ID3 TKEY
    INITIALKEY = also written (some tools look here instead)

  M4A / AAC (MP4 atoms):
    tmpo (atom) = BPM as int16
    ----:com.apple.iTunes:initialkey (freeform atom) = key notation

  WAV: ID3 frames in a RIFF "id3 " chunk (mutagen handles this)

What we DON'T touch:
  • TIT2 (title), TPE1 (artist), TALB (album) — these are user data,
    we never overwrite. The user may have curated them.
  • ID3v1 tags — legacy, not supported.
  • COMM, USLT — comments and lyrics, untouched.

Failure handling
----------------
Print a single JSON line to stdout:
  {"ok": true, "fmt": "mp3"}
or:
  {"ok": false, "error": "reason"}

Never throw. The server treats any non-zero exit as a soft failure and
logs it but doesn't fail the analysis as a whole — BPM/key already made
it to the DB, the tag write is a bonus, not a hard requirement.
"""

import sys
import json
import os


def normalize_key(note, mode):
    """Convert {note:'C', mode:'minor'} to ID3 TKEY format 'Cm'.

    The ID3v2.4 spec (§4.2.3) defines TKEY values like 'A', 'Am', 'F#m', 'Bb'.
    'C' alone means C major; 'Cm' means C minor. We never use the unicode
    sharp (♯) or flat (♭) characters because most readers expect ASCII.
    """
    if not note:
        return None
    # Normalize the note: capitalize first letter, lowercase the rest of an
    # accidental ('Bb' stays 'Bb', not 'BB').
    note = note.strip()
    if len(note) >= 2 and note[1] in ('b', 'B', '#'):
        note = note[0].upper() + note[1:].lower().replace('b', 'b')
    else:
        note = note[0].upper()
    # 'b' as flat in ID3 TKEY is correct ASCII; '#' as sharp is correct.
    is_minor = (mode or '').lower().startswith('min')
    return note + ('m' if is_minor else '')


def write_mp3(path, bpm, key_str):
    """Write TBPM and TKEY into an MP3's ID3v2.4 frames."""
    from mutagen.id3 import ID3, TBPM, TKEY, ID3NoHeaderError
    try:
        tags = ID3(path)
    except ID3NoHeaderError:
        # File has no ID3 frame at all — mutagen needs us to create one.
        tags = ID3()
    if bpm is not None:
        tags['TBPM'] = TBPM(encoding=3, text=str(int(round(bpm))))
    if key_str:
        tags['TKEY'] = TKEY(encoding=3, text=key_str)
    # v2_version=4 means ID3v2.4 (UTF-8 capable). Most modern players read
    # v2.4 fine; foobar2000 and Mixed In Key both prefer it.
    tags.save(path, v2_version=4)


def write_flac(path, bpm, key_str):
    """Write Vorbis comments into a FLAC file."""
    from mutagen.flac import FLAC
    tags = FLAC(path)
    if bpm is not None:
        tags['BPM'] = str(int(round(bpm)))
    if key_str:
        # Some tools look at KEY, some at INITIALKEY. Writing both is
        # cheap and saves the user from a "why doesn't X see it?" debug.
        tags['KEY'] = key_str
        tags['INITIALKEY'] = key_str
    tags.save()


def write_ogg(path, bpm, key_str):
    """Write Vorbis comments into an OGG Vorbis file (same scheme as FLAC)."""
    from mutagen.oggvorbis import OggVorbis
    tags = OggVorbis(path)
    if bpm is not None:
        tags['BPM'] = str(int(round(bpm)))
    if key_str:
        tags['KEY'] = key_str
        tags['INITIALKEY'] = key_str
    tags.save()


def write_m4a(path, bpm, key_str):
    """Write iTunes-style atoms into an M4A/MP4 container."""
    from mutagen.mp4 import MP4
    tags = MP4(path)
    if bpm is not None:
        # tmpo is a list-of-int atom in MP4; mutagen accepts a Python list.
        tags['tmpo'] = [int(round(bpm))]
    if key_str:
        # Freeform iTunes atoms use this colon-separated path. The value
        # must be bytes, not str (MP4 spec quirk).
        tags['----:com.apple.iTunes:initialkey'] = [key_str.encode('utf-8')]
    tags.save()


def write_wav(path, bpm, key_str):
    """Write ID3 frames into a WAV file (RIFF id3 chunk).

    Most DAWs don't read ID3 from WAVs, but FL Studio, Reaper, and Logic
    do. Some don't — that's fine, the file still plays correctly.
    """
    from mutagen.wave import WAVE
    from mutagen.id3 import ID3, TBPM, TKEY
    tags = WAVE(path)
    if tags.tags is None:
        tags.add_tags()
    if bpm is not None:
        tags.tags['TBPM'] = TBPM(encoding=3, text=str(int(round(bpm))))
    if key_str:
        tags.tags['TKEY'] = TKEY(encoding=3, text=key_str)
    tags.save()


# Dispatch by file extension. Lowercased, stripped of the leading dot.
WRITERS = {
    'mp3':  write_mp3,
    'flac': write_flac,
    'ogg':  write_ogg,
    'm4a':  write_m4a,
    'aac':  write_m4a,   # AAC in MP4 container — same atom layout
    'wav':  write_wav,
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'error': 'no command argument'}))
        return 1
    try:
        cmd = json.loads(sys.argv[1])
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'bad JSON: ' + str(e)}))
        return 1

    path = cmd.get('path')
    bpm = cmd.get('bpm')
    key_note = cmd.get('key_note')
    key_mode = cmd.get('key_mode')

    if not path:
        print(json.dumps({'ok': False, 'error': 'no path'}))
        return 1
    if not os.path.isfile(path):
        print(json.dumps({'ok': False, 'error': 'file not found: ' + path}))
        return 1

    ext = os.path.splitext(path)[1].lower().lstrip('.')
    writer = WRITERS.get(ext)
    if not writer:
        print(json.dumps({'ok': False, 'error': 'unsupported format: ' + ext}))
        return 1

    key_str = normalize_key(key_note, key_mode)

    # If both BPM and key are empty, there's nothing to do.
    if bpm is None and not key_str:
        print(json.dumps({'ok': True, 'fmt': ext, 'skipped': 'no data'}))
        return 0

    try:
        writer(path, bpm, key_str)
    except ImportError as e:
        # mutagen is normally installed as a transitive dep of audio-separator,
        # but if for some reason it's missing we surface a clear error so the
        # server can suggest a fix.
        print(json.dumps({'ok': False, 'error': 'mutagen not installed: ' + str(e)}))
        return 1
    except Exception as e:
        print(json.dumps({'ok': False, 'error': type(e).__name__ + ': ' + str(e)}))
        return 1

    print(json.dumps({'ok': True, 'fmt': ext, 'bpm': bpm, 'key': key_str}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
