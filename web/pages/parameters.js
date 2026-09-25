import { fetchConfig, saveConfig } from '../utils/api.js';

export async function renderParameters() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="parameters-view" class="mx-auto" style="max-width: 720px;">
      <h4 class="mb-3">Parameters</h4>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Configuration</div>
        <div class="card-body">
          <p class="small text-muted">
            Saved to <code id="config-file-path"></code>. You can also edit this file directly and restart the server.
          </p>
          <form id="config-form">
            <div class="mb-3">
              <label class="form-label" for="cfg-activities_db">Activities database (SQLite)</label>
              <input class="form-control form-control-sm" id="cfg-activities_db" placeholder="~/llm/bike/HealthData/DBs/garmin_activities.db">
              <div class="form-text path-status" data-path="activities_db_exists"></div>
            </div>
            <div class="mb-3">
              <label class="form-label" for="cfg-garmin_db">Garmin database (SQLite)</label>
              <input class="form-control form-control-sm" id="cfg-garmin_db" placeholder="~/llm/bike/HealthData/DBs/garmin.db">
              <div class="form-text path-status" data-path="garmin_db_exists"></div>
            </div>
            <div class="mb-3">
              <label class="form-label" for="cfg-fit_dir">FIT files directory</label>
              <input class="form-control form-control-sm" id="cfg-fit_dir" placeholder="~/llm/bike/HealthData/FitFiles/Activities">
              <div class="form-text path-status" data-path="fit_dir_exists"></div>
            </div>
            <div class="mb-3">
              <label class="form-label" for="cfg-personal_info_json">Personal info JSON</label>
              <input class="form-control form-control-sm" id="cfg-personal_info_json" placeholder="~/llm/bike/HealthData/FitFiles/personal-information.json">
              <div class="form-text"></div>
            </div>
            <div class="mb-3">
              <label class="form-label" for="cfg-garmindb_cli">GarminDB CLI (optional)</label>
              <input class="form-control form-control-sm" id="cfg-garmindb_cli" placeholder="~/garmindb-venv/bin/garmindb_cli.py">
              <div class="form-text path-status" data-path="garmindb_cli_exists"></div>
            </div>
            <div class="form-check form-switch mb-3">
              <input class="form-check-input" type="checkbox" id="cfg-sync_latest">
              <label class="form-check-label" for="cfg-sync_latest">Fast sync (only fetch the latest activities; untick to walk the whole history)</label>
            </div>
            <button type="submit" class="btn btn-primary btn-sm" id="config-save-btn">Save configuration</button>
            <span id="config-saved-msg" class="text-success small ms-2 d-none">Saved ✓ — restart the server if you changed paths or the CLI.</span>
          </form>
        </div>
      </div>

      <p class="small text-muted">Server port is configured in <code id="config-port-hint"></code>; changing it requires a server restart.</p>
    </div>
  `;

  const status = await fetchConfig();
  const values = status.values || {};

  document.getElementById('config-file-path').textContent = status.config_file || 'config.json';
  document.getElementById('config-port-hint').textContent = status.config_file || 'config.json';

  const fields = ['activities_db', 'garmin_db', 'fit_dir', 'personal_info_json', 'garmindb_cli'];
  for (const f of fields) {
    document.getElementById('cfg-' + f).value = values[f] || '';
  }
  document.getElementById('cfg-sync_latest').checked = values.sync_latest !== false;

  for (const el of document.querySelectorAll('.path-status')) {
    const key = el.dataset.path;
    if (key in (status.paths || {})) {
      el.textContent = status.paths[key] ? '✓ found' : '⚠ not found';
      el.classList.add(status.paths[key] ? 'text-success' : 'text-warning');
    }
  }

  document.getElementById('config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('config-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const payload = {};
      for (const f of fields) {
        payload[f] = document.getElementById('cfg-' + f).value.trim();
      }
      payload.sync_latest = document.getElementById('cfg-sync_latest').checked;
      const updated = await saveConfig(payload);
      document.getElementById('config-saved-msg').classList.remove('d-none');
      applyPathStatus(updated);
    } catch (err) {
      alert(err.message || 'Could not save configuration');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save configuration';
    }
  });
}

function applyPathStatus(status) {
  for (const el of document.querySelectorAll('.path-status')) {
    const key = el.dataset.path;
    if (key in (status.paths || {})) {
      el.textContent = status.paths[key] ? '✓ found' : '⚠ not found';
      el.className = 'form-text path-status ' + (status.paths[key] ? 'text-success' : 'text-warning');
    }
  }
}
