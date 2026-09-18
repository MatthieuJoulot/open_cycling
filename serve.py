#!/usr/bin/env python3
"""Tiny static + API server for the climb analyzer."""
import datetime
import json
import math
import sqlite3
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import analyze_climbs
import climb_groups
import osm_lookup
import regions
import segment_store

ROOT = Path(__file__).parent / "web"
CLIMBS_JSON = Path(__file__).parent / "climbs.json"
DB_PATH = Path.home() / "llm/bike/HealthData/DBs/garmin_activities.db"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/climbs":
            self._send_json(json.dumps(get_climbs_with_overrides()))
            return
        if path == "/api/profile":
            self._send_json(json.dumps(get_profile()))
            return
        if path == "/api/climb-names":
            self._send_json(json.dumps(get_all_climb_names()))
            return
        if path == "/api/climb-groups":
            self._send_json(json.dumps(get_climb_groups()))
            return
        if path == "/api/regions":
            self._send_json(json.dumps(get_regions()))
            return
        if path.startswith("/api/climb/") and path.endswith("/matches"):
            key = path.split("/")[-2]
            self._send_json(json.dumps(get_climb_matches(key)))
            return
        if path.startswith("/api/activity/") and path.endswith("/track"):
            activity_id = path.split("/")[-2]
            self._send_json(json.dumps(get_track(activity_id)))
            return
        if path.startswith("/api/activity/") and path.endswith("/details"):
            activity_id = path.split("/")[-2]
            self._send_json(json.dumps(get_activity_details(activity_id)))
            return
        if path.startswith("/api/activity/") and path.endswith("/records"):
            activity_id = path.split("/")[-2]
            fields = query.get("fields", [""])[0]
            limit = query.get("limit", [None])[0]
            self._send_json(json.dumps(get_activity_records(activity_id, fields, limit)))
            return
        if path.startswith("/api/activity/") and path.endswith("/download/fit"):
            activity_id = path.split("/")[-3]
            self._serve_fit_file(activity_id)
            return
        if path.startswith("/api/activity/") and path.endswith("/polyline"):
            activity_id = path.split("/")[-2]
            self._send_json(json.dumps(get_polyline(activity_id)))
            return
        if path.startswith("/api/activity/") and path.endswith("/climb-names"):
            activity_id = path.split("/")[-2]
            suggest = query.get("suggest", ["false"])[0].lower() == "true"
            self._send_json(json.dumps(get_climb_names(activity_id, suggest)))
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/activity/") and path.endswith("/climb-name"):
            activity_id = path.split("/")[-2]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
                name = payload.get("name", "").strip()
                start = payload.get("start_distance_m")
                end = payload.get("end_distance_m")
                if name and start is not None and end is not None:
                    entry = save_climb_name(activity_id, start, end, name)
                    self._send_json(json.dumps(entry))
                    return
                else:
                    self.send_error(400, "Missing name, start_distance_m or end_distance_m")
                    return
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return

        if path.startswith("/api/activity/") and path.endswith("/identify-segments"):
            activity_id = path.split("/")[-2]
            candidates = _get_candidate_segments(activity_id)
            self._send_json(json.dumps(candidates))
            return

        if path.startswith("/api/activity/") and path.endswith("/segment"):
            activity_id = path.split("/")[-2]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            start = payload.get("start_distance_m")
            end = payload.get("end_distance_m")
            if start is None or end is None:
                self.send_error(400, "Missing start_distance_m or end_distance_m")
                return
            segment = _compute_segment(activity_id, start, end)
            if not segment:
                self.send_error(400, "Could not compute segment for range")
                return
            old_start = payload.get("old_start_distance_m")
            old_end = payload.get("old_end_distance_m")
            if old_start is not None and old_end is not None:
                segment_store.edit_segment(activity_id, old_start, old_end, segment)
            else:
                segment_store.add_segment(activity_id, segment)
            try:
                _recompute_after_segment_change(activity_id)
            except Exception as exc:
                # Do not fail the request if downstream recomputation has issues.
                print("recompute warning:", exc)
            self._send_json(json.dumps(segment))
            return

        if path.startswith("/api/activity/") and path.endswith("/segment/delete"):
            activity_id = path.split("/")[-3]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            start = payload.get("start_distance_m")
            end = payload.get("end_distance_m")
            if start is None or end is None:
                self.send_error(400, "Missing start_distance_m or end_distance_m")
                return
            segment_store.delete_segment(activity_id, start, end)
            try:
                _recompute_after_segment_change(activity_id)
            except Exception as exc:
                print("recompute warning:", exc)
            self._send_json(json.dumps({"deleted": True}))
            return

        self.send_error(404, "Not found")

    def _send_json(self, body):
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_fit_file(self, activity_id):
        fit_path = Path.home() / "llm/bike/HealthData/FitFiles/Activities" / f"{activity_id}_ACTIVITY.fit"
        if not fit_path.exists():
            self.send_error(404, "FIT file not found")
            return
        data = fit_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{activity_id}_ACTIVITY.fit"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass  # quiet


