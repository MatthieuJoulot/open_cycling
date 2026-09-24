import { fetchActivityDetails, fetchActivityRecords, fetchClimbNames, saveClimbName, identifySegments, saveSegment, validateClimb, deleteActivity } from '../utils/api.js';
import { openSegmentEditor } from '../components/segmentEditor.js?v=2';
import { fmtDate, fmtTime, fmtDuration, fmtDistance, fmtElevation, fmtGrade, fmtSpeed, fmtHr } from '../utils/format.js';

let elevationChart = null;
let hrChart = null;
let hrChartRendered = false;
let map = null;
let climbNameMap = {};
let currentActivityId = null;

export async function renderActivity(activityId) {
  currentActivityId = activityId;
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="activity-view">
      <div id="activity-header" class="mb-3"></div>

      <div class="card mb-3 activity-section">
        <div class="card-header fw-semibold">Map</div>
        <div class="collapse show" id="section-map">
          <div class="card-body p-2"><div id="map"></div></div>
        </div>
      </div>

      <div class="card mb-3 activity-section">
        <div class="card-header fw-semibold">Elevation profile</div>
        <div class="collapse show" id="section-elevation">
          <div class="card-body p-2"><canvas id="elevation-chart"></canvas></div>
        </div>
      </div>

      <div class="card mb-3 activity-section">
        <button class="card-header btn btn-link text-decoration-none w-100 text-start fw-semibold collapsed" data-bs-toggle="collapse" data-bs-target="#section-climbs" aria-expanded="false">
          <span class="chevron me-2"></span>Detected climbs
        </button>
        <div class="collapse" id="section-climbs">
          <div class="card-body">
            <button id="identify-segments-btn" class="btn btn-sm btn-outline-primary mb-2">Identify segments</button>
            <div id="climbs-loading" class="small text-muted mb-2 d-none">Looking up names from OpenStreetMap…</div>
            <div class="table-responsive">
              <table class="table table-sm table-striped">
                <thead><tr><th>#</th><th>Name</th><th>Category</th><th>Start (km)</th><th>Length (km)</th><th>Elev. gain</th><th>Avg grade</th><th>Max grade</th><th>VAM</th></tr></thead>
                <tbody id="climbs-body"></tbody>
              </table>
            </div>
            <p id="no-climbs" class="text-muted d-none">No sustained climbs found.</p>
            <div id="candidate-segments" class="d-none"></div>
            <p class="small text-muted mt-2 mb-0">Names from OpenStreetMap contributors · ODbL</p>
          </div>
        </div>
      </div>

      <div class="card mb-3 activity-section" id="hr-card">
        <button class="card-header btn btn-link text-decoration-none w-100 text-start fw-semibold collapsed" data-bs-toggle="collapse" data-bs-target="#section-hr" aria-expanded="false">
          <span class="chevron me-2"></span>Heart rate
        </button>
        <div class="collapse" id="section-hr">
          <div class="card-body p-2"><canvas id="hr-chart"></canvas></div>
        </div>
      </div>

      <div class="card mb-3 activity-section">
        <button class="card-header btn btn-link text-decoration-none w-100 text-start fw-semibold collapsed" data-bs-toggle="collapse" data-bs-target="#section-laps" aria-expanded="false">
          <span class="chevron me-2"></span>Laps
        </button>
        <div class="collapse" id="section-laps">
          <div class="card-body">
            <div class="table-responsive">
              <table class="table table-sm table-striped">
                <thead><tr><th>#</th><th>Distance</th><th>Moving time</th><th>Avg speed</th><th>Ascent</th><th>Avg HR</th></tr></thead>
                <tbody id="laps-body"></tbody>
              </table>
            </div>
            <p id="no-laps" class="text-muted d-none">No lap data available.</p>
          </div>
        </div>
      </div>
    </div>
  `;

  const details = await fetchActivityDetails(activityId);
  const records = await fetchActivityRecords(activityId, 'distance,altitude,hr,speed,timestamp,position_lat,position_long', 3000);

  renderHeader(details);
  setupDeleteActivity(activityId, details.activity);
  renderClimbsTable(activityId, details.climbs || [], records);
  renderLapsTable(details.laps || []);
  renderMap(records, details.climbs || []);
  renderElevationChart(records, details.climbs || []);
  renderHrChartDeferred(records, details.sensors || {});
  setupClimbNameLoading(activityId);
  setupIdentifySegments(activityId);
}

function renderHeader(details) {
  const act = details.activity;
  const header = document.getElementById('activity-header');
  const deviceBadges = (details.devices || []).map(d => {
    const label = [d.manufacturer, d.product && d.product !== 'invalid' ? d.product : null, d.type]
      .filter(Boolean).join(' · ') || d.serial;
    return `<span class="badge bg-light text-dark border me-1">${label}</span>`;
  }).join('');

  header.innerHTML = `
    <div class="d-flex justify-content-between align-items-start">
      <div>
        <h3>${act.name || 'Ride'}</h3>
        <p class="text-muted mb-2">${fmtDate(act.start_time)} · ${fmtTime(act.start_time)}</p>
        ${deviceBadges ? `<div class="mb-3">${deviceBadges}</div>` : ''}
      </div>
      <button id="delete-activity-btn" class="btn btn-sm btn-outline-danger" title="Delete this activity locally">Delete</button>
    </div>
    <div class="row g-2">
      <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtDistance(act.distance)}</div><div class="stat-label">Distance</div></div></div>
      <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtDuration(act.moving_time)}</div><div class="stat-label">Moving time</div></div></div>
      <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtElevation(act.ascent)}</div><div class="stat-label">Ascent</div></div></div>
      <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtSpeed(act.avg_speed)}</div><div class="stat-label">Avg speed</div></div></div>
      <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtSpeed(act.max_speed)}</div><div class="stat-label">Max speed</div></div></div>
      <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtHr(details.avg_hr)}</div><div class="stat-label">Avg HR</div></div></div>
      <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtHr(details.max_hr)}</div><div class="stat-label">Max HR</div></div></div>
      <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtElevation(act.descent)}</div><div class="stat-label">Descent</div></div></div>
    </div>
  `;
}

function setupDeleteActivity(activityId, act) {
  const btn = document.getElementById('delete-activity-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const label = act?.name || 'this activity';
    const ok = confirm(`Delete "${label}" locally?\n\nRemoves it from the analyzer, GarminDB and downloaded files. The ride stays on Garmin Connect, but syncs will not re-import it.`);
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await deleteActivity(activityId);
      window.location.hash = '#feed';
      window.location.reload();
    } catch (err) {
      alert(err.message || 'Delete failed');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  });
}

function renderClimbsTable(activityId, climbs, records) {
  const tbody = document.getElementById('climbs-body');
  const noClimbs = document.getElementById('no-climbs');
  tbody.innerHTML = '';

  if (!climbs || climbs.length === 0) {
    noClimbs.classList.remove('d-none');
    return;
  }
  noClimbs.classList.add('d-none');

  for (let i = 0; i < climbs.length; i++) {
    const c = climbs[i];
    const vam = computeVam(c, records);
    const key = `${activityId}:${Math.round(c.start_distance_m)}:${Math.round(c.end_distance_m)}`;
    const row = document.createElement('tr');
    row.dataset.climbKey = key;
    row.dataset.startDistance = c.start_distance_m;
    row.dataset.endDistance = c.end_distance_m;
    row.innerHTML = `
      <td>${i + 1}</td>
      <td class="climb-name-cell">
        <a href="#climb/${key}" class="climb-name-link text-decoration-none text-muted">Unnamed segment</a>
        <button class="btn btn-sm btn-link py-0 climb-edit-btn" title="Edit name">✎</button>
        <button class="btn btn-sm btn-link py-0 climb-modify-btn" title="Modify segment on map">🗺</button>
        <button class="btn btn-sm btn-link py-0 climb-validate-btn text-success" title="Validate as canonical named climb">✓</button>
      </td>
      <td><span class="badge bg-secondary category-badge">${c.category}</span></td>
      <td>${(c.start_distance_m / 1000).toFixed(1)}</td>
      <td>${(c.length_m / 1000).toFixed(1)}</td>
      <td>${fmtElevation(c.elevation_gain_m)}</td>
      <td>${fmtGrade(c.avg_grade_percent)}</td>
      <td>${fmtGrade(c.max_grade_percent)}</td>
      <td>${vam ? Math.round(vam) + ' m/h' : '-'}</td>
    `;
    if (c.validated_climb_id) {
      const cell = row.querySelector('.climb-name-cell');
      const link = cell.querySelector('.climb-name-link');
      link.textContent = c.validated_name;
      link.className = 'climb-name-link text-decoration-none fw-semibold';
      const vbtn = cell.querySelector('.climb-validate-btn');
      vbtn.outerHTML = `<span class="badge bg-success ms-1" title="Validated">✓</span>`;
    }
    tbody.appendChild(row);
  }

  tbody.addEventListener('click', handleClimbNameEditClick);
  tbody.addEventListener('click', e => handleClimbModifyClick(e, records));
  tbody.addEventListener('click', handleClimbValidateClick);
}

async function handleClimbModifyClick(e, records) {
  const btn = e.target.closest('.climb-modify-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  if (!row) return;
  const activityId = row.dataset.climbKey.split(':')[0];
  const start = parseFloat(row.dataset.startDistance);
  const end = parseFloat(row.dataset.endDistance);
  btn.disabled = true;
  try {
    await openSegmentEditor({
      activityId,
      records,
      startDistanceM: start,
      endDistanceM: end,
      onSave: () => window.location.reload(),
    });
  } catch (err) {
    console.error('Failed to open segment editor', err);
    alert('Could not open segment editor: ' + (err?.message || err));
  } finally {
    btn.disabled = false;
  }
}

function setupClimbNameLoading(activityId) {
  const collapse = document.getElementById('section-climbs');
  if (!collapse) return;
  const spinner = document.getElementById('climbs-loading');
  const load = async () => {
    if (spinner) {
      spinner.classList.remove('d-none');
      spinner.textContent = 'Looking up names from OpenStreetMap…';
    }
    try {
      const names = await fetchClimbNames(activityId, true);
      climbNameMap = names;
      updateClimbNameCells(names);
    } catch (err) {
      console.error('Failed to load climb names', err);
    } finally {
      if (spinner) spinner.classList.add('d-none');
    }
  };
  collapse.addEventListener('shown.bs.collapse', load, { once: true });
  if (collapse.classList.contains('show')) {
    load();
  }
}

function setupIdentifySegments(activityId) {
  const btn = document.getElementById('identify-segments-btn');
  const container = document.getElementById('candidate-segments');
  if (!btn || !container) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Looking for segments…';
    try {
      const candidates = await identifySegments(activityId);
      renderCandidates(activityId, candidates);
    } catch (err) {
      console.error('Failed to identify segments', err);
      alert('Could not identify segments. Is the server running?');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Identify segments';
    }
  });
}

function renderCandidates(activityId, candidates) {
  const container = document.getElementById('candidate-segments');
  container.classList.remove('d-none');
  if (!candidates || candidates.length === 0) {
    container.innerHTML = '<p class="text-muted small mb-0">No additional segments found nearby.</p>';
    return;
  }

  const rows = candidates.map((c, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${c.category}</td>
      <td>${(c.start_distance_m / 1000).toFixed(1)}</td>
      <td>${(c.length_m / 1000).toFixed(2)}</td>
      <td>${fmtElevation(c.elevation_gain_m)}</td>
      <td>${fmtGrade(c.avg_grade_percent)}</td>
      <td>${fmtGrade(c.max_grade_percent)}</td>
      <td><button class="btn btn-sm btn-primary add-candidate-btn" data-start="${c.start_distance_m}" data-end="${c.end_distance_m}">Add</button></td>
    </tr>
  `).join('');

  container.innerHTML = `
    <h6 class="mt-3">Candidate segments nearby</h6>
    <div class="table-responsive">
      <table class="table table-sm table-striped">
        <thead><tr><th>#</th><th>Category</th><th>Start (km)</th><th>Length (km)</th><th>Elev. gain</th><th>Avg grade</th><th>Max grade</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="card card-body p-2 mt-2">
      <div class="row g-2 align-items-end">
        <div class="col-4">
          <label class="form-label small mb-0">Start distance (m)</label>
          <input type="number" step="0.1" class="form-control form-control-sm" id="manual-start">
        </div>
        <div class="col-4">
          <label class="form-label small mb-0">End distance (m)</label>
          <input type="number" step="0.1" class="form-control form-control-sm" id="manual-end">
        </div>
        <div class="col-4">
          <button class="btn btn-sm btn-success w-100" id="manual-add-btn">Add manual segment</button>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll('.add-candidate-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const start = parseFloat(button.dataset.start);
      const end = parseFloat(button.dataset.end);
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        await saveSegment(activityId, start, end);
        window.location.reload();
      } catch (err) {
        console.error('Failed to add segment', err);
        alert('Could not add segment. Is the server running?');
        button.disabled = false;
        button.textContent = 'Add';
      }
    });
  });

  const manualBtn = document.getElementById('manual-add-btn');
  if (manualBtn) {
    manualBtn.addEventListener('click', async () => {
      const start = parseFloat(document.getElementById('manual-start').value);
      const end = parseFloat(document.getElementById('manual-end').value);
      if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
        alert('Enter a valid start and end distance');
        return;
      }
      manualBtn.disabled = true;
      manualBtn.textContent = 'Saving…';
      try {
        await saveSegment(activityId, start, end);
        window.location.reload();
      } catch (err) {
        console.error('Failed to add manual segment', err);
        alert('Could not add segment. Is the server running?');
        manualBtn.disabled = false;
        manualBtn.textContent = 'Add manual segment';
      }
    });
  }
}

function updateClimbNameCells(names) {
  const tbody = document.getElementById('climbs-body');
  if (!tbody) return;
  for (const row of tbody.querySelectorAll('tr')) {
    if (row.querySelector('.climb-name-input')) continue;
    const key = row.dataset.climbKey;
    const entry = names[key];
    const link = row.querySelector('.climb-name-link');
    if (!link) continue;
    if (entry && entry.name) {
      link.textContent = entry.name;
      const badgeClass = entry.source === 'manual' ? 'text-primary' : 'text-dark';
      link.className = `climb-name-link text-decoration-none ${badgeClass}`;
    } else {
      link.textContent = 'Unnamed segment';
      link.className = 'climb-name-link text-decoration-none text-muted';
    }
    // keep edit/modify buttons after update
    const cell = link.closest('.climb-name-cell');
    if (cell && !cell.querySelector('.climb-edit-btn')) {
      cell.insertAdjacentHTML('beforeend', ' <button class="btn btn-sm btn-link py-0 climb-edit-btn" title="Edit name">✎</button> <button class="btn btn-sm btn-link py-0 climb-modify-btn" title="Modify segment on map">🗺</button> <button class="btn btn-sm btn-link py-0 climb-validate-btn text-success" title="Validate as canonical named climb">✓</button>');
    }
  }
}

function handleClimbValidateClick(e) {
  const btn = e.target.closest('.climb-validate-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  if (!row) return;
  const activityId = row.dataset.climbKey.split(':')[0];
  const start = parseFloat(row.dataset.startDistance);
  const end = parseFloat(row.dataset.endDistance);
  const link = row.querySelector('.climb-name-link');
  let current = link && link.textContent.trim() !== 'Unnamed segment' ? link.textContent.trim() : '';
  if (current === 'Unnamed segment') current = '';

  const doValidate = async (name) => {
    btn.disabled = true;
    try {
      await validateClimb(activityId, start, end, name);
      const cell = row.querySelector('.climb-name-cell');
      const link2 = cell.querySelector('.climb-name-link');
      link2.textContent = name;
      link2.className = 'climb-name-link text-decoration-none fw-semibold';
      btn.outerHTML = '<span class="badge bg-success ms-1" title="Validated">✓</span>';
    } catch (err) {
      alert(err.message || 'Validation failed');
      btn.disabled = false;
    }
  };

  if (!current) {
    const name = prompt('Give this climb a name to validate it:');
    if (!name || !name.trim()) return;
    doValidate(name.trim());
  } else {
    doValidate(current);
  }
}

function handleClimbNameEditClick(e) {
  const btn = e.target.closest('.climb-edit-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  if (!row) return;
  const link = row.querySelector('.climb-name-link');
  const current = link && link.textContent.trim() !== 'Unnamed segment' ? link.textContent.trim() : '';
  const start = parseFloat(row.dataset.startDistance);
  const end = parseFloat(row.dataset.endDistance);
  const activityId = row.dataset.climbKey.split(':')[0];
  const key = row.dataset.climbKey;

  const cell = row.querySelector('.climb-name-cell');
  cell.innerHTML = `
    <div class="input-group input-group-sm">
      <input type="text" class="form-control climb-name-input" value="${current.replace(/"/g, '&quot;')}" placeholder="Climb name">
      <button class="btn btn-primary climb-save-btn" type="button">Save</button>
      <button class="btn btn-outline-secondary climb-cancel-btn" type="button">Cancel</button>
    </div>
  `;
  const input = cell.querySelector('.climb-name-input');
  input.focus();
  input.select();

  const save = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      const entry = await saveClimbName(activityId, start, end, name);
      climbNameMap[key] = entry;
      cell.innerHTML = `<a href="#climb/${key}" class="climb-name-link text-decoration-none text-primary">${escapeHtml(entry.name)}</a> <button class="btn btn-sm btn-link py-0 climb-edit-btn" title="Edit name">✎</button> <button class="btn btn-sm btn-link py-0 climb-modify-btn" title="Modify segment on map">🗺</button>`;
    } catch (err) {
      console.error('Failed to save climb name', err);
      alert('Could not save name. Is the server running?');
    }
  };

  const cancel = () => {
    const display = current ? escapeHtml(current) : '<span class="text-muted">Unnamed segment</span>';
    const cls = current ? 'text-primary' : 'text-muted';
    cell.innerHTML = `<a href="#climb/${key}" class="climb-name-link text-decoration-none ${cls}">${display}</a> <button class="btn btn-sm btn-link py-0 climb-edit-btn" title="Edit name">✎</button> <button class="btn btn-sm btn-link py-0 climb-modify-btn" title="Modify segment on map">🗺</button>`;
  };

  cell.querySelector('.climb-save-btn').addEventListener('click', save);
  cell.querySelector('.climb-cancel-btn').addEventListener('click', cancel);
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') save();
    if (ev.key === 'Escape') cancel();
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function computeVam(climb, records) {
  const start = records.find(p => p.distance >= climb.start_distance_m && p.timestamp);
  const end = [...records].reverse().find(p => p.distance <= climb.end_distance_m && p.timestamp);
  if (!start || !end || !start.timestamp || !end.timestamp) return null;
  const seconds = (new Date(end.timestamp) - new Date(start.timestamp)) / 1000;
  if (seconds <= 0) return null;
  return (climb.elevation_gain_m / seconds) * 3600;
}

function renderLapsTable(laps) {
  const tbody = document.getElementById('laps-body');
  const noLaps = document.getElementById('no-laps');
  tbody.innerHTML = '';

  if (!laps || laps.length === 0) {
    noLaps.classList.remove('d-none');
    return;
  }
  noLaps.classList.add('d-none');

  for (const lap of laps) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${lap.lap + 1}</td>
      <td>${fmtDistance(lap.distance)}</td>
      <td>${fmtDuration(lap.moving_time)}</td>
      <td>${fmtSpeed(lap.avg_speed)}</td>
      <td>${fmtElevation(lap.ascent)}</td>
      <td>${fmtHr(lap.avg_hr)}</td>
    `;
    tbody.appendChild(row);
  }
}

