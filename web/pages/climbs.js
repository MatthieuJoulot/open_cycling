import { fetchClimbs, fetchAllClimbNames, fetchClimbGroups, fetchRegions, saveSegment, deleteSegment } from '../utils/api.js';
import { fmtDate, fmtDistance, fmtElevation, fmtGrade, fmtSpeed, climbKey } from '../utils/format.js';

let allClimbs = [];
let allNames = {};
let allGroups = {};
let allRegions = {};
let regionsLoading = false;

export async function renderClimbs() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="climbs-view">
      <h4 class="mb-3">All climbs</h4>
      <div class="card mb-3">
        <div class="card-body">
          <div class="row g-2 align-items-end">
            <div class="col-md-4">
              <label class="form-label small text-muted">Search</label>
              <input type="text" id="climb-search" class="form-control form-control-sm" placeholder="Name, place, category…">
            </div>
            <div class="col-md-3">
              <label class="form-label small text-muted">Sort by</label>
              <select id="climb-sort" class="form-select form-select-sm">
                <option value="date-desc">Newest first</option>
                <option value="date-asc">Oldest first</option>
                <option value="name-asc">Name A-Z</option>
                <option value="difficulty-desc">Hardest first</option>
                <option value="length-desc">Longest first</option>
                <option value="ascent-desc">Most ascent</option>
                <option value="times-desc">Most times done</option>
              </select>
            </div>
            <div class="col-md-3">
              <label class="form-label small text-muted">Group by</label>
              <select id="climb-group" class="form-select form-select-sm">
                <option value="none">None</option>
                <option value="region">Region</option>
              </select>
            </div>
            <div class="col-md-2">
              <label class="form-label small text-muted">View</label>
              <div class="btn-group w-100" role="group">
                <button type="button" class="btn btn-sm btn-outline-secondary active" id="view-list-btn">List</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" id="view-map-btn">Map</button>
              </div>
            </div>
          </div>
          <div id="climbs-region-loading" class="small text-muted mt-2 d-none">Loading regions…</div>
        </div>
      </div>
      <div class="table-responsive" id="climbs-table-wrap">
        <table class="table table-sm table-striped">
          <thead>
            <tr>
              <th>Name</th>
              <th>Region</th>
              <th>Lastly climbed</th>
              <th>Category</th>
              <th>Length</th>
              <th>Ascent</th>
              <th>Avg grade</th>
              <th>Max grade</th>
              <th>Done</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="climbs-list-body"></tbody>
        </table>
      </div>
      <div id="climbs-map-wrap" class="d-none">
        <div class="card mb-3">
          <div class="card-body p-0">
            <div id="climbs-map" style="height: 70vh; border-radius: .375rem;"></div>
          </div>
        </div>
        <p class="small text-muted">Showing climb start points. Marker color = category. Click for details.</p>
      </div>
      <p id="no-climbs" class="text-muted d-none">No climbs found.</p>
    </div>
    <div class="modal fade" id="modifySegmentModal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-sm">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Modify segment</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <form id="modify-segment-form">
              <input type="hidden" id="modify-activity-id">
              <input type="hidden" id="modify-old-start">
              <input type="hidden" id="modify-old-end">
              <div class="mb-2">
                <label class="form-label small">Start distance (m)</label>
                <input type="number" step="0.1" class="form-control form-control-sm" id="modify-start" required>
              </div>
              <div class="mb-2">
                <label class="form-label small">End distance (m)</label>
                <input type="number" step="0.1" class="form-control form-control-sm" id="modify-end" required>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button type="button" class="btn btn-sm btn-primary" id="modify-save-btn">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const [climbsData, names, groups] = await Promise.all([fetchClimbs(), fetchAllClimbNames(), fetchClimbGroups()]);
  allNames = names || {};
  allGroups = groups || {};
  allClimbs = flattenClimbs(climbsData.activities || []);
  renderList();

  const listBody = document.getElementById('climbs-list-body');
  listBody.addEventListener('click', onCountryToggle);
  listBody.addEventListener('click', onRegionToggle);
  document.getElementById('climb-search').addEventListener('input', renderList);
  document.getElementById('climb-sort').addEventListener('change', renderList);
  document.getElementById('climb-group').addEventListener('change', onGroupChange);
  document.getElementById('view-list-btn').addEventListener('click', () => setView('list'));
  document.getElementById('view-map-btn').addEventListener('click', () => setView('map'));
  setupModifySegmentModal();
}

let climbsMap = null;
let climbsMapLayer = null;

const CATEGORY_MARKER_COLORS = {
  'HC': '#dc3545', 'Cat 1': '#fd7e14', 'Cat 2': '#ffc107',
  'Cat 3': '#20c997', 'Cat 4': '#198754', 'Uncategorized': '#adb5bd',
};

