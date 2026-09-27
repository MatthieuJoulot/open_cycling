"""Aggregate cycling statistics for the Statistics page.

One pass over the activities DB (cycling only) plus one over climbs.json,
with a disk cache for per-climb performance (elapsed time / VAM), which
requires querying the records DB per climb occurrence and is expensive
(~760 queries otherwise).
"""
import json
import time
from pathlib import Path

import sqlite3

import segment_store
import validated_store

ROOT = Path(__file__).parent
CLIMBS_JSON = ROOT / "climbs.json"
PERF_CACHE = ROOT / "cache" / "climb_stats.json"
EFFORTS_CACHE = ROOT / "cache" / "best_efforts.json"

# How fresh the performance cache must be relative to climbs.json, in
# seconds. The cache records climbs.json's mtime, so any change (sync,
# segment edits) invalidates it.
PERF_CACHE_MAX_AGE = 3600

# Fixed distances for best efforts (Strava-style cycling set), in meters.
# 1 mile = 1609.344 m.
EFFORT_DISTANCES_M = [
    8047, 10000, 16093, 20000, 30000, 40000, 50000, 80000,
    80467, 90000, 100000,
]

# Garmin self-evaluation enums mapped to ordinal values (1 = easiest).
_FEEL_SCALE = {
    "Very Weak": 1, "Weak": 2, "Normal": 3, "Strong": 4, "Very Strong": 5,
}
_EFFORT_SCALE = {
    "None": 0, "Very Light": 1, "Light": 2, "Moderate": 3, "Somewhat Hard": 4,
    "Hard": 5, "Very Hard": 6, "Extremely Hard": 7, "Maximum": 8,
}


def _load_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default if default is not None else {}


def _save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _load_climb_perf_cache():
    try:
        return json.loads(PERF_CACHE.read_text(encoding="utf-8"))
    except Exception:
        return {"climbs_mtime": 0, "generated_at": 0, "perf": {}}


def _climb_occurrences_from_climbs_data(climbs_data, key_to_group):
    """Flatten overridden climbs to one entry per occurrence."""
    validated = validated_store.get_validated_list()
    occurrences = []
    for act in climbs_data.get("activities", []):
        activity_id = act.get("activity_id")
        climbs = segment_store.apply_overrides(activity_id, act.get("climbs", []))
        validated_store.apply_validated_names(climbs, validated)
        for c in climbs:
            key = f"{activity_id}:{int(round(c['start_distance_m']))}:{int(round(c['end_distance_m']))}"
            occurrences.append({
                "activity_id": activity_id,
                "start_time": act.get("start_time"),
                "category": c.get("category"),
                "length_m": c.get("length_m"),
                "elevation_gain_m": c.get("elevation_gain_m"),
                "avg_grade_percent": c.get("avg_grade_percent"),
                "validated_name": c.get("validated_name"),
                "group_id": key_to_group.get(key),
                "key": key,
                "start_distance_m": c.get("start_distance_m"),
                "end_distance_m": c.get("end_distance_m"),
            })
    return occurrences


