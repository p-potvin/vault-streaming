"""Enhancement state tracking in the video's sidecar.

The sidecar is the shared v2 record (vault-raggae app/files/records/record.py, vault-explorer and vault-streaming
src/sidecar-record.js): ``<file.ext>.json``, or whichever of the four historical names it already has
(``<file.ext>.meta.json``, ``<stem>.json``, ``<stem>.meta.json``; a stem name only when no other media file shares
the stem). This module owns three keys of it, ``enhancements``, ``enhancementDetails`` and ``enhancedPath``; ``save``
re-reads the file and replaces only those, so a ``vw.id``, history, tags or probe fields other tools keep there
survive. A new sidecar gets the v2 envelope (``schema``, ``vw``, ``master``).

Every action records what it did to the ``.enhanced/`` copy here, so the context
menu can show which enhancements are already applied and offer a per-action
revert instead of an all-or-nothing one.

Schema
------
The four legacy top-level keys keep their original *shapes* because the Electron
side already reads them directly (``system.ipc.js`` builds checkbox states from
them, ``media.ipc.js`` uses ``video`` to skip redundant work)::

    enhancements.audio        -> bool
    enhancements.video        -> bool
    enhancements.subtitles    -> list[str] of language codes
    enhancements.translation  -> list[str] of language codes

Richer per-action detail (when, with which parameters, which files were written)
lives alongside them under ``enhancementDetails`` so nothing old breaks::

    enhancementDetails.<action> = {
        "applied":   bool,
        "at":        "Tue, 11 Aug 2026 14:03",
        "params":    {...},
        "outputs":   ["absolute/path.srt", ...],
        "languages": ["en"],
    }
"""

import json
import os
import time
from datetime import datetime, timezone

ACTIONS = ("audio", "video", "subtitles", "translation")

# List-shaped actions track language codes; bool-shaped ones are a simple flag.
LIST_ACTIONS = ("subtitles", "translation")

TIMESTAMP_FORMAT = "%a, %d %b %Y %H:%M"


#: The keys this module writes; everything else in the sidecar belongs to other tools.
OWNED_KEYS = ("enhancements", "enhancementDetails", "enhancedPath")

MEDIA_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".avif", ".tiff",
    ".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".flv", ".wmv",
    ".mp3", ".wav", ".flac", ".m4a", ".aac", ".opus", ".ogg",
}
_VIDEO = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".flv", ".wmv", ".mpg", ".mpeg", ".m2ts", ".3gp"}
_AUDIO = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".opus", ".ogg", ".wma", ".aiff", ".ape"}


def sidecar_path(video_path):
    """The video's existing sidecar under any of its four names, else the canonical ``<file.ext>.json``."""
    for cand in (video_path + '.json', video_path + '.meta.json'):
        if os.path.isfile(cand):
            return cand
    stem, ext = os.path.splitext(video_path)
    stems = [p for p in (stem + '.json', stem + '.meta.json') if os.path.isfile(p)]
    if stems and not any(os.path.exists(stem + e) for e in MEDIA_EXTENSIONS if e != ext.lower()):
        return stems[0]
    return video_path + '.json'


def _now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read(path):
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _blank():
    return {
        "audio": False,
        "video": False,
        "subtitles": [],
        "translation": [],
    }


def load(video_path):
    """Read the sidecar for *video_path*, returning a normalised dict.

    Missing or corrupt sidecars yield a blank record rather than raising — a
    damaged sidecar should degrade the menu's accuracy, never block processing.
    """
    meta = _read(sidecar_path(video_path))

    enh = meta.get('enhancements')
    if not isinstance(enh, dict):
        enh = _blank()
    else:
        base = _blank()
        for key in ACTIONS:
            value = enh.get(key)
            if key in LIST_ACTIONS:
                base[key] = [str(v) for v in value] if isinstance(value, list) else []
            else:
                base[key] = bool(value)
        enh = base

    meta['enhancements'] = enh
    if not isinstance(meta.get('enhancementDetails'), dict):
        meta['enhancementDetails'] = {}
    return meta


