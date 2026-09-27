#!/usr/bin/env python3
"""Tiny static + API server for the climb analyzer."""
import datetime
import json
import math
import sqlite3
import subprocess
import sys
import threading
import traceback
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import analyze_climbs
import activity_store
import climb_groups
import config
import osm_lookup
import regions
import segment_store
import validated_store

ROOT = Path(__file__).parent / "web"
CLIMBS_JSON = Path(__file__).parent / "climbs.json"
DB_PATH = config.ACTIVITIES_DB


def _connect_db():
    """Open the activities DB; returns None when the app is not configured."""
    if not DB_PATH or not DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/sync/status":
            self._send_json(json.dumps(get_sync_status()))
            return
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
        if path == "/api/validated-climbs":
            self._send_json(json.dumps(validated_store.get_validated_list()))
            return
        if path == "/api/history/scan/status":
            self._send_json(json.dumps(get_history_status()))
            return
        if path == "/api/history/download/status":
            self._send_json(json.dumps(get_sync_status()))
            return
        if path == "/api/config":
            self._send_json(json.dumps(get_config_status()))
            return
        if path == "/api/regions":
            # Serve from the cache only (fast); if some activities lack a
            # region, start a background geocode and tell the client.
            missing = len(regions._missing_activity_coords())
            if missing:
                start_region_warm()
            result = get_regions()
            result["warming"] = _region_warm_state["running"] or missing > 0
            result["missing"] = missing
            self._send_json(json.dumps(result))
            return
        if path == "/api/regions/status":
            self._send_json(json.dumps(get_regions_status()))
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

        if path == "/api/sync":
            started = start_sync()
            self._send_json(json.dumps(started))
            return

        if path.startswith("/api/activity/") and path.endswith("/validate"):
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
            name = payload.get("name")
            if start is None or end is None:
                self.send_error(400, "Missing start_distance_m or end_distance_m")
                return
            if not name or not str(name).strip():
                self.send_error(400, "A validated climb requires a name")
                return
            try:
                entry = validate_climb_request(activity_id, start, end, str(name).strip())
            except ValueError as exc:
                self.send_error(400, str(exc))
                return
            self._send_json(json.dumps(entry))
            return

        if path.startswith("/api/validated-climbs/") and path.endswith("/delete"):
            climb_id = path.split("/")[-2]
            removed = validated_store.delete_validated(climb_id)
            if not removed:
                self.send_error(404, "Validated climb not found")
                return
            self._send_json(json.dumps({"deleted": True}))
            return

        if path == "/api/config":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            if not isinstance(payload, dict):
                self.send_error(400, "Expected a JSON object")
                return
            try:
                config.save_config(payload)
            except Exception as exc:
                self.send_error(400, f"Could not save config: {exc}")
                return
            self._send_json(json.dumps(get_config_status()))
            return

        if path == "/api/history/scan":
            started = scan_history()
            self._send_json(json.dumps(started))
            return

        if path == "/api/history/download":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            count = payload.get("count")
            if not count or not str(count).isdigit():
                self.send_error(400, "Missing or invalid count")
                return
            started = start_history_download(int(count))
            self._send_json(json.dumps(started))
            return

        if path == "/api/import-files":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(body)
            except Exception as exc:
                self.send_error(400, f"Invalid JSON: {exc}")
                return
            if not isinstance(payload, dict):
                self.send_error(400, "Expected a JSON object")
                return
            result = import_files(payload)
            if "error" in result:
                self.send_error(400, result["error"])
                return
            self._send_json(json.dumps(result))
            return

        if path.startswith("/api/activity/") and path.endswith("/delete"):
            activity_id = path.split("/")[-2]
            if not activity_id.isdigit():
                self.send_error(400, "Invalid activity id")
                return
            summary = activity_store.delete_activity_locally(activity_id)
            activity_store.remove_activity_from_analysis(activity_id)
            try:
                groups, mapping = climb_groups.build_groups(get_climbs_with_overrides(), validated_store.get_validated_list())
                climb_groups.save_groups(groups, mapping)
                summary["groups"] = len(groups)
            except Exception as exc:
                print("group rebuild after delete warning:", exc)
            self._send_json(json.dumps(summary))
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
        fit_path = config.FIT_DIR / f"{activity_id}_ACTIVITY.fit"
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
    conn = _connect_db()
    if conn is None:
        return []
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
    # Name refresh can hit Overpass (slow, occasionally hangs on big bboxes).
    # Never block the segment save on it: run it in the background.
    threading.Thread(
        target=_refresh_names_and_groups,
        args=(activity_id,),
        daemon=True,
    ).start()
    # Group rebuild is local and fast; keep it synchronous so the UI that
    # reloads right after saving sees consistent groups.
    try:
        groups, mapping = climb_groups.build_groups(get_climbs_with_overrides(), validated_store.get_validated_list())
        climb_groups.save_groups(groups, mapping)
    except Exception as exc:
        print("group rebuild warning:", exc)


