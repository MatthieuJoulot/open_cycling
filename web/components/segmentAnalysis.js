import { fetchProfile } from '../utils/api.js';

const BIN_SIZES = [200, 500, 1000];

const METRICS = {
  avg_speed: { label: 'Avg speed', axis: 'Speed (km/h)', unit: ' km/h', decimals: 1, field: 'speed', higherIsBetter: true },
  avg_hr: { label: 'Avg HR', axis: 'HR (bpm)', unit: ' bpm', decimals: 0, field: 'hr', higherIsBetter: false },
  vam: { label: 'VAM', axis: 'VAM (m/h)', unit: ' m/h', decimals: 0, field: null, higherIsBetter: true },
  avg_power: { label: 'Avg power', axis: 'Power (W)', unit: ' W', decimals: 0, field: 'power', higherIsBetter: true },
  est_wkg: { label: 'Est. power/kg', axis: 'Est. power (W/kg)', unit: ' W/kg', decimals: 2, field: null, higherIsBetter: true },
  avg_cadence: { label: 'Avg cadence', axis: 'Cadence (rpm)', unit: ' rpm', decimals: 0, field: 'cadence', higherIsBetter: true },
};

// Physics constants for the power estimation (same model as the backend
// and the wiki: gravity + rolling + air, ~2.5% drivetrain loss, ~10 kg bike).
const EST = { CRR: 0.005, CDA: 0.32, DRIVETRAIN: 0.975, G: 9.81, BIKE_KG: 10 };

let riderWeightCache;
async function loadRiderWeightKg() {
  if (riderWeightCache !== undefined) return riderWeightCache;
  try {
    const p = await fetchProfile();
    riderWeightCache = p?.athlete?.weight_kg || null;
  } catch (err) {
    riderWeightCache = null;
  }
  return riderWeightCache;
}

function defaultBinSize(totalM) {
  if (totalM < 1000) return 200;
  if (totalM < 2000) return 500;
  return 1000;
}

function pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function gradeColor(grade) {
  if (grade == null) return '#0d6efd';
  if (grade < 0) return '#6c757d';
  if (grade < 3) return '#198754';
  if (grade < 6) return '#20c997';
  if (grade < 9) return '#ffc107';
  if (grade < 12) return '#fd7e14';
  return '#dc3545';
}

function interpolateAltitude(segment, distM) {
  if (segment.length === 0) return null;
  if (distM <= segment[0].distance) return segment[0].altitude;
  if (distM >= segment[segment.length - 1].distance) return segment[segment.length - 1].altitude;
  for (let i = 1; i < segment.length; i++) {
    const a = segment[i - 1];
    const b = segment[i];
    if (distM >= a.distance && distM <= b.distance) {
      const span = b.distance - a.distance;
      if (span <= 0) return a.altitude;
      const t = (distM - a.distance) / span;
      return a.altitude + t * (b.altitude - a.altitude);
    }
  }
  return null;
}

function computeBins(records, startM, endM, binSizeM, riderKg) {
  const segment = records.filter(r => r.distance != null && r.distance >= startM && r.distance <= endM);
  if (segment.length < 2) return { bins: [], segment };

  const totalM = endM - startM;
  const bins = [];
  let k = 0;
  while (k * binSizeM < totalM) {
    const bucketStart = startM + k * binSizeM;
    const bucketEnd = Math.min(startM + (k + 1) * binSizeM, startM + totalM);
    const inside = segment.filter(r => r.distance >= bucketStart && r.distance <= bucketEnd);
    if (inside.length > 0) {
      const startAlt = interpolateAltitude(segment, bucketStart);
      const endAlt = interpolateAltitude(segment, bucketEnd);
      const length = bucketEnd - bucketStart;
      const gain = (startAlt != null && endAlt != null) ? endAlt - startAlt : null;
      const grade = (gain != null && length > 0) ? (gain / length) * 100 : null;

      const avgOf = field => {
        const vals = inside.map(r => r[field]).filter(v => v != null && !isNaN(v));
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };

      let duration = null;
      let vam = null;
      const tsInside = inside.filter(r => r.timestamp);
      if (tsInside.length >= 2) {
        duration = (new Date(tsInside[tsInside.length - 1].timestamp) - new Date(tsInside[0].timestamp)) / 1000;
        if (duration > 0 && gain != null) vam = (gain / duration) * 3600;
      }

      // Estimated W/kg for the bin: physics model with the bin's average
      // speed (m/s), grade and mid-bin altitude. Same constants as backend.
      let estWkg = null;
      if (riderKg && grade != null && grade > 1.5 && duration > 0 && length > 0) {
        const v = (length / duration);                       // m/s
        const gradeFrac = grade / 100;
        if (v > 0.5) {
          const mass = riderKg + EST.BIKE_KG;
          const midAlt = ((startAlt != null ? startAlt : 0) + (endAlt != null ? endAlt : 0)) / 2;
          const rho = 1.225 * Math.exp(-midAlt / 8500);
          const theta = Math.atan(gradeFrac);
          const fGrav = mass * EST.G * Math.sin(theta);
          const fRoll = mass * EST.G * EST.CRR * Math.cos(theta);
          const fAir = 0.5 * rho * EST.CDA * v * v;
          const w = (fGrav + fRoll + fAir) * v / EST.DRIVETRAIN;
          if (w > 0 && w < 2000) estWkg = w / riderKg;
        }
      }

      bins.push({
        idx: k,
        startDistKm: (bucketStart - startM) / 1000,
        endDistKm: (bucketEnd - startM) / 1000,
        length,
        gain,
        grade,
        duration,
        vam,
        avg_speed: avgOf('speed'),
        avg_hr: avgOf('hr'),
        avg_power: avgOf('power'),
        avg_cadence: avgOf('cadence'),
        est_wkg: estWkg,
      });
    }
    k++;
  }
  return { bins, segment };
}