def get_track(activity_id):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT distance, altitude, position_lat, position_long
        FROM activity_records
        WHERE activity_id = ? AND altitude IS NOT NULL AND distance IS NOT NULL
        ORDER BY record
        """,
        (activity_id,),
    ).fetchall()

    points = [
        {
            "d": round(r["distance"] * 1000, 1),
            "a": round(r["altitude"], 1),
            "lat": r["position_lat"],
            "lon": r["position_long"],
        }
        for r in rows
    ]

    return points


def _compute_segment(activity_id, start_m, end_m):
    points = get_track(activity_id)
    return analyze_climbs.compute_segment(points, start_m, end_m)


def _recompute_after_segment_change(activity_id):
    climbs = _find_activity_climbs(activity_id)
    osm_lookup.refresh_names_for_activity(activity_id, climbs)
    groups, mapping = climb_groups.build_groups(get_climbs_with_overrides())
    climb_groups.save_groups(groups, mapping)


def _get_candidate_segments(activity_id):
    points = get_track(activity_id)
    if len(points) < 2:
        return []
    existing = _find_activity_climbs(activity_id)
    candidates = analyze_climbs.propose_candidates(
        [p["d"] for p in points],
        [p["a"] for p in points],
        [p["lat"] for p in points],
        [p["lon"] for p in points],
        existing_segments=existing,
    )
    return candidates


def get_polyline(activity_id, max_points=60):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT position_lat, position_long
        FROM activity_records
        WHERE activity_id = ? AND position_lat IS NOT NULL AND position_long IS NOT NULL
        ORDER BY record
        """,
        (activity_id,),
    ).fetchall()

    if len(rows) == 0:
        return []

    if len(rows) <= max_points:
        return [[r["position_lat"], r["position_long"]] for r in rows]

    step = len(rows) / max_points
    result = []
    for i in range(max_points):
        idx = min(int(i * step), len(rows) - 1)
        result.append([rows[idx]["position_lat"], rows[idx]["position_long"]])
    if result[-1] != [rows[-1]["position_lat"], rows[-1]["position_long"]]:
        result.append([rows[-1]["position_lat"], rows[-1]["position_long"]])
    return result


RECORD_FIELDS = {
    "distance",
    "altitude",
    "hr",
    "speed",
    "cadence",
    "timestamp",
    "position_lat",
    "position_long",
}


