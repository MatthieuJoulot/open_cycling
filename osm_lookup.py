"""Look up climb names from OpenStreetMap and cache results locally."""
import json
import math
import os
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
CACHE_DIR = ROOT / "cache"
OSM_RESPONSES_CACHE = CACHE_DIR / "osm_responses.json"
CLIMB_NAMES_FILE = ROOT / "climb_names.json"
CURATED_COLS_FILE = ROOT / "cols.json"

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
USER_AGENT = "ClimbAnalyzer/1.0 (local; contact via github)"


def _load_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default if default is not None else {}


def _save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _project_scalar(lat, lon, lat1, lon1, lat2, lon2):
    """Return the projection factor t of point (lat,lon) onto segment p1-p2 (0..1)."""
    x = math.radians(lon)
    y = math.radians(lat)
    x1 = math.radians(lon1)
    y1 = math.radians(lat1)
    x2 = math.radians(lon2)
    y2 = math.radians(lat2)
    dx = x2 - x1
    dy = y2 - y1
    denom = dx * dx + dy * dy
    if denom == 0:
        return 0
    return max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / denom))


def _point_to_segment_distance(lat, lon, lat1, lon1, lat2, lon2):
    """Haversine distance from a point to the closest point on a segment."""
    t = _project_scalar(lat, lon, lat1, lon1, lat2, lon2)
    lat_i = lat1 + t * (lat2 - lat1)
    lon_i = lon1 + t * (lon2 - lon1)
    return _haversine(lat, lon, lat_i, lon_i)


MINOR_ROADS = {
    "residential", "tertiary", "tertiary_link", "unclassified", "service",
    "track", "path", "cycleway", "footway", "living_street", "road",
}


_OSM_CACHE = _load_json(OSM_RESPONSES_CACHE, default={})
_DISABLE_OSM_CACHE_SAVE = os.environ.get("CLIMB_ANALYZER_NO_CACHE_SAVE") == "1"


def flush_osm_cache():
    """Write the in-memory OSM response cache to disk."""
    _save_json(OSM_RESPONSES_CACHE, _OSM_CACHE)


def _overpass(query):
    """Run an Overpass query with a tiny cache, fallback endpoints, and polite delay."""
    key = query.strip()
    if key in _OSM_CACHE:
        return _OSM_CACHE[key]

    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    result = None
    last_error = None
    for url in OVERPASS_URLS:
        time.sleep(0.5)
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "User-Agent": USER_AGENT,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8")
            parsed = json.loads(text)
            if "elements" in parsed:
                result = parsed
                break
            last_error = parsed.get("remark", parsed)
        except Exception as exc:
            last_error = exc

    if result is None:
        result = {"error": str(last_error), "elements": []}
        # Do not cache errors; let the next try succeed.
        return result

    _OSM_CACHE[key] = result
    if not _DISABLE_OSM_CACHE_SAVE:
        _save_json(OSM_RESPONSES_CACHE, _OSM_CACHE)
    return result


def _bbox(lat1, lon1, lat2, lon2, margin=0.005):
    """Return a small bounding box around two points (degrees)."""
    lat_min = min(lat1, lat2) - margin
    lat_max = max(lat1, lat2) + margin
    lon_min = min(lon1, lon2) - margin
    lon_max = max(lon1, lon2) + margin
    return lat_min, lon_min, lat_max, lon_max


def _node_kind(tags):
    if tags.get("mountain_pass") == "yes":
        return "mountain_pass", None
    if tags.get("natural") in ("peak", "saddle"):
        return tags.get("natural"), None
    if tags.get("place"):
        return f"place:{tags.get('place')}", None
    for key in ("shop", "amenity", "tourism", "historic", "leisure"):
        if tags.get(key):
            return f"poi:{key}", tags.get(key)
    return "node", None