export async function openSegmentAnalysis({ climb, records, activityName, fetchMatches, fetchRecords }) {
  const existing = document.getElementById('segment-analysis-modal');
  if (existing) existing.remove();

  const startM = climb.start_distance_m;
  const endM = climb.end_distance_m;
  const totalM = endM - startM;
  const hasPower = records.some(r => r.power != null);
  const hasCadence = records.some(r => r.cadence != null);
  const riderKg = await loadRiderWeightKg();
  let binSizeM = defaultBinSize(totalM);
  let metric = 'avg_speed';
  let showAvg = false;
  let showBest = false;
  let chart = null;

  // Other attempts on this segment (same group), each with its records.
  // Records are only needed for the metric; fetched lazily on first render.
  let attempts = null;   // null = unknown, [] = none, [{climb, records}] otherwise
  const attemptsCache = {};

  const loadAttempts = async () => {
    if (attempts !== null) return attempts;
    if (!fetchMatches || !fetchRecords) { attempts = []; return attempts; }
    try {
      const key = `${climb.activity_id}:${pyRound(climb.start_distance_m)}:${pyRound(climb.end_distance_m)}`;
      const matches = await fetchMatches(key);
      const members = (matches.members || []).filter(m =>
        !(m.activity_id === climb.activity_id &&
          Math.abs(m.start_distance_m - startM) < 1 && Math.abs(m.end_distance_m - endM) < 1));
      attempts = members;
    } catch (err) {
      console.warn('Failed to load segment matches', err);
      attempts = [];
    }
    return attempts;
  };

  const getAttemptRecords = async (m) => {
    const k = m.activity_id;
    if (!(k in attemptsCache)) {
      try {
        attemptsCache[k] = await fetchRecords(m.activity_id,
          'distance,altitude,hr,speed,timestamp,cadence,power', 3000);
      } catch (err) {
        attemptsCache[k] = [];
      }
    }
    return attemptsCache[k];
  };

  const modalEl = document.createElement('div');
  modalEl.id = 'segment-analysis-modal';
  modalEl.className = 'modal fade';
  modalEl.setAttribute('tabindex', '-1');
  modalEl.innerHTML = `
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">Segment analysis — ${escapeHtml(climb.name || climb.validated_name || activityName || 'Unnamed segment')}</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body">
          <div class="d-flex align-items-center gap-3 flex-wrap mb-2">
            <div>
              <label class="form-label small mb-0" for="segment-analysis-metric">Metric</label>
              <select id="segment-analysis-metric" class="form-select form-select-sm">
                <option value="avg_speed">Avg speed</option>
                <option value="avg_hr">Avg HR</option>
                <option value="vam">VAM</option>
                <option value="avg_power" ${hasPower ? '' : 'disabled'}>Avg power${hasPower ? '' : ' (no data)'}</option>
                <option value="est_wkg" ${riderKg ? '' : 'disabled'}>Est. power/kg${riderKg ? '' : ' (no weight)'}</option>
                <option value="avg_cadence" ${hasCadence ? '' : 'disabled'}>Avg cadence${hasCadence ? '' : ' (no data)'}</option>
              </select>
            </div>
            <div class="d-flex align-items-center gap-2">
              <label class="form-label small mb-0" for="segment-analysis-bin">Bin size</label>
              <input type="range" id="segment-analysis-bin" min="0" max="2" step="1" value="${BIN_SIZES.indexOf(binSizeM)}" class="form-range" style="width: 140px;">
              <span id="segment-analysis-bin-value" class="small text-muted">${binSizeM} m</span>
            </div>
          </div>
          <div style="height: 320px; position: relative;">
            <canvas id="segment-analysis-chart"></canvas>
            <p id="segment-analysis-no-data" class="text-muted small mb-0 d-none">No data for this segment.</p>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Close</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  const modal = new window.bootstrap.Modal(modalEl);
  modal.show();
  modalEl.addEventListener('hidden.bs.modal', () => {
    if (chart) chart.destroy();
    modalEl.remove();
  });

  const metricSelect = modalEl.querySelector('#segment-analysis-metric');
  const binSlider = modalEl.querySelector('#segment-analysis-bin');
  const binValue = modalEl.querySelector('#segment-analysis-bin-value');

  const render = async () => {
    const meta = METRICS[metric];
    const { bins } = computeBins(records, startM, endM, binSizeM, riderKg);
    const canvas = modalEl.querySelector('#segment-analysis-chart');
    const noData = modalEl.querySelector('#segment-analysis-no-data');
    if (!bins.length) {
      if (chart) { chart.destroy(); chart = null; }
      canvas.classList.add('d-none');
      noData.classList.remove('d-none');
      return;
    }
    canvas.classList.remove('d-none');
    noData.classList.add('d-none');

    // One bar per bin. Chart.js centers each bar on its data x; anchor the
    // bar at the bin start and give it the full bin width so each bar
    // exactly fills its bin (first bar flush with the axis).
    const data = bins.map(b => ({
      x: b.startDistKm + (b.endDistKm - b.startDistKm) / 2,
      y: b[metric],
      _w: (b.endDistKm - b.startDistKm),
    }));

    // Per-bin avg/best across ALL attempts (current one included), when
    // ticked. Computed here, drawn by the refLines plugin as dotted
    // horizontal segments spanning each bin, so they never shift the bars.
    let avgValues = null;
    let bestValues = null;
    if (showAvg || showBest) {
      const perBin = {};
      const collect = mb => {
        if (mb[metric] == null) return;
        (perBin[mb.idx] = perBin[mb.idx] || []).push(mb[metric]);
      };
      bins.forEach(collect);
      const others = attempts || [];
      for (const m of others) {
        const mRecs = await getAttemptRecords(m);
        if (!mRecs.length) continue;
        const { bins: mBins } = computeBins(mRecs, m.start_distance_m, m.end_distance_m, binSizeM, riderKg);
        mBins.forEach(collect);
      }
      // Values indexed by bin position in the current segment's bins array.
      const pick = fn => bins.map(b => {
        const vals = perBin[b.idx];
        return vals && vals.length ? fn(vals) : null;
      });
      if (showAvg) avgValues = pick(vals => vals.reduce((s, v) => s + v, 0) / vals.length);
      if (showBest) {
        // Best = best value per bin, relative to the metric's direction
        // (fastest speed, lowest HR, etc).
        bestValues = pick(vals => meta.higherIsBetter === false ? Math.min(...vals) : Math.max(...vals));
      }
    }

    if (chart) chart.destroy();
    const ctx = canvas.getContext('2d');
    chart = new window.Chart(ctx, {
      type: 'bar',
      data: {
        datasets: [
          {
            label: meta.label,
            data,
            backgroundColor: bins.map(b => gradeColor(b.grade)),
            borderWidth: 0,
            // Exact bin width in pixels is computed per-render by the
            // binBars plugin (barThickness as a number would not adapt to
            // resize). Default auto-width from midpoint spacing matches
            // the bin width already.
          },
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        layout: { padding: { top: 20 } },
        plugins: {
          legend: { display: false },
          gradeLabels: { bins },
          refLines: { bins, avgValues, bestValues },
          tooltip: {
            callbacks: {
              title: items => {
                const b = bins[items[0].dataIndex];
                return `km ${b.startDistKm.toFixed(2)} – ${b.endDistKm.toFixed(2)}`;
              },
              label: item => {
                const b = bins[item.dataIndex];
                const fmt = (label, v, unit, dec = 0) =>
                  `${label}: ${v == null ? '-' : v.toFixed(dec)}${unit}`;
                return [
                  fmt(meta.label, b[metric], meta.unit, meta.decimals),
                  fmt('Gain', b.gain, ' m', 0),
                  fmt('Grade', b.grade, '%', 1),
                  fmt('Duration', b.duration, ' s', 0),
                  fmt('Avg speed', b.avg_speed, ' km/h', 1),
                  fmt('Avg HR', b.avg_hr, ' bpm'),
                  fmt('VAM', b.vam, ' m/h'),
                  hasPower ? fmt('Avg power', b.avg_power, ' W') : null,
                  b.est_wkg != null ? fmt('Est. W/kg', b.est_wkg, ' W/kg', 2) : null,
                  hasCadence ? fmt('Avg cadence', b.avg_cadence, ' rpm') : null,
                ].filter(Boolean);
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: totalM / 1000,
            title: { display: true, text: 'Distance (km)' },
            // Ticks at bin boundaries: 0 to the left of the first bar,
            // 0.2 to its right, etc.
            ticks: { stepSize: binSizeM / 1000, autoSkip: false, includeBounds: true, maxRotation: 0, minRotation: 0 }
          },
          y: (() => {
            const cfg = {
              title: { display: true, text: meta.axis },
              beginAtZero: metric === 'vam' || metric === 'avg_cadence' || metric === 'avg_power' || metric === 'est_wkg',
            };
            // Widen the range so the avg/best lines are never clipped out
            // of the visible area.
            const refVals = [...(avgValues || []), ...(bestValues || [])].filter(v => v != null);
            if (refVals.length) {
              const barVals = bins.map(b => b[metric]).filter(v => v != null);
              const all = [...barVals, ...refVals];
              const lo = Math.min(...all);
              const hi = Math.max(...all);
              const pad = (hi - lo) * 0.1 || 1;
              cfg.min = cfg.beginAtZero ? 0 : lo - pad;
              cfg.max = hi + pad;
            }
            return cfg;
          })()
        }
      },
      plugins: [{
        id: 'refLines',
        afterDatasetsDraw(chart, args, options) {
          // Dotted per-bin segments for average (red) and best (blue),
          // drawn on top of the bars.
          const { ctx, scales: { x, y }, chartArea } = chart;
          const drawValues = (values, color) => {
            if (!values) return;
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            options.bins.forEach((b, i) => {
              const v = values[i];
              if (v == null) return;
              const px0 = x.getPixelForValue(b.startDistKm);
              const px1 = x.getPixelForValue(b.endDistKm);
              const py = y.getPixelForValue(v);
              if (py < chartArea.top || py > chartArea.bottom) return;
              ctx.beginPath();
              ctx.moveTo(px0, py);
              ctx.lineTo(px1, py);
              ctx.stroke();
            });
            ctx.restore();
          };
          drawValues(options.avgValues, '#dc3545');
          drawValues(options.bestValues, '#0d6efd');
        }
      }, {
        id: 'gradeLabels',
        afterDatasetsDraw(chart, args, options) {
          // Grade strip: one label per bar, centered above the bar itself,
          // at the top of the figure.
          const bins = options.bins || [];
          if (!bins.length) return;
          const bars = chart.getDatasetMeta(0).data;
          const { ctx, chartArea } = chart;
          ctx.save();
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = document.documentElement.getAttribute('data-bs-theme') === 'dark'
            ? 'rgba(255, 255, 255, 0.75)' : 'rgba(0, 0, 0, 0.75)';
          bins.forEach((b, i) => {
            if (b.grade == null) return;
            const bar = bars[i];
            if (!bar) return;
            ctx.fillText(`${b.grade.toFixed(1)}%`, bar.x, chartArea.top - 6);
          });
          ctx.restore();
        }
      }]
    });
  };

  metricSelect.addEventListener('change', () => { metric = metricSelect.value; render(); });
  binSlider.addEventListener('input', () => {
    binSizeM = BIN_SIZES[parseInt(binSlider.value)];
    binValue.textContent = `${binSizeM} m`;
    render();
  });

  const avgCheck = modalEl.querySelector('#segment-analysis-show-avg');
  const bestCheck = modalEl.querySelector('#segment-analysis-show-best');
  if (avgCheck) avgCheck.addEventListener('change', () => { showAvg = avgCheck.checked; render(); });
  if (bestCheck) bestCheck.addEventListener('change', () => { showBest = bestCheck.checked; render(); });

  // Load the attempts list, then rebuild the modal controls (checkboxes only
  // exist once we know there is more than one attempt).
  if (attempts === null && fetchMatches) {
    render();
    await loadAttempts();
    if (attempts.length > 0) {
      const controls = modalEl.querySelector('.d-flex.align-items-center.gap-3.flex-wrap');
      const div = document.createElement('div');
      div.className = 'd-flex align-items-center gap-3';
      div.innerHTML = `
        <div class="form-check mb-0">
          <input class="form-check-input" type="checkbox" id="segment-analysis-show-avg">
          <label class="form-check-label small" for="segment-analysis-show-avg">Average performance <span class="text-danger">— —</span></label>
        </div>
        <div class="form-check mb-0">
          <input class="form-check-input" type="checkbox" id="segment-analysis-show-best">
          <label class="form-check-label small" for="segment-analysis-show-best">Best performance <span class="text-primary">— —</span></label>
        </div>`;
      controls.appendChild(div);
      div.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.id === 'segment-analysis-show-avg') showAvg = cb.checked;
          if (cb.id === 'segment-analysis-show-best') showBest = cb.checked;
          render();
        });
      });
    }
  } else {
    render();
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
