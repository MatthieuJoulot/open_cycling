import { loadRiderWeightKg as sharedLoadRiderWeightKg, estimateWkg } from '../utils/estPower.js';
import { elevationDataset, elevationScale } from '../utils/elevChart.js';

const BIN_SIZES = [200, 500, 1000];

const METRICS = {
  avg_speed: { label: 'Avg speed', axis: 'Speed (km/h)', unit: ' km/h', decimals: 1, field: 'speed', higherIsBetter: true },
  avg_hr: { label: 'Avg HR', axis: 'HR (bpm)', unit: ' bpm', decimals: 0, field: 'hr', higherIsBetter: false },
  vam: { label: 'VAM', axis: 'VAM (m/h)', unit: ' m/h', decimals: 0, field: null, higherIsBetter: true },
  avg_power: { label: 'Avg power', axis: 'Power (W)', unit: ' W', decimals: 0, field: 'power', higherIsBetter: true },
  est_wkg: { label: 'Est. power/kg', axis: 'Est. power (W/kg)', unit: ' W/kg', decimals: 2, field: null, higherIsBetter: true },
  avg_cadence: { label: 'Avg cadence', axis: 'Cadence (rpm)', unit: ' rpm', decimals: 0, field: 'cadence', higherIsBetter: true },
};

