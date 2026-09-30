// Shared elevation-profile dataset + axis config, used by the activity
// elevation chart and the segment analysis modal.
//
// The dataset draws the altitude profile as a thin filled area (blue in
// the original). When climbRanges is given, segments inside those ranges
// are highlighted in red (the same convention as the activity chart).

/**
 * Build the elevation dataset for Chart.js.
 * records: [{distance (m), altitude (m)}], pre-sorted.
 * Returns a line dataset (parsing: false) with {x: km, y: m} points.
 */
export function elevationDataset(records, climbRanges = [], options = {}) {
  const pts = records
    .filter(r => r.distance != null && r.altitude != null)
    .map(r => ({ x: r.distance / 1000, y: r.altitude }));
  const inClimb = new Array(pts.length).fill(false);
  for (const range of climbRanges) {
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].x * 1000 >= range[0] && pts[i].x * 1000 <= range[1]) {
        inClimb[i] = true;
      }
    }
  }
  const dark = typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-bs-theme') === 'dark';
  return {
    type: 'line',
    label: 'Elevation (m)',
    data: pts,
    yAxisID: options.yAxisID ?? 'yElev',
    borderWidth: options.borderWidth ?? 2,
    pointRadius: 0,
    fill: true,
    backgroundColor: options.fillColor ?? (dark ? 'rgba(13, 110, 253, 0.15)' : 'rgba(13, 110, 253, 0.1)'),
    tension: 0.1,
    order: 10,   // drawn beneath the scatter datasets
    segment: {
      borderColor: inClimb.some(Boolean)
        ? (ctx => inClimb[ctx.p0DataIndex] || inClimb[ctx.p1DataIndex] ? '#dc3545' : '#0d6efd')
        : '#0d6efd'
    },
  };
}

/**
 * Scale config for the elevation axis.
 */
export function elevationScale(records, options = {}) {
  const alts = records
    .map(r => r.altitude)
    .filter(v => v != null);
  return {
    position: 'right',
    title: { display: true, text: 'Elevation (m)' },
    suggestedMax: alts.length ? Math.max(...alts) * 1.15 : undefined,
    suggestedMin: alts.length ? Math.min(...alts) * 0.98 : undefined,
    grid: { drawOnChartArea: false },
    ...options,
  };
}
