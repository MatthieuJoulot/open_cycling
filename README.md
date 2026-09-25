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
```

The first `garmindb_cli.py` run fails with `Missing or bad config` until the config file exists. Create it:

```bash
mkdir -p ~/.GarminDb
cp ~/garmindb-venv/lib/python3.12/site-packages/garmindb/GarminConnectConfig.json.example ~/.GarminDb/GarminConnectConfig.json
open ~/.GarminDb/GarminConnectConfig.json
```

Edit the `credentials` section — replace the placeholders with your Garmin Connect email and password:

```json
"credentials": {
    "user": "your.email@example.com",
    "secure_password": false,
    "password": "your-garmin-password",
    "password_file": null
},
```

Everything else can stay as is. The downloaded data lands under `~/HealthData` by default — change `directories.base_dir` in the same file if you want it elsewhere (e.g. `"llm/bike/HealthData"` puts it at `~/llm/bike/HealthData`).

Then download and import your activities:

```bash
~/garmindb-venv/bin/garmindb_cli.py --download --import --activities
```

### 2. Configure this app

Start the server and configure from the UI — no file editing needed:

```bash
python3 serve.py
```

Open `http://127.0.0.1:8080`. With no rides found, the feed shows a **Configure** button that leads to the Parameters page. The only path you normally need is the **HealthData directory** from step 1 (`~/HealthData` by default): the database and FIT file paths are derived from it, and the page shows whether each path exists. Save, then restart the server.

Alternatively, create the file by hand:

```bash
cp config.example.json config.json
```

Edit `config.json` so `health_data_dir` points at your GarminDB data directory, and `garmindb_cli` at the CLI from step 1:

```json
{
  "health_data_dir": "~/HealthData",
  "garmindb_cli": "~/garmindb-venv/bin/garmindb_cli.py",
  "port": 8080,
  "sync_latest": true
}
```

The databases and files are expected at the standard GarminDB layout inside that directory:

- `DBs/garmin_activities.db` — activity summaries and records
- `DBs/garmin.db` — devices, monitoring
- `FitFiles/Activities` — downloaded FIT files
- `FitFiles/personal-information.json` — athlete profile

If your layout differs, the individual paths (`activities_db`, `garmin_db`, `fit_dir`, `personal_info_json`) override the derived ones; they are also editable under "Advanced paths" on the Parameters page.

Paths may start with `~`. Each value can also be overridden with environment variables (`CLIMB_ANALYZER_HEALTH_DATA_DIR`, `CLIMB_ANALYZER_GARMINDB_CLI`, …). Changes to the port require a server restart; other values are picked up on save.

### 3. Run

```bash
python3 serve.py
```

Open `http://127.0.0.1:8080`.

### Import from another installation

If you already ran the app elsewhere (or want a friend's curated cols list), the Parameters page has an **Import user data** section: give the path of a source `cols.json`, `climb_segments.json`, `climb_names.json`, or `validated_climbs.json` and it is copied into this installation. Files not given are skipped; the source is never modified.

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
