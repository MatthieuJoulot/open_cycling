#!/usr/bin/env python3
"""Detect climbs in cycling activities stored by GarminDB."""
import json
import sqlite3
import sys
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import config

DB_PATH = config.ACTIVITIES_DB
OUT_PATH = Path(__file__).with_name("climbs.json")

# Detection parameters
SMOOTH_WINDOW = 15          # points for altitude moving average
START_GRADE = 3.0           # % grade needed to start a climb
STOP_GRADE = 1.0            # % grade below which a climb ends
MIN_LENGTH_M = 300          # minimum climb length in meters
MIN_AVG_GRADE = 2.5         # minimum average grade for a climb
SCORE_THRESHOLD = 8000      # Strava-style: length(m) * avg_grade(%) > 8000
MERGE_GAP_M = 500           # max distance between climbs to merge across a false flat
MERGE_DIP_M = 30            # max altitude lost in the gap for merging to apply


def grade_category(score: float) -> str:
    if score >= 80000:
        return "HC"
    if score >= 64000:
        return "Cat 1"
    if score >= 32000:
        return "Cat 2"
    if score >= 16000:
        return "Cat 3"
    if score >= 8000:
        return "Cat 4"
    return "Uncategorized"


def smooth(values, window):
    if len(values) == 0:
        return []
    result = []
    buf = deque(maxlen=window)
    for v in values:
        buf.append(v)
        result.append(sum(buf) / len(buf))
    return result


def _prepare_points(distance_m, altitude, lat, lon):
    points = []
    for d, a, la, lo in zip(distance_m, altitude, lat, lon):
        if d is None or a is None:
            continue
        points.append({"d": float(d), "a": float(a), "lat": la, "lon": lo})
    return points