def get_stats(connect_db):
    """Build the full statistics payload.

    `connect_db` is serve._connect_db, injected to avoid a circular import.
    """
    conn = connect_db()
    if conn is None:
        return {"error": "activities database not configured"}
    cur = conn.cursor()

    activities = []
    rows = cur.execute(
        """
        SELECT activity_id, name, start_time, distance, ascent, moving_time,
               elapsed_time, calories, avg_hr, max_hr, avg_speed, avg_cadence,
               training_load, self_eval_feel, self_eval_effort,
               hrz_1_time, hrz_2_time, hrz_3_time, hrz_4_time, hrz_5_time
        FROM activities
        WHERE sport = 'cycling'
        ORDER BY start_time
        """
    ).fetchall()
    for r in rows:
        d = dict(r)
        # Times arrive as hh:mm:ss strings; convert to seconds.
        for k in ("moving_time", "elapsed_time"):
            if d.get(k) is not None and isinstance(d[k], str):
                parts = d[k].split(":")
                if len(parts) == 3:
                    d[k] = (int(parts[0]) * 3600 + int(parts[1]) * 60
                            + float(parts[2]))
        for k in ("hrz_1_time", "hrz_2_time", "hrz_3_time", "hrz_4_time", "hrz_5_time"):
            if d.get(k) is not None and isinstance(d[k], str):
                parts = d[k].split(":")
                if len(parts) == 3:
                    d[k] = int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        d["distance"] = r["distance"] or 0
        # Self-eval enums -> ordinal 1..5 so the frontend can chart them.
        d["self_eval_feel"] = _FEEL_SCALE.get(d.get("self_eval_feel"))
        d["self_eval_effort"] = _EFFORT_SCALE.get(d.get("self_eval_effort"))
        activities.append(d)

    # Climb occurrences with overrides + grouping.
    import climb_groups
    groups = climb_groups.ensure_groups()
    key_to_group = groups.get("key_to_group", {})
    climbs_data = _load_json(CLIMBS_JSON, default={"activities": []})
    occurrences = _climb_occurrences_from_climbs_data(climbs_data, key_to_group)

    # Per-occurrence performance (elapsed time, VAM), cached.
    cache = _load_climb_perf_cache()
    climbs_mtime = 0
    try:
        climbs_mtime = CLIMBS_JSON.stat().st_mtime
    except Exception:
        pass
    cache_fresh = (
        cache.get("climbs_mtime") == climbs_mtime
        and time.time() - cache.get("generated_at", 0) < PERF_CACHE_MAX_AGE * 24
    )
    perf = cache.get("perf", {}) if cache_fresh else {}
    missing = [o for o in occurrences if o["key"] not in perf]
    if missing:
        for o in missing:
            start_m = o["start_distance_m"]
            end_m = o["end_distance_m"]
            if start_m is None or end_m is None or end_m <= start_m:
                continue
            cur.execute(
                """
                SELECT timestamp FROM activity_records
                WHERE activity_id = ? AND distance >= ? AND distance <= ?
                ORDER BY record
                """,
                (o["activity_id"], start_m / 1000.0, end_m / 1000.0),
            )
            ts_rows = cur.fetchall()
            elapsed = None
            if len(ts_rows) >= 2:
                t0 = _parse_ts(ts_rows[0]["timestamp"])
                t1 = _parse_ts(ts_rows[-1]["timestamp"])
                if t0 is not None and t1 is not None:
                    elapsed = t1 - t0
            gain = o.get("elevation_gain_m")
            vam = None
            if elapsed and elapsed > 0 and gain:
                vam = gain / elapsed * 3600
            perf[o["key"]] = {"elapsed_time_s": elapsed, "vam": vam}
        _save_json(PERF_CACHE, {
            "climbs_mtime": climbs_mtime,
            "generated_at": time.time(),
            "perf": perf,
        })

    for o in occurrences:
        p = perf.get(o["key"], {})
        o["elapsed_time_s"] = p.get("elapsed_time_s")
        o["vam"] = p.get("vam")

    # Per-ride average temperature and altitude from records (the
    # activities.avg_temperature column is mostly a 127 sentinel).
    # Only plausible readings kept.
    env_rows = cur.execute(
        """
        SELECT r.activity_id,
               AVG(CASE WHEN r.temperature BETWEEN -20 AND 45
                        THEN r.temperature END) AS t,
               AVG(r.altitude) AS alt
        FROM activity_records r
        JOIN activities a ON a.activity_id = r.activity_id
        WHERE a.sport = 'cycling'
          AND (r.temperature IS NOT NULL OR r.altitude IS NOT NULL)
        GROUP BY r.activity_id
        """
    ).fetchall()
    ride_temp = {}
    ride_alt = {}
    for r in env_rows:
        if r["t"] is not None:
            ride_temp[r["activity_id"]] = round(r["t"], 1)
        if r["alt"] is not None:
            ride_alt[r["activity_id"]] = round(r["alt"], 0)
    for d in activities:
        d["avg_temperature"] = ride_temp.get(d["activity_id"])
        d["avg_altitude"] = ride_alt.get(d["activity_id"])

    # Best efforts: fastest time covering each fixed distance (rolling
    # window over each ride's distance/timestamp records). Cached.
    efforts = _best_efforts(cur, activities, EFFORT_DISTANCES_M)

    conn.close()
    return {
        "activities": activities,
        "climb_occurrences": occurrences,
        "best_efforts": efforts,
    }


def _best_efforts(cur, activities, distances_m):
    """Fastest time covering each fixed distance, per ride.

    Rolling two-pointer window over each ride's distance/timestamp records.
    Returns {activity_id: {distance_m: seconds}}; the frontend aggregates
    per period and keeps the best per distance with the ride reference.
    Cached in cache/best_efforts.json, keyed by activity_id. Keys are
    stored as strings on disk (JSON) and normalized back to ints here.
    """
    cache = _load_json(EFFORTS_CACHE, default={"efforts": {}})
    efforts_cache = cache.get("efforts", {})
    # Normalize disk cache: {aid: {"8047": t}} -> {aid: {8047: t}}.
    norm = {}
    for aid, eff in efforts_cache.items():
        norm[str(aid)] = {int(k): v for k, v in eff.items() if v is not None}

    dirty = False
    results = {}
    for act in activities:
        aid = str(act["activity_id"])
        max_m = (act.get("distance") or 0) * 1000
        have = norm.get(aid, {})
        needed = [d for d in distances_m if d <= max_m and d not in have]
        if needed and max_m >= min(distances_m):
            rows = cur.execute(
                """
                SELECT distance, timestamp FROM activity_records
                WHERE activity_id = ? AND distance IS NOT NULL AND timestamp IS NOT NULL
                ORDER BY record
                """,
                (act["activity_id"],),
            ).fetchall()
            if rows:
                dists = [r["distance"] * 1000 for r in rows]   # km -> m
                times = [_parse_ts(r["timestamp"]) for r in rows]
                for d_m in needed:
                    best_t = None
                    j = 0
                    for i in range(len(rows)):
                        while j < len(rows) and dists[j] - dists[i] < d_m:
                            j += 1
                        if j >= len(rows):
                            break
                        if (times[i] is not None and times[j] is not None
                                and dists[j] - dists[i] >= d_m):
                            t = times[j] - times[i]
                            if t > 0 and (best_t is None or t < best_t):
                                best_t = t
                        if j >= len(rows) - 1:
                            break
                    if best_t is not None:
                        have[d_m] = best_t
                        norm[aid] = have
                        dirty = True
        if have:
            results[act["activity_id"]] = dict(have)

    if dirty:
        _save_json(EFFORTS_CACHE, {"efforts": norm})

    return results


def _parse_ts(value):
    if value is None:
        return None
    s = str(value)
    # 'YYYY-MM-DD HH:MM:SS.ffffff' or 'YYYY-MM-DD HH:MM:SS'
    try:
        import datetime
        if "." in s:
            return datetime.datetime.strptime(s, "%Y-%m-%d %H:%M:%S.%f").timestamp()
        return datetime.datetime.strptime(s, "%Y-%m-%d %H:%M:%S").timestamp()
    except Exception:
        return None
