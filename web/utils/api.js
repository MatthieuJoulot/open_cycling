const BASE = '';

export async function fetchClimbs() {
  const res = await fetch(`${BASE}/api/climbs`);
  if (!res.ok) throw new Error('Failed to load climbs');
  return res.json();
}

export async function fetchProfile() {
  const res = await fetch(`${BASE}/api/profile`);
  if (!res.ok) throw new Error('Failed to load profile');
  return res.json();
}

export async function fetchActivityDetails(id) {
  const res = await fetch(`${BASE}/api/activity/${id}/details`);
  if (!res.ok) throw new Error('Failed to load activity details');
  return res.json();
}

export async function fetchActivityRecords(id, fields = 'distance,altitude,hr,speed,timestamp', limit = 2000) {
  const res = await fetch(`${BASE}/api/activity/${id}/records?fields=${fields}&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to load activity records');
  return res.json();
}

export async function fetchClimbNames(id, suggest = true) {
  const res = await fetch(`${BASE}/api/activity/${id}/climb-names?suggest=${suggest ? 'true' : 'false'}`);
  if (!res.ok) throw new Error('Failed to load climb names');
  return res.json();
}

export async function fetchAllClimbNames() {
  const res = await fetch(`${BASE}/api/climb-names`);
  if (!res.ok) throw new Error('Failed to load climb names');
  return res.json();
}

export async function fetchClimbGroups() {
  const res = await fetch(`${BASE}/api/climb-groups`);
  if (!res.ok) throw new Error('Failed to load climb groups');
  return res.json();
}

export async function fetchClimbMatches(key) {
  const res = await fetch(`${BASE}/api/climb/${key}/matches`);
  if (!res.ok) throw new Error('Failed to load climb matches');
  return res.json();
}

export async function fetchRegions() {
  const res = await fetch(`${BASE}/api/regions`);
  if (!res.ok) throw new Error('Failed to load regions');
  return res.json();
}

export async function saveClimbName(id, startDistanceM, endDistanceM, name) {
  const res = await fetch(`${BASE}/api/activity/${id}/climb-name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_distance_m: startDistanceM, end_distance_m: endDistanceM, name }),
  });
  if (!res.ok) throw new Error('Failed to save climb name');
  return res.json();
}

export async function identifySegments(id) {
  const res = await fetch(`${BASE}/api/activity/${id}/identify-segments`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to identify segments');
  return res.json();
}

export async function saveSegment(id, startDistanceM, endDistanceM, oldStartDistanceM, oldEndDistanceM) {
  const body = { start_distance_m: startDistanceM, end_distance_m: endDistanceM };
  if (oldStartDistanceM != null && oldEndDistanceM != null) {
    body.old_start_distance_m = oldStartDistanceM;
    body.old_end_distance_m = oldEndDistanceM;
  }
  const res = await fetch(`${BASE}/api/activity/${id}/segment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to save segment');
  return res.json();
}

export async function deleteSegment(id, startDistanceM, endDistanceM) {
  const res = await fetch(`${BASE}/api/activity/${id}/segment/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_distance_m: startDistanceM, end_distance_m: endDistanceM }),
  });
  if (!res.ok) throw new Error('Failed to delete segment');
  return res.json();
}

export async function startSync() {
  const res = await fetch(`${BASE}/api/sync`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to start sync');
  return res.json();
}

export async function fetchSyncStatus() {
  const res = await fetch(`${BASE}/api/sync/status`);
  if (!res.ok) throw new Error('Failed to get sync status');
  return res.json();
}
