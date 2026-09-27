import { fetchProfile, startSync, fetchSyncStatus } from '../utils/api.js';
import { fmtDistance, fmtDuration, fmtElevation } from '../utils/format.js';

let profileData = null;

export async function renderSidebar(activeSection = 'feed') {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  if (!profileData) {
    try {
      profileData = await fetchProfile();
    } catch (e) {
      profileData = { athlete: {}, all_time: {} };
    }
  }

  const athlete = profileData.athlete || {};
  const all = profileData.all_time || {};
  const ytd = profileData.ytd || {};

  const rawName = athlete.email ? athlete.email.split('@')[0] : 'Athlete';
  const displayName = rawName
    .replace(/[._]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const profileStats = [
    { label: 'Age', value: athlete.age ? athlete.age + ' yrs' : '-' },
    { label: 'Country', value: athlete.country || '-' },
    { label: 'Weight', value: athlete.weight_kg ? athlete.weight_kg + ' kg' : '-' },
    { label: 'Height', value: athlete.height_cm ? athlete.height_cm + ' cm' : '-' },
    { label: 'VO₂max', value: athlete.vo2max ? athlete.vo2max : '-' },
    { label: 'LTHR', value: athlete.lactate_threshold_hr ? Math.round(athlete.lactate_threshold_hr) + ' bpm' : '-' },
  ];

  const profileStatsHtml = profileStats.map(s => `
    <div class="col-6">
      <div class="border rounded p-2 text-center">
        <div class="stat-value" style="font-size:.95rem;">${s.value}</div>
        <div class="stat-label" style="font-size:.6rem;">${s.label}</div>
      </div>
    </div>
  `).join('');

  sidebar.innerHTML = `
    <div class="sidebar-sticky">
      <div class="card mb-3">
        <div class="card-body text-center pb-2">
          <div class="rounded-circle bg-secondary text-white d-inline-flex align-items-center justify-content-center mb-2" style="width:64px;height:64px;font-size:1.5rem;font-weight:600;">
            ${displayName.charAt(0).toUpperCase()}
          </div>
          <h5 class="mb-0">${displayName}</h5>
          <div class="row g-2 mt-2 mb-1">
            ${profileStatsHtml}
          </div>
        </div>
        <ul class="list-group list-group-flush small">
          <li class="list-group-item d-flex justify-content-between"><span>Rides</span><strong>${all.rides || 0}</strong></li>
          <li class="list-group-item d-flex justify-content-between"><span>Distance</span><strong>${fmtDistance(all.distance_km)}</strong></li>
          <li class="list-group-item d-flex justify-content-between"><span>Moving time</span><strong>${fmtDuration(all.moving_time_s)}</strong></li>
          <li class="list-group-item d-flex justify-content-between"><span>Ascent</span><strong>${fmtElevation(all.ascent_m)}</strong></li>
          <li class="list-group-item d-flex justify-content-between"><span>Climbs</span><strong>${all.climbs || 0}</strong></li>
        </ul>
        <div class="card-footer small text-muted">
          This year: ${ytd.rides || 0} rides · ${fmtDistance(ytd.distance_km)} · ${fmtElevation(ytd.ascent_m)}
        </div>
      </div>

      <button id="sync-btn" class="btn btn-primary w-100 mb-3">
        <span id="sync-btn-label">Sync new activities</span>
      </button>

      <div class="list-group">
        <a href="#feed" class="list-group-item list-group-item-action ${activeSection === 'feed' ? 'active' : ''}">Feed</a>
        <a href="#climbs" class="list-group-item list-group-item-action ${activeSection === 'climbs' ? 'active' : ''}">Climbs</a>
        <a href="#statistics" class="list-group-item list-group-item-action ${activeSection === 'statistics' ? 'active' : ''}">Statistics</a>
        <a href="#training" class="list-group-item list-group-item-action ${activeSection === 'training' ? 'active' : ''}">Training</a>
        <a href="#wiki" class="list-group-item list-group-item-action ${activeSection === 'wiki' ? 'active' : ''}">Wiki</a>
        <a href="#parameters" class="list-group-item list-group-item-action ${activeSection === 'parameters' ? 'active' : ''}">Parameters</a>
      </div>
    </div>
  `;

  document.getElementById('sync-btn').addEventListener('click', onSyncClick);
}

let syncing = false;

const PHASE_LABELS = {
  starting: 'Starting…',
  garmindb: 'Downloading from Garmin Connect…',
  analysis: 'Detecting climbs…',
  groups: 'Grouping climbs…',
  done: 'Done',
  failed: 'Failed',
};

async function onSyncClick() {
  const btn = document.getElementById('sync-btn');
  const label = document.getElementById('sync-btn-label');
  if (!btn || syncing) return;

  syncing = true;
  btn.disabled = true;
  label.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Syncing…';

  try {
    const started = await startSync();
    if (!started.ok) throw new Error(started.error || 'Failed to start sync');
    await pollSyncUntilDone(label);
  } catch (e) {
    showSyncToast(e.message || 'Sync failed', 'danger');
  } finally {
    syncing = false;
    const btnAfter = document.getElementById('sync-btn');
    if (btnAfter) {
      btnAfter.disabled = false;
      document.getElementById('sync-btn-label').textContent = 'Sync new activities';
    }
  }
}

async function pollSyncUntilDone(label) {
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    let status;
    try {
      status = await fetchSyncStatus();
    } catch (e) {
      showSyncToast('Lost connection to server', 'danger');
      return;
    }
    if (status.running) {
      const phase = PHASE_LABELS[status.phase] || 'Syncing…';
      label.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status"></span>${phase}`;
      continue;
    }
    if (status.result && status.result.ok) {
      const r = status.result;
      const parts = [];
      parts.push(r.new_activities > 0 ? `${r.new_activities} new ride${r.new_activities > 1 ? 's' : ''}` : 'no new rides');
      if (r.new_climbs > 0) parts.push(`${r.new_climbs} new climb${r.new_climbs > 1 ? 's' : ''}`);
      showSyncToast(parts.join(', '), 'success');
      profileData = null;
      await renderSidebar(location.hash.replace('#', '') || 'feed');
    } else {
      showSyncToast((status.result && status.result.error) || status.error || 'Sync failed', 'danger');
    }
    return;
  }
}

function showSyncToast(message, variant) {
  let container = document.getElementById('sync-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'sync-toast-container';
    container.className = 'toast-container position-fixed top-0 end-0 p-3';
    container.style.zIndex = '1090';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast align-items-center text-bg-${variant} border-0`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>
  `;
  container.appendChild(toast);
  const bsToast = new bootstrap.Toast(toast, { delay: 5000 });
  bsToast.show();
  toast.addEventListener('hidden.bs.toast', () => toast.remove());
}

export function hideSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.add('d-none');
}

export function showSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.remove('d-none');
}