const loadRiderWeightKg = sharedLoadRiderWeightKg;

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
      // speed (m/s), grade and mid-bin altitude. Shared util, same
      // constants as the backend.
      let estWkg = null;
      if (grade != null && duration > 0 && length > 0) {
        estWkg = estimateWkg(grade, length / duration,
          (startAlt != null ? startAlt : 0) / 2 + (endAlt != null ? endAlt : 0) / 2,
          riderKg);
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

export async function renderSegmentAnalysis(container, { climb, records, fetchMatches, fetchRecords, showCurrent = true }) {
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

  container.innerHTML = `
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
  `;

  const modalEl = container;
  const metricSelect = modalEl.querySelector('#segment-analysis-metric');
  const binSlider = modalEl.querySelector('#segment-analysis-bin');
  const binValue = modalEl.querySelector('#segment-analysis-bin-value');

  const render = async () => {
    const meta = METRICS[metric];
    const { bins, segment } = computeBins(records, startM, endM, binSizeM, riderKg);
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

    // One dot per bin, at the bin centre, on the metric axis.
    const binCenter = b => b.startDistKm + (b.endDistKm - b.startDistKm) / 2;
    const currentData = bins
      .filter(b => b[metric] != null)
      .map(b => ({ x: binCenter(b), y: b[metric], _bin: b }));

    // Other attempts: one grey dot per bin per attempt, snapped to the
    // current segment's bin grid so every dot sits at a bin centre.
    // Attempts may cover slightly different absolute ranges, so values
    // are matched to bins by absolute distance, not by attempt-local index.
    const othersData = [];
    const perBin = {};   // for avg/best, populated always (cheap)
    const binCenterAbs = b => b.startDistKm + (b.endDistKm - b.startDistKm) / 2;
    const collect = (mb, list) => {
      if (mb[metric] == null) return;
      (perBin[mb.idx] = perBin[mb.idx] || []).push(mb[metric]);
      if (list) list.push({ x: binCenterAbs(mb), y: mb[metric] });
    };
    bins.forEach(b => collect(b, null));
    const others = attempts || [];
    for (const m of others) {
      const mRecs = await getAttemptRecords(m);
      if (!mRecs.length) continue;
      // Bin on the current segment's absolute grid: values outside the
      // current segment's bins are dropped, partial overlaps land in the
      // bin they intersect.
      const { bins: mBins } = computeBins(mRecs, startM, endM, binSizeM, riderKg);
      const pts = [];
      mBins.forEach(mb => collect(mb, pts));
      othersData.push(...pts);
    }

    // Per-bin average and best across ALL attempts (current included),
    // dots at the same bin centres when ticked.
    let avgData = null;
    let bestData = null;
    const pick = fn => bins
      .map(b => {
        const vals = perBin[b.idx];
        return vals && vals.length ? { x: binCenter(b), y: fn(vals) } : null;
      })
      .filter(v => v != null);
    if (showAvg) avgData = pick(vals => vals.reduce((s, v) => s + v, 0) / vals.length);
    if (showBest) {
      // Best = best value per bin, relative to the metric's direction
      // (fastest speed, lowest HR, etc).
      bestData = pick(vals => meta.higherIsBetter === false ? Math.min(...vals) : Math.max(...vals));
    }

    if (chart) chart.destroy();
    const ctx = canvas.getContext('2d');

    const datasets = [];
    // Elevation area behind everything, on its own axis. Points must be
    // shifted to the segment-relative x range (0..totalM km), not the
    // activity's absolute distances.
    if (segment.length) {
      const rel = segment.map(r => ({ ...r, distance: r.distance - startM }));
      datasets.push(elevationDataset(rel, [[0, totalM]]));
    }
    const metricSets = [
      showCurrent ? {
        label: meta.label,
        data: currentData,
        type: 'scatter',
        showLine: false,
        pointRadius: 5,
        pointBackgroundColor: '#0d6efd',
        pointBorderColor: '#0d6efd',
        order: 1,
      } : null,
      othersData.length ? {
        label: 'Other attempts',
        data: othersData,
        type: 'scatter',
        showLine: false,
        pointRadius: 3,
        pointBackgroundColor: 'rgba(108, 117, 125, 0.55)',
        pointBorderColor: 'transparent',
        order: 2,
      } : null,
      avgData ? {
        label: 'Average',
        data: avgData,
        type: 'line',
        showLine: true,
        pointRadius: 4,
        pointBackgroundColor: '#dc3545',
        pointBorderColor: '#dc3545',
        borderColor: 'rgba(220, 53, 69, 0.5)',
        borderWidth: 1,
        tension: 0.2,
        order: 3,
      } : null,
      bestData ? {
        label: 'Best',
        data: bestData,
        type: 'line',
        showLine: true,
        pointRadius: 5,
        pointBackgroundColor: '#ffd700',
        pointBorderColor: '#b8860b',
        borderColor: 'rgba(255, 215, 0, 0.45)',
        borderWidth: 1,
        tension: 0.2,
        order: 0,
      } : null,
    ].filter(Boolean);
    datasets.push(...metricSets);

    // Metric axis range: cover ALL dots (current, other attempts, avg,
    // best) so nothing is clipped out of the visible area.
    const refVals = [...(avgData || []), ...(bestData || [])].map(v => v.y);
    const dotVals = [
      ...(showCurrent ? currentData.map(v => v.y) : []),
      ...othersData.map(v => v.y),
      ...refVals,
    ].filter(v => v != null);
    const beginAtZero = metric === 'vam' || metric === 'avg_cadence' || metric === 'avg_power' || metric === 'est_wkg';
    let yCfg = { title: { display: true, text: meta.axis }, beginAtZero };
    if (dotVals.length) {
      const lo = Math.min(...dotVals);
      const hi = Math.max(...dotVals);
      const pad = (hi - lo) * 0.12 || 1;
      yCfg.min = beginAtZero ? 0 : lo - pad;
      yCfg.max = hi + pad;
    }

    chart = new window.Chart(ctx, {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: {
              boxWidth: 10,
              usePointStyle: true,
              filter: item => item.datasetIndex > 0 && !item.text.startsWith('Elevation'),   // hide elevation entry
            },
          },
          tooltip: {
            callbacks: {
              title: items => {
                const b = items[0]?.raw?._bin;
                return b ? `km ${b.startDistKm.toFixed(2)} – ${b.endDistKm.toFixed(2)}` : `km ${items[0]?.parsed?.x?.toFixed(2) ?? ''}`;
              },
              label: item => {
                const b = item.raw?._bin;
                if (!b) return `${item.dataset.label}: ${item.parsed.y.toFixed(meta.decimals)}${meta.unit}`;
                const fmt = (label, v, unit, dec = 0) =>
                  `${label}: ${v == null ? '-' : v.toFixed(dec)}${unit}`;
                return [
                  `${item.dataset.label}: ${fmt('', b[metric], meta.unit, meta.decimals).replace(': ', '')}`,
                  fmt('Gain', b.gain, ' m', 0),
                  fmt('Grade', b.grade, '%', 1),
                  fmt('Duration', b.duration, ' s', 0),
                  metric === 'avg_speed' ? null : fmt('Avg speed', b.avg_speed, ' km/h', 1),
                  metric === 'avg_hr' ? null : fmt('Avg HR', b.avg_hr, ' bpm'),
                  metric === 'vam' ? null : fmt('VAM', b.vam, ' m/h'),
                  hasPower && metric !== 'avg_power' ? fmt('Avg power', b.avg_power, ' W') : null,
                  b.est_wkg != null && metric !== 'est_wkg' ? fmt('Est. W/kg', b.est_wkg, ' W/kg', 2) : null,
                  hasCadence && metric !== 'avg_cadence' ? fmt('Avg cadence', b.avg_cadence, ' rpm') : null,
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
            ticks: { maxTicksLimit: 10, maxRotation: 0, minRotation: 0 }
          },
          y: yCfg,
          yElev: segment.length ? elevationScale(segment) : { display: false },
        }
      }
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
    // Re-render with the other attempts' dots now that we know them.
    if (attempts.length > 0) render();
    if (attempts.length > 0) {
      const controls = modalEl.querySelector('.d-flex.align-items-center.gap-3.flex-wrap');
      const div = document.createElement('div');
      div.className = 'd-flex align-items-center gap-3';
      div.innerHTML = `
        <div class="form-check mb-0">
          <input class="form-check-input" type="checkbox" id="segment-analysis-show-avg">
          <label class="form-check-label small" for="segment-analysis-show-avg">Average performance <span class="text-danger">•—</span></label>
        </div>
        <div class="form-check mb-0">
          <input class="form-check-input" type="checkbox" id="segment-analysis-show-best">
          <label class="form-check-label small" for="segment-analysis-show-best">Best performance <span style="color:#b8860b">★</span></label>
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

// Modal wrapper around the inline renderer, used from the activity page
// where the analysis is opened per climb row.
export async function openSegmentAnalysis({ climb, records, activityName, fetchMatches, fetchRecords }) {
  const existing = document.getElementById('segment-analysis-modal');
  if (existing) existing.remove();

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
        <div class="modal-body" id="segment-analysis-body"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Close</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);
  const modal = new window.bootstrap.Modal(modalEl);
  modal.show();
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());

  await renderSegmentAnalysis(modalEl.querySelector('#segment-analysis-body'), {
    climb,
    records,
    fetchMatches,
    fetchRecords,
  });
}
