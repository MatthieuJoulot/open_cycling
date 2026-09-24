"""Group equivalent climbs across activities by geometry."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).parent
CLIMBS_JSON = ROOT / "climbs.json"
GROUPS_JSON = ROOT / "climb_groups.json"


def _haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _climb_key(activity_id, climb):
    return f"{activity_id}:{int(round(climb['start_distance_m']))}:{int(round(climb['end_distance_m']))}"


def climbs_match(a, b, start_tol=150, end_tol=150, length_tol=0.30, elevation_tol=0.30):
    """Return True if two climbs are the same real-world segment."""
    if any(a.get(k) is None or b.get(k) is None
           for k in ("start_lat", "start_lon", "end_lat", "end_lon")):
        return False
    start_dist = _haversine(a["start_lat"], a["start_lon"], b["start_lat"], b["start_lon"])
    if start_dist > start_tol:
        return False
    end_dist = _haversine(a["end_lat"], a["end_lon"], b["end_lat"], b["end_lon"])
    if end_dist > end_tol:
        return False
    if a["length_m"] and b["length_m"]:
        min_len = min(a["length_m"], b["length_m"])
        max_len = max(a["length_m"], b["length_m"])
        if max_len == 0 or (max_len - min_len) / max_len > length_tol:
            return False
    if a["elevation_gain_m"] and b["elevation_gain_m"]:
        min_elev = min(a["elevation_gain_m"], b["elevation_gain_m"])
        max_elev = max(a["elevation_gain_m"], b["elevation_gain_m"])
        if max_elev == 0 or (max_elev - min_elev) / max_elev > elevation_tol:
            return False
    return True


def build_groups(climbs_data, start_tol=150, end_tol=150, length_tol=0.30, elevation_tol=0.30):
    """Group climbs and return (groups, climb_key_to_group_id)."""
    climbs = []
    for act in climbs_data.get("activities", []):
        for c in act.get("climbs", []):
            c = {
                **c,
                "activity_id": act["activity_id"],
                "activity_name": act.get("name"),
                "start_time": act.get("start_time"),
                "key": _climb_key(act["activity_id"], c),
            }
            if all(c.get(k) is not None for k in ("start_lat", "start_lon", "end_lat", "end_lon")):
                climbs.append(c)

    groups = []
    key_to_group = {}

    for c in climbs:
        matched_group = None
        for idx, grp in enumerate(groups):
            if climbs_match(grp["template"], c, start_tol, end_tol, length_tol, elevation_tol):
                matched_group = idx
                break
        if matched_group is None:
            group_id = f"g{len(groups)}"
            groups.append({
                "group_id": group_id,
                "template": c,
                "members": [c],
            })
            key_to_group[c["key"]] = group_id
        else:
            groups[matched_group]["members"].append(c)
            key_to_group[c["key"]] = groups[matched_group]["group_id"]

    return groups, key_to_group


def save_groups(groups, mapping):
    data = {
        "groups": {g["group_id"]: [m["key"] for m in g["members"]] for g in groups},
        "key_to_group": mapping,
    }
    GROUPS_JSON.write_text(json.dumps(data, indent=2), encoding="utf-8")


def load_groups():
    if not GROUPS_JSON.exists():
        return None
    return json.loads(GROUPS_JSON.read_text(encoding="utf-8"))


def ensure_groups():
    if GROUPS_JSON.exists():
        return load_groups()
    climbs_data = json.loads(CLIMBS_JSON.read_text(encoding="utf-8"))
    groups, mapping = build_groups(climbs_data)
    save_groups(groups, mapping)
    return load_groups()


if __name__ == "__main__":
    ensure_groups()
    data = load_groups()
    print(f"Built {len(data['groups'])} groups from {len(data['key_to_group'])} climbs")
