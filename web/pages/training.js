import { fetchStats } from '../utils/api.js';
import { fmtDate, fmtDistance, fmtElevation, fmtDuration } from '../utils/format.js';

let statsData = null;

export async function renderTraining() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <h4 class="mb-3">Training</h4>
    <div id="training-content"><p class="text-muted">Loading…</p></div>
  `;
  statsData = await fetchStats();
  const content = document.getElementById('training-content');
  content.innerHTML = `
    <div class="row g-3">
      <div class="col-12">
        <div class="card mb-3">
          <div class="card-header fw-semibold">Streaks</div>
          <div class="card-body" id="streak-body"></div>
        </div>
      </div>
      <div class="col-12">
        <div class="card mb-3">
          <div class="card-header fw-semibold">Fitness &amp; freshness</div>
          <div class="card-body">
            <div style="height: 340px;"><canvas id="fitness-chart"></canvas></div>
            <p class="small text-muted mb-0 mt-2" id="fitness-note"></p>
          </div>
        </div>
      </div>
      <div class="col-12">
        <div class="card mb-3">
          <div class="card-header fw-semibold">Riding calendar</div>
          <div class="card-body">
            <div id="calendar-heatmap" class="overflow-x-auto"></div>
            <p class="small text-muted mb-0 mt-2">Darker = more distance that day. Hover a day for details.</p>
          </div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card mb-3">
          <div class="card-header fw-semibold">Year over year — distance</div>
          <div class="card-body">
            <div style="height: 280px;"><canvas id="yoy-chart"></canvas></div>
          </div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card mb-3">
          <div class="card-header fw-semibold">Goals</div>
          <div class="card-body" id="goals-body"></div>
        </div>
      </div>
    </div>
  `;
  renderStreaks();
  renderFitness();
  renderCalendar();
  renderYoY();
  renderGoals();
}

function renderCalendar() {
  const el = document.getElementById('calendar-heatmap');
  const acts = statsData.activities;

  // Distance per day.
  const byDay = {};
  for (const a of acts) {
    const day = a.start_time.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + (a.distance || 0);
  }
  const days = Object.keys(byDay).sort();
  if (!days.length) { el.innerHTML = '<p class="text-muted mb-0">No rides.</p>'; return; }

  const first = new Date(days[0] + 'T00:00:00Z');
  const last = new Date(days[days.length - 1] + 'T00:00:00Z');
  // Start the grid on the Monday before the first ride, end on the Sunday
  // after the last: full weeks per year row.
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(last);
  end.setUTCDate(end.getUTCDate() + (6 - (end.getUTCDay() + 6) % 7));

  // Quantile-based color buckets: 0, then quartiles of ridden days.
  const ridden = days.map(d => byDay[d]).sort((a, b) => a - b);
  const q = p => ridden[Math.min(ridden.length - 1, Math.floor(p * (ridden.length - 1)))];
  const thresholds = [q(0.25), q(0.5), q(0.75), q(1)].map(v => v || 0);
  const colors = ['var(--bs-tertiary-bg)', '#c6e6c4', '#74c476', '#238b45', '#00441b'];

  // Layout: one row per year, 53 week columns, 7 day cells (compact grid).
  const years = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const y = d.getUTCFullYear();
    if (!years.length || years[years.length - 1].year !== y) years.push({ year: y, weeks: [] });
    const yr = years[years.length - 1];
    const monday = new Date(d);
    monday.setUTCDate(monday.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    let wk = yr.weeks.find(w => w.t === monday.getTime());
    if (!wk) { wk = { t: monday.getTime(), days: new Array(7).fill(null) }; yr.weeks.push(wk); }
    const day = d.toISOString().slice(0, 10);
    wk.days[(d.getUTCDay() + 6) % 7] = { day, km: byDay[day] || 0 };
  }

  const cellSize = 13, gap = 2;
  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';

  // Layout: one row per year, one <td> per day, weeks left to right.
  el.innerHTML = years.map(yr => {
    // GitHub-style grid: 7 rows (Mon..Sun) x one column per week.
    const grid = [[], [], [], [], [], [], []];   // grid[dayIdx][weekIdx]
    yr.weeks.forEach((w, wi) => {
      for (let di = 0; di < 7; di++) {
        const cell = w.days[di];
        if (!cell) { grid[di].push(`<td class="cal-empty" style="width:${cellSize}px;height:${cellSize}px;"></td>`); continue; }
        const lvl = cell.km > 0 ? Math.min(4, 1 + thresholds.filter(t => cell.km > t).length) : 0;
        const bg = lvl > 0 ? colors[lvl] : 'var(--bs-secondary-bg)';
        grid[di].push(`<td class="cal-cell" data-day="${cell.day}" data-km="${cell.km}" style="width:${cellSize}px;height:${cellSize}px;background:${bg};border:1px solid var(--bs-border-color);border-radius:2px;" title="${cell.day}: ${cell.km ? cell.km.toFixed(1) + ' km' : 'no ride'}"></td>`);
      }
    });
    const rows = grid.map(r => `<tr>${r.join('')}</tr>`).join('');
    return `
      <div class="d-flex align-items-start mb-2">
        <span class="small text-muted me-2" style="width:3rem;flex:none;">${yr.year}</span>
        <table class="cal-table m-0"><tbody>${rows}</tbody></table>
      </div>`;
  }).join('') + `
    <style>
      .cal-table { border-collapse: separate; border-spacing: ${gap}px; table-layout: fixed; }
      .cal-table td { padding: 0; }
      .cal-cell:hover { outline: 2px solid #0d6efd; }
    </style>`;
}

function renderStreaks() {
  const el = document.getElementById('streak-body');
  const acts = statsData.activities;

  // Weekly streak: consecutive ISO weeks with at least one ride.
  const weeks = new Set(acts.map(a => isoWeekKey(a.start_time)));
  const sortedWeeks = [...weeks].sort();

  // Current streak (counting back from the last ridden week; ends if the
  // current week has no ride yet, we still check from last week).
  let current = 0;
  if (sortedWeeks.length) {
    let cursor = sortedWeeks[sortedWeeks.length - 1];
    current = 1;
    while (weeks.has(prevWeekKey(cursor))) {
      cursor = prevWeekKey(cursor);
      current++;
    }
  }

  // Longest streak across all history.
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const w of sortedWeeks) {
    run = (prev && nextWeekKey(prev) === w) ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = w;
  }

  // Active weeks / total weeks since first ride.
  const first = acts.length ? acts[0].start_time.slice(0, 10) : null;
  const totalWeeks = first ? Math.max(1, Math.round((Date.now() - new Date(first)) / (7 * 864e5))) : 0;

  el.innerHTML = `
    <div class="row text-center g-3">
      <div class="col-4">
        <div class="border rounded p-2">
          <div class="stat-value">${current}</div>
          <div class="stat-label">Current streak (weeks)</div>
        </div>
      </div>
      <div class="col-4">
        <div class="border rounded p-2">
          <div class="stat-value">${longest}</div>
          <div class="stat-label">Longest streak (weeks)</div>
        </div>
      </div>
      <div class="col-4">
        <div class="border rounded p-2">
          <div class="stat-value">${weeks.size}</div>
          <div class="stat-label">Active weeks of ${totalWeeks}</div>
        </div>
      </div>
    </div>
    <p class="small text-muted mb-0 mt-2">A week counts if it has at least one ride. Streak continues while you ride every week.</p>
  `;
}

function isoWeekKey(t) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;   // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week1 = new Date(jan4);
  week1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const w = 1 + Math.floor((d - week1) / (7 * 864e5));
  return `${d.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}

function prevWeekKey(key) {
  const [y, w] = key.split('-W').map(Number);
  if (w > 1) return `${y}-W${String(w - 1).padStart(2, '0')}`;
  // Week 1 -> last week of previous year (52 or 53); compute properly.
  const jan4 = new Date(Date.UTC(y - 1, 0, 4));
  const week1 = new Date(jan4);
  week1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const dec28 = new Date(Date.UTC(y - 1, 11, 28));
  const wLast = 1 + Math.floor((dec28 - week1) / (7 * 864e5));
  return `${y - 1}-W${String(wLast).padStart(2, '0')}`;
}

function nextWeekKey(key) {
  const [y, w] = key.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const week1 = new Date(jan4);
  week1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const dec28 = new Date(Date.UTC(y, 11, 28));
  const wLast = 1 + Math.floor((dec28 - week1) / (7 * 864e5));
  if (w < wLast) return `${y}-W${String(w + 1).padStart(2, '0')}`;
  return `${y + 1}-W01`;
}

function renderFitness() {
  const canvas = document.getElementById('fitness-chart');
  const note = document.getElementById('fitness-note');
  const acts = statsData.activities;
  const withLoad = acts.filter(a => a.training_load != null);

  if (!withLoad.length) {
    note.textContent = 'No training load data available.';
    return;
  }

  // Daily load: sum training_load on the day of the ride.
  const byDay = {};
  for (const a of withLoad) {
    const day = a.start_time.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + a.training_load;
  }
  const days = Object.keys(byDay).sort();

  // Build a continuous daily series from first to last load day.
  const first = new Date(days[0] + 'T00:00:00Z');
  const last = new Date(days[days.length - 1] + 'T00:00:00Z');
  const series = [];
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    series.push({ day: key, load: byDay[key] || 0 });
  }

  // CTL: 42-day exponential moving average (fitness).
  // ATL: 7-day EMA (fatigue). TSB = CTL - ATL (form).
  const CTL_TC = 42, ATL_TC = 7;
  let ctl = null, atl = null;
  const ctlSeries = [], atlSeries = [], tsbSeries = [], labels = [];
  for (const p of series) {
    const kC = 1 - Math.exp(-1 / CTL_TC);
    const kA = 1 - Math.exp(-1 / ATL_TC);
    ctl = ctl == null ? p.load : ctl + kC * (p.load - ctl);
    atl = atl == null ? p.load : atl + kA * (p.load - atl);
    ctlSeries.push(+ctl.toFixed(1));
    atlSeries.push(+atl.toFixed(1));
    tsbSeries.push(+(ctl - atl).toFixed(1));
    labels.push(p.day.slice(5));
  }

  new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Fitness (Chronic Training Load, 42-day avg)', data: ctlSeries, borderColor: '#0d6efd', borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'Fatigue (Acute Training Load, 7-day avg)', data: atlSeries, borderColor: '#dc3545', borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'Form (Training Stress Balance = Fitness − Fatigue)', data: tsbSeries, borderColor: '#198754', borderWidth: 2, pointRadius: 0, tension: 0.2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top' } },
      scales: { x: { ticks: { maxTicksLimit: 12, maxRotation: 45 } } },
    },
  });

  const pct = Math.round(100 * withLoad.length / Math.max(1, acts.length));
  note.textContent = `Fitness = 42-day average of daily training load (long-term capacity). Fatigue = 7-day average (short-term tiredness). Form = Fitness − Fatigue: positive means rested, negative means carrying fatigue. Based on ${withLoad.length} of ${acts.length} rides (${pct}%) — older devices did not record training load.`;
}

