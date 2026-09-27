import { fetchStats } from '../utils/api.js';
import { fmtDate, fmtDuration, fmtDistance, fmtElevation, fmtHr, fmtSpeed, climbKey } from '../utils/format.js';

let statsData = null;
let period = 'year';   // 'year' | '12m' | 'all'
let monthlyChart = null;
let zonesChart = null;
let hrTrendChart = null;
let categoriesChart = null;
let countChart = null;
let loadChart = null;

function monthKey(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : '';
}

function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function monthsBetween(startIso, endIso) {
  const out = [];
  let cur = startIso;
  let guard = 0;
  while (cur <= endIso && guard++ < 600) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

function periodRange(now) {
  const year = now.slice(0, 4);
  if (period === 'year') {
    return { start: `${year}-01`, end: `${year}-12`, label: year };
  }
  if (period === '12m') {
    return { start: addMonths(now, -11), end: now, label: `last 12 months` };
  }
  return { start: null, end: null, label: 'all time' };
}

function previousRange(now) {
  if (period === 'year') {
    const prevYear = String(Number(now.slice(0, 4)) - 1);
    return { start: `${prevYear}-01`, end: `${prevYear}-12` };
  }
  if (period === '12m') {
    return { start: addMonths(now, -23), end: addMonths(now, -12) };
  }
  return null;
}

function inMonth(dateStr, range) {
  if (!range || !range.start) return true;
  const mk = monthKey(dateStr);
  return mk >= range.start && mk <= range.end;
}

export async function renderStatistics() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="container py-3">
      <h4 class="mb-3">Statistics</h4>
      <div id="stats-error" class="alert alert-warning d-none"></div>
      <div id="stats-loading" class="text-muted">Loading statistics…</div>
      <div id="stats-content" class="d-none">
        <div class="btn-group mb-3" role="group" id="stats-period">
          <button class="btn btn-sm btn-outline-primary" data-period="year">This year</button>
          <button class="btn btn-sm btn-outline-primary" data-period="12m">Last 12 months</button>
          <button class="btn btn-sm btn-outline-primary" data-period="all">All time</button>
        </div>
        <div id="stats-summary"></div>
        <div id="stats-records"></div>
        <div id="stats-charts"></div>
        <div id="stats-climbs"></div>
      </div>
    </div>
  `;

  try {
    statsData = await fetchStats();
  } catch (err) {
    document.getElementById('stats-loading').classList.add('d-none');
    const errEl = document.getElementById('stats-error');
    errEl.textContent = 'Could not load statistics. Is the server running?';
    errEl.classList.remove('d-none');
    return;
  }
  document.getElementById('stats-loading').classList.add('d-none');
  document.getElementById('stats-content').classList.remove('d-none');

  document.querySelectorAll('#stats-period button').forEach(btn => {
    btn.addEventListener('click', () => {
      period = btn.dataset.period;
      renderAll();
    });
  });
  renderAll();
}

function renderAll() {
  document.querySelectorAll('#stats-period button').forEach(btn => {
    btn.classList.toggle('btn-primary', btn.dataset.period === period);
    btn.classList.toggle('btn-outline-primary', btn.dataset.period !== period);
  });
  renderSummary();
  renderRecords();
  renderCharts();
  renderClimbs();
}

function delta(current, previous) {
  if (previous == null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(0)}%`;
}