def save(video_path, meta):
    """Write this module's keys of *meta* into the sidecar as it is on disk now (a key missing from *meta*, such as
    ``enhancedPath`` after a full revert, is removed); atomic. True when written."""
    path = sidecar_path(video_path)
    record = _read(path)
    for key in OWNED_KEYS:
        if key in meta and meta[key] is not None:
            record[key] = meta[key]
        else:
            record.pop(key, None)
    record.setdefault('schema', 2)
    vw = record.setdefault('vw', {})
    ext = os.path.splitext(video_path)[1].lower()
    vw.setdefault('kind', 'video' if ext in _VIDEO else 'audio' if ext in _AUDIO else 'other')
    vw.setdefault('created', _now_iso())
    vw['updated'] = _now_iso()
    master = record.setdefault('master', {})
    master['basename'] = os.path.basename(video_path)
    master['ext'] = ext
    try:
        st = os.stat(video_path)
        master['size'] = st.st_size
        master['mtime'] = st.st_mtime
    except OSError:
        pass
    for key in ('name', 'path', 'size', 'created', 'modified', 'type'):   # derived from the file, never stored
        record.pop(key, None)
    tmp = f"{path}.tmp_{os.getpid()}"
    try:
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(record, fh, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
        return True
    except Exception as err:
        print(f"[state] Failed to write sidecar {path}: {err}")
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False


def is_applied(video_path, action, language=None):
    """True if *action* (optionally for *language*) is already recorded.

    The enhanced copy must still exist on disk; a sidecar that outlived its
    output would otherwise make the menu claim work that is gone.
    """
    meta = load(video_path)
    enhanced = meta.get('enhancedPath')
    if enhanced and not os.path.exists(enhanced):
        return False

    value = meta['enhancements'].get(action)
    if action in LIST_ACTIONS:
        if not value:
            return False
        return True if language is None else str(language) in value
    return bool(value)


def mark(video_path, action, enhanced_path=None, languages=None, params=None,
         outputs=None):
    """Record that *action* completed, merging into any existing record."""
    if action not in ACTIONS:
        raise ValueError(f"Unknown enhancement action: {action}")

    meta = load(video_path)
    enh = meta['enhancements']

    if action in LIST_ACTIONS:
        merged = list(enh.get(action) or [])
        for lang in (languages or []):
            if str(lang) not in merged:
                merged.append(str(lang))
        enh[action] = merged
    else:
        enh[action] = True

    if enhanced_path:
        meta['enhancedPath'] = enhanced_path

    detail = meta['enhancementDetails'].get(action)
    if not isinstance(detail, dict):
        detail = {}
    detail['applied'] = True
    detail['at'] = time.strftime(TIMESTAMP_FORMAT)
    if params:
        detail['params'] = params
    if languages:
        detail['languages'] = enh[action] if action in LIST_ACTIONS else list(languages)
    if outputs:
        existing = [p for p in (detail.get('outputs') or []) if p not in outputs]
        detail['outputs'] = existing + list(outputs)
    meta['enhancementDetails'][action] = detail

    save(video_path, meta)
    return meta


def clear(video_path, action, languages=None):
    """Un-record *action* (or just *languages* of it) after a revert."""
    if action not in ACTIONS:
        raise ValueError(f"Unknown enhancement action: {action}")

    meta = load(video_path)
    enh = meta['enhancements']

    if action in LIST_ACTIONS and languages:
        drop = {str(l) for l in languages}
        enh[action] = [l for l in (enh.get(action) or []) if l not in drop]
        still_applied = bool(enh[action])
    else:
        enh[action] = [] if action in LIST_ACTIONS else False
        still_applied = False

    detail = meta['enhancementDetails'].get(action)
    if isinstance(detail, dict):
        if still_applied:
            detail['languages'] = enh[action]
        else:
            meta['enhancementDetails'].pop(action, None)

    if not any(enh[a] for a in ACTIONS):
        meta.pop('enhancedPath', None)

    save(video_path, meta)
    return meta


def summary(video_path):
    """Compact view of applied enhancements, for CLI output and tests."""
    meta = load(video_path)
    enh = meta['enhancements']
    return {
        "enhancedPath": meta.get('enhancedPath'),
        "audio": bool(enh['audio']),
        "video": bool(enh['video']),
        "subtitles": list(enh['subtitles']),
        "translation": list(enh['translation']),
    }
