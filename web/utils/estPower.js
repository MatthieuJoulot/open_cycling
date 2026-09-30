// Shared physics model for estimating cycling power without a power
// meter — same constants as the backend (backend/serve.py,
// _estimate_climb_power) and the wiki page:
//   W = (F_gravity + F_rolling + F_air) · v / drivetrain efficiency
// with F_gravity from total mass and gradient, F_rolling from Crr,
// F_air from CdA and altitude-adjusted air density.
export const EST_CONSTANTS = {
  CRR: 0.005,          // rolling resistance, asphalt
  CDA: 0.32,           // aero drag (m²), hoods position
  DRIVETRAIN: 0.975,   // 2.5% drivetrain loss
  G: 9.81,
  BIKE_KG: 10,
};

let riderWeightPromise = null;

/** Rider weight (kg) from the Garmin profile via /api/profile, cached. */
export function loadRiderWeightKg() {
  if (!riderWeightPromise) {
    riderWeightPromise = fetch('/api/profile')
      .then(r => r.ok ? r.json() : null)
      .then(p => p?.athlete?.weight_kg || null)
      .catch(() => null);
  }
  return riderWeightPromise;
}

/**
 * Estimated W/kg for one section.
 * gradePercent: section grade in %. v: speed in m/s. altM: mid-section
 * altitude in m. riderKg: rider weight without the bike.
 * Returns W/kg, or null when the section is flat/downhill or the
 * numbers are implausible (no braking or wind model for the rest).
 */
export function estimateWkg(gradePercent, vMs, altM, riderKg) {
  if (!riderKg || gradePercent == null || !(gradePercent > 1.5)) return null;
  if (!vMs || vMs <= 0.5) return null;
  const mass = riderKg + EST_CONSTANTS.BIKE_KG;
  const gradeFrac = gradePercent / 100;
  const rho = 1.225 * Math.exp(-(altM || 0) / 8500);
  const theta = Math.atan(gradeFrac);
  const fGrav = mass * EST_CONSTANTS.G * Math.sin(theta);
  const fRoll = mass * EST_CONSTANTS.G * EST_CONSTANTS.CRR * Math.cos(theta);
  const fAir = 0.5 * rho * EST_CONSTANTS.CDA * vMs * vMs;
  const w = (fGrav + fRoll + fAir) * vMs / EST_CONSTANTS.DRIVETRAIN;
  if (!(w > 0 && w < 2000)) return null;
  return w / riderKg;
}

/**
 * Estimated W/kg for a whole climb attempt given its records.
 * Walks the climb at ~100 m stations and averages section watts
 * weighted by elapsed time, uphill sections only.
 * records: [{distance (m), altitude (m), speed?, timestamp?}], the
 * segment pre-filtered to the climb range. Speed is km/h when present.
 */
export function estimateClimbWkg(climb, records, riderKg) {
  if (!riderKg) return null;
  const pts = records
    .filter(r => r.distance != null && r.altitude != null && r.timestamp)
    .sort((a, b) => a.distance - b.distance);
  if (pts.length < 4) return null;
  const d0 = pts[0].distance;
  const d1 = pts[pts.length - 1].distance;
  const nSections = Math.floor((d1 - d0) / 100);
  if (nSections < 1) return null;

  // First record past each 100 m station.
  const stations = [];
  let j = 0;
  for (let s = 0; s <= nSections; s++) {
    const target = d0 + s * 100;
    while (j + 1 < pts.length && pts[j + 1].distance <= target) j++;
    stations.push(pts[Math.min(j, pts.length - 1)]);
  }

  let wattsSum = 0;
  let secsSum = 0;
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1], b = stations[i];
    const dL = b.distance - a.distance;
    if (dL < 20 || dL > 400) continue;
    const dt = (new Date(b.timestamp) - new Date(a.timestamp)) / 1000;
    if (!(dt > 0)) continue;
    const v = (b.speed != null && b.speed > 1.8)
      ? b.speed / 3.6
      : dL / dt;
    const grade = ((b.altitude - a.altitude) / dL) * 100;
    const wkg = estimateWkg(grade, v, (a.altitude + b.altitude) / 2, riderKg);
    if (wkg != null) {
      wattsSum += wkg * riderKg * dt;
      secsSum += dt;
    }
  }
  if (secsSum < 30) return null;
  return wattsSum / secsSum / riderKg;
}
