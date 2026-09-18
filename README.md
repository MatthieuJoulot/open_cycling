# Climb Analyzer

A local web app to detect, name, edit, and review cycling climbs from Garmin activities stored in a local `garmin_activities.db` SQLite database.

## Features

- Detects climb segments from ride altitude data.
- Names climbs using a curated list of cols/passes and OpenStreetMap fallback.
- Groups equivalent climbs across activities.
- Shows activity feed, climb list, individual climb performance history, and segment editing on a map.
- Lets you modify or add segments manually and edit climb names.

## Requirements

- Python 3.10+
- A GarminDB SQLite database at `~/llm/bike/HealthData/DBs/garmin_activities.db`
- FIT files at `~/llm/bike/HealthData/FitFiles/Activities` (optional, for download)

## Installation

```bash
git clone <repo-url>
cd climb-analyzer
python3 -m venv venv
source venv/bin/activate
# No external Python dependencies needed beyond the standard library.
```

## Usage

1. Make sure your GarminDB database and FIT files are in the expected paths.
2. Regenerate climbs and groups after importing new activities:
   ```bash
   python3 regenerate.py
   ```
3. Start the server:
   ```bash
   python3 serve.py
   ```
4. Open `http://127.0.0.1:8080` in your browser.

## Files

- `serve.py` — API and static file server.
- `analyze_climbs.py` — climb detection logic.
- `osm_lookup.py` — climb naming from curated list and OSM.
- `climb_groups.py` — grouping of equivalent climbs.
- `regions.py` — reverse geocoding of activity regions.
- `segment_store.py` — user-defined segment edits/additions.
- `web/` — frontend JavaScript and HTML.
- `cols.json` — curated cols/passes/saddles.
- `climbs.json`, `climb_groups.json`, `climb_names.json`, `climb_segments.json`, `cache/` — generated data.

## License

MIT
