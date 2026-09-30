"""Curated database of famous road climbs for the Explore page.

Seed list built by hand (name + col coordinates + elevation). Geometry
(start-to-col track) is enriched from OpenStreetMap on demand: named
roads within a radius of the col are chained into plausible approach
tracks, cached in cache/climb_db.json. Climbed status is matched against
the user's own detected climbs (climbs.json occurrences) by proximity of
the col point to any ridden track point.
"""
import json
import math
import time
from pathlib import Path

import osm_lookup

ROOT = Path(__file__).parent.parent
DB_CACHE = ROOT / "cache" / "climb_db.json"

# name, country, region, lat, lon (col point), elevation (m)
CURATED = [
    # --- Provence / Ventoux ---
    ("Mont Ventoux (Chalet Reynard)", "FR", "Provence", 44.1715, 5.2765, 1617),
    ("Mont Ventoux (Bédoin)", "FR", "Provence", 44.1715, 5.2765, 1909),
    ("Mont Ventoux (Malaucène)", "FR", "Provence", 44.1715, 5.2765, 1909),
    ("Mont Ventoux (Sault)", "FR", "Provence", 44.1715, 5.2765, 1909),
    ("Col de Mène", "FR", "Provence", 43.9069, 6.3422, 803),
    # --- Northern Alps ---
    ("Alpe d'Huez", "FR", "Isère", 45.0913, 6.0697, 1850),
    ("Col du Galibier", "FR", "Savoie/Hautes-Alpes", 45.0575, 6.4086, 2642),
    ("Col de la Croix de Fer", "FR", "Savoie/Isère", 45.2103, 6.2453, 2067),
    ("Col du Glandon", "FR", "Savoie/Isère", 45.3311, 6.2561, 1924),
    ("Col de la Madeleine", "FR", "Savoie", 45.4328, 6.3858, 2000),
    ("Col de l'Iseran", "FR", "Savoie", 45.4172, 7.0303, 2770),
    ("Col du Télégraphe", "FR", "Savoie", 45.1392, 6.8725, 1566),
    ("Col du Chaussy", "FR", "Savoie", 45.5383, 6.5247, 1533),
    ("Col de la Croix Fry", "FR", "Haute-Savoie", 45.9069, 6.3711, 1477),
    ("Col de la Forclaz", "FR", "Haute-Savoie", 45.8658, 6.4486, 1157),
    ("Col des Aravis", "FR", "Haute-Savoie", 45.8892, 6.4472, 1486),
    ("Col de la Colombière", "FR", "Haute-Savoie", 45.9869, 6.4306, 1613),
    ("Col de Joux Plane", "FR", "Haute-Savoie", 46.1617, 6.6397, 1691),
    ("Col de la Ramaz", "FR", "Haute-Savoie", 46.1372, 6.5372, 1619),
    ("Col des Montets", "FR", "Haute-Savoie", 46.0206, 6.9128, 1461),
    ("Col de la Forclaz (Martigny side)", "CH", "Valais", 46.0431, 7.0228, 1528),
    # --- Southern Alps ---
    ("Col d'Izoard", "FR", "Hautes-Alpes", 44.8233, 6.7378, 2361),
    ("Col d'Agnel", "FR/IT", "Hautes-Alpes", 44.6828, 6.9628, 2744),
    ("Col de Vars", "FR", "Hautes-Alpes", 44.9161, 6.7283, 2108),
    ("Col de la Bonette", "FR", "Alpes-Maritimes", 44.3244, 6.8719, 2715),
    ("Col de la Cayolle", "FR", "Alpes-Maritimes", 44.2689, 6.9917, 2326),
    ("Col de la Lombarde", "FR/IT", "Alpes-Maritimes", 44.1297, 7.2953, 2350),
    ("Col de Turini", "FR", "Alpes-Maritimes", 43.9886, 7.4067, 1607),
    ("Col de Braus", "FR", "Alpes-Maritimes", 43.8661, 7.4472, 1002),
    ("Col de la Madone", "FR", "Alpes-Maritimes", 43.7808, 7.4739, 933),
    # --- Pyrenees ---
    ("Col du Tourmalet", "FR", "Hautes-Pyrénées", 42.9083, 0.1447, 2115),
    ("Col d'Aubisque", "FR", "Pyrénées-Atlantiques", 42.9658, -0.5633, 1709),
    ("Col du Soulor", "FR", "Pyrénées-Atlantiques", 42.9803, -0.4747, 1474),
    ("Col de Pailhères", "FR", "Ariège", 42.6442, 1.7469, 2001),
    ("Port de Lers", "FR", "Ariège", 42.7222, 1.4286, 1517),
    ("Col de Port", "FR", "Ariège", 42.7583, 1.7069, 1249),
    ("Col de Peyresourde", "FR", "Haute-Garonne", 42.7933, 0.5242, 1569),
    ("Col d'Aspin", "FR", "Hautes-Pyrénées", 42.9233, 0.2719, 1489),
    ("Col de Menté", "FR", "Haute-Garonne", 42.9194, 0.8419, 1349),
    ("Col du Portet", "FR", "Hautes-Pyrénées", 42.8700, 0.2483, 2215),
    ("Col de Spandelles", "FR", "Hautes-Pyrénées", 42.9519, -0.0819, 1364),
    ("Hautacam", "FR", "Hautes-Pyrénées", 42.9683, -0.0947, 1520),
    ("Col de Marie-Blanque", "FR", "Pyrénées-Atlantiques", 43.0483, -0.5681, 1035),
    ("Port de Larrau", "FR", "Pyrénées-Atlantiques", 42.8339, -0.9236, 1573),
    # --- Jura ---
    ("Col de la Faucille", "FR", "Jura", 46.3992, 6.0208, 1323),
    ("Col de la Biche", "FR", "Jura", 46.3161, 5.7733, 1395),
    ("Grand Colombier", "FR", "Ain", 45.9411, 5.6469, 1501),
    ("Col du Marchairuz", "FR", "Jura", 46.5589, 6.2358, 1369),
    # --- Vosges ---
    ("Grand Ballon", "FR", "Vosges", 47.8725, 7.0278, 1336),
    ("Col de la Schlucht", "FR", "Vosges", 48.0508, 7.0194, 1139),
    ("Col du Markstein", "FR", "Vosges", 47.9133, 7.0219, 1180),
    ("Col du Donon", "FR", "Vosges", 48.4889, 7.0958, 961),
    # --- Massif Central / other ---
    ("Puy de Dôme", "FR", "Puy-de-Dôme", 45.7764, 2.9611, 1465),
    ("Col du Pré", "FR", "Savoie", 45.6342, 6.4817, 1703),
    ("Plateau des Glières", "FR", "Haute-Savoie", 45.9269, 6.2869, 1450),
    ("Col de Semnoz", "FR", "Haute-Savoie", 45.8039, 6.1033, 1655),
    ("Mont Revard", "FR", "Savoie", 45.6428, 5.9600, 1547),
    ("Cormet de Roselend", "FR", "Savoie", 45.6875, 6.4686, 1968),
    ("Col de l'Épine", "FR", "Savoie", 45.6075, 5.8697, 1118),
    ("Col du Granier", "FR", "Savoie", 45.5383, 5.8431, 1134),
    ("Col de Plainpalais", "FR", "Savoie", 45.6492, 5.9217, 1178),
    # --- Italy classics ---
    ("Passo dello Stelvio", "IT", "Lombardia", 46.5283, 10.4542, 2758),
    ("Passo Gavia", "IT", "Lombardia", 46.3294, 10.4906, 2621),
    ("Passo del Mortirolo", "IT", "Lombardia", 46.2389, 10.1894, 1852),
    ("Passo Pordoi", "IT", "Dolomites", 46.5161, 11.8386, 2239),
    ("Passo Fedaia", "IT", "Dolomites", 46.4394, 11.8669, 2057),
    ("Passo Giau", "IT", "Dolomites", 46.6083, 12.0486, 2236),
    # --- Belgium/Flanders & Ardennes ---
    ("Mur de Huy", "BE", "Wallonia", 50.5289, 5.2208, 148),
    ("Côte de La Redoute", "BE", "Wallonia", 50.4875, 5.7936, 240),
    ("Koppenberg", "BE", "Flanders", 50.8311, 3.5756, 70),
    ("Paterberg", "BE", "Flanders", 50.7889, 3.3967, 60),
    ("Oude Kwaremont", "BE", "Flanders", 50.7764, 3.4311, 90),
    # --- Switzerland ---
    ("Furkapass", "CH", "Uri", 46.5897, 8.3978, 2431),
    ("Grimselpass", "CH", "Bern", 46.5631, 8.3336, 2168),
    ("Sustenpass", "CH", "Bern/Uri", 46.6997, 8.4383, 2224),
    ("Albulapass", "CH", "Graubünden", 46.5439, 9.8342, 2315),
    ("Oberalppass", "CH", "Graubünden", 46.6564, 8.6742, 2044),
    ("Col du Sanetsch", "CH", "Valais", 46.3292, 7.3286, 2252),
    ("Kreuzbergpass", "CH", "Graubünden", 46.6808, 9.7914, 2365),
]