function setView(view) {
  const listWrap = document.getElementById('climbs-table-wrap');
  const mapWrap = document.getElementById('climbs-map-wrap');
  const listBtn = document.getElementById('view-list-btn');
  const mapBtn = document.getElementById('view-map-btn');
  if (view === 'map') {
    listWrap.classList.add('d-none');
    mapWrap.classList.remove('d-none');
    listBtn.classList.remove('active');
    mapBtn.classList.add('active');
    renderClimbsMap();
  } else {
    listWrap.classList.remove('d-none');
    mapWrap.classList.add('d-none');
    listBtn.classList.add('active');
    mapBtn.classList.remove('active');
    if (climbsMap) climbsMap.invalidateSize();
  }
}

function renderClimbsMap() {
  const div = document.getElementById('climbs-map');
  if (!climbsMap) {
    climbsMap = L.map(div);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(climbsMap);
    climbsMapLayer = L.layerGroup().addTo(climbsMap);
  }
  climbsMap.invalidateSize();
  climbsMapLayer.clearLayers();

  const withCoords = allClimbs.filter(c => c.start_lat != null && c.start_lon != null);
  const bounds = [];
  for (const c of withCoords) {
    const color = CATEGORY_MARKER_COLORS[c.category] || CATEGORY_MARKER_COLORS['Uncategorized'];
    const marker = L.circleMarker([c.start_lat, c.start_lon], {
      radius: 7, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 0.95,
    });
    marker.bindPopup(`
      <strong>${c.name ? escapeHtmlClimbs(c.name) : 'Unnamed climb'}</strong><br>
      <span class="badge bg-secondary">${c.category || 'Uncategorized'}</span>
      ${fmtElevation(c.elevation_gain_m)} · ${fmtDistance(c.length_m / 1000)} · ${fmtGrade(c.avg_grade_percent)}<br>
      Done ${c.groupSize} time${c.groupSize === 1 ? '' : 's'}<br>
      <a href="#climb/${c.key}">View climb</a>
    `);
    marker.addTo(climbsMapLayer);
    bounds.push([c.start_lat, c.start_lon]);
  }
  if (bounds.length) climbsMap.fitBounds(bounds, { padding: [30, 30] });
}

function escapeHtmlClimbs(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

async function onGroupChange() {
  const group = document.getElementById('climb-group').value;
  if (group === 'region' && Object.keys(allRegions).length === 0 && !regionsLoading) {
    regionsLoading = true;
    const loader = document.getElementById('climbs-region-loading');
    if (loader) loader.classList.remove('d-none');
    try {
      await loadRegionsOnce();
    } catch (err) {
      console.error('Failed to load regions', err);
    } finally {
      regionsLoading = false;
      if (loader) loader.classList.add('d-none');
    }
  } else {
    renderList();
  }
}

async function loadRegionsOnce() {
  // /api/regions now returns instantly from the cache; if some climbs
  // have no region yet the server geocodes in the background and we
  // re-fetch when it finishes.
  const data = await fetchRegions();
  allRegions = data || {};
  allClimbs = allClimbs.map(c => ({ ...c, region: allRegions[c.key] || 'Unknown' }));
  renderList();
  if (data && data.warming) {
    await pollRegionsWarm();
  }
}

async function pollRegionsWarm() {
  // Poll the background geocode; when done, refetch regions and re-render.
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    let status = null;
    try {
      status = await fetchRegionsStatus();
    } catch (err) {
      console.warn('region status fetch failed', err);
    }
    if (!status || !status.running) break;
  }
  const data = await fetchRegions();
  allRegions = data || {};
  allClimbs = allClimbs.map(c => ({ ...c, region: allRegions[c.key] || 'Unknown' }));
  renderList();
}

function flattenClimbs(activities) {
  const keyToOccurrence = {};
  for (const act of activities) {
    for (const c of act.climbs || []) {
      const key = climbKey(act.activity_id, c.start_distance_m, c.end_distance_m);
      keyToOccurrence[key] = { ...c, key, startTime: act.start_time, activityId: act.activity_id, activityName: act.name };
    }
  }

  const groups = allGroups.groups || {};
  const keyToGroup = allGroups.key_to_group || {};
  const groupIds = new Set(Object.values(keyToGroup));
  const seenGroupIds = new Set();
  const list = [];

  function makeGroup(groupKeys) {
    const occurrences = groupKeys
      .map(k => keyToOccurrence[k])
      .filter(o => o != null);
    if (occurrences.length === 0) return null;
    const sorted = occurrences.slice().sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
    // Prefer a validated occurrence as representative: its name and segment
    // bounds are the canonical, user-confirmed ones.
    const rep = sorted.find(o => o.validated_climb_id) || sorted[0];
    const nameEntry = allNames[rep.key];
    return {
      ...rep,
      key: rep.key,
      name: rep.validated_name || nameEntry?.name || null,
      lastClimbed: sorted[0].startTime,
      groupSize: groupKeys.length,
      region: allRegions[rep.key] || '—',
    };
  }

  for (const key of Object.keys(keyToOccurrence)) {
    const groupId = keyToGroup[key];
    if (groupId) {
      if (seenGroupIds.has(groupId)) continue;
      seenGroupIds.add(groupId);
      const group = makeGroup(groups[groupId] || [key]);
      if (group) list.push(group);
    } else {
      const group = makeGroup([key]);
      if (group) list.push(group);
    }
  }

  return list;
}