def profile_metrics(points, start_m, end_m, section=100.0):
    """Cotacol difficulty points (as used by Climbfinder) for a range.

    The profile is resampled at fixed `section` stations, altitudes are
    smoothed with a 3-station centred median (barometric jitter would
    explode through the squared gradient), and each station interval
    scores dI = 0.001 * s^2 * dL with s the local gradient in % and dL
    the section length in m. Descents/flats score zero; the total is the
    sum, i.e. the total effort to reach the top.
    """
    pts = sorted(
        [p for p in points if p["d"] is not None and p["a"] is not None
         and p["d"] >= start_m - 50 and p["d"] <= end_m + 50],
        key=lambda p: p["d"],
    )
    if len(pts) < 2:
        return None
    d0, d1 = pts[0]["d"], pts[-1]["d"]
    n = int((d1 - d0) // section)
    if n < 1:
        return None

    def altitude_at(d):
        lo = hi = None
        for r in pts:
            if r["d"] <= d:
                lo = r
            if r["d"] >= d and hi is None:
                hi = r
        if lo and hi:
            if lo is hi:
                return lo["a"]
            t = (d - lo["d"]) / max(1e-6, hi["d"] - lo["d"])
            return lo["a"] + (hi["a"] - lo["a"]) * t
        return lo["a"] if lo else (hi["a"] if hi else None)

    raw = [altitude_at(d0 + i * section) for i in range(n + 1)]
    smoothed = []
    for i in range(len(raw)):
        window = sorted(v for v in raw[max(0, i - 1):i + 2] if v is not None)
        smoothed.append(window[len(window) // 2] if window else None)

    total = 0.0
    steepest = 0.0
    for i in range(n):
        a, b = smoothed[i], smoothed[i + 1]
        if a is None or b is None:
            continue
        gain = b - a
        if gain > 0:
            grade = gain / section * 100
            total += 0.001 * grade * grade * section
            if gain > steepest:
                steepest = gain
    if n * section < section:
        return None
    return {"cotacol_points": round(total, 1),
            "steepest_100m_grade": round(steepest / section * 100, 1)}


def _build_climb(points, smoothed, start_idx, end_idx, max_grade):
    elev_gain = smoothed[end_idx] - smoothed[start_idx]
    length = points[end_idx]["d"] - points[start_idx]["d"]
    avg_grade = (elev_gain / length * 100) if length > 0 else 0
    score = length * avg_grade
    start_pt = points[start_idx]
    end_pt = points[end_idx]
    metrics = profile_metrics(points, start_pt["d"], end_pt["d"]) or {}
    return {
        "start_distance_m": round(start_pt["d"], 1),
        "end_distance_m": round(end_pt["d"], 1),
        "length_m": round(length, 1),
        "elevation_gain_m": round(elev_gain, 1),
        "avg_grade_percent": round(avg_grade, 1),
        "max_grade_percent": round(max_grade, 1),
        "cotacol_points": metrics.get("cotacol_points"),
        "steepest_100m_grade": metrics.get("steepest_100m_grade"),
        "category": grade_category(score),
        "start_lat": start_pt.get("lat"),
        "start_lon": start_pt.get("lon"),
        "end_lat": end_pt.get("lat"),
        "end_lon": end_pt.get("lon"),
    }


def detect_climbs(distance_m, altitude, lat, lon,
                  start_grade=START_GRADE, stop_grade=STOP_GRADE,
                  min_length_m=MIN_LENGTH_M, min_avg_grade=MIN_AVG_GRADE,
                  smooth_window=SMOOTH_WINDOW):
    """Return list of climb envelope dicts from arrays of distance (m), altitude (m), lat/lon.

    Consecutive or overlapping uphill sections are merged into the longest continuous
    envelope so that shorter ramps inside a longer climb are not reported as separate
    climbs by default.
    """
    points = _prepare_points(distance_m, altitude, lat, lon)
    if len(points) < smooth_window * 2:
        return []

    altitudes = [p["a"] for p in points]
    smoothed = smooth(altitudes, smooth_window)

    raw = []
    in_climb = False
    start_idx = 0
    max_grade = 0.0

    for i in range(1, len(points)):
        dist_delta = points[i]["d"] - points[i - 1]["d"]
        grade = 0.0
        if dist_delta > 0.1:
            grade = (smoothed[i] - smoothed[i - 1]) / dist_delta * 100

        if not in_climb:
            if grade >= start_grade:
                in_climb = True
                start_idx = _look_back_start(points, smoothed, i - 1, start_grade)
                max_grade = grade
        else:
            if grade > max_grade:
                max_grade = grade
            if grade < stop_grade:
                end_idx = i
                climb = _build_climb(points, smoothed, start_idx, end_idx, max_grade)
                if climb["length_m"] >= min_length_m and climb["avg_grade_percent"] >= min_avg_grade:
                    raw.append(climb)
                in_climb = False
                max_grade = 0.0

    return merge_envelopes(raw, points)


def _look_back_start(points, smoothed, detected_idx, gentle_grade=0.5, max_lookback_m=3000):
    """Walk backwards from the detected climb start to capture the true foot.

    A climb often starts with a gentle run-in (2-3%) below the detection
    threshold. Extend the start backwards while the road is still rising at
    least `gentle_grade` percent (smoothed), stopping at any sustained dip.
    """
    idx = detected_idx
    limit_d = points[idx]["d"] - max_lookback_m

    while idx > 0 and points[idx - 1]["d"] >= limit_d:
        # Average grade over the segment between idx-1 and idx; the smoothed
        # series already filters single-point noise.
        d = points[idx]["d"] - points[idx - 1]["d"]
        if d <= 0.1:
            idx -= 1
            continue
        g = (smoothed[idx] - smoothed[idx - 1]) / d * 100
        if g >= gentle_grade:
            idx -= 1
        else:
            break

    return idx


def merge_envelopes(climbs, points=None):
    """Merge overlapping/nested/adjacent climb sections into longest envelopes.

    A second, relaxed pass bridges small gaps: two climbs separated by a short
    false flat or dip (village, hairpin, respite stretch) are merged into one
    envelope if the altitude lost in the gap is small and the combined result
    still climbs meaningfully. This reconstructs big cols (e.g. Tourmalet)
    that detection splits at gentle interludes.
    """
    if not climbs:
        return []

    sorted_climbs = sorted(climbs, key=lambda c: (c["start_distance_m"], -c["end_distance_m"]))
    merged = [sorted_climbs[0]]

    for c in sorted_climbs[1:]:
        last = merged[-1]
        # Overlap or immediate adjacency within 50 m
        if c["start_distance_m"] <= last["end_distance_m"] + 50:
            if c["end_distance_m"] > last["end_distance_m"]:
                last["end_distance_m"] = c["end_distance_m"]
                last["end_lat"] = c["end_lat"]
                last["end_lon"] = c["end_lon"]
            if c["max_grade_percent"] > last["max_grade_percent"]:
                last["max_grade_percent"] = c["max_grade_percent"]
        elif points and _bridgeable(last, c, points):
            last["end_distance_m"] = c["end_distance_m"]
            last["end_lat"] = c["end_lat"]
            last["end_lon"] = c["end_lon"]
            if c["max_grade_percent"] > last["max_grade_percent"]:
                last["max_grade_percent"] = c["max_grade_percent"]
        else:
            merged.append(c)

    # Recompute metrics for merged envelopes so length/gain/avg_grade reflect the union.
    if points:
        merged = [_recompute_envelope(c, points) for c in merged]
        # Drop envelopes that fell below the climb bar after recomputation.
        merged = [c for c in merged if c["length_m"] >= MIN_LENGTH_M and c["avg_grade_percent"] >= MIN_AVG_GRADE]
    return merged


def _bridgeable(a, b, points):
    """True when the gap between climb a and climb b is a short false flat/dip.

    Conditions: gap length within MERGE_GAP_M, altitude lost within
    MERGE_DIP_M, and the combined envelope still averages at least
    MIN_AVG_GRADE. Combined gain is measured on the altitude series, not from
    the pieces' possibly-stale elevation_gain_m (they may already be merged
    envelopes whose gain was not accumulated).
    """
    gap_len = b["start_distance_m"] - a["end_distance_m"]
    if gap_len <= 50 or gap_len > MERGE_GAP_M:
        return False

    pts = sorted([p for p in points if p["d"] is not None and p["a"] is not None], key=lambda p: p["d"])
    env_pts = [p for p in pts if a["start_distance_m"] <= p["d"] <= b["end_distance_m"]]
    if len(env_pts) < 2:
        return False

    gap_pts = [p for p in pts if a["end_distance_m"] <= p["d"] <= b["start_distance_m"]]
    if len(gap_pts) < 2:
        return False

    # Altitude lost in the gap: highest point of the gap minus altitude at b's start.
    gap_max = max(p["a"] for p in gap_pts)
    dip_lost = gap_max - gap_pts[-1]["a"]
    if dip_lost > MERGE_DIP_M:
        return False

    # Combined envelope must still be a real climb.
    combined_len = b["end_distance_m"] - a["start_distance_m"]
    if combined_len <= 0:
        return False
    combined_gain = env_pts[-1]["a"] - env_pts[0]["a"]
    combined_avg = combined_gain / combined_len * 100
    return combined_avg >= MIN_AVG_GRADE


def _recompute_envelope(climb, points):
    """Recompute length/gain/avg grade for an envelope using original raw points."""
    start_m = climb["start_distance_m"]
    end_m = climb["end_distance_m"]
    pts = sorted([p for p in points if p["d"] is not None and p["a"] is not None], key=lambda p: p["d"])
    if len(pts) < 2:
        return climb

    altitudes = [p["a"] for p in pts]
    smoothed = smooth(altitudes, SMOOTH_WINDOW)

    start_idx = None
    end_idx = None
    for i, p in enumerate(pts):
        if start_idx is None and p["d"] >= start_m:
            start_idx = i
        if p["d"] <= end_m:
            end_idx = i
    if start_idx is None or end_idx is None or start_idx >= end_idx:
        return climb

    length = pts[end_idx]["d"] - pts[start_idx]["d"]
    gain = smoothed[end_idx] - smoothed[start_idx]
    avg = (gain / length * 100) if length > 0 else 0
    score = length * avg
    metrics = profile_metrics(pts, start_m, end_m) or {}
    return {
        **climb,
        "length_m": round(length, 1),
        "elevation_gain_m": round(gain, 1),
        "avg_grade_percent": round(avg, 1),
        "cotacol_points": metrics.get("cotacol_points"),
        "steepest_100m_grade": metrics.get("steepest_100m_grade"),
        "category": grade_category(score),
        "start_lat": pts[start_idx]["lat"],
        "start_lon": pts[start_idx]["lon"],
        "end_lat": pts[end_idx]["lat"],
        "end_lon": pts[end_idx]["lon"],
    }


def detect_subsegments(distance_m, altitude, lat, lon, envelope,
                       start_grade=1.5, stop_grade=0.5,
                       min_length_m=200, min_avg_grade=1.5,
                       smooth_window=SMOOTH_WINDOW):
    """Detect candidate sub-segments inside a climb envelope with relaxed thresholds."""
    points = _prepare_points(distance_m, altitude, lat, lon)
    points = [p for p in points if envelope["start_distance_m"] - 10 <= p["d"] <= envelope["end_distance_m"] + 10]
    if len(points) < smooth_window * 2:
        return []
    return detect_climbs(
        [p["d"] for p in points],
        [p["a"] for p in points],
        [p["lat"] for p in points],
        [p["lon"] for p in points],
        start_grade=start_grade, stop_grade=stop_grade,
        min_length_m=min_length_m, min_avg_grade=min_avg_grade,
        smooth_window=smooth_window,
    )


def compute_segment(points, start_distance_m, end_distance_m, smooth_window=SMOOTH_WINDOW):
    """Compute segment metrics for an arbitrary start/end distance range."""
    points = [p for p in points if p["d"] is not None and p["a"] is not None]
    if len(points) < 2:
        return None
    points = sorted(points, key=lambda p: p["d"])
    altitudes = [p["a"] for p in points]
    smoothed = smooth(altitudes, smooth_window)

    start_idx = None
    end_idx = None
    for i, p in enumerate(points):
        if start_idx is None and p["d"] >= start_distance_m:
            start_idx = i
        if p["d"] <= end_distance_m:
            end_idx = i
    if start_idx is None or end_idx is None or start_idx >= end_idx:
        return None

    max_grade = 0.0
    for i in range(start_idx + 1, end_idx + 1):
        dist_delta = points[i]["d"] - points[i - 1]["d"]
        if dist_delta > 0.1:
            grade = abs((smoothed[i] - smoothed[i - 1]) / dist_delta * 100)
            if grade > max_grade:
                max_grade = grade

    result = _build_climb(points, smoothed, start_idx, end_idx, max_grade)
    result["start_distance_m"] = round(start_distance_m, 1)
    result["end_distance_m"] = round(end_distance_m, 1)
    metrics = profile_metrics(points, start_distance_m, end_distance_m) or {}
    result["cotacol_points"] = metrics.get("cotacol_points")
    result["steepest_100m_grade"] = metrics.get("steepest_100m_grade")
    return result


def propose_candidates(distance_m, altitude, lat, lon, existing_segments=None,
                       start_grade=1.5, stop_grade=0.5,
                       min_length_m=200, min_avg_grade=1.5):
    """Detect candidate segments with relaxed thresholds, excluding existing ones."""
    candidates = detect_climbs(distance_m, altitude, lat, lon,
                               start_grade=start_grade, stop_grade=stop_grade,
                               min_length_m=min_length_m, min_avg_grade=min_avg_grade)
    existing = existing_segments or []

    def overlaps(cand):
        for ex in existing:
            if (abs(cand["start_distance_m"] - ex["start_distance_m"]) < 50 and
                abs(cand["end_distance_m"] - ex["end_distance_m"]) < 50):
                return True
            # also skip if candidate is mostly inside an existing segment
            overlap_start = max(cand["start_distance_m"], ex["start_distance_m"])
            overlap_end = min(cand["end_distance_m"], ex["end_distance_m"])
            if overlap_end > overlap_start:
                overlap_len = overlap_end - overlap_start
                if overlap_len > 0.7 * cand["length_m"]:
                    return True
        return False

    return [c for c in candidates if not overlaps(c)]


def _time_to_seconds(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        parts = value.split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    return None


def main(full=False):
    if not DB_PATH or not DB_PATH.exists():
        print(f"No activities database found ({DB_PATH}); nothing to analyze.")
        return
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # User-deleted activities never come back, even if a sync re-imports
    # them into GarminDB.
    try:
        import activity_store
        ignored = activity_store.load_ignored()
    except Exception:
        ignored = set()

    activities = [
        act for act in cur.execute(
            """
            SELECT activity_id, name, start_time, distance, ascent, descent,
                   moving_time, elapsed_time, avg_speed, max_speed, avg_hr, max_hr,
                   start_lat, start_long
            FROM activities
            WHERE sport = 'cycling'
            ORDER BY start_time DESC
            """
        ).fetchall()
        if str(act["activity_id"]) not in ignored
    ]

    # Load previous results so unchanged activities can be skipped.
    previous = {}
    if not full and OUT_PATH.exists():
        try:
            old_data = json.loads(OUT_PATH.read_text(encoding="utf-8"))
            for act in old_data.get("activities", []):
                previous[act["activity_id"]] = act
        except Exception:
            previous = {}

    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "activity_count": len(activities),
        "climb_count": 0,
        "activities": [],
    }

    n_analyzed = 0
    n_skipped = 0

    for idx, act in enumerate(activities, 1):
        activity_id = act["activity_id"]
        old = previous.get(activity_id)

        # Skip if the activity was already analyzed and no ride is newer than it
        # (records are immutable once in GarminDB, so old rides never change).
        newest_time = activities[0]["start_time"]
        if old is not None and act["start_time"] != newest_time:
            result["climb_count"] += len(old.get("climbs", []))
            result["activities"].append(old)
            n_skipped += 1
            continue

        print(f"[{idx}/{len(activities)}] {activity_id} {act['name']}", flush=True)
        records = cur.execute(
            """
            SELECT distance, altitude, position_lat, position_long
            FROM activity_records
            WHERE activity_id = ?
            ORDER BY record
            """,
            (activity_id,),
        ).fetchall()

        distance_m = [r["distance"] * 1000 if r["distance"] is not None else None for r in records]
        altitude = [r["altitude"] for r in records]
        lats = [r["position_lat"] for r in records]
        lons = [r["position_long"] for r in records]

        climbs = detect_climbs(distance_m, altitude, lats, lons)
        n_analyzed += 1
        result["climb_count"] += len(climbs)
        result["activities"].append({
            "activity_id": activity_id,
            "name": act["name"],
            "start_time": act["start_time"],
            "distance_km": round(act["distance"], 2) if act["distance"] else None,
            "ascent_m": act["ascent"],
            "descent_m": act["descent"],
            "moving_time_s": _time_to_seconds(act["moving_time"]),
            "elapsed_time_s": _time_to_seconds(act["elapsed_time"]),
            "avg_speed": act["avg_speed"],
            "max_speed": act["max_speed"],
            "avg_hr": act["avg_hr"],
            "max_hr": act["max_hr"],
            "start_lat": act["start_lat"],
            "start_lon": act["start_long"],
            "climbs": climbs,
            "climb_count": len(climbs),
        })

    OUT_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(
        f"Wrote {OUT_PATH}: {result['climb_count']} climbs from "
        f"{result['activity_count']} rides ({n_analyzed} analyzed, {n_skipped} skipped)."
    )


if __name__ == "__main__":
    main(full="--full" in sys.argv)
