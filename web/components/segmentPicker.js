import { fetchReplaceCandidates, replaceSegmentByGps } from '../utils/api.js';
import { fmtDistance, fmtElevation, fmtGrade, fmtDate } from '../utils/format.js';

/**
 * Modal picker for replacing a climb with another existing segment.
 *
 * Suggestions (most geometrically similar) come first as quick-apply
 * cards; below, the full candidate list with search, sort (similarity,
 * name, length, elevation, date) and a validated filter
 * (all / validated / non-validated).
 */
export async function openSegmentPicker({ activityId, climb, onReplaced }) {
  const existing = document.getElementById('segment-picker-modal');
  if (existing) existing.remove();

  const modalEl = document.createElement('div');
  modalEl.id = 'segment-picker-modal';
  modalEl.className = 'modal fade';
  modalEl.setAttribute('tabindex', '-1');
  modalEl.innerHTML = `
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">Replace segment — ${escapeHtml(climb.name || 'Unnamed segment')}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body">
          <div class="d-flex align-items-center justify-content-between small text-muted mb-2">
            <span>Current: ${(climb.start_distance_m / 1000).toFixed(2)} – ${(climb.end_distance_m / 1000).toFixed(2)} km
              · ${fmtDistance((climb.end_distance_m - climb.start_distance_m) / 1000)} ·
              +${Math.round(climb.elevation_gain_m)} m</span>
          </div>
          <div id="segment-picker-content">
            <div class="text-center py-4"><span class="spinner-border" role="status"></span></div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);
  const modal = new window.bootstrap.Modal(modalEl);
  modal.show();
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());

  const content = modalEl.querySelector('#segment-picker-content');
  let data;
  try {
    data = await fetchReplaceCandidates(activityId, climb.start_distance_m, climb.end_distance_m);
  } catch (e) {
    content.innerHTML = `<p class="text-danger small mb-0">${escapeHtml(e.message || 'Could not load candidates')}</p>`;
    return;
  }
  if (!data.ok) {
    content.innerHTML = `<p class="text-danger small mb-0">${escapeHtml(data.error || 'Could not load candidates')}</p>`;
    return;
  }

  let sort = 'similarity';
  let filter = 'all';
  let search = '';

  const render = () => {
    let list = data.candidates.slice();
    if (filter === 'validated') list = list.filter(c => c.validated);
    if (filter === 'nonvalidated') list = list.filter(c => !c.validated);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(c => (c.name || '').toLowerCase().includes(q)
        || String(c.activity_id).includes(q)
        || (c.activity_name || '').toLowerCase().includes(q));
    }
    const sorters = {
      similarity: (a, b) => a.similarity_m - b.similarity_m,
      name: (a, b) => (a.name || '\uffff').localeCompare(b.name || '\uffff'),
      length: (a, b) => (b.length_m || 0) - (a.length_m || 0),
      elevation: (a, b) => (b.elevation_gain_m || 0) - (a.elevation_gain_m || 0),
      date: (a, b) => (b.start_time || '').localeCompare(a.start_time || ''),
    };
    list.sort(sorters[sort] || sorters.similarity);

    const suggestionSet = new Set(data.suggestions);
    const rows = list.map((c, i) => `
      <tr data-idx="${i}" class="segment-picker-row" style="cursor:pointer"
          title="Replace the current segment with this one">
        <td>${c.validated ? '<span class="badge bg-success">✓</span>' : ''}${suggestionSet.has(c.name || `Climb in ${c.activity_name || c.activity_id}`) ? ' <span class="badge bg-info" title="Suggested">★</span>' : ''}</td>
        <td>${escapeHtml(c.name || `Climb in ${c.activity_name || c.activity_id}`)}</td>
        <td class="text-end">${(c.length_m / 1000).toFixed(2)} km</td>
        <td class="text-end">+${Math.round(c.elevation_gain_m)} m</td>
        <td class="text-end">${c.avg_grade_percent != null ? fmtGrade(c.avg_grade_percent) : '-'}</td>
        <td class="text-end">${c.start_time ? fmtDate(c.start_time) : '-'}</td>
        <td class="text-end text-muted">${Math.round(c.similarity_m)} m</td>
      </tr>
    `).join('');

    content.innerHTML = `
      ${data.suggestions.length ? `
        <div class="mb-3">
          <div class="small text-muted mb-1">Suggestions</div>
          <div class="d-flex flex-wrap gap-2">
            ${[...suggestionSet].map(name => `
              <button class="btn btn-sm btn-outline-primary segment-picker-suggest" data-name="${escapeHtml(name)}">
                ★ ${escapeHtml(name)}
              </button>
            `).join('')}
          </div>
        </div>` : ''}
      <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <input type="search" id="segment-picker-search" class="form-control form-control-sm" style="width: 180px;"
               placeholder="Search name, activity…" value="${escapeHtml(search)}">
        <select id="segment-picker-sort" class="form-select form-select-sm w-auto">
          <option value="similarity" ${sort === 'similarity' ? 'selected' : ''}>Sort: similarity</option>
          <option value="name" ${sort === 'name' ? 'selected' : ''}>Sort: name</option>
          <option value="length" ${sort === 'length' ? 'selected' : ''}>Sort: length</option>
          <option value="elevation" ${sort === 'elevation' ? 'selected' : ''}>Sort: elevation</option>
          <option value="date" ${sort === 'date' ? 'selected' : ''}>Sort: date</option>
        </select>
        <select id="segment-picker-filter" class="form-select form-select-sm w-auto">
          <option value="all" ${filter === 'all' ? 'selected' : ''}>All</option>
          <option value="validated" ${filter === 'validated' ? 'selected' : ''}>Validated only</option>
          <option value="nonvalidated" ${filter === 'nonvalidated' ? 'selected' : ''}>Non-validated only</option>
        </select>
        <span class="small text-muted ms-auto">${list.length} segments</span>
      </div>
      <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
        <table class="table table-sm table-striped mb-0">
          <thead class="table-light" style="position: sticky; top: 0;">
            <tr><th></th><th>Segment</th><th class="text-end">Length</th><th class="text-end">Gain</th>
                <th class="text-end">Grade</th><th class="text-end">Date</th><th class="text-end">Δ GPS</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="7" class="text-muted text-center py-3">No segments match.</td></tr>'}</tbody>
        </table>
      </div>
    `;

    content.querySelector('#segment-picker-search').addEventListener('input', e => {
      search = e.target.value;
      render();
    });
    content.querySelector('#segment-picker-sort').addEventListener('change', e => {
      sort = e.target.value;
      render();
    });
    content.querySelector('#segment-picker-filter').addEventListener('change', e => {
      filter = e.target.value;
      render();
    });
    content.querySelectorAll('.segment-picker-suggest').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        const c = data.candidates.find(c => (c.name || `Climb in ${c.activity_name || c.activity_id}`) === name);
        if (c) apply(c);
      });
    });
    content.querySelectorAll('.segment-picker-row').forEach(tr => {
      tr.addEventListener('click', () => apply(list[parseInt(tr.dataset.idx)]));
    });
  };

  const apply = async (candidate) => {
    if (!candidate) return;
    if (!confirm(`Replace this segment with "${candidate.name || 'the selected segment'}"?`)) return;
    content.innerHTML = '<div class="text-center py-4"><span class="spinner-border" role="status"></span></div>';
    try {
      await replaceSegmentByGps(activityId, candidate, climb.start_distance_m, climb.end_distance_m);
      modal.hide();
      if (onReplaced) onReplaced();
    } catch (e) {
      content.innerHTML = `<p class="text-danger small mb-0">${escapeHtml(e.message || 'Replacement failed')}</p>`;
    }
  };

  render();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
