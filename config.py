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


def current_config():
    """Config values as shown in the UI (raw strings, unexpanded)."""
    return {key: _cfg[key] for key in DEFAULTS}


def save_config(values):
    """Write a subset of config keys to config.json and reload."""
    allowed = set(DEFAULTS) - {"port"}  # port changes need a server restart
    updates = {k: v for k, v in values.items() if k in allowed}
    existing = {}
    if CONFIG_JSON.exists():
        try:
            existing = json.loads(CONFIG_JSON.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    existing.update(updates)
    CONFIG_JSON.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    global _cfg, ACTIVITIES_DB, GARMIN_DB, FIT_DIR, PERSONAL_INFO_JSON, GARMINDB_CLI, SYNC_LATEST
    _cfg = _load()
    ACTIVITIES_DB = _expand(_cfg["activities_db"])
    GARMIN_DB = _expand(_cfg["garmin_db"])
    FIT_DIR = _expand(_cfg["fit_dir"])
    PERSONAL_INFO_JSON = _expand(_cfg["personal_info_json"])
    GARMINDB_CLI = Path(_cfg["garmindb_cli"]).expanduser() if _cfg["garmindb_cli"] else None
    SYNC_LATEST = bool(_cfg["sync_latest"])
