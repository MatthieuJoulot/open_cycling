"""Group equivalent climbs across activities by geometry."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).parent.parent
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


def build_groups(climbs_data, validated=None, start_tol=150, end_tol=150, length_tol=0.30, elevation_tol=0.30):
    """Group climbs and return (groups, climb_key_to_group_id).

    When `validated` (a list of validated climb entries) is given, every
    climb matching a validated entry is forced into that entry's group:
    validation is the strongest signal that two segments are the same
    real-world climb, and it wins over the geometric matching below.
    """
    validated = validated or []
    validated_groups = {}
    next_vg = 0

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
            climbs.append(c)

    groups = []
    key_to_group = {}

    # First pass: seed one group per validated climb, keyed by climb_id.
    vg_key_to_group = {}
    for v in validated:
        if v.get("climb_id") in validated_groups:
            continue
        group_id = f"g{len(groups)}"
        groups.append({
            "group_id": group_id,
            "template": v,
            "members": [],
        })
        validated_groups[v["climb_id"]] = group_id

    # Second pass: assign each climb, validated matches first.
    for c in climbs:
        assigned = False
        for v in validated:
            if climbs_match(v, c, start_tol, end_tol, length_tol, elevation_tol):
                gid = validated_groups[v["climb_id"]]
                groups[int(gid[1:])]["members"].append(c)
                key_to_group[c["key"]] = gid
                assigned = True
                break
        if assigned:
            continue
        matched_group = None
        for idx, grp in enumerate(groups):
            if grp["template"].get("climb_id") in validated_groups:
                continue
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

    # Drop validated groups that matched nothing (shouldn't happen, but be safe).
    groups = [g for g in groups if g["members"] or g["template"].get("climb_id") not in validated_groups]

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


def _climbs_data_with_overrides(climbs_data):
    """Return climbs data with segment edits and validated names applied,
    mirroring what /api/climbs serves."""
    import segment_store
    import validated_store
    data = json.loads(json.dumps(climbs_data))  # deep copy; don't mutate caller's
    validated = validated_store.get_validated_list()
    for act in data.get("activities", []):
        activity_id = act.get("activity_id")
        climbs = segment_store.apply_overrides(activity_id, act.get("climbs", []))
        validated_store.apply_validated_names(climbs, validated)
        act["climbs"] = climbs
    return data


def ensure_groups():
    """Load groups, rebuilding when stale.

    Groups go stale when climbs.json gains activities (after a sync) or when
    segment edits change climb bounds: saved keys no longer match what the
    API serves. Rebuild when the saved mapping doesn't cover the current
    overridden climb keys.
    """
    climbs_data = _climbs_data_with_overrides(json.loads(CLIMBS_JSON.read_text(encoding="utf-8")))
    current_keys = set()
    for act in climbs_data.get("activities", []):
        activity_id = act.get("activity_id")
        for climb in act.get("climbs", []):
            current_keys.add(_climb_key(activity_id, climb))

    if GROUPS_JSON.exists():
        data = load_groups()
        if set(data.get("key_to_group", {})) == current_keys:
            return data
        stale = set(data.get("key_to_group", {})) - current_keys
        print(f"climb groups stale ({len(current_keys)} current keys, "
              f"{len(stale)} orphaned); rebuilding")
    import validated_store
    groups, mapping = build_groups(climbs_data, validated_store.get_validated_list())
    save_groups(groups, mapping)
    return load_groups()


if __name__ == "__main__":
    ensure_groups()
    data = load_groups()
    print(f"Built {len(data['groups'])} groups from {len(data['key_to_group'])} climbs")
