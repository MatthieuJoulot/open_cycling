import { fetchConfig, saveConfig, importFiles } from '../utils/api.js';

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
              <label class="form-label" for="cfg-health_data_dir">HealthData directory (GarminDB data)</label>
              <input class="form-control form-control-sm text-muted" id="cfg-health_data_dir" placeholder="/path/to/HealthData">
              <div class="form-text">The database and file paths are derived from it (DBs/ and FitFiles/ inside).</div>
            </div>
            <div class="mb-3">
              <label class="form-label" for="cfg-garmindb_cli">GarminDB CLI (optional)</label>
              <input class="form-control form-control-sm text-muted" id="cfg-garmindb_cli" placeholder="/path/to/garmindb_cli.py">
              <div class="form-text path-status" data-path="garmindb_cli_exists"></div>
            </div>
            <div class="form-check form-switch mb-3">
              <input class="form-check-input" type="checkbox" id="cfg-sync_latest">
              <label class="form-check-label" for="cfg-sync_latest">Fast sync (only fetch the latest activities; untick to walk the whole history)</label>
            </div>

            <a class="small text-decoration-none" data-bs-toggle="collapse" href="#advanced-paths" role="button">Advanced paths</a>
            <div class="collapse mt-2" id="advanced-paths">
              <p class="small text-muted mb-2">Set these only if your layout differs from the standard GarminDB structure.</p>
              <div class="mb-3">
                <label class="form-label small" for="cfg-activities_db">Activities database (SQLite)</label>
                <input class="form-control form-control-sm text-muted" id="cfg-activities_db" placeholder="derived from HealthData directory">
                <div class="form-text path-status" data-path="activities_db_exists"></div>
              </div>
              <div class="mb-3">
                <label class="form-label small" for="cfg-garmin_db">Garmin database (SQLite)</label>
                <input class="form-control form-control-sm text-muted" id="cfg-garmin_db" placeholder="derived from HealthData directory">
                <div class="form-text path-status" data-path="garmin_db_exists"></div>
              </div>
              <div class="mb-3">
                <label class="form-label small" for="cfg-fit_dir">FIT files directory</label>
                <input class="form-control form-control-sm text-muted" id="cfg-fit_dir" placeholder="derived from HealthData directory">
                <div class="form-text path-status" data-path="fit_dir_exists"></div>
              </div>
              <div class="mb-3">
                <label class="form-label small" for="cfg-personal_info_json">Personal info JSON</label>
                <input class="form-control form-control-sm text-muted" id="cfg-personal_info_json" placeholder="derived from HealthData directory">
              </div>
            </div>

            <div class="mt-3">
              <button type="submit" class="btn btn-primary btn-sm" id="config-save-btn">Save configuration</button>
              <span id="config-saved-msg" class="text-success small ms-2 d-none">Saved ✓ — restart the server if you changed paths or the CLI.</span>
            </div>
          </form>
        </div>
      </div>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Import user data</div>
        <div class="card-body">
          <p class="small text-muted mb-2">
            Copy a curated cols list, your segment edits, climb names, or validated climbs from another installation.
            Give the path of the source file (e.g. <code>/path/to/other/install/cols.json</code>); it is copied here, the source is untouched.
          </p>
          <form id="import-form">
            <div class="row g-2">
              <div class="col-md-6">
                <label class="form-label small">Cols list (cols.json)</label>
                <input class="form-control form-control-sm text-muted" id="imp-cols" placeholder="/path/to/cols.json">
              </div>
              <div class="col-md-6">
                <label class="form-label small">Segment edits (climb_segments.json)</label>
                <input class="form-control form-control-sm text-muted" id="imp-segments" placeholder="/path/to/climb_segments.json">
              </div>
              <div class="col-md-6">
                <label class="form-label small">Climb names (climb_names.json)</label>
                <input class="form-control form-control-sm text-muted" id="imp-names" placeholder="/path/to/climb_names.json">
              </div>
              <div class="col-md-6">
                <label class="form-label small">Validated climbs (validated_climbs.json)</label>
                <input class="form-control form-control-sm text-muted" id="imp-validated" placeholder="/path/to/validated_climbs.json">
              </div>
            </div>
            <button type="submit" class="btn btn-sm btn-outline-primary mt-3" id="import-btn">Import</button>
            <span id="import-result" class="small ms-2"></span>
          </form>
        </div>
      </div>

      <p class="small text-muted">Server port is configured in <code id="config-port-hint"></code>; changing it requires a server restart.</p>
    </div>
  `;

  const status = await fetchConfig();
  fillForm(status);

  document.getElementById('config-file-path').textContent = status.config_file || 'config.json';
  document.getElementById('config-port-hint').textContent = status.config_file || 'config.json';

  document.getElementById('config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('config-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const payload = {
        health_data_dir: document.getElementById('cfg-health_data_dir').value.trim(),
        garmindb_cli: document.getElementById('cfg-garmindb_cli').value.trim(),
        sync_latest: document.getElementById('cfg-sync_latest').checked,
      };
      for (const f of ['activities_db', 'garmin_db', 'fit_dir', 'personal_info_json']) {
        payload[f] = document.getElementById('cfg-' + f).value.trim();
      }
      const updated = await saveConfig(payload);
      document.getElementById('config-saved-msg').classList.remove('d-none');
      fillForm(updated);
    } catch (err) {
      alert(err.message || 'Could not save configuration');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save configuration';
    }
  });
  document.getElementById('import-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('import-btn');
    const result = document.getElementById('import-result');
    const payload = {};
    for (const [key, id] of [['cols', 'imp-cols'], ['segments', 'imp-segments'], ['names', 'imp-names'], ['validated', 'imp-validated']]) {
      const v = document.getElementById(id).value.trim();
      if (v) payload[key] = v;
    }
    if (Object.keys(payload).length === 0) {
      result.textContent = 'Nothing to import — fill at least one path.';
      result.className = 'small ms-2 text-warning';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Importing…';
    result.textContent = '';
    try {
      const res = await importFiles(payload);
      const parts = Object.entries(res.imported || {})
        .filter(([k]) => k !== 'groups' && !k.endsWith('_warning'))
        .map(([k, v]) => `${k}: ${v.entries} entries`);
      result.textContent = 'Imported — ' + parts.join(', ') + '. Reload pages to see the changes.';
      result.className = 'small ms-2 text-success';
    } catch (err) {
      result.textContent = err.message || 'Import failed';
      result.className = 'small ms-2 text-danger';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  });
}

function fillForm(status) {
  const values = status.values || {};
  document.getElementById('cfg-health_data_dir').value = values.health_data_dir || '';
  document.getElementById('cfg-garmindb_cli').value = values.garmindb_cli || '';
  document.getElementById('cfg-sync_latest').checked = values.sync_latest !== false;
  for (const f of ['activities_db', 'garmin_db', 'fit_dir', 'personal_info_json']) {
    document.getElementById('cfg-' + f).value = values[f] || '';
  }
  applyPathStatus(status);
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