function renderSummary() {
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const range = periodRange(now);
  const prev = previousRange(now);

  const inPeriod = acts.filter(a => inMonth(a.start_time, range));
  const inPrev = prev ? acts.filter(a => inMonth(a.start_time, prev)) : [];
  const total = (list, key) => list.reduce((s, a) => s + (a[key] || 0), 0);

  const tiles = [
    { label: 'Rides', value: inPeriod.length, prev: inPrev.length },
    { label: 'Distance', value: fmtDistance(total(inPeriod, 'distance')), prev: prev ? total(inPrev, 'distance') : null, raw: total(inPeriod, 'distance'), rawPrev: prev ? total(inPrev, 'distance') : null },
    { label: 'Elevation', value: fmtElevation(total(inPeriod, 'ascent')), raw: total(inPeriod, 'ascent'), rawPrev: prev ? total(inPrev, 'ascent') : null },
    { label: 'Time', value: fmtDuration(total(inPeriod, 'moving_time')), raw: total(inPeriod, 'moving_time'), rawPrev: prev ? total(inPrev, 'moving_time') : null },
    { label: 'Calories', value: Math.round(total(inPeriod, 'calories')).toLocaleString(), raw: total(inPeriod, 'calories'), rawPrev: prev ? total(inPrev, 'calories') : null },
  ];

  let biggest = null;
  for (const a of inPeriod) {
    if (!biggest || (a.distance || 0) > (biggest.distance || 0)) biggest = a;
  }

  // Week (ISO yyyy-Www) with the most climb elevation in the period.
  const weekOf = t => {
    const d = new Date(t);
    const day = (d.getUTCDay() + 6) % 7;   // Monday = 0
    d.setUTCDate(d.getUTCDate() - day);
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week1 = new Date(Date.UTC(jan4.getUTCFullYear(), 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
    const w = Math.floor((d - week1) / (7 * 24 * 3600 * 1000)) + 1;
    return `${d.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
  };
  const climbWeeks = {};
  for (const o of statsData.climb_occurrences) {
    if (!inMonth(o.start_time, range)) continue;
    const wk = weekOf(o.start_time);
    climbWeeks[wk] = (climbWeeks[wk] || 0) + (o.elevation_gain_m || 0);
  }
  const bestClimbWeek = Object.entries(climbWeeks).sort((a, b) => b[1] - a[1])[0];
  const avgDistance = inPeriod.length ? total(inPeriod, 'distance') / inPeriod.length : 0;
  const avgDistancePrev = inPrev.length ? total(inPrev, 'distance') / inPrev.length : null;

  const tiles2 = [
    { label: 'Avg ride distance', value: fmtDistance(avgDistance), raw: avgDistance || null, rawPrev: avgDistancePrev },
    bestClimbWeek ? { label: `Biggest climb week (${bestClimbWeek[0]})`, value: fmtElevation(bestClimbWeek[1]) } : null,
  ].filter(Boolean);

  document.getElementById('stats-summary').innerHTML = `
    <div class="row g-2 mb-3">
      ${tiles.map(t => `
        <div class="col-6 col-md-4 col-lg-2">
          <div class="card text-center p-2 h-100">
            <div class="stat-value">${t.value}</div>
            <div class="stat-label">${t.label}</div>
            ${t.rawPrev != null && t.raw != null ? `<div class="small ${delta(t.raw, t.rawPrev)?.startsWith('+') ? 'text-success' : 'text-danger'}">${delta(t.raw, t.rawPrev) || ''} vs prev.</div>` : ''}
          </div>
        </div>`).join('')}
    </div>
    <div class="row g-2 mb-2">
      ${tiles2.map(t => `
        <div class="col-6 col-md-4 col-lg-3">
          <div class="card text-center p-2 h-100">
            <div class="stat-value">${t.value}</div>
            <div class="stat-label">${t.label}</div>
          </div>
        </div>`).join('')}
    </div>
    ${biggest ? `
    <div class="row g-2 mb-3">
      <div class="col-12">
        <div class="card p-2">
          <span class="small text-muted">Biggest ride:</span>
          <a href="#activity/${biggest.activity_id}" class="fw-semibold">${escapeHtml(biggest.name || 'Unnamed ride')}</a>
          <span class="small text-muted">${fmtDate(biggest.start_time)} · ${fmtDistance(biggest.distance)} · ${fmtElevation(biggest.ascent)}</span>
        </div>
      </div>
    </div>` : ''}
  `;
}

function renderRecords() {
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const range = periodRange(now);
  const inPeriod = acts.filter(a => inMonth(a.start_time, range));

  const best = (fn) => inPeriod.reduce((acc, a) => {
    const v = fn(a);
    if (v == null) return acc;
    if (!acc || v > acc.v) return { a, v };
    return acc;
  }, null);

  const longest = best(a => a.distance);
  const climbing = best(a => a.ascent);
  const fastest = best(a => (a.distance >= 20 && a.avg_speed) ? a.avg_speed : null);
  const maxHr = best(a => a.max_hr);
  const climbsPerRide = {};
  for (const o of statsData.climb_occurrences) {
    if (inMonth(o.start_time, range)) climbsPerRide[o.activity_id] = (climbsPerRide[o.activity_id] || 0) + 1;
  }
  const mostClimbsEntry = Object.entries(climbsPerRide).sort((a, b) => b[1] - a[1])[0];
  const mostClimbs = mostClimbsEntry
    ? { a: inPeriod.find(a => a.activity_id === mostClimbsEntry[0]), v: mostClimbsEntry[1] }
    : null;

  const climbs = statsData.climb_occurrences.filter(o => inMonth(o.start_time, range));
  // Best VAM only over real climbs: VAM is meaningless on tiny or flat
  // segments (the gain/elapsed ratio explodes on 15 m noise segments and
  // dilutes on segments that include flat run-outs).
  const vamCandidates = climbs.filter(o =>
    o.vam && (o.elevation_gain_m || 0) >= 50 && (o.length_m || 0) >= 500);
  const bestVam = vamCandidates.reduce((acc, o) => (!acc || o.vam > acc.vam) ? { o, v: o.vam } : acc, null);

  const rows = [
    longest && { label: 'Longest ride', a: longest.a, text: fmtDistance(longest.v) },
    climbing && { label: 'Biggest climbing day', a: climbing.a, text: fmtElevation(climbing.v) },
    fastest && { label: 'Fastest avg speed (20 km+)', a: fastest.a, text: fmtSpeed(fastest.v) },
    maxHr && { label: 'Max heart rate', a: maxHr.a, text: fmtHr(maxHr.v) },
    bestVam && { label: 'Best VAM climb', a: { activity_id: bestVam.o.activity_id }, text: `${Math.round(bestVam.o.vam)} m/h · ${escapeHtml(bestVam.o.validated_name || bestVam.o.category || 'Unnamed')}`, climbKey: climbKey(bestVam.o.activity_id, bestVam.o.start_distance_m, bestVam.o.end_distance_m) },
    mostClimbs && { label: 'Most climbs in one ride', a: mostClimbs.a, text: `${mostClimbs.v}` },
  ].filter(Boolean);
  document.getElementById('stats-records').innerHTML = rows.length ? `
    <div class="card mb-3">
      <div class="card-header fw-semibold">Personal records — ${range.label}</div>
      <div class="card-body p-0">
        <table class="table table-sm mb-0">
          <tbody>
            ${rows.map(r => `
              <tr>
                <td class="text-muted ps-3">${r.label}</td>
                <td class="fw-semibold">${r.text}</td>
                <td class="text-end pe-3">${r.a.start_time ? fmtDate(r.a.start_time) : ''} ${r.climbKey ? `<a href="#climb/${r.climbKey}" class="ms-2 small">view</a>` : (r.a.activity_id ? `<a href="#activity/${r.a.activity_id}" class="ms-2 small">view</a>` : '')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  ` : '';
}

function renderCharts() {
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const range = periodRange(now);
  const isAllTime = period === 'all';

  // Aggregate per month over the selected period (or all data for 'all').
  const scope = isAllTime ? { start: monthKey(acts[0].start_time), end: now } : range;
  const months = monthsBetween(scope.start, scope.end);
  const perMonth = {};
  for (const m of months) perMonth[m] = { distance: 0, ascent: 0, count: 0, time: 0, calories: 0, hr: [], speed: [], cadence: [] };
  for (const a of acts) {
    const m = monthKey(a.start_time);
    if (!perMonth[m]) continue;
    perMonth[m].distance += a.distance || 0;
    perMonth[m].ascent += a.ascent || 0;
    perMonth[m].count += 1;
    perMonth[m].time += a.moving_time || 0;
    perMonth[m].calories += a.calories || 0;
    if (a.avg_hr) perMonth[m].hr.push(a.avg_hr);
    if (a.avg_speed) perMonth[m].speed.push(a.avg_speed);
    if (a.avg_cadence) perMonth[m].cadence.push(a.avg_cadence);
  }

  // For all time, charts average per calendar month (Jan..Dec) across
  // years, so adding more years never widens the chart.
  const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let labels, distKm, ascentM, hrMonths, hrAvg, speedAvg, cadenceAvg, rideCounts;
  if (isAllTime) {
    const years = new Set(months.map(m => m.slice(0, 4)));
    const nYears = Math.max(1, years.size);
    const byCal = {};
    for (const m of months) {
      const cm = m.slice(5, 7);
      byCal[cm] = byCal[cm] || { dist: 0, asc: 0, count: 0, cal: 0, hr: [], speed: [], cadence: [] };
      byCal[cm].count += perMonth[m].count;
      byCal[cm].cal += perMonth[m].calories;
      byCal[cm].cadence.push(...perMonth[m].cadence);
      byCal[cm].dist += perMonth[m].distance;
      byCal[cm].asc += perMonth[m].ascent;
      byCal[cm].hr.push(...perMonth[m].hr);
      byCal[cm].speed.push(...perMonth[m].speed);
    }
    labels = CAL_MONTHS;
    distKm = CAL_MONTHS.map((_, i) => {
      const e = byCal[String(i + 1).padStart(2, '0')];
      return e ? e.dist / nYears : 0;
    });
    ascentM = CAL_MONTHS.map((_, i) => {
      const e = byCal[String(i + 1).padStart(2, '0')];
      return e ? e.asc / nYears : 0;
    });
    rideCounts = CAL_MONTHS.map((_, i) => {
      const e = byCal[String(i + 1).padStart(2, '0')];
      return e ? e.count / nYears : 0;
    });
    hrMonths = labels;
    const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
    hrAvg = CAL_MONTHS.map((_, i) => {
      const e = byCal[String(i + 1).padStart(2, '0')];
      return e ? mean(e.hr) : null;
    });
    speedAvg = CAL_MONTHS.map((_, i) => {
      const e = byCal[String(i + 1).padStart(2, '0')];
      return e ? mean(e.speed) : null;
    });
    cadenceAvg = CAL_MONTHS.map((_, i) => {
      const e = byCal[String(i + 1).padStart(2, '0')];
      return e ? mean(e.cadence) : null;
    });
  } else {
    labels = months;
    distKm = months.map(m => perMonth[m].distance);
    ascentM = months.map(m => perMonth[m].ascent);
    rideCounts = months.map(m => perMonth[m].count);
    const hrWindowStart = addMonths(now, -11);
    hrMonths = months.filter(m => m >= hrWindowStart);
    hrAvg = hrMonths.map(m => {
      const h = perMonth[m].hr;
      return h.length ? h.reduce((s, v) => s + v, 0) / h.length : null;
    });
    speedAvg = hrMonths.map(m => {
      const s = perMonth[m].speed;
      return s.length ? s.reduce((x, v) => x + v, 0) / s.length : null;
    });
    cadenceAvg = hrMonths.map(m => {
      const c = perMonth[m].cadence;
      return c.length ? c.reduce((x, v) => x + v, 0) / c.length : null;
    });
  }

  const monthlyTitle = isAllTime ? 'Average distance &amp; elevation per calendar month' : 'Distance &amp; elevation per month';
  const trendTitle = isAllTime ? 'Avg HR &amp; speed &amp; cadence per calendar month' : 'Avg HR &amp; speed &amp; cadence (last 12 months)';
  const countTitle = isAllTime ? 'Average rides per calendar month' : 'Rides per month';

  document.getElementById('stats-charts').innerHTML = `
    <div class="card mb-3">
      <div class="card-header fw-semibold">${monthlyTitle}</div>
      <div class="card-body p-2">
        <div style="height: 280px; position: relative;"><canvas id="stats-monthly-chart"></canvas></div>
      </div>
    </div>
    <div class="card mb-3">
      <div class="card-header fw-semibold">${countTitle}</div>
      <div class="card-body p-2">
        <div style="height: 220px; position: relative;"><canvas id="stats-count-chart"></canvas></div>
      </div>
    </div>
    <div class="card mb-3">
      <div class="card-header fw-semibold">HR zones — ${range.label} &nbsp;·&nbsp; ${trendTitle}</div>
      <div class="card-body p-2">
        <div class="row">
          <div class="col-md-5"><div style="height: 240px; position: relative;"><canvas id="stats-zones-chart"></canvas></div></div>
          <div class="col-md-7"><div style="height: 240px; position: relative;"><canvas id="stats-hr-trend-chart"></canvas></div></div>
        </div>
      </div>
    </div>
    <div id="stats-extras"></div>
  `;

  renderExtras(acts, range);

  // Monthly distance + elevation bars
  if (monthlyChart) monthlyChart.destroy();
  monthlyChart = new window.Chart(document.getElementById('stats-monthly-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Distance (km)',
          data: distKm,
          backgroundColor: 'rgba(13, 110, 253, 0.7)',
          yAxisID: 'yDist',
        },
        {
          label: 'Elevation (m)',
          data: ascentM,
          backgroundColor: 'rgba(25, 135, 84, 0.55)',
          yAxisID: 'yElev',
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, labels: { boxWidth: 12 } } },
      scales: {
        x: { stacked: false, ticks: { maxRotation: 45 } },
        yDist: { position: 'left', title: { display: true, text: 'Distance (km)' } },
        yElev: { position: 'right', title: { display: true, text: 'Elevation (m)' }, grid: { drawOnChartArea: false } },
      }
    }
  });

  // Rides per month
  if (countChart) countChart.destroy();
  countChart = new window.Chart(document.getElementById('stats-count-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Rides',
          data: rideCounts.map(v => Number.isFinite(v) ? v : 0),
          backgroundColor: 'rgba(111, 66, 193, 0.65)',
          yAxisID: 'yCount',
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, labels: { boxWidth: 12 } } },
      scales: {
        x: { ticks: { maxRotation: 45 } },
        yCount: { position: 'left', title: { display: true, text: 'Rides' }, ticks: { precision: 1 } },
      }
    }
  });

  // HR zone donut for the period
  const zoneKeys = ['hrz_1_time', 'hrz_2_time', 'hrz_3_time', 'hrz_4_time', 'hrz_5_time'];
  const zoneLabels = ['Z1 Recovery', 'Z2 Endurance', 'Z3 Tempo', 'Z4 Threshold', 'Z5 Anaerobic'];
  const zoneColors = ['#adb5bd', '#0dcaf0', '#198754', '#ffc107', '#dc3545'];
  const zoneTotals = zoneKeys.map(k =>
    acts.filter(a => inMonth(a.start_time, range)).reduce((s, a) => s + (a[k] || 0), 0));

  if (zonesChart) zonesChart.destroy();
  zonesChart = new window.Chart(document.getElementById('stats-zones-chart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: zoneLabels,
      datasets: [{ data: zoneTotals, backgroundColor: zoneColors }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: { callbacks: { label: i => `${i.label}: ${fmtDuration(i.raw)}` } }
      }
    }
  });

  // Avg HR / speed trend (per calendar month in all time, last 12 months
  // otherwise; values computed above).
  if (hrTrendChart) hrTrendChart.destroy();
  hrTrendChart = new window.Chart(document.getElementById('stats-hr-trend-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: hrMonths,
      datasets: [
        { label: 'Avg HR (bpm)', data: hrAvg, borderColor: '#dc3545', borderWidth: 2, pointRadius: 2, yAxisID: 'yHr', tension: 0.2 },
        { label: 'Avg speed (km/h)', data: speedAvg, borderColor: '#0d6efd', borderWidth: 2, pointRadius: 2, yAxisID: 'ySpeed', tension: 0.2 },
        { label: 'Avg cadence (rpm)', data: cadenceAvg, borderColor: '#6f42c1', borderWidth: 2, pointRadius: 2, yAxisID: 'yCad', tension: 0.2, spanGaps: true },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, labels: { boxWidth: 12 } } },
      scales: {
        x: { ticks: { maxRotation: 45 } },
        yHr: { position: 'left', title: { display: true, text: 'HR (bpm)' }, beginAtZero: false },
        ySpeed: { position: 'right', title: { display: true, text: 'Speed (km/h)' }, grid: { drawOnChartArea: false } },
        yCad: { display: false, position: 'right', beginAtZero: false },
      }
    }
  });
}

