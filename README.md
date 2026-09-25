# Open Cycling

A local web app to detect, name, edit, and review cycling climbs from Garmin activities stored in a local GarminDB SQLite database.

## Features

- Detects climb segments from ride altitude data.
- Names climbs using a curated list of cols/passes and OpenStreetMap fallback.
- Groups equivalent climbs across activities.
- Shows activity feed, climb list, individual climb performance history, and segment editing on a map.
- Lets you modify or add segments manually and edit climb names.
- **Sync button**: downloads and imports new activities from Garmin Connect, then re-analyzes climbs — no command line needed.

## Requirements

- Python 3.10+ (standard library only, no pip packages needed for this app)
- [GarminDB](https://github.com/tgoessler/GarminDB) — syncs activities from Garmin Connect into SQLite. The sync button calls its CLI, so it must be installed and logged in beforehand.

## Installation

The repository is private; clone it with the GitHub CLI (or another authenticated method):

```bash
gh repo clone MatthieuJoulot/open_cycling
cd open_cycling
```

### 1. Install GarminDB (one time)

```bash
python3 -m venv ~/garmindb-venv
~/garmindb-venv/bin/pip install garmindb
# Authenticate with Garmin Connect (interactive, one time):
~/garmindb-venv/bin/garmindb_cli.py --download --import --activities
```

The first `garmindb_cli.py` run creates `~/.GarminDb/garminconnect.conf` — open it and add your Garmin username/password, then re-run. This first run also downloads your whole activity history into SQLite databases (location configurable in GarminDB's `~/.GarminDb/HealthData` config).

### 2. Configure this app

Start the server and configure from the UI — no file editing needed:

```bash
python3 serve.py
```

Open `http://127.0.0.1:8080`. With no rides found, the feed shows a **Configure** button that leads to the Parameters page: fill in the paths to your GarminDB data (the fields are pre-filled with sensible defaults and show whether each path exists), then save and restart the server.

Alternatively, create the file by hand:

```bash
cp config.example.json config.json
```

Edit `config.json` so the paths point to your GarminDB data and the garmindb CLI, e.g.:

```json
{
  "activities_db": "/path/to/HealthData/DBs/garmin_activities.db",
  "garmin_db": "/path/to/HealthData/DBs/garmin.db",
  "fit_dir": "/path/to/HealthData/FitFiles/Activities",
  "personal_info_json": "/path/to/HealthData/FitFiles/personal-information.json",
  "garmindb_cli": "/path/to/garmindb-venv/bin/garmindb_cli.py",
  "port": 8080,
  "sync_latest": true
}
```

Paths may start with `~`. Each value can also be overridden with environment variables (`CLIMB_ANALYZER_ACTIVITIES_DB`, `CLIMB_ANALYZER_GARMINDB_CLI`, …). Changes to the port require a server restart; other values are picked up on save.

### 3. Run

```bash
python3 serve.py
```

Open `http://127.0.0.1:8080`.

## First sync and later syncs

Both work the same way: click **"Sync new activities"** in the left sidebar.

The button:

1. Runs `garmindb_cli.py --download --import --activities --analyze --latest` (fetches the most recent activities from Garmin Connect; already-downloaded ones are skipped without a request).
2. Re-detects climbs — only rides not analyzed before are processed, so incremental syncs are fast.
3. Rebuilds climb groups.
4. Shows a toast with the number of new rides and new climbs.

With `sync_latest` (default `true` in `config.json`), GarminDB only walks the 25 most recent activities (`download_latest_activities` in `~/.GarminDb/GarminConnectConfig.json`) instead of the whole history, so a sync with nothing new takes ~1 minute. If you record more activities than that between two syncs — or want to bulk-import old history — set `"sync_latest": false` and run one full sync.

## Files

- `serve.py` — API and static file server (includes `/api/sync` + `/api/sync/status`).
- `analyze_climbs.py` — climb detection logic (incremental).
- `osm_lookup.py` — climb naming from curated list and OSM.
- `climb_groups.py` — grouping of equivalent climbs.
- `regions.py` — reverse geocoding of activity regions.
- `segment_store.py` — user-defined segment edits/additions.
- `config.py` / `config.example.json` — configuration layer.
- `web/` — frontend JavaScript and HTML.
- `cols.json` — curated cols/passes/saddles.
- `climbs.json`, `climb_groups.json`, `climb_names.json`, `climb_segments.json`, `cache/` — generated data (gitignored).

## License

MIT
