"""Reverse-geocode activity start coordinates to a region name and cache results."""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
CACHE_DIR = ROOT / "cache"
REGIONS_CACHE = CACHE_DIR / "regions.json"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "ClimbAnalyzer/1.0 (local; contact via github)"


def _load_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default if default is not None else {}


def _save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _coord_key(lat, lon):
    return f"{round(lat, 2)}:{round(lon, 2)}"


def _extract_region(address):
    for key in ("state", "county", "region", "state_district", "province"):
        value = address.get(key)
        if value:
            return value
    return address.get("country", "Unknown")


def get_region(lat, lon):
    cache = _load_json(REGIONS_CACHE, default={})
    key = _coord_key(lat, lon)
    if key in cache:
        return cache[key]

    time.sleep(1.0)
    query = urllib.parse.urlencode({
        "lat": lat,
        "lon": lon,
        "format": "json",
        "zoom": 10,
        "addressdetails": 1,
    })
    req = urllib.request.Request(
        f"{NOMINATIM_URL}?{query}",
        headers={"User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        region = _extract_region(data.get("address", {}))
    except Exception as exc:
        region = f"Unknown ({exc})"

    cache[key] = region
    _save_json(REGIONS_CACHE, cache)
    return region


def get_activity_regions():
    climbs_data = _load_json(ROOT / "climbs.json", default={"activities": []})
    regions = {}
    for act in climbs_data.get("activities", []):
        lat = act.get("start_lat")
        lon = act.get("start_lon")
        if lat is not None and lon is not None:
            regions[act["activity_id"]] = get_region(lat, lon)
    return regions


def get_climb_regions():
    activity_regions = get_activity_regions()
    climbs_data = _load_json(ROOT / "climbs.json", default={"activities": []})
    result = {}
    for act in climbs_data.get("activities", []):
        activity_id = act["activity_id"]
        region = activity_regions.get(activity_id, "Unknown")
        for c in act.get("climbs", []):
            key = f"{activity_id}:{int(round(c['start_distance_m']))}:{int(round(c['end_distance_m']))}"
            result[key] = region
    return result


if __name__ == "__main__":
    print(len(get_activity_regions()), "activity regions cached")
