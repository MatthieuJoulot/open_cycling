#!/usr/bin/env python3
"""Scan a Garmin Connect account without downloading activities.

Runs inside the GarminDB virtualenv (like garmindb_cli) and reuses its
saved login. Prints a JSON summary: total activities, per-year counts,
and how many of them are already present locally (in the GarminDB
activity files directory).
"""
import json
import os
import sys


def main():
    # Imported lazily: only available inside the GarminDB venv.
    from garmindb import GarminConnectConfigManager
    from garmindb.garmin_connect_auth_adapter import GarminConnectAuthAdapter

    gc_config = GarminConnectConfigManager()
    auth = GarminConnectAuthAdapter(gc_config)
    if not auth.login():
        print(json.dumps({"error": "Garmin Connect login failed"}))
        sys.exit(1)

    summaries = []
    start = 0
    search_url = "/activitylist-service/activities/search/activities"
    while True:
        page = auth.connectapi(search_url, params={"start": str(start), "limit": "100"})
        if not page:
            break
        summaries.extend(page)
        start += len(page)
        if len(page) < 100:
            break

    per_year = {}
    for s in summaries:
        year = (s.get("startTimeLocal") or s.get("startTimeGMT") or "")[:4]
        if year:
            per_year[year] = per_year.get(year, 0) + 1

    activities_dir = gc_config.get_activities_dir()
    local_ids = set()
    try:
        for name in os.listdir(activities_dir):
            if name.startswith("activity_") and name.endswith(".json"):
                local_ids.add(name[len("activity_"):-len(".json")])
    except Exception:
        pass

    have_local = sum(1 for s in summaries if str(s.get("activityId")) in local_ids)
    oldest = None
    if summaries:
        times = [s.get("startTimeLocal") or s.get("startTimeGMT") for s in summaries if s.get("startTimeLocal") or s.get("startTimeGMT")]
        if times:
            oldest = min(times)[:10]

    print(json.dumps({
        "total": len(summaries),
        "oldest": oldest,
        "per_year": per_year,
        "local": have_local,
        "missing": len(summaries) - have_local,
        "missing_by_year": {
            year: count - sum(
                1 for s in summaries
                if (s.get("startTimeLocal") or s.get("startTimeGMT") or "")[:4] == year
                and str(s.get("activityId")) in local_ids
            )
            for year, count in per_year.items()
        },
    }))


if __name__ == "__main__":
    main()
