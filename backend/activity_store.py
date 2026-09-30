#!/usr/bin/env python3
"""Local deletion of activities: GarminDB rows, downloaded files, analysis entry.

Deleted activity ids are kept in ignored_activities.json so syncs do not
re-import them from Garmin Connect (the ride stays on Garmin servers).
"""
import json
import sqlite3
from pathlib import Path

import config

ROOT = Path(__file__).parent.parent
IGNORED_FILE = ROOT / "ignored_activities.json"

GARMINDB_ACTIVITY_TABLES = (
    "activity_records",
    "activity_laps",
    "activity_splits",
    "activities_devices",
    "activities",
)


def load_ignored():
    try:
        return set(json.loads(IGNORED_FILE.read_text(encoding="utf-8")))
    except Exception:
        return set()


def _save_ignored(ids):
    IGNORED_FILE.write_text(json.dumps(sorted(ids), indent=2), encoding="utf-8")


def is_ignored(activity_id):
    return str(activity_id) in load_ignored()


def delete_activity_locally(activity_id, delete_files=True):
    """Remove an activity from local data. Returns a summary dict."""
    activity_id = str(activity_id)
    summary = {"activity_id": activity_id, "db_rows_deleted": 0, "files_deleted": [], "was_ignored": False}

    conn = sqlite3.connect(str(config.ACTIVITIES_DB))
    try:
        for table in GARMINDB_ACTIVITY_TABLES:
            cur = conn.execute(f"DELETE FROM {table} WHERE activity_id = ?", (activity_id,))
            summary["db_rows_deleted"] += cur.rowcount
        conn.commit()
    finally:
        conn.close()

    if delete_files and config.FIT_DIR:
        for f in config.FIT_DIR.glob(f"*{activity_id}*"):
            try:
                f.unlink()
                summary["files_deleted"].append(f.name)
            except FileNotFoundError:
                pass

    ignored = load_ignored()
    summary["was_ignored"] = activity_id in ignored
    ignored.add(activity_id)
    _save_ignored(ignored)

    return summary


def remove_activity_from_analysis(activity_id):
    """Drop the activity entry from climbs.json if present. Returns True if removed."""
    from analyze_climbs import OUT_PATH

    activity_id = str(activity_id)
    try:
        data = json.loads(OUT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return False
    acts = [a for a in data.get("activities", []) if str(a.get("activity_id")) != activity_id]
    if len(acts) == len(data.get("activities", [])):
        return False
    data["activities"] = acts
    data["activity_count"] = len(acts)
    data["climb_count"] = sum(a.get("climb_count", 0) for a in acts)
    OUT_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return True
