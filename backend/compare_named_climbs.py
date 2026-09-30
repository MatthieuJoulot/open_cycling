#!/usr/bin/env python3
"""Compare OSM midpoint, OSM top, and curated col naming for selected activities."""
import json
from pathlib import Path
from osm_lookup import (
    _features_in_bbox,
    _road_ways_in_bbox,
    _activity_bbox,
    suggest_name_full,
)

ROOT = Path(__file__).parent.parent
CLIMBS_JSON = ROOT / "climbs.json"

SELECTED_ACTIVITY_IDS = [
    "23573007930",
    "22822976105",
    "22810812177",
    "20607292269",
    "23594900796",
]


def main():
    data = json.loads(CLIMBS_JSON.read_text(encoding="utf-8"))
    by_id = {str(a["activity_id"]): a for a in data.get("activities", [])}

    for aid in SELECTED_ACTIVITY_IDS:
        act = by_id.get(aid)
        if not act:
            print(f"\n=== {aid}: NOT FOUND ===")
            continue
        climbs = act.get("climbs", [])
        print(f"\n=== {aid} – {act.get('name')} ({len(climbs)} climbs) ===")
        if not climbs:
            continue

        bbox = _activity_bbox(climbs)
        features = _features_in_bbox(*bbox) if bbox else []
        road_ways = _road_ways_in_bbox(*bbox) if bbox else []

        rows = []
        for c in climbs:
            primary = suggest_name_full(c, features, road_ways, col_method="curated_then_top")
            top = suggest_name_full(c, features, road_ways, col_method="top")
            curated = suggest_name_full(c, features, road_ways, col_method="curated")
            rows.append((
                int(c.get("length_m", 0)),
                c.get("avg_grade_percent", 0),
                primary.get("name") or "–",
                top.get("name") or "–",
                curated.get("name") or "–",
                primary.get("start") or "–",
            ))

        print(f"{'len(m)':>8} {'grade':>6} {'curated+top':<55} {'top only':<55} {'curated only':<55} {'start label':<30}")
        for length, grade, primary, top, curated, start in rows:
            print(f"{length:>8} {grade:>6.1f}% {primary:<55} {top:<55} {curated:<55} {start:<30}")


if __name__ == "__main__":
    main()