function sortClimbs(list, sort) {
  return list.slice().sort((a, b) => {
    if (sort === 'date-desc') return new Date(b.lastClimbed || 0) - new Date(a.lastClimbed || 0);
    if (sort === 'date-asc') return new Date(a.lastClimbed || 0) - new Date(b.lastClimbed || 0);
    if (sort === 'name-asc') return (a.name || '').localeCompare(b.name || '');
    if (sort === 'difficulty-desc') return (b.elevation_gain_m || 0) - (a.elevation_gain_m || 0);
    if (sort === 'length-desc') return (b.length_m || 0) - (a.length_m || 0);
    if (sort === 'ascent-desc') return (b.elevation_gain_m || 0) - (a.elevation_gain_m || 0);
    if (sort === 'times-desc') return (b.groupSize || 0) - (a.groupSize || 0);
    return 0;
  });
}

function renderList() {
  const term = (document.getElementById('climb-search').value || '').toLowerCase();
  const sort = document.getElementById('climb-sort').value;
  const group = document.getElementById('climb-group').value;

  let filtered = allClimbs.filter(c => {
    const text = `${c.name || ''} ${c.category || ''} ${c.region || ''}`.toLowerCase();
    return !term || text.includes(term);
  });

  const tbody = document.getElementById('climbs-list-body');
  const noClimbs = document.getElementById('no-climbs');
  tbody.innerHTML = '';

  if (filtered.length === 0) {
    noClimbs.classList.remove('d-none');
    return;
  }
  noClimbs.classList.add('d-none');

  if (group === 'region') {
    const grouped = {};
    for (const c of filtered) {
      const region = c.region || 'Unknown';
      if (!grouped[region]) grouped[region] = [];
      grouped[region].push(c);
    }
    const sortedRegions = Object.keys(grouped).sort((a, b) => {
      const countryA = regionToCountry(a);
      const countryB = regionToCountry(b);
      const userCountry = getUserCountry();
      if (countryA === userCountry && countryB !== userCountry) return -1;
      if (countryB === userCountry && countryA !== userCountry) return 1;
      if (countryA !== countryB) return countryA.localeCompare(countryB);
      return a.localeCompare(b);
    });

    let currentCountry = null;
    for (const region of sortedRegions) {
      const country = regionToCountry(region);
      if (country !== currentCountry) {
        const countryId = 'country-' + country.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const countryHeading = document.createElement('tr');
        countryHeading.className = 'country-toggle table-primary';
        countryHeading.dataset.country = countryId;
        countryHeading.style.cursor = 'pointer';
        countryHeading.innerHTML = `<td colspan="10" class="fw-bold">
          <span class="me-2">▼</span>${escapeHtml(country)}
        </td>`;
        tbody.appendChild(countryHeading);
        currentCountry = country;
      }
      const rows = sortClimbs(grouped[region], sort);
      const regionId = 'region-' + region.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const countryClass = 'country-' + currentCountry.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const heading = document.createElement('tr');
      heading.className = 'region-toggle';
      heading.classList.add(countryClass);
      heading.dataset.region = regionId;
      heading.style.cursor = 'pointer';
      heading.innerHTML = `<td colspan="10" class="table-secondary fw-semibold ps-4">
        <span class="me-2">▼</span>${escapeHtml(region)} <span class="text-muted fw-normal">(${rows.length})</span>
      </td>`;
      tbody.appendChild(heading);
      for (const c of rows) {
        const row = buildClimbRow(c);
        row.classList.add(regionId, countryClass);
        tbody.appendChild(row);
      }
    }
  } else {
    const rows = sortClimbs(filtered, sort);
    for (const c of rows) tbody.appendChild(buildClimbRow(c));
  }
}

function onCountryToggle(e) {
  const row = e.target.closest('.country-toggle');
  if (!row) return;
  const countryId = row.dataset.country;
  const expanded = !row.classList.contains('collapsed');
  row.classList.toggle('collapsed', expanded);
  const icon = row.querySelector('span');
  if (icon) icon.textContent = expanded ? '▶' : '▼';
  const groupRows = row.parentElement.querySelectorAll('.' + countryId);
  for (const r of groupRows) {
    r.classList.toggle('d-none', expanded);
  }
}