def _refresh_names_and_groups(activity_id):
    try:
        climbs = _find_activity_climbs(activity_id)
        osm_lookup.refresh_names_for_activity(activity_id, climbs)
    except Exception as exc:
        print("name refresh warning:", exc)


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
    conn = _connect_db()
    if conn is None:
        return []
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


PERSONAL_INFO_JSON = config.PERSONAL_INFO_JSON


def _load_climbs():
    try:
        return json.loads(CLIMBS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {"activities": []}


def get_climbs_with_overrides():
    data = _load_climbs()
    validated = validated_store.get_validated_list()
    for act in data.get("activities", []):
        activity_id = act.get("activity_id")
        auto_climbs = act.get("climbs", [])
        climbs = segment_store.apply_overrides(activity_id, auto_climbs)
        _apply_validated_names(climbs, validated)
        act["climbs"] = climbs
    return data


def _apply_validated_names(climbs, validated):
    """Attach validated names to matching climbs in place.

    A validated name wins over any OSM/manual name: validation is the
    strongest signal. The climb key records which validated entry matched.
    """
    if not validated:
        return
    for c in climbs:
        for v in validated:
            if climb_groups.climbs_match(v, c):
                c["validated_name"] = v["name"]
                c["validated_climb_id"] = v["climb_id"]
                break


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


_region_warm_state = {"running": False, "last_done": None}


def _region_warm_worker():
    """Geocode any missing activity regions in the background so the API
    never blocks on Nominatim (1 req/s makes a cold cache take minutes)."""
    try:
        regions.warm_activity_regions()
        _region_warm_state["last_done"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    except Exception as exc:
        print("region warm warning:", exc)
    finally:
        _region_warm_state["running"] = False


def start_region_warm():
    if _region_warm_state["running"]:
        return
    _region_warm_state["running"] = True
    threading.Thread(target=_region_warm_worker, daemon=True).start()


def get_regions_status():
    return dict(_region_warm_state)


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
    conn = _connect_db()
    if conn is None:
        return {}
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

    # Build reverse lookup from climbs.json by key, applying user edits so
    # modified/added segments are what the climb page actually shows.
    data = _load_climbs()
    validated = validated_store.get_validated_list()
    climbs_by_key = {}
    for act in data.get("activities", []):
        activity_id = act.get("activity_id")
        for c in segment_store.apply_overrides(activity_id, act.get("climbs", [])):
            k = f"{activity_id}:{int(round(c['start_distance_m']))}:{int(round(c['end_distance_m']))}"
            climbs_by_key[k] = {**c, "activity_id": activity_id, "activity_name": act.get("name"), "start_time": act.get("start_time")}

    results = []
    for k in member_keys:
        c = climbs_by_key.get(k)
        if not c:
            continue
        _apply_validated_names([c], validated)
        perf = _compute_climb_performance(c["activity_id"], c["start_distance_m"], c["end_distance_m"])
        results.append({**c, **perf})
    results.sort(key=lambda x: x.get("start_time") or "")
    return {"group_id": group_id, "count": len(results), "members": results}


def validate_climb_request(activity_id, start_distance_m, end_distance_m, name):
    """Validate the climb at the given range as a canonical named segment."""
    climbs = _find_activity_climbs(activity_id)
    climb = validated_store.find_climb(climbs, start_distance_m, end_distance_m)
    if climb is None:
        raise ValueError("No climb found at the given range in this activity")
    return validated_store.validate_climb(activity_id, climb, name)


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
    conn = _connect_db()
    if conn is None:
        return {"error": "not configured: set the activities database in Parameters"}
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
            SUM(CASE WHEN speed IS NOT NULL THEN 1 ELSE 0 END) AS speed_n,
            SUM(CASE WHEN altitude IS NOT NULL THEN 1 ELSE 0 END) AS altitude_n,
            SUM(CASE WHEN temperature IS NOT NULL THEN 1 ELSE 0 END) AS temperature_n
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
    _apply_validated_names(activity_climbs, validated_store.get_validated_list())

    devices = []
    try:
        garmin_db = config.GARMIN_DB
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
            "has_altitude": bool(counts["altitude_n"]),
            "has_temperature": bool(counts["temperature_n"]),
        },
        "laps": laps,
        "climbs": activity_climbs,
        "devices": devices,
    }


