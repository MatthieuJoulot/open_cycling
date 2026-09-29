import { fetchClimbDb } from '../utils/api.js';
import { attachFullscreen } from '../utils/fullscreen.js';
import { fmtElevation } from '../utils/format.js';
import { renderNav } from '../components/nav.js';

let dbData = null;
let exploreMap = null;
let exploreLayer = null;

export async function renderExplore() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <h4 class="mb-3">Explore climbs</h4>
    <div class="card mb-3">
      <div class="card-body">
        <div class="row g-2 align-items-end">
          <div class="col-md-4">
            <label class="form-label small text-muted">Search</label>
            <input type="text" id="explore-search" class="form-control form-control-sm" placeholder="Name, region…">
          </div>
          <div class="col-md-3">
            <label class="form-label small text-muted">Country</label>
            <select id="explore-country" class="form-select form-select-sm"></select>
          </div>
          <div class="col-md-3">
            <label class="form-label small text-muted">Status</label>
            <select id="explore-status" class="form-select form-select-sm">
              <option value="all">All</option>
              <option value="climbed">Climbed</option>
              <option value="todo">Not climbed</option>
            </select>
          </div>
          <div class="col-md-2">
            <label class="form-label small text-muted">View</label>
            <div class="btn-group w-100" role="group">
              <button type="button" class="btn btn-sm btn-outline-secondary active" id="explore-list-btn">List</button>
              <button type="button" class="btn btn-sm btn-outline-secondary" id="explore-map-btn">Map</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="explore-list-wrap">
      <div class="table-responsive">
        <table class="table table-sm table-striped align-middle">
          <thead><tr><th>Name</th><th>Region</th><th>Country</th><th>Summit elev.</th><th>Climbed</th></tr></thead>
          <tbody id="explore-body"></tbody>
        </table>
      </div>
    </div>
    <div id="explore-map-wrap" class="d-none">
      <div class="card mb-3">
        <div class="card-header fw-semibold">Famous climbs map</div>
        <div class="card-body p-0">
          <div id="explore-map" style="height: 75vh; border-radius: .375rem;"></div>
        </div>
      </div>
      <p class="small text-muted">Click a climb to load its road on the map. Green = climbed. Zoom in for terrain.</p>
    </div>
  `;

  dbData = await fetchClimbDb();
  const countries = [...new Set(dbData.climbs.map(c => c.country))].sort();
  document.getElementById('explore-country').innerHTML =
    '<option value="all">All</option>' +
    countries.map(c => `<option value="${c}">${c}</option>`).join('');

  document.getElementById('explore-search').addEventListener('input', renderExploreList);
  document.getElementById('explore-country').addEventListener('change', renderExploreList);
  document.getElementById('explore-status').addEventListener('change', renderExploreList);
  document.getElementById('explore-list-btn').addEventListener('click', () => setExploreView('list'));
  document.getElementById('explore-map-btn').addEventListener('click', () => setExploreView('map'));
  renderExploreList();
}

function exploreFiltered() {
  const term = (document.getElementById('explore-search').value || '').toLowerCase();
  const country = document.getElementById('explore-country').value;
  const status = document.getElementById('explore-status').value;
  return dbData.climbs.filter(c => {
    const text = `${c.name} ${c.region}`.toLowerCase();
    if (term && !text.includes(term)) return false;
    if (country !== 'all' && c.country !== country) return false;
    if (status === 'climbed' && !c.climbed) return false;
    if (status === 'todo' && c.climbed) return false;
    return true;
  });
}

function renderExploreList() {
  const tbody = document.getElementById('explore-body');
  tbody.innerHTML = exploreFiltered().map(c => `
    <tr>
      <td><a href="#explore/${c.id}" class="text-decoration-none">${c.name}</a></td>
      <td class="text-muted">${c.region}</td>
      <td>${c.country}</td>
      <td>${fmtElevation(c.ele)}</td>
      <td>${c.climbed
        ? `<span class="badge bg-success" title="First climbed ${c.climbed.first_time ? c.climbed.first_time.slice(0, 10) : ''} · ${c.climbed.times}×">✓ ${c.climbed.times}×</span>`
        : '<span class="badge bg-secondary">—</span>'}</td>
    </tr>
  `).join('');
}

function setExploreView(view) {
  const listWrap = document.getElementById('explore-list-wrap');
  const mapWrap = document.getElementById('explore-map-wrap');
  document.getElementById('explore-list-btn').classList.toggle('active', view === 'list');
  document.getElementById('explore-map-btn').classList.toggle('active', view === 'map');
  listWrap.classList.toggle('d-none', view !== 'list');
  mapWrap.classList.toggle('d-none', view !== 'map');
  if (view === 'map') renderExploreMap();
  if (view === 'map') attachFullscreen(document.getElementById('explore-map')?.closest('.card'), document.getElementById('explore-map'), {
    onResize: () => { if (exploreMap) exploreMap.invalidateSize(); }
  });
}

async function renderExploreMap() {
  const div = document.getElementById('explore-map');
  if (!exploreMap) {
    exploreMap = L.map(div);
    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '&copy; OpenTopoMap (CC-BY-SA)'
    }).addTo(exploreMap);
    exploreLayer = L.layerGroup().addTo(exploreMap);
  }
  exploreMap.invalidateSize();
  exploreLayer.clearLayers();

  const climbs = exploreFiltered();
  const bounds = L.latLngBounds();
  for (const c of climbs) {
    const color = c.climbed ? '#198754' : '#6c757d';
    const marker = L.circleMarker([c.lat, c.lon], {
      radius: 7, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 0.95,
    });
    marker.bindPopup(`
      <strong>${c.name}</strong><br>
      ${fmtElevation(c.ele)} · ${c.region}<br>
      ${c.climbed ? `Climbed ${c.climbed.times}×` : 'Not climbed yet'}<br>
      <a href="#explore/${c.id}">Details</a>
    `);
    marker.addTo(exploreLayer);
    bounds.extend([c.lat, c.lon]);
  }
  if (bounds.isValid()) exploreMap.fitBounds(bounds, { padding: [30, 30] });
}

export function renderClimbDbDetail(id) {
  const climb = dbData ? dbData.climbs.find(c => c.id === id) : null;
  const app = document.getElementById('app');
  renderNav(true);
  if (!climb) {
    app.innerHTML = '<div class="alert alert-warning">Climb not found.</div>';
    return;
  }
  app.innerHTML = `
    <h4 class="mb-1">${climb.name}</h4>
    <p class="text-muted mb-3">${climb.region} · ${climb.country} · summit ${fmtElevation(climb.ele)}</p>
    <div class="row g-3">
      <div class="col-lg-6">
        <div class="card mb-3">
          <div class="card-header fw-semibold">Map</div>
          <div class="card-body p-2"><div id="dbclimb-map" style="height: 420px;"></div></div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card mb-3">
          <div class="card-header fw-semibold">Status</div>
          <div class="card-body">
            ${climb.climbed
              ? `<p class="mb-1">Climbed <span class="badge bg-success">✓ ${climb.climbed.times}×</span></p>
                 <p class="small text-muted mb-0">First time: ${climb.climbed.first_time ? climb.climbed.first_time.slice(0, 10) : '?'}</p>`
              : '<p class="mb-0">Not climbed yet — add it to your bucket list.</p>'}
          </div>
        </div>
        <div class="card mb-3">
          <div class="card-header fw-semibold">About</div>
          <div class="card-body">
            <p class="small text-muted mb-0">Coordinates: ${climb.lat.toFixed(4)}, ${climb.lon.toFixed(4)}</p>
            <button class="btn btn-sm btn-outline-primary mt-2" id="dbclimb-enrich-btn">Load climb road from OSM</button>
            <span class="small text-muted ms-2" id="dbclimb-enrich-msg"></span>
          </div>
        </div>
      </div>
    </div>
  `;
  renderDbClimbMap(climb);
}

function renderDbClimbMap(climb) {
  const div = document.getElementById('dbclimb-map');
  const map = L.map(div);
  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '&copy; OpenTopoMap (CC-BY-SA)'
  }).addTo(map);
  L.circleMarker([climb.lat, climb.lon], {
    radius: 8, color: '#fff', weight: 2, fillColor: climb.climbed ? '#198754' : '#dc3545', fillOpacity: 1,
  }).addTo(map).bindPopup(`<strong>${climb.name}</strong><br>${fmtElevation(climb.ele)}`);
  const bounds = L.latLngBounds([[climb.lat, climb.lon]]);
  if (climb.geometry) {
    L.polyline(climb.geometry, { color: '#0d6efd', weight: 4 }).addTo(map);
    bounds.extend(climb.geometry);
  }
  map.fitBounds(bounds, { padding: [30, 30] });

  document.getElementById('dbclimb-enrich-btn').addEventListener('click', async () => {
    const msg = document.getElementById('dbclimb-enrich-msg');
    msg.textContent = 'Loading from OpenStreetMap…';
    try {
      const r = await fetch(`/api/climb-db/${climb.id}/enrich`);
      const data = await r.json();
      if (data.geometry) {
        climb.geometry = data.geometry;
        renderDbClimbMap(climb);   // redraw with track
        msg.textContent = '';
      } else {
        msg.textContent = 'No road geometry found.';
      }
    } catch (err) {
      msg.textContent = 'Overpass failed — try again later.';
    }
  });
}
