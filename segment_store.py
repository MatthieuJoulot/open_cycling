#!/usr/bin/env python3
"""Store user-created or edited climb segments."""
import json
from pathlib import Path

import analyze_climbs

ROOT = Path(__file__).parent
SEGMENTS_FILE = ROOT / "climb_segments.json"


def _load_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default if default is not None else {}


def _save_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_segments():
    return _load_json(SEGMENTS_FILE, default={})


def save_segments(segments):
    _save_json(SEGMENTS_FILE, segments)


def get_activity_segments(activity_id):
    return load_segments().get(str(activity_id), {"edits": [], "additions": [], "deletions": []})


def set_activity_segments(activity_id, entry):
    segments = load_segments()
    segments[str(activity_id)] = entry
    save_segments(segments)


def _segment_key(start, end):
    return f"{int(round(start))}:{int(round(end))}"


def _matches(segment, start, end, tol=1.0):
    return (abs(segment["start_distance_m"] - start) < tol and
            abs(segment["end_distance_m"] - end) < tol)


def add_segment(activity_id, segment):
    """Record a new user-defined segment dict."""
    segments = load_segments()
    entry = segments.setdefault(str(activity_id), {"edits": [], "additions": [], "deletions": []})
    key = _segment_key(segment["start_distance_m"], segment["end_distance_m"])
    entry["deletions"] = [k for k in entry.get("deletions", []) if k != key]
    entry["additions"] = [a for a in entry["additions"] if not _matches(a, segment["start_distance_m"], segment["end_distance_m"])]
    entry["additions"].append(segment)
    save_segments(segments)


def edit_segment(activity_id, old_start, old_end, segment):
    """Record an edit from old start/end to a new segment dict."""
    segments = load_segments()
    entry = segments.setdefault(str(activity_id), {"edits": [], "additions": [], "deletions": []})

    # If we are editing an existing user segment, update it in place.
    for e in entry["edits"]:
        if _matches(e, old_start, old_end):
            e.update(segment)
            save_segments(segments)
            return
    for a in entry["additions"]:
        if _matches(a, old_start, old_end):
            a.update(segment)
            save_segments(segments)
            return

    # Otherwise this was an auto-detected segment: store an edit keyed to the original range.
    old_key = _segment_key(old_start, old_end)
    entry["edits"] = [e for e in entry["edits"] if e.get("original_key") != old_key]
    entry["edits"].append({**segment, "original_key": old_key})
    entry["deletions"] = [k for k in entry.get("deletions", []) if k != old_key]
    save_segments(segments)


def delete_segment(activity_id, start, end):
    """Remove an edited/added segment, or suppress an auto-detected one."""
    segments = load_segments()
    entry = segments.get(str(activity_id))
    if not entry:
        entry = {"edits": [], "additions": [], "deletions": []}
        segments[str(activity_id)] = entry

    key = _segment_key(start, end)

    removed_user = False
    new_edits = []
    for e in entry["edits"]:
        if _matches(e, start, end):
            removed_user = True
            continue
        new_edits.append(e)
    entry["edits"] = new_edits

    new_additions = [a for a in entry["additions"] if not _matches(a, start, end)]
    removed_user = removed_user or (len(new_additions) < len(entry["additions"]))
    entry["additions"] = new_additions

    if not removed_user:
        entry.setdefault("deletions", []).append(key)

    save_segments(segments)


def apply_overrides(activity_id, auto_climbs):
    """Apply user edits/additions/deletions on top of auto-detected climbs."""
    entry = get_activity_segments(activity_id)
    edits = entry.get("edits", [])
    additions = entry.get("additions", [])
    deletions = set(entry.get("deletions", []))
    if not edits and not additions and not deletions:
        return auto_climbs

    suppressed = deletions | {e["original_key"] for e in edits if e.get("original_key")}
    result = [c for c in auto_climbs
              if _segment_key(c["start_distance_m"], c["end_distance_m"]) not in suppressed]

    for segment in edits:
        result.append({k: v for k, v in segment.items() if k != "original_key"})

    for segment in additions:
        result.append(segment)

    return result
