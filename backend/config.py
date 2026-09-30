"""Central configuration: config.json + environment overrides.

Most users only need `health_data_dir` (the GarminDB data directory,
e.g. ~/HealthData): the database and file paths are derived from it.
Each derived path can still be set explicitly to override the default
layout.
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONFIG_JSON = ROOT / "config.json"

DEFAULTS = {
    "health_data_dir": "",
    "activities_db": "",
    "garmin_db": "",
    "fit_dir": "",
    "personal_info_json": "",
    "garmindb_cli": "",
    "media_dir": "",
    "port": 8080,
    "sync_latest": True,
}

ENV_VARS = {
    "health_data_dir": "CLIMB_ANALYZER_HEALTH_DATA_DIR",
    "activities_db": "CLIMB_ANALYZER_ACTIVITIES_DB",
    "garmin_db": "CLIMB_ANALYZER_GARMIN_DB",
    "fit_dir": "CLIMB_ANALYZER_FIT_DIR",
    "personal_info_json": "CLIMB_ANALYZER_PERSONAL_INFO",
    "garmindb_cli": "CLIMB_ANALYZER_GARMINDB_CLI",
    "media_dir": "CLIMB_ANALYZER_MEDIA_DIR",
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


def _resolve(cfg):
    """Return effective (resolved) paths, deriving from health_data_dir."""
    base = _expand(cfg["health_data_dir"])
    derived = {
        "activities_db": base / "DBs" / "garmin_activities.db" if base else None,
        "garmin_db": base / "DBs" / "garmin.db" if base else None,
        "fit_dir": base / "FitFiles" / "Activities" if base else None,
        "personal_info_json": base / "FitFiles" / "personal-information.json" if base else None,
    }
    # Explicit settings override the derived defaults.
    for key in derived:
        if cfg.get(key):
            derived[key] = _expand(cfg[key])
    return derived


_cfg = _load()
_paths = _resolve(_cfg)

ACTIVITIES_DB = _paths["activities_db"]
GARMIN_DB = _paths["garmin_db"]
FIT_DIR = _paths["fit_dir"]
PERSONAL_INFO_JSON = _paths["personal_info_json"]
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
    global _cfg, _paths, ACTIVITIES_DB, GARMIN_DB, FIT_DIR, PERSONAL_INFO_JSON, GARMINDB_CLI, SYNC_LATEST
    _cfg = _load()
    _paths = _resolve(_cfg)
    ACTIVITIES_DB = _paths["activities_db"]
    GARMIN_DB = _paths["garmin_db"]
    FIT_DIR = _paths["fit_dir"]
    PERSONAL_INFO_JSON = _paths["personal_info_json"]
    GARMINDB_CLI = Path(_cfg["garmindb_cli"]).expanduser() if _cfg["garmindb_cli"] else None
    SYNC_LATEST = bool(_cfg["sync_latest"])