def _parse_time_to_seconds(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        parts = value.split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    return None


def _row_to_dict(row):
    return {key: row[key] for key in row.keys()}


def _convert_time_fields(row):
    for key in row.keys():
        if key in ("start_time", "stop_time"):
            continue
        if key.endswith("_time") and row[key] is not None:
            row[key] = _parse_time_to_seconds(row[key])
    return row


PERSONAL_INFO_JSON = Path.home() / "llm/bike/HealthData/FitFiles/personal-information.json"


def _load_climbs():
    try:
        return json.loads(CLIMBS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {"activities": []}


def get_climbs_with_overrides():
    data = _load_climbs()
    for act in data.get("activities", []):
        activity_id = act.get("activity_id")
        auto_climbs = act.get("climbs", [])
        act["climbs"] = segment_store.apply_overrides(activity_id, auto_climbs)
    return data


def _find_activity_climbs(activity_id):
    data = _load_climbs()
    for act in data.get("activities", []):
        if act.get("activity_id") == activity_id:
            auto_climbs = act.get("climbs", [])
            return segment_store.apply_overrides(activity_id, auto_climbs)
    return []


def get_climb_names(activity_id, suggest=True):
    climbs = _find_activity_climbs(activity_id)
    return osm_lookup.get_names(activity_id, climbs, suggest=suggest)


def get_all_climb_names():
    return osm_lookup.load_climb_names()


def get_climb_groups():
    return climb_groups.ensure_groups()


def get_regions():
    return regions.get_climb_regions()


def _parse_timestamp(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None
    return None


def _compute_climb_performance(activity_id, start_m, end_m):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Detect available columns to avoid errors on older DB schemas.
    available_cols = {c["name"] for c in cur.execute("SELECT name FROM pragma_table_info('activity_records')")}
    has_power = "power" in available_cols

    power_sql = ", power" if has_power else ""
    rows = cur.execute(
        f"""
        SELECT distance, altitude, hr, speed, timestamp{power_sql}
        FROM activity_records
        WHERE activity_id = ? AND distance >= ? AND distance <= ?
        ORDER BY record
        """,
        (activity_id, start_m / 1000.0, end_m / 1000.0),
    ).fetchall()
    if not rows:
        return {}

    first_ts = _parse_timestamp(rows[0]["timestamp"])
    last_ts = _parse_timestamp(rows[-1]["timestamp"])
    elapsed = (last_ts - first_ts) if first_ts and last_ts else None

    hr_values = [r["hr"] for r in rows if r["hr"] is not None]
    speed_values = [r["speed"] for r in rows if r["speed"] is not None]
    altitudes = [r["altitude"] for r in rows if r["altitude"] is not None]
    power_values = [r["power"] for r in rows if has_power and r["power"] is not None]

    gain = (max(altitudes) - min(altitudes)) if altitudes else None
    vam = (gain / elapsed * 3600) if gain and elapsed and elapsed > 0 else None

    return {
        "elapsed_time_s": elapsed,
        "avg_hr": sum(hr_values) / len(hr_values) if hr_values else None,
        "avg_speed": sum(speed_values) / len(speed_values) if speed_values else None,
        "avg_power": sum(power_values) / len(power_values) if power_values else None,
        "gain_m": gain,
        "vam": vam,
    }


def get_climb_matches(key):
    groups = climb_groups.ensure_groups()
    group_id = groups.get("key_to_group", {}).get(key)
    member_keys = []
    if group_id:
        member_keys = groups.get("groups", {}).get(group_id, [])
    if not member_keys:
        member_keys = [key]

    # Build reverse lookup from climbs.json by key
    data = _load_climbs()
    climbs_by_key = {}
    for act in data.get("activities", []):
        activity_id = act.get("activity_id")
        for c in act.get("climbs", []):
            k = f"{activity_id}:{int(round(c['start_distance_m']))}:{int(round(c['end_distance_m']))}"
            climbs_by_key[k] = {**c, "activity_id": activity_id, "activity_name": act.get("name"), "start_time": act.get("start_time")}

    results = []
    for k in member_keys:
        c = climbs_by_key.get(k)
        if not c:
            continue
        perf = _compute_climb_performance(c["activity_id"], c["start_distance_m"], c["end_distance_m"])
        results.append({**c, **perf})
    results.sort(key=lambda x: x.get("start_time") or "")
    return {"group_id": group_id, "count": len(results), "members": results}


def save_climb_name(activity_id, start_distance_m, end_distance_m, name):
    climbs = _find_activity_climbs(activity_id)
    climb = osm_lookup.find_climb(activity_id, climbs, start_distance_m, end_distance_m)
    if climb is None:
        # Build a minimal climb stub from stored record coordinates if missing.
        climb = {"start_distance_m": start_distance_m, "end_distance_m": end_distance_m}
    return osm_lookup.set_manual_name(activity_id, climb, name)


def _load_personal_info():
    try:
        return json.loads(PERSONAL_INFO_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_activity_details(activity_id):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    activity = cur.execute(
        "SELECT * FROM activities WHERE activity_id = ?", (activity_id,)
    ).fetchone()
    if activity is None:
        return {"error": "activity not found"}

    activity = _row_to_dict(activity)
    activity = _convert_time_fields(activity)

    hr_stats = cur.execute(
        "SELECT AVG(hr) AS avg_hr, MAX(hr) AS max_hr FROM activity_records WHERE activity_id = ?",
        (activity_id,),
    ).fetchone()

    sensor_cols = cur.execute(
        "SELECT name FROM pragma_table_info('activity_records')"
    ).fetchall()
    sensor_cols = {c["name"] for c in sensor_cols}

    counts = cur.execute(
        """
        SELECT
            SUM(CASE WHEN hr IS NOT NULL THEN 1 ELSE 0 END) AS hr_n,
            SUM(CASE WHEN cadence IS NOT NULL THEN 1 ELSE 0 END) AS cadence_n,
            SUM(CASE WHEN speed IS NOT NULL THEN 1 ELSE 0 END) AS speed_n
        FROM activity_records
        WHERE activity_id = ?
        """,
        (activity_id,),
    ).fetchone()

    power_n = 0
    if "power" in sensor_cols:
        power_n = cur.execute(
            "SELECT COUNT(*) FROM activity_records WHERE activity_id = ? AND power IS NOT NULL",
            (activity_id,),
        ).fetchone()[0]

    laps = []
    try:
        lap_rows = cur.execute(
            "SELECT * FROM activity_laps WHERE activity_id = ? ORDER BY lap",
            (activity_id,),
        ).fetchall()
        for lap in lap_rows:
            lap_dict = _convert_time_fields(_row_to_dict(lap))
            laps.append(lap_dict)
    except Exception:
        pass

    climbs_data = _load_climbs()
    activity_climbs = []
    for act in climbs_data.get("activities", []):
        if act.get("activity_id") == activity_id:
            activity_climbs = act.get("climbs", [])
            break
    activity_climbs = segment_store.apply_overrides(activity_id, activity_climbs)

    devices = []
    try:
        garmin_db = Path.home() / "llm/bike/HealthData/DBs/garmin.db"
        gconn = sqlite3.connect(str(garmin_db))
        gconn.row_factory = sqlite3.Row
        gcur = gconn.cursor()
        serial_rows = cur.execute(
            "SELECT device_serial_number FROM activities_devices WHERE activity_id = ?",
            (activity_id,),
        ).fetchall()
        serials = [r["device_serial_number"] for r in serial_rows]
        if serials:
            placeholders = ",".join("?" * len(serials))
            for drow in gcur.execute(
                f"""SELECT serial_number, device_type, manufacturer, product FROM devices
                    WHERE serial_number IN ({placeholders})
                    AND device_type NOT IN ('invalid', 'accelerometer', 'barometer', 'bluetooth_low_energy_chipset', 'sensor_hub', 'wrist_heart_rate', 'gps')""",
                serials,
            ):
                devices.append({
                    "serial": drow["serial_number"],
                    "type": drow["device_type"],
                    "manufacturer": drow["manufacturer"],
                    "product": drow["product"],
                })
    except Exception:
        pass

    return {
        "activity": activity,
        "avg_hr": round(hr_stats["avg_hr"], 1) if hr_stats["avg_hr"] else None,
        "max_hr": hr_stats["max_hr"],
        "sensors": {
            "has_hr": bool(counts["hr_n"]),
            "has_power": bool(power_n),
            "has_cadence": bool(counts["cadence_n"]),
            "has_speed": bool(counts["speed_n"]),
        },
        "laps": laps,
        "climbs": activity_climbs,
        "devices": devices,
    }


def get_activity_records(activity_id, fields_param, limit_param):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    available = {
        c["name"] for c in cur.execute("SELECT name FROM pragma_table_info('activity_records')").fetchall()
    }

    default_fields = ["distance", "altitude", "hr", "speed", "timestamp"]
    if fields_param:
        requested = [f.strip() for f in fields_param.split(",")]
    else:
        requested = default_fields

    fields = [f for f in requested if f in available]
    if not fields:
        fields = default_fields

    # Always include record for ordering; it is not returned.
    select_sql = ", ".join(fields)
    rows = cur.execute(
        f"SELECT {select_sql} FROM activity_records WHERE activity_id = ? ORDER BY record",
        (activity_id,),
    ).fetchall()

    limit = None
    if limit_param is not None:
        try:
            limit = int(limit_param)
        except ValueError:
            limit = None

    n = len(rows)
    if limit and n > limit:
        step = math.ceil(n / limit)
        selected = [rows[i] for i in range(0, n, step)]
        if selected[-1] is not rows[-1]:
            selected.append(rows[-1])
    else:
        selected = rows

    result = []
    for r in selected:
        point = {}
        for f in fields:
            v = r[f]
            if f == "distance" and v is not None:
                v = round(v * 1000, 2)
            point[f] = v
        result.append(point)

    return result


def get_profile():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # All-time cycling totals
    row = cur.execute(
        """
        SELECT COUNT(*) AS n,
               SUM(distance) AS distance_km,
               SUM(ascent) AS ascent_m,
               SUM(descent) AS descent_m
        FROM activities
        WHERE sport = 'cycling'
        """
    ).fetchone()

    moving_seconds = 0
    for r in cur.execute(
        "SELECT moving_time FROM activities WHERE sport = 'cycling' AND moving_time IS NOT NULL"
    ):
        moving_seconds += _parse_time_to_seconds(r["moving_time"]) or 0

    # Climbs total
    climbs_data = _load_climbs()
    climb_count = sum(a.get("climb_count", 0) for a in climbs_data.get("activities", []))

    # Time-window summaries
    now = datetime.datetime.now(datetime.timezone.utc)
    ytd_start = datetime.datetime(now.year, 1, 1, tzinfo=datetime.timezone.utc)
    last30_start = now - datetime.timedelta(days=30)

    def window_stats(start):
        r = cur.execute(
            """
            SELECT COUNT(*) AS n,
                   SUM(distance) AS distance_km,
                   SUM(ascent) AS ascent_m
            FROM activities
            WHERE sport = 'cycling' AND start_time >= ?
            """,
            (start.strftime("%Y-%m-%d %H:%M:%S"),),
        ).fetchone()
        return {
            "rides": r["n"] or 0,
            "distance_km": round(r["distance_km"], 1) if r["distance_km"] else 0,
            "ascent_m": round(r["ascent_m"]) if r["ascent_m"] else 0,
        }

    personal = _load_personal_info()
    user_info = personal.get("userInfo", {})
    bio = personal.get("biometricProfile", {})

    devices = []
    try:
        garmin_db = Path.home() / "llm/bike/HealthData/DBs/garmin.db"
        gconn = sqlite3.connect(str(garmin_db))
        gconn.row_factory = sqlite3.Row
        gcur = gconn.cursor()
        for drow in gcur.execute(
            """
            SELECT d.serial_number, d.device_type, d.manufacturer, d.product,
                   di.software_version
            FROM devices d
            LEFT JOIN device_info di ON d.serial_number = di.serial_number
            WHERE d.device_type NOT IN ('invalid', 'accelerometer', 'barometer', 'bluetooth_low_energy_chipset', 'sensor_hub', 'wrist_heart_rate')
            GROUP BY d.serial_number
            ORDER BY di.timestamp DESC
            LIMIT 10
            """
        ):
            devices.append({
                "serial": drow["serial_number"],
                "type": drow["device_type"],
                "manufacturer": drow["manufacturer"],
                "product": drow["product"],
                "software_version": drow["software_version"],
            })
    except Exception:
        pass

    return {
        "athlete": {
            "email": user_info.get("email"),
            "age": user_info.get("age"),
            "gender": user_info.get("genderType"),
            "country": user_info.get("countryCode"),
            "weight_kg": round(bio.get("weight", 0) / 1000, 1) if bio.get("weight") else None,
            "height_cm": round(bio.get("height", 0), 1) if bio.get("height") else None,
            "vo2max": bio.get("vo2Max"),
            "lactate_threshold_hr": bio.get("lactateThresholdHeartRate"),
        },
        "devices": devices,
        "all_time": {
            "rides": row["n"] or 0,
            "distance_km": round(row["distance_km"], 1) if row["distance_km"] else 0,
            "moving_time_s": moving_seconds,
            "ascent_m": round(row["ascent_m"]) if row["ascent_m"] else 0,
            "descent_m": round(row["descent_m"]) if row["descent_m"] else 0,
            "climbs": climb_count,
        },
        "ytd": window_stats(ytd_start),
        "last_30_days": window_stats(last30_start),
    }


if __name__ == "__main__":
    port = 8080
    print(f"Serving at http://127.0.0.1:{port}/")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
