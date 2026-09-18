export function fmtDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(totalSeconds) {
  if (totalSeconds == null || (typeof totalSeconds === 'number' && isNaN(totalSeconds))) return '-';
  if (typeof totalSeconds === 'string') {
    const parts = totalSeconds.split(':');
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10) || 0;
      const m = parseInt(parts[1], 10) || 0;
      const s = parseFloat(parts[2]) || 0;
      totalSeconds = h * 3600 + m * 60 + s;
    } else {
      return '-';
    }
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function fmtDistance(km) {
  if (km == null || isNaN(km)) return '-';
  return `${km.toFixed(1)} km`;
}

export function fmtElevation(m) {
  if (m == null || isNaN(m)) return '-';
  return `${Math.round(m)} m`;
}

export function fmtGrade(p) {
  if (p == null || isNaN(p)) return '-';
  return `${p.toFixed(1)}%`;
}

export function fmtSpeed(kmh) {
  if (kmh == null || isNaN(kmh)) return '-';
  return `${kmh.toFixed(1)} km/h`;
}

export function fmtHr(bpm) {
  if (bpm == null || isNaN(bpm)) return '-';
  return `${Math.round(bpm)} bpm`;
}

export function fmtPower(watts) {
  if (watts == null || isNaN(watts)) return '-';
  return `${Math.round(watts)} W`;
}
