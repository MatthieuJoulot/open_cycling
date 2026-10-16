"""Aggregate cycling statistics for the Statistics page.

One pass over the activities DB (cycling only) plus one over climbs.json,
with a disk cache for per-climb performance (elapsed time / VAM), which
requires querying the records DB per climb occurrence and is expensive
(~760 queries otherwise).
"""
import json
import math
import time
from pathlib import Path

import sqlite3

import segment_store
import validated_store
import moving as moving_time

ROOT = Path(__file__).parent.parent
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
    """Flatten overridden climbs to one entry per occurrence.

    climbs.json lists every enabled sport, but only cycling activities
    ever carry climbs, so no extra filter is needed.
    """
    validated = validated_store.get_validated_list()
    occurrences = []
    for act in climbs_data.get("activities", []):
        if act.get("sport", "cycling") != "cycling":
            continue
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


def get_stats(connect_db, sport=None, from_date=None, to_date=None):
    """Build the full statistics payload.

    `connect_db` is serve._connect_db, injected to avoid a circular import.
    `sport` filters the activity list / environment stats / best efforts to
    one sport, and selects that sport's best-effort distance set; None means
    all enabled sports with the cycling effort set. Climb occurrences and
    normalized HR stay cycling-only (climbs are bike segments).
    `from_date`/`to_date` ("YYYY-MM-DD") bound every activity-derived stat —
    including the best efforts and the own VO2max estimates — to the UI's
    selected period.
    """
    import sports as sports_registry
    conn = connect_db()
    if conn is None:
        return {"error": "activities database not configured"}
    cur = conn.cursor()

    enabled = sports_registry.enabled_sports({"sports": __import__("config").SPORTS})
    # DB-level names: hiking covers Garmin's `walking` rows too.
    sports_in = sports_registry.db_names([sport] if sport else list(enabled))
    # Report each activity under its canonical sport (walking → hiking).
    canon = sports_registry.canon
    effort_distances = sports_registry.sport_meta(sport)["efforts"] if sport else EFFORT_DISTANCES_M
    placeholders = ",".join("?" for _ in sports_in)

    activities = []
    rows = cur.execute(
        f"""
        SELECT activity_id, name, start_time, distance, ascent, moving_time,
               elapsed_time, calories, avg_hr, max_hr, avg_speed, avg_cadence,
               training_load, self_eval_feel, self_eval_effort,
               hrz_1_time, hrz_2_time, hrz_3_time, hrz_4_time, hrz_5_time,
               sport
        FROM activities
        WHERE sport IN ({placeholders})
        ORDER BY start_time
        """,
        tuple(sports_in),
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
        d["sport"] = canon(r["sport"]) if r["sport"] else r["sport"]
        # Self-eval enums -> ordinal 1..5 so the frontend can chart them.
        d["self_eval_feel"] = _FEEL_SCALE.get(d.get("self_eval_feel"))
        d["self_eval_effort"] = _EFFORT_SCALE.get(d.get("self_eval_effort"))
        activities.append(d)

    # Period bounds from the UI. The activity list itself stays unbounded
    # (year-over-year, records and the Garmin VO2 line need full history);
    # only period-sensitive aggregates — best efforts and the own VO2max
    # estimates — are limited to activities that started in the window.
    def in_period(start_time):
        if not start_time:
            return False
        day = str(start_time)[:10]
        if from_date and day < from_date:
            return False
        if to_date and day > to_date:
            return False
        return True

    if from_date or to_date:
        period_ids = {a["activity_id"] for a in activities if in_period(a.get("start_time"))}
    else:
        period_ids = None

    # Climb occurrences with overrides + grouping.
    import climb_groups
    groups = climb_groups.ensure_groups()
    key_to_group = groups.get("key_to_group", {})
    climbs_data = _load_json(CLIMBS_JSON, default={"activities": []})
    occurrences = _climb_occurrences_from_climbs_data(climbs_data, key_to_group)
    if period_ids is not None:
        occurrences = [o for o in occurrences if o["activity_id"] in period_ids]

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
                SELECT timestamp, speed FROM activity_records
                WHERE activity_id = ? AND distance >= ? AND distance <= ?
                ORDER BY record
                """,
                (o["activity_id"], start_m / 1000.0, end_m / 1000.0),
            )
            ts_rows = cur.fetchall()
            elapsed = None
            if len(ts_rows) >= 2:
                # Strava-style: elapsed to the arrival at the end point
                # (a stop at the top after arriving is not climb time).
                elapsed, _raw = moving_time.moving_seconds(ts_rows)
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
        f"""
        SELECT r.activity_id,
               AVG(CASE WHEN r.temperature BETWEEN -20 AND 45
                        THEN r.temperature END) AS t,
               AVG(r.altitude) AS alt
        FROM activity_records r
        JOIN activities a ON a.activity_id = r.activity_id
        WHERE a.sport IN ({placeholders})
          AND (r.temperature IS NOT NULL OR r.altitude IS NOT NULL)
        GROUP BY r.activity_id
        """,
        tuple(sports_in),
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
    # window over each ride's distance/timestamp records), using the
    # selected sport's distance set. Cached.
    efforts = _best_efforts(cur, activities, effort_distances)

    # VO2 max history: Garmin stores one estimate per foot-activity in
    # steps_activities and per bike-activity in cycle_activities. Collected
    # across sports regardless of the scope filter — the series is sparse.
    vo2_history = []
    try:
        vo2_rows = cur.execute(
            """
            SELECT a.start_time, a.sport, s.vo2_max
            FROM steps_activities s
            JOIN activities a ON a.activity_id = s.activity_id
            WHERE s.vo2_max IS NOT NULL
            UNION ALL
            SELECT a.start_time, a.sport, c.vo2_max
            FROM cycle_activities c
            JOIN activities a ON a.activity_id = c.activity_id
            WHERE c.vo2_max IS NOT NULL
            ORDER BY 1
            """
        ).fetchall()
        for r in vo2_rows:
            vo2_history.append({
                "date": r["start_time"],
                "vo2": r["vo2_max"],
                "sport": canon(r["sport"]) if r["sport"] else r["sport"],
            })
    except Exception:
        vo2_history = []

    # Own VO2 max estimates, performance-based, one per sport, scoped to
    # the selected period via period_ids.
    vo2_estimates = _vo2_estimates(activities, efforts, occurrences, period_ids)

    # Normalized HR: fit avg_hr against climb intensity, temperature and
    # altitude, then subtract each effect so rides are comparable as if
    # all done flat, at 20°C, sea level.
    norm = _normalized_hr(activities)

    # HR vs speed per grade bucket (cycling only, cached).
    grade_hr = _grade_hr_cycling(cur, activities) if any(
        a.get("sport") == "cycling" for a in activities) else []

    conn.close()
    return {
        "activities": activities,
        "climb_occurrences": occurrences,
        "best_efforts": efforts,
        "hr_normalization": norm,
        "vo2_history": vo2_history,
        "vo2_estimates": vo2_estimates,
        "grade_hr": grade_hr,
    }


# ---------------------------------------------------------------------------
# Own VO2 max estimates (performance-based, vs Garmin's HR-model number).
#
# Running — VDOT (Daniels): each best-effort pace maps to the metabolic
# cost of running at that speed (ACSM equation), then divides by the
# fraction of VO2max sustainable for that duration (Daniels tables).
# Median across distances gives one number per runner.
#
# Cycling — no power meter data, so watts come from physics on climbs
# (same model as serve._estimate_climb_power, simplified to whole-climb
# averages: gravity + rolling + aero from the climb's own grade, length
# and time). The top 3-12 min climb efforts convert to VO2 via the
# ACSM leg-ergometry equation, adjusted by how close to VO2max an
# effort of that duration can be run. Reported as a range-friendly
# point; the constants (CdA, mass) carry ±10-15% uncertainty.
# ---------------------------------------------------------------------------

_RIDER_WEIGHT_KG = 69.5        # from Garmin personal info, fallback
_BIKE_MASS_KG = 10.0           # bike + kit
_CRR = 0.005                   # rolling resistance, asphalt
_CDA = 0.32                    # aero drag m², hoods position
_DRIVETRAIN = 0.975            # 2.5% drivetrain loss
_G = 9.81
_RHO = 1.225                   # air density, sea level

# Fraction of VO2max sustainable for a best effort of that length
# (Daniels): shorter is supramaximal, longer drains towards the
# sustainable rate.
_RUN_VO2MAX_FRACTION = {
    1000: 1.06, 1609: 1.05, 5000: 0.95, 10000: 0.92,
    21097: 0.90, 42195: 0.86,
}


def _vo2_estimates(activities, efforts, occurrences, period_ids=None):
    """Own VO2max estimates: running via VDOT, cycling via climb physics.

    `efforts` is the best-efforts cache {activity_id: {distance_m: sec}}
    and `occurrences` the climb list with elapsed_time_s/vam already
    attached. `period_ids` bounds the estimate to activities inside the
    UI-selected period (None = all time). Returns {"running": {...},
    "cycling": {...}} with None entries when the sport lacks data.
    """
    running = _vo2_running(activities, period_ids)
    cycling = _vo2_cycling(activities, occurrences)
    return {"running": running, "cycling": cycling}


def _vo2_running(activities, period_ids=None):
    """VDOT estimate: median over best-effort distances.

    Reads the on-disk best-efforts cache directly (all distances, all
    rides) because the payload's `efforts` is filtered to the selected
    sport's distance set and would miss running distances in the
    all-sports scope. Needs at least two distances with best times
    (one distance alone risks being a non-maximal day). `period_ids`
    restricts the effort cache to the UI-selected period.
    """
    import sports as sports_registry
    running_ids = {
        a["activity_id"] for a in activities
        if a.get("sport") == "running"
    }
    if period_ids is not None:
        running_ids &= period_ids
    if not running_ids:
        return None
    cache = _load_json(EFFORTS_CACHE, default={"efforts": {}})
    best_t = {}
    for aid, dists in (cache.get("efforts") or {}).items():
        if aid not in running_ids:
            continue
        for d_m, t in dists.items():
            d_m = int(d_m)
            if d_m not in _RUN_VO2MAX_FRACTION or not t or t <= 0:
                continue
            if d_m not in best_t or t < best_t[d_m]:
                best_t[d_m] = t
    per_distance = []
    for d_m, frac in sorted(_RUN_VO2MAX_FRACTION.items()):
        t = best_t.get(d_m)
        if t is None:
            continue
        v = d_m / t * 60.0                      # m/min
        vo2_cost = 0.2 * v + 3.5               # ACSM running, no grade
        per_distance.append({
            "distance_m": d_m,
            "time_s": round(t, 1),
            "vo2max": round(vo2_cost / frac, 1),
        })
    # At least two distances, else too fragile.
    if len(per_distance) < 2:
        return None
    vals = sorted(e["vo2max"] for e in per_distance)
    mid = len(vals) // 2
    median = vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2
    return {
        "vo2max": round(median, 1),
        "per_distance": per_distance,
        "method": ("VDOT: best-effort paces → metabolic cost (ACSM), "
                   "divided by the VO2max fraction sustainable per distance (Daniels)."),
    }


def _vo2_cycling(activities, occurrences):
    """Climb-physics estimate: top 3-12 min efforts → W/kg → VO2 (ACSM bike)."""
    if not occurrences:
        return None
    rider_kg = _rider_weight_kg_live() or _RIDER_WEIGHT_KG
    if not rider_kg:
        return None
    mass = rider_kg + _BIKE_MASS_KG

    top = []
    for o in occurrences:
        t = o.get("elapsed_time_s")
        length = o.get("length_m")
        grade_pct = o.get("avg_grade_percent")
        if not t or not length or grade_pct is None or not (180 <= t <= 720):
            continue
        grade = grade_pct / 100.0
        if grade < 0.02:                        # near-flat: aero model noise
            continue
        v = length / t                          # m/s
        theta = math.atan(grade)
        f = (mass * _G * math.sin(theta)
             + mass * _G * _CRR * math.cos(theta)
             + 0.5 * _RHO * _CDA * v * v)
        w = f * v / _DRIVETRAIN
        if w <= 0 or w > 2000:
            continue
        top.append({
            "when": (o.get("start_time") or "")[:10],
            "name": o.get("validated_name") or o.get("category") or "Unnamed climb",
            "elapsed_time_s": round(t, 1),
            "watts": round(w, 1),
            "w_per_kg": round(w / rider_kg, 2),
            "activity_id": o.get("activity_id"),
        })
    top.sort(key=lambda e: -e["w_per_kg"])
    # Drop the single best (freak wind/GPS outlier risk) and take the
    # next 4; their median is the estimate.
    pool = top[1:5]
    if len(pool) < 2:
        return None
    def _vo2max_fraction(t):
        # How much of VO2max a maximal effort of this length can hit.
        if t < 300: return 1.02
        if t < 480: return 1.00
        return 0.97
    vo2s = sorted((10.8 * e["w_per_kg"] + 7.0) / _vo2max_fraction(e["elapsed_time_s"])
                 for e in pool)
    median = vo2s[len(vo2s) // 2] if len(vo2s) % 2 else (vo2s[len(vo2s) // 2 - 1] + vo2s[len(vo2s) // 2]) / 2
    return {
        "vo2max": round(median, 1),
        "rider_mass_kg": round(rider_kg, 1),
        "per_climb": top[:5],
        "method": ("Best 3-12 min climbs → watts from physics (gravity + rolling + aero), "
                   "W/kg → VO2 via ACSM leg ergometry; drop the top outlier, median of next 4."),
    }


def _rider_weight_kg_live():
    """Rider weight from Garmin personal info; None when unavailable."""
    try:
        import config
        info = json.loads(config.PERSONAL_INFO_JSON.read_text(encoding="utf-8"))
        grams = info.get("biometricProfile", {}).get("weight")
        return round(grams / 1000, 1) if grams else None
    except Exception:
        return None


def _normalized_hr(activities):
    """OLS fit of avg HR on climb intensity, temperature, altitude.

    Predictors are included only when enough rides carry them
    (temperature is often absent). Coefficients are for predictors
    centred on their in-sample means, so the intercept equals the
    mean HR of the fitted rides and each coefficient is the local
    effect per unit. The frontend subtracts each ride's deviations
    from the means, normalizing every ride to the typical
    conditions (flat-ish, median temp, median altitude).
    Returns {"intercept", "coef", "means", "n", "r2", "std_err",
    "predictors"} or {"n": 0} when not enough data.
    """
    rows = []
    for a in activities:
        hr = a.get("avg_hr")
        dist = a.get("distance")
        ascent = a.get("ascent")
        if not hr or not dist or ascent is None:
            continue
        ci = ascent / dist                     # vertical m per horizontal km
        temp = a.get("avg_temperature")
        alt = a.get("avg_altitude")
        rows.append({
            "hr": float(hr),
            "climb_intensity": ci,
            "temp_dev": (float(temp) - 20.0) if temp is not None else None,
            "altitude_km": (float(alt) / 1000.0) if alt is not None else None,
        })

    # Keep a predictor only when at least MIN_PRED rows have it.
    MIN_PRED = 50
    predictors = []
    for key in ("climb_intensity", "temp_dev", "altitude_km"):
        if sum(1 for r in rows if r[key] is not None) >= MIN_PRED:
            predictors.append(key)
    if not predictors:
        return {"n": len(rows)}

    fit_rows = [r for r in rows if all(r[p] is not None for p in predictors)]
    n = len(fit_rows)
    if n < 20:
        return {"n": n}

    means = {"hr": sum(r["hr"] for r in fit_rows) / n}
    for p in predictors:
        means[p] = sum(r[p] for r in fit_rows) / n

    k = 1 + len(predictors)
    X = [[1.0] + [r[p] - means[p] for p in predictors] for r in fit_rows]
    y = [r["hr"] - means["hr"] for r in fit_rows]

    xtx = [[sum(X[t][i] * X[t][j] for t in range(n)) for j in range(k)] for i in range(k)]
    xty = [sum(X[t][i] * y[t] for t in range(n)) for i in range(k)]
    b = _solve(xtx, xty)
    if b is None:
        return {"n": n}

    ss_res = sum((y[t] - sum(b[i] * X[t][i] for i in range(k))) ** 2 for t in range(n))
    ss_tot = sum(v * v for v in y) or 1e-12
    r2 = 1 - ss_res / ss_tot
    dof = max(1, n - k)
    std_err = (ss_res / dof) ** 0.5

    coef = {p: b[i + 1] for i, p in enumerate(predictors)}
    return {
        "intercept": round(means["hr"], 1),
        "coef": {p: round(v, 2) for p, v in coef.items()},
        "means": {"hr": round(means["hr"], 1),
                  **{p: round(means[p], 3 if p == "altitude_km" else 1) for p in predictors}},
        "n": n,
        "r2": round(r2, 3),
        "std_err": round(std_err, 1),
        "predictors": predictors,
    }


def _solve(A, y):
    """Gaussian elimination with partial pivoting; None if singular."""
    n = len(A)
    M = [row[:] + [y[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-12:
            return None
        M[col], M[piv] = M[piv], M[col]
        pv = M[col][col]
        for r in range(n):
            if r == col:
                continue
            f = M[r][col] / pv
            for c in range(col, n + 1):
                M[r][c] -= f * M[col][c]
    return [M[i][n] / M[i][i] for i in range(n)]


def _best_efforts(cur, activities, distances_m):
    """Fastest time covering each fixed distance, per ride.

    Rolling two-pointer window over each ride's distance/timestamp records.
    Returns {activity_id: {distance_m: seconds}}; the frontend aggregates
    per period and keeps the best per distance with the ride reference.
    Cached in cache/best_efforts.json, keyed by activity_id. Keys are
    stored as strings on disk (JSON) and normalized back to ints here.

    Times are Strava-style elapsed windows: pauses inside a window
    count (that is what a best effort means).
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
                # Strava-style: fastest elapsed window. A stop inside a
                # window costs time (that is what a best effort means).
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
            # Only report the distances this sport's effort set asks for
            # (the cache can hold other sports' distances for the ride).
            wanted = {d: t for d, t in have.items() if d in distances_m}
            if wanted:
                results[act["activity_id"]] = wanted

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


GRADE_HR_CACHE = ROOT / "cache" / "grade_hr.json"
# Grade buckets (percent). The bucket label shown in the UI.
GRADE_BUCKETS = [(0, 2), (2, 4), (4, 6), (6, 8), (8, None)]


def _grade_hr_cycling(cur, activities):
    """HR vs speed per grade bucket for every cycling ride.

    GPS/barometric data is noisy, and every naive choice leaks descents
    into climb buckets, so this function is deliberately paranoid:

    - speed is DERIVED from consecutive distance/timestamp deltas, not
      the glitchy speed column;
    - altitude is median-filtered (~15 samples ≈ 75 m), which kills
      single-point spikes;
    - a window's grade is the least-squares slope over the whole 500 m
      window, AND the endpoint difference must agree within 2% —
      disagreeing windows are transitions (descent into climb, lock
      glitches) and are dropped;
    - windows whose derived speed or HR look non-physiological (> 75
      km/h mean, HR < 60) are dropped.

    HR is averaged over moving samples only (speed > 1.8 km/h).
    Cached on disk; invalidated when the ride count or the newest start
    time changes.
    """
    cycling = [a for a in activities if a.get("sport") == "cycling"]
    n = len(cycling)
    newest = max((a.get("start_time") or "" for a in cycling), default="")
    cache = _load_json(GRADE_HR_CACHE, default={})
    if (cache.get("n") == n and cache.get("newest") == newest
            and cache.get("sport") == "cycling"):
        return cache.get("buckets", [])
    if not n:
        _save_json(GRADE_HR_CACHE, {"n": 0, "newest": "", "sport": "cycling", "buckets": []})
        return []

    WINDOW_KM = 0.5
    points = {label: [] for label in
               [f"{lo}-{hi}%" if hi else f"{lo}%+"
                for lo, hi in GRADE_BUCKETS]}
    for a in cycling:
        aid = a["activity_id"]
        rows = cur.execute(
            """
            SELECT distance, altitude, hr, speed, timestamp
            FROM activity_records
            WHERE activity_id = ? AND distance IS NOT NULL
              AND altitude IS NOT NULL
            ORDER BY record
            """,
            (aid,),
        ).fetchall()
        if len(rows) < 8:
            continue

        # Median-filter altitude: sorted window, take the middle value.
        alts = [r["altitude"] for r in rows]
        med_win = 9
        smooth_alts = []
        half = med_win // 2
        for i in range(len(alts)):
            lo = max(0, i - half)
            hi = min(len(alts), i + half + 1)
            smooth_alts.append(sorted(alts[lo:hi])[len(alts[lo:hi]) // 2])

        # Derived speeds (m/s) from distance/timestamp deltas; falls back
        # to the recorded speed column when timestamps are missing.
        derived = []
        for k in range(len(rows)):
            if k == 0:
                derived.append(None)
                continue
            dt = None
            t0, t1 = rows[k - 1]["timestamp"], rows[k]["timestamp"]
            if t0 and t1:
                try:
                    dt = _ts_diff_s(t0, t1)
                except Exception:
                    dt = None
            dd = rows[k]["distance"] - rows[k - 1]["distance"]
            if dt and 0 < dt < 30 and dd is not None and dd >= 0:
                derived.append(dd * 1000.0 / dt)
            else:
                derived.append(rows[k]["speed"])

        # Window boundary walk: one window per 500 m of distance.
        i = 0
        while i < len(rows):
            d0 = rows[i]["distance"]
            if d0 is None:
                i += 1
                continue
            j = i
            while j + 1 < len(rows) and rows[j + 1]["distance"] < d0 + WINDOW_KM:
                j += 1
            if j == i or rows[j]["distance"] is None:
                i += 1
                continue
            seg = rows[i:j + 1]
            dist = seg[-1]["distance"] - seg[0]["distance"]   # km
            if dist < WINDOW_KM * 0.9:
                i = j + 1
                continue

            sp_vals = [(derived[k], k) for k in range(i, j + 1)
                       if derived[k] is not None and rows[k]["hr"] is not None]
            if not sp_vals:
                i = j + 1
                continue
            sp_mean = sum(v for v, _ in sp_vals) / len(sp_vals)
            # Non-physiological speed: descent/glitch window.
            if sp_mean > 20.8 or max(v for v, _ in sp_vals) > 33.3:
                i = j + 1
                continue

            # Grade: least-squares slope over smoothed altitude, cross-
            # checked against the endpoint difference.
            m = j - i + 1
            if m < 4:
                i = j + 1
                continue
            sx = sy = sxy = sxx = 0.0
            for k in range(i, j + 1):
                dk = rows[k]["distance"]
                sx += dk; sy += smooth_alts[k]
            mx, my = sx / m, sy / m
            for k in range(i, j + 1):
                dk = rows[k]["distance"]
                sxx += (dk - mx) ** 2
                sxy += (dk - mx) * (smooth_alts[k] - my)
            if sxx <= 0:
                i = j + 1
                continue
            grade = (sxy / sxx) / 10.0           # m per km -> %
            end_grade = ((smooth_alts[j] - smooth_alts[i]) / (dist * 1000.0)) * 100
            if abs(grade - end_grade) > 2.0:    # transition window, drop
                i = j + 1
                continue

            hr_vals = [rows[k]["hr"] for k in range(i, j + 1)
                       if rows[k]["hr"] is not None and derived[k] is not None
                       and derived[k] > 0.5]
            if hr_vals:
                hr_mean = sum(hr_vals) / len(hr_vals)
                if hr_mean >= 60:
                    for lo, hi in GRADE_BUCKETS:
                        if grade >= lo and (hi is None or grade < hi):
                            label = f"{lo}-{hi}%" if hi else f"{lo}%+"
                            points[label].append({
                                "speed": round(sp_mean * 3.6, 2),
                                "hr": round(hr_mean, 1),
                                "activity_id": aid,
                                "date": (a.get("start_time") or "")[:10],
                            })
                            break
            i = j + 1

    buckets = [{"label": label, "points": pts}
               for label, pts in points.items() if pts]
    payload = {"n": n, "newest": newest, "sport": "cycling", "buckets": buckets}
    _save_json(GRADE_HR_CACHE, payload)
    return buckets


def _ts_diff_s(t0, t1):
    """Seconds between two activity_records timestamp strings."""
    from datetime import datetime
    d0 = datetime.fromisoformat(str(t0))
    d1 = datetime.fromisoformat(str(t1))
    return (d1 - d0).total_seconds()