def _load():
    try:
        return json.loads(DB_CACHE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(data):
    DB_CACHE.parent.mkdir(parents=True, exist_ok=True)
    DB_CACHE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p)
         * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def get_database():
    """Full climb database: curated entries + enrichment cache."""
    cache = _load()
    entries = []
    for i, (name, country, region, lat, lon, ele) in enumerate(CURATED):
        cid = f"db{i}"
        rich = (cache.get("enriched") or {}).get(cid) or {}
        entries.append({
            "id": cid,
            "name": name,
            "country": country,
            "region": region,
            "lat": lat,
            "lon": lon,
            "ele": ele,
            "geometry": rich.get("geometry"),
        })
    return {"climbs": entries}


def enrich_climb(cid):
    """Fetch approach-road geometry near a climb's col point via Overpass.

    Queries named highways within ~3 km of the col and returns the longest
    connected chain of segments as the climb track (approximation: the
    real climb geometry would need per-side routing; good enough for the
    explore map).
    """
    db = get_database()
    climb = next(c for c in db["climbs"] if c["id"] == cid)
    lat, lon = climb["lat"], climb["lon"]
    margin = 0.02    # ~2.2 km
    q = f"""
    [out:json][timeout:60];
    way["highway"]["name"]({lat - margin},{lon - margin},{lat + margin},{lon + margin});
    out geom 400;
    """
    result = osm_lookup._overpass(q)
    ways = []
    for el in result.get("elements", []):
        geom = [[g["lat"], g["lon"]] for g in el.get("geometry", [])]
        if len(geom) >= 2:
            ways.append({
                "name": el.get("tags", {}).get("name"),
                "geometry": geom,
            })
    if not ways:
        return None

    # Longest way as the representative track (famous cols usually have
    # their climb road as the longest named way in the bbox).
    ways.sort(key=lambda w: -len(w["geometry"]))
    best = ways[0]

    cache = _load()
    cache.setdefault("enriched", {})[cid] = {
        "geometry": [[round(p[0], 6), round(p[1], 6)] for p in best["geometry"]],
        "road_name": best["name"],
        "fetched_at": time.time(),
    }
    _save(cache)
    return cache["enriched"][cid]


def match_climbed(col_lat, col_lon, threshold_m=300):
    """Has the user ridden within `threshold_m` of this col point?

    Scans climbs.json occurrences' climb start/end coordinates.
    Returns {climbed, first_time, times} or None.
    """
    climbs_path = ROOT / "climbs.json"
    try:
        data = json.loads(climbs_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    times = []
    for act in data.get("activities", []):
        for c in act.get("climbs", []):
            matched = False
            for skey, ekey in (("start_lat", "start_lon"), ("end_lat", "end_lon")):
                if c.get(skey) is None or c.get(ekey) is None:
                    continue
                if _haversine_m(col_lat, col_lon, c[skey], c[ekey]) <= threshold_m:
                    times.append(act.get("start_time"))
                    matched = True
                    break
            if matched:
                break
    if not times:
        return None
    times = sorted(t for t in times if t)
    return {"climbed": True, "first_time": times[0], "times": len(times)}