function renderMap(records, climbs) {
  if (!map) {
    map = L.map('map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  }

  map.eachLayer(layer => {
    if (layer instanceof L.Polyline || layer instanceof L.Marker) {
      map.removeLayer(layer);
    }
  });

  const routePoints = records.filter(p => p.position_lat && p.position_long).map(p => [p.position_lat, p.position_long]);
  if (routePoints.length === 0) return;

  L.polyline(routePoints, { color: '#6c757d', weight: 3, opacity: 0.7 }).addTo(map);
  L.circleMarker(routePoints[0], { radius: 7, color: '#198754', fillColor: '#198754', fillOpacity: 1, weight: 2 }).addTo(map).bindPopup('Start');
  L.circleMarker(routePoints[routePoints.length - 1], { radius: 7, color: '#dc3545', fillColor: '#dc3545', fillOpacity: 1, weight: 2 }).addTo(map).bindPopup('Finish');

  for (const c of climbs) {
    const segment = records.filter(p =>
      p.position_lat && p.position_long && p.distance >= c.start_distance_m && p.distance <= c.end_distance_m
    ).map(p => [p.position_lat, p.position_long]);
    if (segment.length > 1) {
      L.polyline(segment, { color: '#dc3545', weight: 5, opacity: 0.9 }).addTo(map);
    }
  }

  map.fitBounds(routePoints, { padding: [20, 20] });
}

function renderElevationChart(records, climbs) {
  if (elevationChart) elevationChart.destroy();
  const ctx = document.getElementById('elevation-chart').getContext('2d');

  const labels = records.map(p => (p.distance / 1000).toFixed(1));
  const data = records.map(p => p.altitude);

  const inClimb = new Array(records.length).fill(false);
  for (const c of climbs) {
    for (let i = 0; i < records.length; i++) {
      if (records[i].distance >= c.start_distance_m && records[i].distance <= c.end_distance_m) {
        inClimb[i] = true;
      }
    }
  }

  function nearestIndex(targetDistance) {
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < records.length; i++) {
      const diff = Math.abs(records[i].distance - targetDistance);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  const climbLabels = climbs.map((c, idx) => {
    const startIdx = nearestIndex(c.start_distance_m);
    const endIdx = nearestIndex(c.end_distance_m);
    const midIdx = nearestIndex((c.start_distance_m + c.end_distance_m) / 2);
    return { idx, startIdx, endIdx, dataIndex: midIdx, altitude: records[midIdx]?.altitude ?? 0, midDistance: (c.start_distance_m + c.end_distance_m) / 2, climb: c };
  });

  // Stagger labels that are close horizontally.
  climbLabels.sort((a, b) => a.midDistance - b.midDistance);
  let prevMid = -Infinity;
  let offset = 0;
  const offsetStep = 16;
  const proximityM = 400;
  for (const item of climbLabels) {
    if (item.midDistance - prevMid < proximityM) {
      offset += offsetStep;
    } else {
      offset = 0;
    }
    item.vOffset = offset;
    prevMid = item.midDistance;
  }
  climbLabels.sort((a, b) => a.idx - b.idx);

  elevationChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Elevation (m)',
        data,
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        backgroundColor: 'rgba(13, 110, 253, 0.1)',
        tension: 0.1,
        segment: {
          borderColor: ctx => inClimb[ctx.p0DataIndex] || inClimb[ctx.p1DataIndex] ? '#dc3545' : '#0d6efd'
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: items => `km ${items[0].label}` } },
        climbNumbers: { labels: climbLabels }
      },
      scales: {
        x: { title: { display: true, text: 'Distance (km)' }, ticks: { maxTicksLimit: 10 } },
        y: { title: { display: true, text: 'Elevation (m)' }, suggestedMax: Math.max(...data) * 1.25 }
      }
    },
    plugins: [{
      id: 'climbNumbers',
      afterDatasetsDraw(chart, args, options) {
        const { ctx, scales: { x, y } } = chart;
        ctx.save();
        const radius = 9;
        for (const item of options.labels || []) {
          const px = (x.getPixelForValue(item.startIdx) + x.getPixelForValue(item.endIdx)) / 2;
          const py = y.getPixelForValue(item.altitude) - radius - 10 - (item.vOffset || 0);

          ctx.beginPath();
          ctx.arc(px, py, radius, 0, 2 * Math.PI);
          ctx.fillStyle = 'white';
          ctx.fill();
          ctx.strokeStyle = '#842029';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.font = 'bold 10px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#842029';
          ctx.fillText(item.idx + 1, px, py + 0.5);
        }
        ctx.restore();
      }
    }]
  });

  attachClimbTooltip(elevationChart, climbLabels);
}