def get_activity_records(activity_id, fields_param, limit_param):
    conn = _connect_db()
    if conn is None:
        return []
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


IMPORTABLE_FILES = {
    "cols": ("cols.json", list),
    "segments": ("climb_segments.json", dict),
    "names": ("climb_names.json", dict),
    "validated": ("validated_climbs.json", dict),
}


def import_files(payload):
    """Copy user data files (cols, segments, names, validated climbs) from
    another install into this one. Only files given in the payload are
    imported; existing files here are overwritten after validation."""
    results = {}
    imported_any = False
    for key, (filename, expected_type) in IMPORTABLE_FILES.items():
        source = payload.get(key)
        if not source:
            continue
        src_path = Path(source).expanduser()
        if not src_path.is_absolute():
            return {"error": f"{key}: path must be absolute"}
        if not src_path.exists():
            return {"error": f"{key}: file not found ({src_path})"}
        try:
            data = json.loads(src_path.read_text(encoding="utf-8"))
        except Exception as exc:
            return {"error": f"{key}: not valid JSON ({exc})"}
        if expected_type is list and not isinstance(data, list):
            return {"error": f"{key}: expected a JSON list"}
        if expected_type is dict and not isinstance(data, dict):
            return {"error": f"{key}: expected a JSON object"}
        dest = Path(__file__).parent / filename
        dest.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        if isinstance(data, list):
            count = len(data)
        elif isinstance(data, dict):
            count = len(data)
        else:
            count = 0
        results[key] = {"from": str(src_path), "entries": count}
        imported_any = True
    if not imported_any:
        return {"error": "no files given"}
    # Segment overrides and validated names apply immediately; groups may
    # change, rebuild them so the UI is consistent.
    try:
        groups, mapping = climb_groups.build_groups(get_climbs_with_overrides(), validated_store.get_validated_list())
        climb_groups.save_groups(groups, mapping)
        results["groups"] = len(groups)
    except Exception as exc:
        results["groups_warning"] = str(exc)
    return {"imported": results}


def get_config_status():
    """Current config for the parameters page, plus data availability checks."""
    values = config.current_config()
    return {
        "values": values,
        "config_file": str(config.CONFIG_JSON),
        "config_file_exists": config.CONFIG_JSON.exists(),
        "paths": {
            "activities_db_exists": bool(config.ACTIVITIES_DB and config.ACTIVITIES_DB.exists()),
            "garmin_db_exists": bool(config.GARMIN_DB and config.GARMIN_DB.exists()),
            "fit_dir_exists": bool(config.FIT_DIR and config.FIT_DIR.is_dir()),
            "garmindb_cli_exists": bool(config.GARMINDB_CLI and config.GARMINDB_CLI.exists()),
        },
    }


def get_profile():
    conn = _connect_db()
    if conn is None:
        return {
            "athlete": {}, "devices": [],
            "all_time": {"rides": 0, "distance_km": 0, "moving_time_s": 0, "ascent_m": 0, "descent_m": 0, "climbs": 0},
            "ytd": {"rides": 0, "distance_km": 0, "ascent_m": 0},
            "last_30_days": {"rides": 0, "distance_km": 0, "ascent_m": 0},
        }
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
        garmin_db = config.GARMIN_DB
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


_sync_state = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "phase": None,
    "last_log": [],
    "result": None,
    "error": None,
}
_sync_lock = threading.Lock()


def _sync_log(phase, message):
    with _sync_lock:
        _sync_state["phase"] = phase
        _sync_state["last_log"] = (_sync_state["last_log"] + [message])[-30:]


def get_sync_status():
    with _sync_lock:
        return dict(_sync_state)