function renderExtras(acts, range) {
  const inPeriod = acts.filter(a => inMonth(a.start_time, range));
  const loadRides = inPeriod.filter(a => a.training_load != null);

  if (loadRides.length < 3) {
    document.getElementById('stats-extras').innerHTML = '';
    return;
  }

  document.getElementById('stats-extras').innerHTML = `
    <div class="card mb-3">
      <div class="card-header fw-semibold">Training load (${loadRides.length} rides with data)</div>
      <div class="card-body p-2">
        <div style="height: 240px; position: relative;"><canvas id="stats-load-chart"></canvas></div>
      </div>
    </div>
  `;

  if (loadChart) loadChart.destroy();
  loadRides.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  loadChart = new window.Chart(document.getElementById('stats-load-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: loadRides.map(a => a.start_time.slice(0, 10)),
      datasets: [{
        label: 'Training load',
        data: loadRides.map(a => a.training_load),
        borderColor: '#fd7e14',
        backgroundColor: 'rgba(253, 126, 20, 0.2)',
        borderWidth: 2,
        pointRadius: 1,
        fill: true,
        tension: 0.2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: items => loadRides[items[0].dataIndex] ? loadRides[items[0].dataIndex].name || loadRides[items[0].dataIndex].start_time.slice(0, 10) : '' } }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, maxRotation: 45 } },
        y: { title: { display: true, text: 'Load' }, beginAtZero: true },
      }
    }
  });
}

