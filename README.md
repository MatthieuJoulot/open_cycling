# Open Sports Analysis

A local web app to analyze your Garmin activities — cycling, running and hiking — from a local GarminDB SQLite database: detect, name, edit and review climbs, per-sport statistics, best efforts, GPS heatmaps, 3D flyovers and training tracking.

## Features

- Detects climb segments from ride altitude data (FIETS categories: gain² / length).
- Names climbs using a curated list of cols/passes and OpenStreetMap fallback.
- Groups equivalent climbs across activities.
- Shows activity feed, climb list, individual climb performance history, and segment editing on a map.
- Lets you modify or add segments manually and edit climb names.
- **Two sync buttons**: **Fetch new activities** downloads and imports new rides from Garmin Connect; **Analyze activities** processes rides not yet analyzed and rebuilds climb groups — no command line needed.
- **Statistics pages per sport** (cycling, running, hiking, all): per-period summary (distance, elevation, time, calories), monthly distance/elevation and rides charts, activity calendar, records/best efforts, climb profile (VAM vs duration), HR vs pace for running (elapsed-based, breaks included), HR vs speed by road grade for cycling, own VO₂max estimates (running VDOT, cycling climb physics) with Garmin trend, weather correlation, year-over-year distance, training load charts.
- **Best efforts**: fastest time over fixed distances (1K, 1 mile, 5K, 10K … 100K), computed with a rolling window over ride records and filtered by period.
- **Climb map**: all your climbs on a map, colored by category, with popups linking to their history.
- **GPS heatmap**: every ridden/run/walked road as a thin track; overlapping activities accumulate opacity so frequent routes glow. Per-sport on each statistics page, plus the full cycling heatmap with basemap choice (ESRI gray or OpenTopoMap).
- **3D flyover**: terrain flyover of any ride with HUD (speed, altitude, climb badges, POI labels), in-browser video export.
- **PR deltas**: each climb attempt (climb page and ride page) is compared to your personal best on that climb — green when faster, red when slower.
- **Dark mode**: theme toggle in the navbar, persisted per browser.

## Requirements

- Python 3.10+ (standard library only, no pip packages needed for the core app)
- [GarminDB](https://github.com/tgoessler/GarminDB) — syncs activities from Garmin Connect into SQLite. **No need to install it beforehand**: it is installed in step 1 of the [Installation](#installation) below.
- For the **flyover video export** only (everything else works without them):
  - `playwright` Python package (`pip3 install playwright`) — drives an installed Google Chrome in headless mode (no browser download needed).
  - `ffmpeg` on the PATH — assembles the rendered frames into a video.
- Map libraries (Leaflet, MapLibre GL, Chart.js, Bootstrap) load from CDN in the browser; map and elevation tiles are fetched through the app's own caching proxy — no API keys required.

## Installation

Everything runs in a single conda environment — the app and GarminDB together.

Clone the repository:

```bash
gh repo clone MatthieuJoulot/open_sports_analysis
cd open_sports_analysis
```

### 1. Create the environment and install GarminDB (one time)

```bash
conda create -n opensports python=3.12 -y
conda activate opensports
pip install garmindb
```

The first `garmindb_cli.py` run fails with `Missing or bad config` until the config file exists. Create it:

```bash
mkdir -p ~/.GarminDb
cp "$(python -c "import garmindb, pathlib; print(pathlib.Path(garmindb.__file__).parent / 'GarminConnectConfig.json.example')")" ~/.GarminDb/GarminConnectConfig.json
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
garmindb_cli.py --download --import --activities
```

This fetches the **1000 most recent** activities (GarminDB's default `download_all_activities` cap). If your history goes back further, download the rest from the app: Parameters → **Download history** → *Scan Garmin Connect* shows what is missing and offers chunked downloads (by year, by 500, or everything) that run in the background.

### 2. Configure this app

Still in the `opensports` environment, start the server and configure from the UI — no file editing needed:

```bash
python backend/serve.py
```

Open `http://127.0.0.1:8080`. With no rides found, the feed shows a **Configure** button that leads to the Parameters page. The only path you normally need is the **HealthData directory** from step 1 (`~/HealthData` by default): the database and FIT file paths are derived from it, and the page shows whether each path exists. Save, then restart the server.

The app finds `garmindb_cli.py` automatically in the active environment, so the `garmindb_cli` config key normally stays empty.

Alternatively, create the file by hand:

```bash
cp config.example.json config.json
```

Edit `config.json` so `health_data_dir` points at your GarminDB data directory:

```json
{
  "health_data_dir": "~/HealthData",
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

Paths may start with `~`. Each value can also be overridden with environment variables (`OPEN_SPORTS_ANALYSIS_HEALTH_DATA_DIR`, `OPEN_SPORTS_ANALYSIS_GARMINDB_CLI`, …; the legacy `CLIMB_ANALYZER_*` names still work). Changes to the port require a server restart; other values are picked up on save.

### 3. Run

```bash
conda activate opensports
python backend/serve.py
```

Open `http://127.0.0.1:8080`.

### Segment databases

If you already ran the app elsewhere (or want a friend's curated cols list), the Parameters page has a **Segment databases** section: give the path of a source `cols.json`, `climb_segments.json`, `climb_names.json`, or `validated_climbs.json` and it is copied into this installation. Files not given are skipped; the source is never modified.

## First sync and later syncs

Two buttons in the left sidebar, run strictly in this order:

1. **⬇ Fetch new activities** — runs `garmindb_cli.py --download --import --activities --analyze --latest`: downloads the most recent activities from Garmin Connect and imports them (already-downloaded ones are skipped without a request). No analysis happens here.
2. **📊 Analyze activities** — processes rides not analyzed before (so incremental runs are fast) and rebuilds climb groups. Shows a toast with the number of new rides and new climbs.

With `sync_latest` (default `true` in `config.json`), the fetch only walks the 25 most recent activities (`download_latest_activities` in `~/.GarminDb/GarminConnectConfig.json`) instead of the whole history, so a fetch with nothing new takes ~1 minute. If you record more activities than that between two fetches — or want to bulk-import old history — set `"sync_latest": false` and run one full fetch, or use the chunked history downloads on the Parameters page (those run fetch + analysis together in the background).

## Files

- `backend/serve.py` — API and static file server (includes `/api/sync/fetch`, `/api/sync/analyze`, `/api/stats`, `/api/heatmap`).
- `backend/analyze_climbs.py` — climb detection logic (incremental).
- `backend/statistics.py` — statistics page backend, best efforts, per-ride temperature/altitude.
- `backend/osm_lookup.py` — climb naming from curated list and OSM.
- `backend/climb_groups.py` — grouping of equivalent climbs.
- `backend/regions.py` — reverse geocoding of activity regions.
- `backend/segment_store.py` — user-defined segment edits/additions.
- `backend/config.py` / `config.example.json` — configuration layer.
- `backend/` — Python server and analysis modules.
- `web/` — frontend JavaScript and HTML (pages: feed, climbs, climb, activity, statistics, training, wiki, parameters).
- `cols.json` — curated cols/passes/saddles.
- `climbs.json`, `climb_groups.json`, `climb_names.json`, `climb_segments.json`, `cache/` — generated data (gitignored).

## License

MIT — see [LICENSE](LICENSE).