function renderYoY() {
  const canvas = document.getElementById('yoy-chart');
  const acts = statsData.activities;
  const years = [...new Set(acts.map(a => a.start_time.slice(0, 4)))].sort();
  const lastTwo = years.slice(-2);

  const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const datasets = [];
  const colors = ['#adb5bd', '#0d6efd'];
  lastTwo.forEach((y, i) => {
    const monthly = new Array(12).fill(0);
    for (const a of acts) {
      if (a.start_time.slice(0, 4) !== y) continue;
      monthly[parseInt(a.start_time.slice(5, 7), 10) - 1] += a.distance || 0;
    }
    datasets.push({
      label: y, data: monthly.map(v => +v.toFixed(1)),
      backgroundColor: colors[i], borderColor: colors[i],
    });
  });

  new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: { x: { stacked: false }, y: { beginAtZero: true, title: { display: true, text: 'Distance (km)' } } },
    },
  });
}

function renderGoals() {
  const el = document.getElementById('goals-body');
  const acts = statsData.activities;
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const inYear = acts.filter(a => a.start_time.slice(0, 4) == year);
  const yDist = inYear.reduce((s, a) => s + (a.distance || 0), 0);
  const yElev = inYear.reduce((s, a) => s + (a.ascent || 0), 0);
  const inMonth = acts.filter(a => a.start_time.startsWith(`${year}-${String(month).padStart(2, '0')}`));
  const mDist = inMonth.reduce((s, a) => s + (a.distance || 0), 0);
  const mElev = inMonth.reduce((s, a) => s + (a.ascent || 0), 0);

  const goals = JSON.parse(localStorage.getItem('trainingGoals') || '{}');
  el.innerHTML = `
    <div class="row g-3 mb-3">
      ${goalBar('Monthly distance', mDist, goals.monthDistance, 'km')}
      ${goalBar('Monthly elevation', mElev, goals.monthElevation, 'm')}
      ${goalBar('Yearly distance', yDist, goals.yearDistance, 'km')}
      ${goalBar('Yearly elevation', yElev, goals.yearElevation, 'm')}
    </div>
    <div class="row g-2">
      <div class="col-6 col-md-3">
        <label class="form-label small text-muted">Month distance goal (km)</label>
        <input type="number" min="0" class="form-control form-control-sm" id="goal-month-distance" value="${goals.monthDistance || ''}">
      </div>
      <div class="col-6 col-md-3">
        <label class="form-label small text-muted">Month elevation goal (m)</label>
        <input type="number" min="0" class="form-control form-control-sm" id="goal-month-elevation" value="${goals.monthElevation || ''}">
      </div>
      <div class="col-6 col-md-3">
        <label class="form-label small text-muted">Year distance goal (km)</label>
        <input type="number" min="0" class="form-control form-control-sm" id="goal-year-distance" value="${goals.yearDistance || ''}">
      </div>
      <div class="col-6 col-md-3">
        <label class="form-label small text-muted">Year elevation goal (m)</label>
        <input type="number" min="0" class="form-control form-control-sm" id="goal-year-elevation" value="${goals.yearElevation || ''}">
      </div>
    </div>
  `;
  const save = () => {
    const g = {
      monthDistance: +document.getElementById('goal-month-distance').value || null,
      monthElevation: +document.getElementById('goal-month-elevation').value || null,
      yearDistance: +document.getElementById('goal-year-distance').value || null,
      yearElevation: +document.getElementById('goal-year-elevation').value || null,
    };
    localStorage.setItem('trainingGoals', JSON.stringify(g));
    renderGoals();
  };
  for (const id of ['goal-month-distance', 'goal-month-elevation', 'goal-year-distance', 'goal-year-elevation']) {
    document.getElementById(id).addEventListener('change', save);
  }
}

function goalBar(label, value, goal, unit) {
  if (!goal) return `
    <div class="col-6">
      <div class="border rounded p-2 text-center">
        <div class="stat-value">${Math.round(value).toLocaleString()} ${unit}</div>
        <div class="stat-label">${label} — set a goal →</div>
      </div>
    </div>`;
  const pct = Math.min(100, Math.round(100 * value / goal));
  const done = value >= goal;
  return `
    <div class="col-6">
      <div class="border rounded p-2">
        <div class="d-flex justify-content-between">
          <span class="small">${label}</span>
          <span class="small fw-semibold">${Math.round(value).toLocaleString()} / ${goal.toLocaleString()} ${unit}</span>
        </div>
        <div class="progress mt-1" style="height: 8px;">
          <div class="progress-bar ${done ? 'bg-success' : 'bg-primary'}" style="width: ${pct}%"></div>
        </div>
      </div>
    </div>`;
}
