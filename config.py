"""Central configuration: config.json + environment overrides."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).parent
CONFIG_JSON = ROOT / "config.json"

DEFAULTS = {
    "activities_db": "~/llm/bike/HealthData/DBs/garmin_activities.db",
    "garmin_db": "~/llm/bike/HealthData/DBs/garmin.db",
    "fit_dir": "~/llm/bike/HealthData/FitFiles/Activities",
    "personal_info_json": "~/llm/bike/HealthData/FitFiles/personal-information.json",
    "garmindb_cli": "",
    "port": 8080,
    "sync_latest": True,
}

ENV_VARS = {
    "activities_db": "CLIMB_ANALYZER_ACTIVITIES_DB",
    "garmin_db": "CLIMB_ANALYZER_GARMIN_DB",
    "fit_dir": "CLIMB_ANALYZER_FIT_DIR",
    "personal_info_json": "CLIMB_ANALYZER_PERSONAL_INFO",
    "garmindb_cli": "CLIMB_ANALYZER_GARMINDB_CLI",
    "port": "CLIMB_ANALYZER_PORT",
}


def _expand(path):
    return Path(path).expanduser().resolve() if path else None


def _load():
    values = dict(DEFAULTS)
    if CONFIG_JSON.exists():
        try:
            values.update(json.loads(CONFIG_JSON.read_text(encoding="utf-8")))
        except Exception as exc:
            print(f"Warning: could not parse {CONFIG_JSON}: {exc}")
    for key, env in ENV_VARS.items():
        if os.environ.get(env):
            values[key] = os.environ[env]
    return values


_cfg = _load()

ACTIVITIES_DB = _expand(_cfg["activities_db"])
GARMIN_DB = _expand(_cfg["garmin_db"])
FIT_DIR = _expand(_cfg["fit_dir"])
PERSONAL_INFO_JSON = _expand(_cfg["personal_info_json"])
GARMINDB_CLI = Path(_cfg["garmindb_cli"]).expanduser() if _cfg["garmindb_cli"] else None
PORT = int(_cfg["port"])
SYNC_LATEST = bool(_cfg["sync_latest"])