def start_sync():
    with _sync_lock:
        if _sync_state["running"]:
            return {"ok": True, "already_running": True, "status": dict(_sync_state)}
        _sync_state.update({
            "running": True,
            "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "finished_at": None,
            "phase": "starting",
            "kind": "sync",
            "last_log": [],
            "result": None,
            "error": None,
        })

    thread = threading.Thread(target=_run_sync_worker, daemon=True)
    thread.start()
    return {"ok": True, "started": True}


def _run_sync_worker():
    try:
        result = run_sync()
        with _sync_lock:
            _sync_state["running"] = False
            _sync_state["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            _sync_state["result"] = result
            _sync_state["phase"] = "done" if result.get("ok") else "failed"
    except Exception as exc:
        traceback.print_exc()
        with _sync_lock:
            _sync_state["running"] = False
            _sync_state["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            _sync_state["error"] = str(exc)
            _sync_state["phase"] = "failed"


# --- History scan / bulk download -------------------------------------------

_HISTORY_STATE = {
    "scanning": False,
    "scan_result": None,
    "scan_error": None,
    "scan_finished_at": None,
}


def _garmindb_interpreter():
    """Python interpreter of the configured GarminDB venv, or None."""
    if not config.GARMINDB_CLI or not config.GARMINDB_CLI.exists():
        return None
    venv_python = config.GARMINDB_CLI.parent / "python"
    return str(venv_python) if venv_python.exists() else sys.executable


def _run_scan_once():
    """Run the scan script, return its result dict or None on failure.
    Sets _HISTORY_STATE['scan_error'] on failure."""
    interp = _garmindb_interpreter()
    if not interp:
        _HISTORY_STATE["scan_error"] = "garmindb_cli not configured: cannot scan"
        return None
    try:
        proc = subprocess.run(
            [interp, str(Path(__file__).parent / "scan_garmin_history.py")],
            capture_output=True, text=True, timeout=120,
        )
        if proc.returncode != 0:
            _HISTORY_STATE["scan_error"] = (proc.stderr or proc.stdout or "scan failed")[-500:]
            return None
        data = json.loads(proc.stdout.strip().split("\n")[-1])
        if "error" in data:
            _HISTORY_STATE["scan_error"] = data["error"]
            return None
        return data
    except Exception as exc:
        _HISTORY_STATE["scan_error"] = str(exc)
        return None


def scan_history():
    """List the Garmin Connect activity history (no download) in background."""
    if _HISTORY_STATE["scanning"]:
        return {"ok": True, "already_running": True}
    if not _garmindb_interpreter():
        return {"ok": False, "error": "garmindb_cli not configured: cannot scan"}
    _HISTORY_STATE.update({"scanning": True, "scan_error": None})

    def worker():
        data = _run_scan_once()
        _HISTORY_STATE["scanning"] = False
        if data is not None:
            _HISTORY_STATE["scan_result"] = data
        _HISTORY_STATE["scan_finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "started": True}


def get_history_status():
    return dict(_HISTORY_STATE)


GARMINDB_CONFIG_FILE = Path.home() / ".GarminDb" / "GarminConnectConfig.json"


def start_history_download(count):
    """Download `count` more activities in the background.

    GarminDB walks the most recent `download_all_activities` activities and
    skips files already on disk. Setting the cap to (local + count) makes it
    walk only `count` activities beyond what is already downloaded. Requires
    a scan first (provides the local count); falls back to counting files in
    the GarminDB activities directory.
    """
    with _sync_lock:
        if _sync_state["running"]:
            return {"ok": True, "already_running": True, "status": dict(_sync_state)}
        if not config.GARMINDB_CLI or not config.GARMINDB_CLI.exists():
            return {"ok": False, "error": "garmindb_cli not configured"}

        try:
            gc_config = json.loads(GARMINDB_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception as exc:
            return {"ok": False, "error": f"could not read {GARMINDB_CONFIG_FILE}: {exc}"}

        scan = _HISTORY_STATE.get("scan_result") or {}
        local = scan.get("local")
        if not local:
            # No fresh scan result: run one synchronously (it takes seconds).
            _HISTORY_STATE["scanning"] = True
            result = _run_scan_once()
            _HISTORY_STATE["scanning"] = False
            _HISTORY_STATE["scan_finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            if result is None:
                return {"ok": False, "error": _HISTORY_STATE.get("scan_error") or "scan failed"}
            _HISTORY_STATE["scan_result"] = result
            local = result.get("local", 0)

        gc_config.setdefault("data", {})["download_all_activities"] = int(local) + int(count)
        GARMINDB_CONFIG_FILE.write_text(
            json.dumps(gc_config, indent=4, ensure_ascii=False), encoding="utf-8"
        )

        _sync_state.update({
            "running": True,
            "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "finished_at": None,
            "phase": "history-download",
            "kind": "history-download",
            "last_log": [f"bulk download: +{count} activities"],
            "result": None,
            "error": None,
        })

    def worker():
        try:
            result = run_sync(latest=False)
            with _sync_lock:
                _sync_state["running"] = False
                _sync_state["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                _sync_state["result"] = result
                _sync_state["phase"] = "done" if result.get("ok") else "failed"
        except Exception as exc:
            traceback.print_exc()
            with _sync_lock:
                _sync_state["running"] = False
                _sync_state["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                _sync_state["error"] = str(exc)
                _sync_state["phase"] = "failed"

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "started": True}


def run_sync(latest=None):
    """Download + import new activities via GarminDB, then refresh analysis.

    Runs in a background thread started by start_sync(). GarminDB keeps its own
    download state, but re-checks every activity against Garmin Connect, so a
    full pass takes minutes even when nothing is new.
    """
    if latest is None:
        latest = config.SYNC_LATEST
    if not config.ACTIVITIES_DB or not config.ACTIVITIES_DB.exists():
        return {"ok": False, "error": f"activities_db not found: {config.ACTIVITIES_DB}"}

    if config.GARMINDB_CLI and Path(config.GARMINDB_CLI).exists():
        cli = Path(config.GARMINDB_CLI)
        # Use the interpreter next to the CLI when it lives inside a venv.
        venv_python = cli.parent / "python"
        interpreter = str(venv_python) if venv_python.exists() else sys.executable
        cmd = [interpreter, str(cli), "--download", "--import", "--activities", "--analyze"]
        if latest:
            # Only fetch the most recent activities (config:
            # download_latest_activities in GarminConnectConfig.json) instead
            # of walking the entire history every sync.
            cmd.append("--latest")
        _sync_log("garmindb", "running " + " ".join(cmd))
        print("sync: running", " ".join(cmd), flush=True)
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        tail = []
        for line in proc.stdout:
            print("sync: garmindb:", line.rstrip(), flush=True)
            tail.append(line)
            tail = tail[-20:]
        proc.wait()
        if proc.returncode != 0:
            detail = "".join(tail)[-2000:]
            print("sync: garmindb failed:", detail, flush=True)
            _sync_log("failed", "garmindb download/import failed")
            return {"ok": False, "error": "garmindb download/import failed", "detail": detail}
        _sync_log("analysis", "garmindb done, analyzing climbs")
        print("sync: garmindb done", flush=True)
    elif config.GARMINDB_CLI:
        return {"ok": False, "error": f"garmindb_cli not found: {config.GARMINDB_CLI}"}
    else:
        # No CLI configured: just re-run analysis over existing DB contents.
        print("sync: no garmindb_cli configured, analyzing existing DB", flush=True)
        _sync_log("analysis", "no garmindb_cli configured, analyzing existing DB")

    # Snapshot previously analyzed activities before re-analyzing.
    prev_data = _load_climbs()
    old_ids = {a.get("activity_id") for a in prev_data.get("activities", [])}
    old_climb_count = sum(a.get("climb_count", 0) for a in prev_data.get("activities", []))

    # Incremental climb analysis then rebuild groups.
    _sync_log("analysis", "detecting climbs")
    analyze_climbs.main()
    _sync_log("groups", "grouping climbs")
    groups, mapping = climb_groups.build_groups(get_climbs_with_overrides(), validated_store.get_validated_list())
    climb_groups.save_groups(groups, mapping)

    new_data = _load_climbs()
    new_ids = {a.get("activity_id") for a in new_data.get("activities", [])}
    new_climb_count = sum(a.get("climb_count", 0) for a in new_data.get("activities", []))

    _sync_log("done", "sync complete")
    return {
        "ok": True,
        "new_activities": len(new_ids - old_ids),
        "total_activities": new_data.get("activity_count", len(new_ids)),
        "new_climbs": new_climb_count - old_climb_count,
        "total_climbs": new_climb_count,
        "groups": len(groups),
    }


if __name__ == "__main__":
    port = config.PORT
    print(f"Serving at http://127.0.0.1:{port}/")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
