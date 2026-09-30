#!/usr/bin/env python3
"""Regenerate climb_names.json using the combined curated+OSM naming."""
import json
import math
import os
import sys
from pathlib import Path

os.environ["CLIMB_ANALYZER_NO_CACHE_SAVE"] = "1"

from osm_lookup import (
    _point_features_in_bbox,
    _road_ways_in_bbox,
    suggest_name_full,
    load_climb_names,
    _save_climb_names,
    flush_osm_cache,
)

ROOT = Path(__file__).parent.parent
CLIMBS_JSON = ROOT / "climbs.json"


def _entry(c, suggestion, activity_id):
    return {
        **suggestion,
        "activity_id": activity_id,
        "start_distance_m": c["start_distance_m"],
        "end_distance_m": c["end_distance_m"],
    }


def _climb_bbox(c, margin_deg=0.005):
    lat_min = min(c["start_lat"], c["end_lat"]) - margin_deg
    lat_max = max(c["start_lat"], c["end_lat"]) + margin_deg
    lon_min = min(c["start_lon"], c["end_lon"]) - margin_deg
    lon_max = max(c["start_lon"], c["end_lon"]) + margin_deg
    return (lat_min, lon_min, lat_max, lon_max)


def _start_bbox(lat, lon, radius_m=250):
    lat_m = 111320
    lon_m = 111320 * math.cos(math.radians(lat))
    margin_lat = radius_m / lat_m
    margin_lon = radius_m / lon_m
    return (lat - margin_lat, lon - margin_lon, lat + margin_lat, lon + margin_lon)


def main():
    data = json.loads(CLIMBS_JSON.read_text(encoding="utf-8"))

    names = load_climb_names()
    manual = {k: v for k, v in names.items() if v.get("source") == "manual"}
    _save_climb_names(manual)
    print(f"Preserved {len(manual)} manual names.", flush=True)

    all_climbs = []
    for act in data.get("activities", []):
        for c in act.get("climbs", []):
            key = f"{act['activity_id']}:{int(round(c['start_distance_m']))}:{int(round(c['end_distance_m']))}"
            all_climbs.append((key, act["activity_id"], c))

    names.clear()
    names.update(manual)
    print(f"Processing {len(all_climbs)} climbs...", flush=True)

    # First pass: per-climb point features only (small bbox, fast).
    col_keys = []
    for idx, (key, aid, c) in enumerate(all_climbs):
        if key in manual:
            continue
        bbox = _climb_bbox(c)
        features = _point_features_in_bbox(*bbox)
        suggestion = suggest_name_full(c, features, road_ways=[], col_method="curated_then_top")
        if suggestion.get("name"):
            names[key] = _entry(c, suggestion, aid)
            if suggestion.get("col"):
                col_keys.append((key, aid, c))
        if (idx + 1) % 50 == 0 or idx == len(all_climbs) - 1:
            print(f"  first pass {idx + 1}/{len(all_climbs)} done", flush=True)

    # Second pass: precise intersection start labels for climbs with a named col.
    print(f"Refining start labels for {len(col_keys)} named-col climbs...", flush=True)
    for idx, (key, aid, c) in enumerate(col_keys):
        bbox = _start_bbox(c["start_lat"], c["start_lon"], radius_m=250)
        road_ways = _road_ways_in_bbox(*bbox)
        # Re-fetch point features for this climb to feed into suggest_name_full.
        features = _point_features_in_bbox(*_climb_bbox(c))
        suggestion = suggest_name_full(c, features, road_ways, col_method="curated_then_top")
        if suggestion.get("name"):
            names[key] = _entry(c, suggestion, aid)
        if (idx + 1) % 10 == 0 or idx == len(col_keys) - 1:
            print(f"  second pass {idx + 1}/{len(col_keys)} done", flush=True)

    _save_climb_names(names)
    flush_osm_cache()
    print(f"Finished. {len(names)} names stored ({len(manual)} manual).", flush=True)


if __name__ == "__main__":
    main()
