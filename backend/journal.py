"""Journal storage: per-activity notes and photos.

Notes live in journal.json (app root, gitignored). Photo files live in the
media directory (configurable, sibling of the GarminDB HealthData dir by
default); this file only stores references.
"""
import json
import re
import threading
import time
import uuid
from pathlib import Path

import config

ROOT = Path(__file__).parent.parent
JOURNAL_JSON = ROOT / "journal.json"

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
MAX_PHOTO_BYTES = 15 * 1024 * 1024

_lock = threading.Lock()


def _media_dir():
    """Resolve the media directory, deriving from health_data_dir if unset."""
    cfg = config.current_config()
    media = cfg.get("media_dir")
    if media:
        p = Path(media).expanduser()
    else:
        base = cfg.get("health_data_dir")
        if not base:
            return None
        p = Path(str(Path(base).expanduser()) + "_media")
    return p


def media_dir_path():
    """Media dir as Path, creating it on demand. None when unconfigurable."""
    p = _media_dir()
    if p is None:
        return None
    p.mkdir(parents=True, exist_ok=True)
    return p


def _load():
    try:
        return json.loads(JOURNAL_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(data):
    JOURNAL_JSON.write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def get_entry(activity_id):
    """Return {note, photos: [{file, caption}]} for an activity (empty defaults)."""
    data = _load()
    entry = data.get(str(activity_id)) or {}
    return {
        "note": entry.get("note") or "",
        "photos": entry.get("photos") or [],
    }


def save_note(activity_id, note):
    with _lock:
        data = _load()
        entry = data.get(str(activity_id)) or {}
        entry["note"] = str(note or "")[:20000]
        data[str(activity_id)] = entry
        _save(data)
        return entry.get("note") or ""


def add_photo(activity_id, filename, caption=""):
    """Register an uploaded photo file (already on disk) for an activity."""
    with _lock:
        data = _load()
        entry = data.get(str(activity_id)) or {}
        photos = entry.get("photos") or []
        photos.append({"file": filename, "caption": str(caption or "")[:500]})
        entry["photos"] = photos
        data[str(activity_id)] = entry
        _save(data)
        return photos[-1]


def delete_photo(activity_id, filename):
    """Remove a photo entry and its file. Returns True if something was deleted."""
    with _lock:
        data = _load()
        entry = data.get(str(activity_id)) or {}
        photos = entry.get("photos") or []
        kept = [p for p in photos if p.get("file") != filename]
        if len(kept) == len(photos):
            return False
        entry["photos"] = kept
        if entry.get("note") is None and not kept:
            data.pop(str(activity_id), None)
        else:
            data[str(activity_id)] = entry
        _save(data)
    try:
        (media_dir_path() / filename).unlink(missing_ok=True)
    except Exception:
        pass
    return True


def sanitize_extension(filename):
    """Return a safe extension for an upload, or None if not allowed."""
    ext = Path(filename or "").suffix.lower()
    if ext == ".jpg":
        ext = ".jpeg"
    return ext if ext in ALLOWED_EXTENSIONS else None


def new_media_filename(activity_id, ext):
    return f"{activity_id}_{uuid.uuid4().hex[:12]}{ext}"


def feed_badges(activity_ids):
    """For the feed: which activities have a note or photos."""
    data = _load()
    out = {}
    for aid in activity_ids:
        entry = data.get(str(aid))
        if not entry:
            continue
        out[str(aid)] = {
            "has_note": bool(entry.get("note")),
            "photo_count": len(entry.get("photos") or []),
            "first_photo": (entry.get("photos") or [{}])[0].get("file"),
        }
    return out
