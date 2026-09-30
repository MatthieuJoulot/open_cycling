#!/usr/bin/env python3
"""Store user-validated climbs: canonical named segments."""
import datetime
import json
from pathlib import Path

import climb_groups

ROOT = Path(__file__).parent.parent
VALIDATED_FILE = ROOT / "validated_climbs.json"


def _load_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default if default is not None else {}


def _save_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_validated():
    return _load_json(VALIDATED_FILE, default={})


def save_validated(validated):
    _save_json(VALIDATED_FILE, validated)


def get_validated_list():
    return list(load_validated().values())


def find_climb(climbs, start_distance_m, end_distance_m, tol=5.0):
    """Return the climb dict matching the given start/end distances."""
    for c in climbs:
        if (abs(c["start_distance_m"] - start_distance_m) < tol and
                abs(c["end_distance_m"] - end_distance_m) < tol):
            return c
    return None


def matches_climb(validated, climb):
    """Geometry + metrics match between a validated entry and a climb."""
    return climb_groups.climbs_match(validated, climb)


def apply_validated_names(climbs, validated):
    """Attach validated names to matching climbs in place.

    A validated name wins over any OSM/manual name: validation is the
    strongest signal that two segments are the same real-world climb.
    """
    if not validated:
        return
    for c in climbs:
        for v in validated:
            if climb_groups.climbs_match(v, c):
                c["validated_name"] = v["name"]
                c["validated_climb_id"] = v["climb_id"]
                break


def validate_climb(activity_id, climb, name):
    """Add a validated climb snapshot. Rejects nameless entries."""
    name = (name or "").strip()
    if not name:
        raise ValueError("A validated climb requires a name")

    validated = load_validated()

    climb_id = f"vc{len(validated) + 1}"
    while climb_id in validated:
        # defensive: id collisions after manual deletions
        n = int(climb_id[2:]) + 1
        climb_id = f"vc{n}"

    entry = {
        "climb_id": climb_id,
        "name": name,
        "start_lat": climb["start_lat"],
        "start_lon": climb["start_lon"],
        "end_lat": climb["end_lat"],
        "end_lon": climb["end_lon"],
        "length_m": climb["length_m"],
        "elevation_gain_m": climb["elevation_gain_m"],
        "avg_grade_percent": climb["avg_grade_percent"],
        "category": climb.get("category"),
        "source_activity_id": str(activity_id),
        "source_start_distance_m": climb["start_distance_m"],
        "source_end_distance_m": climb["end_distance_m"],
        "validated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    validated[climb_id] = entry
    save_validated(validated)
    return entry


def delete_validated(climb_id):
    validated = load_validated()
    removed = validated.pop(climb_id, None)
    if removed:
        save_validated(validated)
    return removed