function onRegionToggle(e) {
  const row = e.target.closest('.region-toggle');
  if (!row) return;
  const regionId = row.dataset.region;
  const expanded = !row.classList.contains('collapsed');
  row.classList.toggle('collapsed', expanded);
  const icon = row.querySelector('span');
  if (icon) icon.textContent = expanded ? '▶' : '▼';
  const groupRows = row.parentElement.querySelectorAll('.' + regionId);
  for (const r of groupRows) {
    r.classList.toggle('d-none', expanded);
  }
}

function buildClimbRow(c) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><a href="#climb/${c.key}" class="text-decoration-none">${c.name ? escapeHtml(c.name) : '<span class="text-muted">Unnamed segment</span>'}</a></td>
    <td>${escapeHtml(c.region || '—')}</td>
    <td><a href="#activity/${c.activityId}" class="text-decoration-none">${fmtDate(c.startTime)}</a></td>
    <td><span class="badge bg-secondary category-badge">${c.category}</span></td>
    <td>${fmtDistance(c.length_m / 1000)}</td>
    <td>${fmtElevation(c.elevation_gain_m)}</td>
    <td>${fmtGrade(c.avg_grade_percent)}</td>
    <td>${fmtGrade(c.max_grade_percent)}</td>
    <td>${c.groupSize || 1}</td>
    <td>
      <button class="btn btn-sm btn-link py-0 modify-segment-btn" data-activity-id="${c.activityId}" data-start="${c.start_distance_m}" data-end="${c.end_distance_m}" title="Modify segment">✎</button>
      <button class="btn btn-sm btn-link py-0 text-danger delete-segment-btn" data-activity-id="${c.activityId}" data-start="${c.start_distance_m}" data-end="${c.end_distance_m}" title="Delete segment">×</button>
    </td>
  `;
  return row;
}

function setupModifySegmentModal() {
  const tbody = document.getElementById('climbs-list-body');
  const modalEl = document.getElementById('modifySegmentModal');
  if (!modalEl || !tbody) return;
  const modal = new window.bootstrap.Modal(modalEl);

  tbody.addEventListener('click', e => {
    const modifyBtn = e.target.closest('.modify-segment-btn');
    const deleteBtn = e.target.closest('.delete-segment-btn');
    if (modifyBtn) {
      document.getElementById('modify-activity-id').value = modifyBtn.dataset.activityId;
      document.getElementById('modify-old-start').value = modifyBtn.dataset.start;
      document.getElementById('modify-old-end').value = modifyBtn.dataset.end;
      document.getElementById('modify-start').value = modifyBtn.dataset.start;
      document.getElementById('modify-end').value = modifyBtn.dataset.end;
      modal.show();
    } else if (deleteBtn) {
      if (!confirm('Delete this segment?')) return;
      const activityId = deleteBtn.dataset.activityId;
      const start = parseFloat(deleteBtn.dataset.start);
      const end = parseFloat(deleteBtn.dataset.end);
      deleteSegment(activityId, start, end).then(() => window.location.reload()).catch(err => {
        console.error('Failed to delete segment', err);
        alert('Could not delete segment');
      });
    }
  });

  document.getElementById('modify-save-btn').addEventListener('click', async () => {
    const activityId = document.getElementById('modify-activity-id').value;
    const oldStart = parseFloat(document.getElementById('modify-old-start').value);
    const oldEnd = parseFloat(document.getElementById('modify-old-end').value);
    const start = parseFloat(document.getElementById('modify-start').value);
    const end = parseFloat(document.getElementById('modify-end').value);
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
      alert('Invalid distance range');
      return;
    }
    try {
      await saveSegment(activityId, start, end, oldStart, oldEnd);
      modal.hide();
      window.location.reload();
    } catch (err) {
      console.error('Failed to modify segment', err);
      alert('Could not save segment');
    }
  });
}

function regionToCountry(region) {
  if (!region || region === 'Unknown') return 'ZZZ';
  // Known French regions
  const france = new Set([
    'Auvergne-Rhône-Alpes', 'Bourgogne-Franche-Comté', 'Bretagne', 'Centre-Val de Loire',
    'Grand Est', 'Hauts-de-France', 'Île-de-France', 'Normandie', 'Nouvelle-Aquitaine',
    'Occitanie', 'Pays de la Loire', 'Provence-Alpes-Côte d\'Azur', 'Corse',
    'France métropolitaine',
  ]);
  if (france.has(region)) return 'France';
  if (region === 'Luxembourg') return 'Luxembourg';
  if (region === 'Namur') return 'Belgium';
  return region;
}

function getUserCountry() {
  // Could be replaced with profile-based detection later.
  return 'France';
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