def _point_features_in_bbox(lat_min, lon_min, lat_max, lon_max):
    """Query OSM for named cols, peaks, saddles, places, and POIs in a bbox (no roads)."""
    query = f"""
    [bbox:{lat_min},{lon_min},{lat_max},{lon_max}][out:json][timeout:15];
    (
      node["name"]["mountain_pass"="yes"];
      node["name"]["natural"="peak"];
      node["name"]["natural"="saddle"];
      node["name"]["place"];
      node["name"]["shop"];
      node["name"]["amenity"];
      node["name"]["tourism"];
      node["name"]["historic"];
      node["name"]["leisure"];
    );
    out center tags;
    """
    result = _overpass(query)
    features = []
    for elem in result.get("elements", []):
        tags = elem.get("tags", {})
        name = tags.get("name", "").strip()
        if not name:
            continue
        if elem["type"] == "node":
            lat = elem.get("lat")
            lon = elem.get("lon")
            kind, poi_type = _node_kind(tags)
        elif elem["type"] == "way":
            center = elem.get("center")
            if not center:
                continue
            lat = center["lat"]
            lon = center["lon"]
            kind = "roundabout" if tags.get("junction") == "roundabout" else "road"
            poi_type = None
        else:
            continue
        features.append({
            "name": name,
            "lat": lat,
            "lon": lon,
            "kind": kind,
            "poi_type": poi_type,
            "ele": tags.get("ele"),
            "highway": tags.get("highway"),
        })
    return features


def _features_in_bbox(lat_min, lon_min, lat_max, lon_max):
    """Query OSM for named point features and road centers inside a bbox."""
    query = f"""
    [bbox:{lat_min},{lon_min},{lat_max},{lon_max}][out:json][timeout:20];
    (
      node["name"]["mountain_pass"="yes"];
      node["name"]["natural"="peak"];
      node["name"]["natural"="saddle"];
      node["name"]["place"];
      node["name"]["shop"];
      node["name"]["amenity"];
      node["name"]["tourism"];
      node["name"]["historic"];
      node["name"]["leisure"];
      way["name"]["highway"];
    );
    out center tags;
    """
    result = _overpass(query)
    features = []
    for elem in result.get("elements", []):
        tags = elem.get("tags", {})
        name = tags.get("name", "").strip()
        if not name:
            continue
        if elem["type"] == "node":
            lat = elem.get("lat")
            lon = elem.get("lon")
            kind, poi_type = _node_kind(tags)
        elif elem["type"] == "way":
            center = elem.get("center")
            if not center:
                continue
            lat = center["lat"]
            lon = center["lon"]
            kind = "roundabout" if tags.get("junction") == "roundabout" else "road"
            poi_type = None
        else:
            continue
        features.append({
            "name": name,
            "lat": lat,
            "lon": lon,
            "kind": kind,
            "poi_type": poi_type,
            "ele": tags.get("ele"),
            "highway": tags.get("highway"),
        })
    return features


def _road_ways_in_bbox(lat_min, lon_min, lat_max, lon_max):
    """Query OSM for named highway ways with geometry inside a bbox."""
    features, ways = _features_and_roads_in_bbox(lat_min, lon_min, lat_max, lon_max)
    return ways


def _features_and_roads_in_bbox(lat_min, lon_min, lat_max, lon_max):
    """Single Overpass query for named point features and named highway ways."""
    query = f"""
    [bbox:{lat_min},{lon_min},{lat_max},{lon_max}][out:json][timeout:25];
    (
      node["name"]["mountain_pass"="yes"];
      node["name"]["natural"="peak"];
      node["name"]["natural"="saddle"];
      node["name"]["place"];
      node["name"]["shop"];
      node["name"]["amenity"];
      node["name"]["tourism"];
      node["name"]["historic"];
      node["name"]["leisure"];
      way["name"]["highway"];
    );
    out geom tags;
    """
    result = _overpass(query)
    features = []
    ways = []
    for elem in result.get("elements", []):
        tags = elem.get("tags", {})
        name = tags.get("name", "").strip()
        if not name:
            continue
        if elem["type"] == "node":
            kind, poi_type = _node_kind(tags)
            features.append({
                "name": name,
                "lat": elem.get("lat"),
                "lon": elem.get("lon"),
                "kind": kind,
                "poi_type": poi_type,
                "ele": tags.get("ele"),
                "highway": tags.get("highway"),
            })
        elif elem["type"] == "way":
            geom = elem.get("geometry", [])
            if len(geom) < 2:
                continue
            points = [(p["lat"], p["lon"]) for p in geom]
            ways.append({
                "name": name,
                "highway": tags.get("highway"),
                "points": points,
            })
    return features, ways