function renderClimbs() {
  const occs = statsData.climb_occurrences;
  const acts = statsData.activities;
  const now = monthKey(acts.length ? acts[acts.length - 1].start_time : '');
  const range = periodRange(now);
  const inPeriod = occs.filter(o => inMonth(o.start_time, range));

  const totalGain = inPeriod.reduce((s, o) => s + (o.elevation_gain_m || 0), 0);

  const catOrder = ['HC', 'Cat 1', 'Cat 2', 'Cat 3', 'Cat 4'];
  const catColors = { 'HC': '#dc3545', 'Cat 1': '#fd7e14', 'Cat 2': '#ffc107', 'Cat 3': '#20c997', 'Cat 4': '#198754', 'Uncategorized': '#adb5bd' };
  const catCounts = {};
  for (const o of inPeriod) catCounts[o.category] = (catCounts[o.category] || 0) + 1;

  // Hardest = highest category then avg grade
  const rank = c => { const i = catOrder.indexOf(c); return i === -1 ? 99 : i; };
  const hardest = inPeriod.reduce((acc, o) => {
    if (!acc) return o;
    if (rank(o.category) < rank(acc.category)) return o;
    if (rank(o.category) === rank(acc.category) && (o.avg_grade_percent || 0) > (acc.avg_grade_percent || 0)) return o;
    return acc;
  }, null);

  // Favorite = most repeated group
  const groupCount = {};
  for (const o of inPeriod) {
    if (!o.group_id) continue;
    groupCount[o.group_id] = (groupCount[o.group_id] || 0) + 1;
  }
  const favGroup = Object.entries(groupCount).sort((a, b) => b[1] - a[1])[0];
  const favOcc = favGroup ? inPeriod.find(o => o.group_id === favGroup[0] && o.validated_name) || inPeriod.find(o => o.group_id === favGroup[0]) : null;

  // Hardest 10: category first (HC hardest), then average grade, then length.
  const hardness = o => {
    const r = rank(o.category);
    const catScore = r === 99 ? -60 : -r * 10;
    return catScore + (o.avg_grade_percent || 0) + (o.length_m || 0) / 100000;
  };
  const hardest10 = inPeriod
    .slice()
    .sort((a, b) => hardness(b) - hardness(a))
    .slice(0, 10);

  document.getElementById('stats-climbs').innerHTML = `
    <div class="card mb-3">
      <div class="card-header fw-semibold">Climbs — ${range.label}</div>
      <div class="card-body">
        <div class="row g-2 mb-3">
          <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${inPeriod.length}</div><div class="stat-label">Climbs</div></div></div>
          <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${fmtElevation(totalGain)}</div><div class="stat-label">Elevation in climbs</div></div></div>
          <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${hardest ? (hardest.category === 'Uncategorized' ? fmtGradeShort(hardest.avg_grade_percent) : hardest.category) : '—'}</div><div class="stat-label">Hardest climb</div></div></div>
          <div class="col-6 col-md-3"><div class="card text-center p-2"><div class="stat-value">${favOcc ? escapeHtml(favOcc.validated_name || (favOcc.category !== 'Uncategorized' ? favOcc.category : 'Unnamed')) : '—'}</div><div class="stat-label">Most repeated (${favGroup ? favGroup[1] : 0}×)</div></div></div>
        </div>
        <div class="row g-2">
          <div class="col-lg-5">
            <h6 class="small text-muted text-uppercase">Category distribution</h6>
            <div style="height: 200px; position: relative;"><canvas id="stats-categories-chart"></canvas></div>
          </div>
          <div class="col-lg-7">
            <h6 class="small text-muted text-uppercase">Hardest 10 climbs</h6>
            <div class="table-responsive">
              <table class="table table-sm mb-0">
                <thead><tr><th>Climb</th><th>Category</th><th class="text-end">Avg grade</th><th class="text-end">Length</th><th class="text-end">Gain</th></tr></thead>
                <tbody>
                  ${hardest10.map(o => `
                    <tr>
                      <td><a href="#climb/${climbKey(o.activity_id, o.start_distance_m, o.end_distance_m)}" class="text-decoration-none">${escapeHtml(o.validated_name || o.category || 'Unnamed')}</a></td>
                      <td><span class="badge bg-secondary">${o.category || '—'}</span></td>
                      <td class="text-end">${fmtGradeShort(o.avg_grade_percent)}</td>
                      <td class="text-end">${(o.length_m / 1000).toFixed(1)} km</td>
                      <td class="text-end">${fmtElevation(o.elevation_gain_m)}</td>
                    </tr>`).join('') || '<tr><td colspan="5" class="text-muted">No climbs in this period.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  if (categoriesChart) categoriesChart.destroy();
  categoriesChart = new window.Chart(document.getElementById('stats-categories-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: [...catOrder, 'Uncategorized'].filter(c => catCounts[c]),
      datasets: [{ label: 'Climbs', data: [...catOrder, 'Uncategorized'].filter(c => catCounts[c]).map(c => catCounts[c]), backgroundColor: [...catOrder, 'Uncategorized'].filter(c => catCounts[c]).map(c => catColors[c]) }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

function fmtGradeShort(p) {
  if (p == null) return '—';
  return `${p.toFixed(1)}%`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