function getOrCreateClimbTooltip() {
  let tip = document.getElementById('climb-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'climb-tooltip';
    tip.className = 'card border-0 shadow-sm p-2 small';
    tip.style.position = 'absolute';
    tip.style.display = 'none';
    tip.style.pointerEvents = 'none';
    tip.style.zIndex = '1000';
    tip.style.background = 'white';
    document.body.appendChild(tip);
  }
  return tip;
}

function formatClimbTooltip(item) {
  const c = item.climb;
  const key = `${currentActivityId || ''}:${Math.round(c.start_distance_m)}:${Math.round(c.end_distance_m)}`;
  const entry = climbNameMap[key];
  const name = entry?.name || `Climb ${item.idx + 1}`;
  return `
    <div class="fw-semibold">${escapeHtml(name)}</div>
    <div class="text-muted">${fmtElevation(c.elevation_gain_m)} · ${(c.length_m / 1000).toFixed(1)} km</div>
  `;
}

function attachClimbTooltip(chart, labels) {
  const canvas = chart.canvas;
  const tip = getOrCreateClimbTooltip();

  canvas.addEventListener('mousemove', evt => {
    const rect = canvas.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    const my = evt.clientY - rect.top;
    const x = chart.scales.x;
    const y = chart.scales.y;

    let hovered = null;
    let hoveredDist = Infinity;
    for (const item of labels) {
      const px = (x.getPixelForValue(item.startIdx) + x.getPixelForValue(item.endIdx)) / 2;
      const py = y.getPixelForValue(item.altitude) - 9 - 10 - (item.vOffset || 0);
      const dist = Math.hypot(mx - px, my - py);
      if (dist <= 12 && dist < hoveredDist) {
        hovered = item;
        hoveredDist = dist;
      }
    }

    if (hovered) {
      tip.innerHTML = formatClimbTooltip(hovered);
      tip.style.display = 'block';
      tip.style.left = `${evt.pageX + 12}px`;
      tip.style.top = `${evt.pageY - 12}px`;
      canvas.style.cursor = 'pointer';
    } else {
      tip.style.display = 'none';
      canvas.style.cursor = 'default';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    canvas.style.cursor = 'default';
  });
}

function renderHrChartDeferred(records, sensors) {
  hrChartRendered = false;
  const card = document.getElementById('hr-card');
  if (!card) return;
  if (!sensors.has_hr) {
    card.classList.add('d-none');
    return;
  }
  card.classList.remove('d-none');
  const collapse = document.getElementById('section-hr');
  collapse.addEventListener('shown.bs.collapse', () => {
    if (!hrChartRendered) renderHrChart(records, sensors);
  }, { once: true });
}

function renderHrChart(records, sensors) {
  const card = document.getElementById('hr-card');
  if (!sensors.has_hr) {
    card.classList.add('d-none');
    return;
  }
  card.classList.remove('d-none');

  if (hrChart) hrChart.destroy();
  const ctx = document.getElementById('hr-chart').getContext('2d');

  const labels = records.map(p => (p.distance / 1000).toFixed(1));
  const data = records.map(p => p.hr);

  hrChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Heart rate (bpm)',
        data,
        borderColor: '#dc3545',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0.1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: items => `km ${items[0].label}` } }
      },
      scales: {
        x: { title: { display: true, text: 'Distance (km)' }, ticks: { maxTicksLimit: 10 } },
        y: { title: { display: true, text: 'Heart rate (bpm)' } }
      }
    }
  });
  hrChartRendered = true;
}