def _nearest_roads(lat, lon, ways, threshold=100):
    """Return list of (name, highway, distance) for named roads within threshold metres of a point."""
    hits = {}
    for w in ways:
        pts = w["points"]
        best = float("inf")
        for i in range(len(pts) - 1):
            d = _point_to_segment_distance(lat, lon, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
            if d < best:
                best = d
        if best <= threshold:
            key = (w["name"], w["highway"])
            if key not in hits or best < hits[key][2]:
                hits[key] = (w["name"], w["highway"], best)
    return sorted(hits.values(), key=lambda x: x[2])


def _climb_key(activity_id, climb):
    start = int(round(climb["start_distance_m"]))
    end = int(round(climb["end_distance_m"]))
    return f"{activity_id}:{start}:{end}"


def _sample_points(climb, n=5):
    """Return (lat, lon) points along the climb."""
    points = []
    start_lat = climb.get("start_lat")
    start_lon = climb.get("start_lon")
    end_lat = climb.get("end_lat")
    end_lon = climb.get("end_lon")
    if None in (start_lat, start_lon, end_lat, end_lon):
        return points
    for i in range(n):
        t = i / (n - 1) if n > 1 else 0
        lat = start_lat + (end_lat - start_lat) * t
        lon = start_lon + (end_lon - start_lon) * t
        points.append((lat, lon))
    return points


def suggest_name(climb):
    """Suggest a name for a climb using OSM."""
    start_lat = climb.get("start_lat")
    start_lon = climb.get("start_lon")
    end_lat = climb.get("end_lat")
    end_lon = climb.get("end_lon")
    if None in (start_lat, start_lon, end_lat, end_lon):
        return {"name": None, "source": None}

    lat_min, lon_min, lat_max, lon_max = _bbox(start_lat, start_lon, end_lat, end_lon)
    features = _features_in_bbox(lat_min, lon_min, lat_max, lon_max)
    if not features:
        return {"name": None, "source": None}

    mid_lat = (start_lat + end_lat) / 2
    mid_lon = (start_lon + end_lon) / 2

    # Prefer named peaks/passes/saddles close to the climb.
    mountain = [f for f in features if f["kind"] != "road"]
    if mountain:
        for f in mountain:
            f["distance"] = _haversine(mid_lat, mid_lon, f["lat"], f["lon"])
        mountain.sort(key=lambda f: f["distance"])
        best = mountain[0]
        return {"name": best["name"], "source": f"osm_{best['kind']}", "distance_m": round(best["distance"])}

    # Fall back to the nearest named road.
    roads = [f for f in features if f["kind"] == "road"]
    for f in roads:
        f["distance"] = _haversine(mid_lat, mid_lon, f["lat"], f["lon"])
    roads.sort(key=lambda f: f["distance"])
    if roads:
        best = roads[0]
        return {"name": best["name"], "source": "osm_road", "distance_m": round(best["distance"])}

    return {"name": None, "source": None}


def _name_from_features_top(climb, features):
    """Match by the climb's top/end point rather than its midpoint."""
    end_lat = climb.get("end_lat")
    end_lon = climb.get("end_lon")
    start_lat = climb.get("start_lat")
    start_lon = climb.get("start_lon")
    if None in (end_lat, end_lon) or not features:
        return {"name": None, "source": None}

    mountain = []
    roads = []
    for f in features:
        dist_end = _haversine(end_lat, end_lon, f["lat"], f["lon"])
        dist_start = _haversine(start_lat, start_lon, f["lat"], f["lon"])
        f = {**f, "distance": min(dist_end, dist_start)}
        if f["kind"] != "road":
            mountain.append(f)
        else:
            roads.append(f)

    MOUNTAIN_THRESHOLD = 600  # metres
    ROAD_THRESHOLD = 1500

    def _mountain_score(kind):
        return {"mountain_pass": 3, "saddle": 2, "peak": 1}.get(kind, 0)

    if mountain:
        mountain.sort(key=lambda f: (-_mountain_score(f["kind"]), f["distance"]))
        best = mountain[0]
        if best["distance"] <= MOUNTAIN_THRESHOLD:
            return {"name": best["name"], "source": f"osm_top_{best['kind']}", "distance_m": round(best["distance"])}

    if roads:
        roads.sort(key=lambda f: f["distance"])
        best = roads[0]
        if best["distance"] <= ROAD_THRESHOLD:
            return {"name": best["name"], "source": "osm_top_road", "distance_m": round(best["distance"])}

    return {"name": None, "source": None}


def _load_curated_cols():
    return _load_json(CURATED_COLS_FILE, default=[])


def suggest_curated_name(climb):
    """Match the climb top/end to a local list of known cols."""
    end_lat = climb.get("end_lat")
    end_lon = climb.get("end_lon")
    start_lat = climb.get("start_lat")
    start_lon = climb.get("start_lon")
    if None in (end_lat, end_lon):
        return {"name": None, "source": None}

    cols = _load_curated_cols()
    if not cols:
        return {"name": None, "source": None}

    best = None
    best_dist = float("inf")
    for c in cols:
        d_end = _haversine(end_lat, end_lon, c["lat"], c["lon"])
        d_start = _haversine(start_lat, start_lon, c["lat"], c["lon"])
        d = min(d_end, d_start)
        if d < best_dist:
            best_dist = d
            best = c

    THRESHOLD = 600
    if best and best_dist <= THRESHOLD:
        return {"name": best["name"], "source": "curated_col", "distance_m": round(best_dist)}
    return {"name": None, "source": None}


def suggest_name_top(climb):
    """OSM-based name suggestion using the climb top/end point."""
    start_lat = climb.get("start_lat")
    start_lon = climb.get("start_lon")
    end_lat = climb.get("end_lat")
    end_lon = climb.get("end_lon")
    if None in (start_lat, start_lon, end_lat, end_lon):
        return {"name": None, "source": None}

    lat_min, lon_min, lat_max, lon_max = _bbox(start_lat, start_lon, end_lat, end_lon)
    features = _features_in_bbox(lat_min, lon_min, lat_max, lon_max)
    if not features:
        return {"name": None, "source": None}
    return _name_from_features_top(climb, features)


def _place_score(kind):
    place_type = kind.split(":", 1)[1] if kind.startswith("place:") else ""
    scores = {
        "city": 6, "town": 5, "village": 4, "suburb": 3,
        "quarter": 2, "neighbourhood": 2, "hamlet": 2,
        "locality": 1, "isolated_dwelling": 1, "farm": 1,
    }
    return scores.get(place_type, 0)


def _is_usable_place(kind):
    place_type = kind.split(":", 1)[1] if kind.startswith("place:") else ""
    return place_type in {
        "city", "town", "village", "suburb", "quarter", "neighbourhood",
        "hamlet", "locality", "isolated_dwelling", "farm",
    }


SKIP_POI_TYPES = {
    "information", "board", "guidepost", "parking", "bicycle_parking",
    "post_box", "waste_basket", "recycling", "telephone", "toilets",
}


def _start_name(climb, features, road_ways=None, col_name=None):
    """Return a precise human label for the climb start location."""
    start_lat = climb.get("start_lat")
    start_lon = climb.get("start_lon")
    if start_lat is None or start_lon is None or (not features and not road_ways):
        return None

    col_name_lower = (col_name or "").lower()

    def _conflicts(name):
        n = name.lower()
        return n == col_name_lower or (col_name_lower and col_name_lower in n)

    if road_ways:
        roads = _nearest_roads(start_lat, start_lon, road_ways, threshold=80)
        roads = [r for r in roads if not _conflicts(r[0])]
        if len(roads) >= 2:
            names = []
            seen = set()
            for r in roads:
                if r[0].lower() not in seen:
                    seen.add(r[0].lower())
                    names.append(r[0])
                if len(names) == 2:
                    break
            if len(names) == 2:
                return f"intersection {names[0]} et {names[1]}"
        if len(roads) == 1 and roads[0][1] in MINOR_ROADS and roads[0][2] <= 50:
            return roads[0][0]

    nearest_roundabout = None
    nearest_roundabout_dist = float("inf")
    nearest_poi = None
    nearest_poi_dist = float("inf")
    nearest_road_200 = None
    nearest_road_200_dist = float("inf")
    nearest_road_400 = None
    nearest_road_400_dist = float("inf")
    best_place = None
    best_place_score = -1
    best_place_dist = float("inf")

    for f in features:
        d = _haversine(start_lat, start_lon, f["lat"], f["lon"])
        kind = f.get("kind", "")
        name = f["name"]
        if _conflicts(name):
            continue
        if kind == "roundabout" and d < nearest_roundabout_dist:
            nearest_roundabout_dist = d
            nearest_roundabout = name
        elif kind.startswith("poi:"):
            if f.get("poi_type") in SKIP_POI_TYPES:
                continue
            if d < nearest_poi_dist:
                nearest_poi_dist = d
                nearest_poi = name
        elif kind == "road":
            if d < nearest_road_200_dist:
                nearest_road_200_dist = d
                nearest_road_200 = name
            if d < nearest_road_400_dist:
                nearest_road_400_dist = d
                nearest_road_400 = name
        elif kind.startswith("place:") and _is_usable_place(kind):
            score = _place_score(kind)
            within = 2000 if score >= 4 else 1000
            if d > within:
                continue
            if score > best_place_score or (score == best_place_score and d < best_place_dist):
                best_place = name
                best_place_score = score
                best_place_dist = d

    if nearest_roundabout and nearest_roundabout_dist <= 200:
        return nearest_roundabout
    if nearest_road_200 and nearest_road_200_dist <= 200:
        return nearest_road_200
    if nearest_poi and nearest_poi_dist <= 150:
        return nearest_poi
    if nearest_road_400 and nearest_road_400_dist <= 400:
        return nearest_road_400
    if best_place:
        return best_place
    return None


def _combine_name(col_name, start_name):
    if col_name and start_name:
        return f"{col_name} depuis {start_name}"
    return col_name or start_name or None


def suggest_name_full(climb, features=None, road_ways=None, col_method="curated_then_top"):
    """Suggest a combined name: col/peak/saddle + start location.

    col_method options:
      - "curated_then_top": curated col first, OSM-top fallback
      - "top": OSM-top only
      - "curated": curated only
      - "mid": original midpoint OSM matching
    """
    start_lat = climb.get("start_lat")
    start_lon = climb.get("start_lon")
    end_lat = climb.get("end_lat")
    end_lon = climb.get("end_lon")
    if None in (start_lat, start_lon, end_lat, end_lon):
        return {"name": None, "source": None}

    if features is None or road_ways is None:
        lat_min, lon_min, lat_max, lon_max = _bbox(start_lat, start_lon, end_lat, end_lon)
        features, road_ways = _features_and_roads_in_bbox(lat_min, lon_min, lat_max, lon_max)

    col = None
    if col_method == "curated_then_top":
        col = suggest_curated_name(climb)
        if not col.get("name"):
            col = _name_from_features_top(climb, features)
    elif col_method == "top":
        col = _name_from_features_top(climb, features)
    elif col_method == "curated":
        col = suggest_curated_name(climb)
    else:
        col = _name_from_features(climb, features)

    col_name = col.get("name") if col else None
    start = _start_name(climb, features, road_ways=road_ways, col_name=col_name)
    full = _combine_name(col_name, start)
    if full:
        return {
            "name": full,
            "source": f"{col.get('source','unknown')}+start" if col and col.get("name") else "start_label",
            "col": col_name,
            "start": start,
        }
    return {"name": None, "source": None}


def load_climb_names():
    return _load_json(CLIMB_NAMES_FILE, default={})


def _save_climb_names(names):
    _save_json(CLIMB_NAMES_FILE, names)


def get_name(activity_id, climb, suggest=True):
    """Return the stored or suggested name for a climb."""
    key = _climb_key(activity_id, climb)
    names = load_climb_names()
    entry = names.get(key)
    if entry:
        return entry
    if not suggest:
        return {"name": None, "source": None}

    suggestion = suggest_name_full(climb, col_method="curated_then_top")
    if suggestion.get("name"):
        names[key] = {**suggestion, "activity_id": activity_id, "start_distance_m": climb["start_distance_m"], "end_distance_m": climb["end_distance_m"]}
        _save_climb_names(names)
    return suggestion


def _activity_bbox(climbs, margin=0.01):
    lats = []
    lons = []
    for c in climbs:
        for key in ("start_lat", "end_lat"):
            v = c.get(key)
            if v is not None:
                lats.append(v)
        for key in ("start_lon", "end_lon"):
            v = c.get(key)
            if v is not None:
                lons.append(v)
    if not lats or not lons:
        return None
    return (min(lats) - margin, min(lons) - margin, max(lats) + margin, max(lons) + margin)


def _name_from_features(climb, features):
    start_lat = climb.get("start_lat")
    start_lon = climb.get("start_lon")
    end_lat = climb.get("end_lat")
    end_lon = climb.get("end_lon")
    if None in (start_lat, start_lon, end_lat, end_lon) or not features:
        return {"name": None, "source": None}

    mid_lat = (start_lat + end_lat) / 2
    mid_lon = (start_lon + end_lon) / 2

    mountain = []
    roads = []
    for f in features:
        dist = _haversine(mid_lat, mid_lon, f["lat"], f["lon"])
        f = {**f, "distance": dist}
        if f["kind"] != "road":
            mountain.append(f)
        else:
            roads.append(f)

    MOUNTAIN_THRESHOLD = 600  # metres
    ROAD_THRESHOLD = 1500  # metres

    if mountain:
        mountain.sort(key=lambda f: f["distance"])
        best = mountain[0]
        if best["distance"] <= MOUNTAIN_THRESHOLD:
            return {"name": best["name"], "source": f"osm_{best['kind']}", "distance_m": round(best["distance"])}

    if roads:
        roads.sort(key=lambda f: f["distance"])
        best = roads[0]
        if best["distance"] <= ROAD_THRESHOLD:
            return {"name": best["name"], "source": "osm_road", "distance_m": round(best["distance"])}

    return {"name": None, "source": None}


def suggest_names_for_activity(activity_id, climbs):
    """Suggest combined col+start names for all climbs in an activity."""
    if not climbs:
        return {}

    bbox = _activity_bbox(climbs)
    if not bbox:
        return {}

    features, road_ways = _features_and_roads_in_bbox(*bbox)
    names = load_climb_names()
    suggestions = {}

    for c in climbs:
        key = _climb_key(activity_id, c)
        if key in names and names[key].get("source") == "manual":
            suggestions[key] = names[key]
            continue
        suggestion = suggest_name_full(c, features, road_ways, col_method="curated_then_top")
        if suggestion.get("name"):
            entry = {
                **suggestion,
                "activity_id": activity_id,
                "start_distance_m": c["start_distance_m"],
                "end_distance_m": c["end_distance_m"],
            }
            names[key] = entry
            suggestions[key] = entry
        else:
            suggestions[key] = {"name": None, "source": None}
            if key in names and not names[key].get("source") == "manual":
                del names[key]

    _save_climb_names(names)
    return suggestions


def get_names(activity_id, climbs, suggest=True):
    """Return name entries for every climb in an activity."""
    names = load_climb_names()
    result = {}
    missing = []
    for c in climbs:
        key = _climb_key(activity_id, c)
        if key in names:
            result[key] = names[key]
        else:
            result[key] = {"name": None, "source": None}
            missing.append(c)

    if suggest and missing:
        suggestions = suggest_names_for_activity(activity_id, missing)
        for key, entry in suggestions.items():
            result[key] = entry

    return result


def set_manual_name(activity_id, climb, name):
    key = _climb_key(activity_id, climb)
    names = load_climb_names()
    names[key] = {
        "name": name.strip(),
        "source": "manual",
        "activity_id": activity_id,
        "start_distance_m": climb["start_distance_m"],
        "end_distance_m": climb["end_distance_m"],
    }
    _save_climb_names(names)
    return names[key]


def refresh_names_for_activity(activity_id, climbs):
    """Remove stale non-manual names and suggest names for current climbs."""
    names = load_climb_names()
    keep_keys = {_climb_key(activity_id, c) for c in climbs}
    stale = [k for k, v in names.items()
             if v.get("activity_id") == activity_id and k not in keep_keys and v.get("source") != "manual"]
    for k in stale:
        del names[k]
    _save_climb_names(names)
    return suggest_names_for_activity(activity_id, climbs)


def find_climb(activity_id, climbs, start_distance_m, end_distance_m):
    for c in climbs:
        if c["start_distance_m"] == start_distance_m and c["end_distance_m"] == end_distance_m:
            return c
    return None
