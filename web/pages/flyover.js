import { fetchActivityFlyover, fetchActivityDetails, fetchFlyoverPois } from '../utils/api.js';
import { renderNav } from '../components/nav.js';
import { fmtDistance, fmtElevation, fmtSpeed } from '../utils/format.js';

let flyoverMap = null;
let animState = null;

export async function renderFlyover(activityId) {
  renderNav(true);
  const app = document.getElementById('app');
  app.innerHTML = `
    <h4 class="mb-3">3D flyover</h4>
    <div class="card mb-3" id="flyover-card">
      <div class="card-body p-0 position-relative" id="flyover-container">
        <div id="flyover-map" style="height: 75vh; border-radius: .375rem;"></div>
        <div id="flyover-hud" class="position-absolute top-0 start-0 m-2 px-2 py-1 rounded d-flex gap-3 small" style="background:rgba(0,0,0,.6);color:#fff;">
          <span id="hud-dist">0 km</span>
          <span id="hud-alt">—</span>
          <span id="hud-speed">—</span>
          <span id="hud-climb" class="fw-semibold d-none" style="color:#ffd700;"></span>
        </div>
        <div class="position-absolute bottom-0 start-0 end-0 p-2" style="background:linear-gradient(transparent, rgba(0,0,0,.65));">
          <input type="range" class="form-range" id="flyover-progress" min="0" max="100" value="0" step="0.05">
          <div class="d-flex align-items-center gap-2 text-white">
            <button class="btn btn-sm btn-light" id="flyover-play-btn">▶</button>
            <select id="flyover-speed" class="form-select form-select-sm w-auto">
              <option value="0.25">×0.25</option>
              <option value="0.5">×0.5</option>
              <option value="1">×1</option>
              <option value="1.5">×1.5</option>
              <option value="2" selected>×2</option>
              <option value="2.5">×2.5</option>
              <option value="3">×3</option>
              <option value="4">×4</option>
              <option value="8">×8</option>
            </select>
            <span class="small" id="flyover-progress-label">0%</span>
            <button class="btn btn-sm btn-outline-light ms-auto" id="flyover-fullscreen-btn" title="Fullscreen">⛶</button>
            <button class="btn btn-sm btn-outline-light" id="flyover-record-btn" title="Record the flyover and download a video (starts from 0, plays to the end)">⏺ Download video</button>
          </div>
        </div>
      </div>
    </div>
    <a href="#activity/${activityId}" class="btn btn-sm btn-outline-secondary">← Back to ride</a>
  `;

  const data = await fetchActivityFlyover(activityId);
  const pts = data.points || [];
  if (pts.length < 2) {
    app.innerHTML = '<div class="alert alert-warning">No GPS track for this ride.</div>';
    return;
  }

  // Validated climbs of this ride, for the HUD badge (name + km range).
  let climbBadges = [];
  try {
    const details = await fetchActivityDetails(activityId);
    climbBadges = (details.climbs || [])
      .filter(c => c.validated_name && c.start_distance_m != null && c.end_distance_m != null)
      .map(c => ({ name: c.validated_name, startM: c.start_distance_m, endM: c.end_distance_m }));
  } catch (err) { /* optional */ }

  // POIs (cities + summits) for the 3D labels. Non-blocking: the flyover
  // starts without them and they pop in when ready.
  let poisPromise = fetchFlyoverPois(activityId).catch(() => ({ cities: [], summits: [] }));
  let pois = null;
  poisPromise.then(p => { pois = p; });

  const track = pts.map(p => [p[0], p[1], p[2]]);
  const times = pts.map(p => p[3] ? new Date(p[3]).getTime() : null);

  // Cumulative distance along the track — the animation advances by
  // metres, not points, so ground speed is constant.
  const R = 6371000, D2R = Math.PI / 180;
  const cum = [0];
  for (let i = 1; i < track.length; i++) {
    const [la1, lo1] = track[i - 1], [la2, lo2] = track[i];
    const x = (la2 - la1) * D2R, y = (lo2 - lo1) * D2R * Math.cos((la1 + la2) / 2 * D2R);
    cum.push(cum[i - 1] + Math.hypot(x, y) * R);
  }
  const totalM = cum[cum.length - 1];

  flyoverMap = new maplibregl.Map({
    container: 'flyover-map',
    style: {
      version: 8,
      sources: {
        map: {
          type: 'raster',
          // Esri World Imagery via the local tile-cache proxy: every
          // tile is cached on disk, so the flyover loads fast even on
          // repeat views and slow connections.
          tiles: [location.origin + '/tiles/esri/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: 'Imagery © Esri',
        },
        dem: {
          type: 'raster-dem',
          tiles: [location.origin + '/tiles/terrarium/{z}/{x}/{y}'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 13,
        },
      },
      layers: [
        { id: 'base', type: 'raster', source: 'map' },
      ],
    },
    center: [track[0][1], track[0][0]],
    zoom: 13,
    pitch: 55,
    bearing: 0,
    maxPitch: 80,
    attributionControl: false,
  });
  flyoverMap.on('error', e => console.warn('maplibre:', e && e.error && e.error.message));
  flyoverMap.on('load', () => {
    flyoverMap.setTerrain({ source: 'dem', exaggeration: 1.2 });
    flyoverMap.addSource('track', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: track.slice(0, 2).map(p => [p[1], p[0], p[2] || 0]),
        },
      },
    });
    flyoverMap.addLayer({
      id: 'track-line',
      type: 'line',
      source: 'track',
      paint: { 'line-color': '#ffd700', 'line-width': 4 },
    });
    // Tour-de-France-style start/end flags: green square at the départ,
    // red chequer at the arrivée. Small but instantly readable.
    flyoverMap.addSource('ends', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature',
            properties: { kind: 'start' },
            geometry: { type: 'Point', coordinates: [track[0][1], track[0][0]] } },
          { type: 'Feature',
            properties: { kind: 'end' },
            geometry: { type: 'Point', coordinates: [track[track.length - 1][1], track[track.length - 1][0]] } },
        ],
      },
    });
    flyoverMap.addLayer({
      id: 'ends-bg',
      type: 'circle',
      source: 'ends',
      paint: {
        'circle-radius': 8,
        'circle-color': '#fff',
        'circle-stroke-width': 2.5,
        'circle-stroke-color': [
          'match', ['get', 'kind'], 'start', '#28a745', '#dc3545',
        ],
      },
    });
    flyoverMap.addLayer({
      id: 'ends-dot',
      type: 'circle',
      source: 'ends',
      paint: {
        'circle-radius': 3.5,
        'circle-color': [
          'match', ['get', 'kind'], 'start', '#28a745', '#dc3545',
        ],
      },
    });
    startFlyover(track, times, cum, totalM, climbBadges, () => pois, activityId);
  });
}

function startFlyover(track, times, cum, totalM, climbBadges, getPois, activityId) {
  const hudClimb = document.getElementById('hud-climb');
  const mapContainer = document.getElementById('flyover-map');
  const playBtn = document.getElementById('flyover-play-btn');
  const progress = document.getElementById('flyover-progress');
  const progressLabel = document.getElementById('flyover-progress-label');
  const speedSel = document.getElementById('flyover-speed');
  const hudDist = document.getElementById('hud-dist');
  const hudAlt = document.getElementById('hud-alt');
  const hudSpeed = document.getElementById('hud-speed');
  const fsBtn = document.getElementById('flyover-fullscreen-btn');
  const recBtn = document.getElementById('flyover-record-btn');

  // Position (metres along the route) and a binary search to convert it
  // into a fractional track index.
  let posM = 0;
  let playing = false;
  let lastT = null;

  const mPerSec1x = totalM / 60;   // whole ride in ~60 s at 1x

  const indexAt = (m) => {
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < m) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(1, lo);
    const seg = cum[i] - cum[i - 1] || 1;
    return (i - 1) + (m - cum[i - 1]) / seg;
  };
  const mAt = (i) => cum[Math.min(cum.length - 1, Math.round(i))];

  // Fixed-distance look-ahead kernel for the camera bearing: the camera
  // aims at a point 10-30 km down the road, clamped to the ride length.
  // A fixed kernel (instead of scaling with ride length) keeps rotation
  // smooth and equally responsive on short and long rides — big enough
  // to avoid twitching on switchbacks, small enough to actually turn.
  const lookAheadM = Math.min(Math.max(10000, 250), Math.min(30000, totalM));
  let smoothBearing = null;

  const lerpPos = (i) => {
    const f = i - Math.floor(i);
    const a = track[Math.floor(i)], b = track[Math.min(track.length - 1, Math.floor(i) + 1)];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f,
            (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * f];
  };

  // Smoothed camera path: gaussian-blurred copy of the track (sigma in
  // metres of ground distance). The camera walks this while the yellow
  // line follows the real GPS line, so switchbacks make the line drift
  // across the frame — even recede briefly — without the camera
  // chasing every hairpin. Altitude is blurred too: no bobbing in dips.
  const buildCamTrack = (sigmaM) => {
    const out = new Array(track.length);
    const inv2s2 = 1 / (2 * sigmaM * sigmaM);
    for (let i = 0; i < track.length; i++) {
      // Window: +-3 sigma in ground metres, converted to point indices
      // via the cumulative-distance array (points are ~15 m apart but
      // the spacing is not guaranteed).
      let lo = i, hi = i;
      while (lo > 0 && cum[i] - cum[lo] < 3 * sigmaM) lo--;
      while (hi < track.length - 1 && cum[hi] - cum[i] < 3 * sigmaM) hi++;
      let wSum = 0, la = 0, lo2 = 0, al = 0;
      for (let j = lo; j <= hi; j++) {
        const d = cum[j] - cum[i];
        const w = Math.exp(-d * d * inv2s2);
        wSum += w;
        la += track[j][0] * w; lo2 += track[j][1] * w;
        al += (track[j][2] || 0) * w;
      }
      out[i] = [la / wSum, lo2 / wSum, al / wSum];
    }
    return out;
  };
  const camTrack = buildCamTrack(600);
  const camLerpPos = (i) => {
    const f = i - Math.floor(i);
    const a = camTrack[Math.floor(i)], b = camTrack[Math.min(camTrack.length - 1, Math.floor(i) + 1)];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f,
            a[2] + (b[2] - a[2]) * f];
  };

  function bearingDeg(a, b) {
    const D2R = Math.PI / 180;
    const dy = (b[0] - a[0]) * D2R;
    const dx = (b[1] - a[1]) * D2R * Math.cos((a[0] + b[0]) / 2 * D2R);
    let deg = Math.atan2(dx, dy) / D2R;
    return (deg + 360) % 360;
  }

  // --- 3D labels: DOM elements projected onto the map every frame ---
  const labelLayer = document.createElement('div');
  labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  mapContainer.appendChild(labelLayer);
  const labelEls = new Map();   // key -> {el, lat, lon, kind}

  const ensureLabel = (key, name, lat, lon, kind) => {
    let e = labelEls.get(key);
    if (!e) {
      const el = document.createElement('div');
      el.className = 'flyover-label';
      const color = kind === 'summit' ? '#ffd700' : '#e9ecef';
      el.innerHTML = `<span style="color:${color};font-weight:600;">${name}</span><span class="label-alt" style="color:${color};font-size:11px;display:block;"></span><div style="color:${color};font-size:14px;line-height:6px;">▼</div>`;
      labelLayer.appendChild(el);
      e = { el, lat, lon, kind, altSet: false };
      labelEls.set(key, e);
    }
    return e;
  };

  const projectLabels = () => {
    const poisNow = getPois ? getPois() : null;
    if (!poisNow) return;
    const size = flyoverMap.getContainer().getBoundingClientRect();
    const items = [
      ...(poisNow.cities || []).map(c => ({ key: 'c' + c.name, name: c.name, lat: c.lat, lon: c.lon, kind: c.kind, alt: c.alt })),
      ...(poisNow.summits || []).map(s => ({ key: 's' + s.name, name: '⛰ ' + s.name, lat: s.lat, lon: s.lon, kind: 'summit', alt: s.alt })),
    ];
    for (const it of items) {
      const e = ensureLabel(it.key, it.name, it.lat, it.lon, it.kind);
      // Altitude comes from the server payload (nearest track point's
      // GPS altitude) — terrain queries at runtime are unreliable.
      if (!e.altSet && it.alt != null) {
        e.el.querySelector('.label-alt').textContent = Math.round(it.alt) + ' m';
        e.altSet = true;
      }
      // Project to screen coords; queryTerrainElevation offsets the label
      // so it floats just above the 3D summit/city ground.
      const p = flyoverMap.project([it.lon, it.lat]);
      const x = p.x, y = p.y;
      const inView = x > -200 && x < size.width + 200 && y > -200 && y < size.height + 200;
      if (inView) {
        e.el.style.display = 'block';
        e.el.style.left = (x - e.el.offsetWidth / 2) + 'px';
        e.el.style.top = (y - e.el.offsetHeight - 6) + 'px';
      } else {
        e.el.style.display = 'none';
      }
    }
  };

  const labelStyle = document.createElement('style');
  labelStyle.textContent = `
    .flyover-label { position:absolute; display:none; text-align:center;
      font-size: 13px; font-family: system-ui, sans-serif;
      text-shadow: 0 1px 3px rgba(0,0,0,.9); transform: translateZ(0);
      pointer-events: none; }
  `;
  document.head.appendChild(labelStyle);

  // Real riding speed at index i (m/s) from the recorded timestamps.
  // Paused/duplicate-timestamp stretches yield 0 dt -> NaN/Infinity; those
  // samples are skipped by scanning neighbours for a valid one.
  const speedAtRaw = (i) => {
    const i0 = Math.max(0, Math.min(track.length - 2, Math.floor(i)));
    const i1 = i0 + 1;
    if (times[i0] && times[i1] && cum[i1] > cum[i0]) {
      const dt = (times[i1] - times[i0]) / 1000;
      if (dt > 0) {
        const s = (cum[i1] - cum[i0]) / dt;
        if (isFinite(s)) return Math.max(0.5, s);
      }
    }
    return null;
  };
  const speedAt = (i) => {
    const here = speedAtRaw(i);
    if (here != null) return here;
    // Fallback: nearest sample with a real timestamp pair.
    for (let d = 1; d < 60 && d < track.length; d++) {
      const up = speedAtRaw(Math.floor(i) + d);
      if (up != null) return up;
      const down = speedAtRaw(Math.floor(i) - d);
      if (down != null) return down;
    }
    return null;
  };
  // Average speed over the ride, to normalize the playback rate. Cap each
  // sample at 3x the median so GPS noise cannot drag the average up.
  let avgSpeed = null;
  {
    const valid = [];
    for (let i = 0; i < track.length - 1; i++) {
      const s = speedAtRaw(i);
      if (s != null) valid.push(s);
    }
    if (valid.length) {
      const sorted = valid.slice().sort((a, b) => a - b);
      const cap = sorted[Math.floor(sorted.length / 2)] * 3;
      const kept = valid.filter(v => v <= cap);
      avgSpeed = kept.reduce((a, b) => a + b, 0) / kept.length;
    }
  }
  // Smoothing window for the speed factor (avoid jerks between samples).
  let smoothFactor = 1;

  const updateCamera = (i) => {
    // Camera position/altitude come from the blurred camTrack; the
    // bearing target too, so hairpins don't yank the heading around.
    const cam = camLerpPos(i);
    const ahead = camLerpPos(Math.min(track.length - 1, indexAt(posM + lookAheadM)));
    const target = bearingDeg(cam, ahead);
    if (smoothBearing == null) smoothBearing = target;
    else {
      let d = ((target - smoothBearing + 540) % 360) - 180;
      // Dead zone: ignore small corrections, ease the rest slowly, so the
      // camera only turns on real direction changes.
      if (Math.abs(d) > 3) smoothBearing = (smoothBearing + d * 0.04 + 360) % 360;
    }
    flyoverMap.jumpTo({
      center: [cam[1], cam[0], cam[2] + 60],
      bearing: smoothBearing,
      pitch: 55,
    });
    // Reveal the track progressively. The length is synced both ways:
    // restarting or scrubbing backwards shrinks the line back so every
    // run starts with a clean track.
    const src = flyoverMap.getSource('track');
    const upto = Math.floor(i) + 1;
    const want = Math.min(track.length, upto + 1);
    if (src._data.geometry.coordinates.length !== want) {
      src.setData({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: track.slice(0, want)
            .map(p => [p[1], p[0], p[2] || 0]),
        },
      });
    }
    hudDist.textContent = fmtDistance(posM / 1000);
    hudAlt.textContent = cam[2] != null ? fmtElevation(cam[2]) : '—';
    // Validated climb badge when the camera is inside the climb's range.
    if (hudClimb) {
      const c = climbBadges.find(b => posM >= b.startM - 100 && posM <= b.endM + 100);
      if (c) {
        hudClimb.textContent = `⛰ ${c.name}`;
        hudClimb.classList.remove('d-none');
      } else {
        hudClimb.classList.add('d-none');
      }
    }
    const spd = speedAt(i);
    hudSpeed.textContent = spd ? fmtSpeed(spd * 3.6) : '—';
    const pct = totalM ? (posM / totalM) * 100 : 0;
    progress.value = pct;
    progressLabel.textContent = `${pct.toFixed(0)}%`;
    projectLabels();
  };

  function tick(t) {
    if (!playing || !animState) return;
    if (lastT != null) {
      const mult = parseFloat(speedSel.value);
      const dt = Math.min(0.1, (t - lastT) / 1000);
      // Constant ground speed in metres per second — the track is
      // resampled at fixed 15 m spacing server-side, so this is truly
      // uniform no matter how fast the ride was.
      const rate = mPerSec1x * mult;
      posM = Math.min(totalM, posM + rate * dt);
    }
    lastT = t;
    updateCamera(indexAt(posM));
    if (posM >= totalM) {
      // Ride done -> 5 s finale: zoom out to the whole route in one
      // smooth move (fit bounds), then stop.
      startFinale();
      return;
    }
    animState = requestAnimationFrame(tick);
  }

  // --- Finale: pan out to see the whole ride -------------------------
  const FINALE_S = 5;
  let finaleT0 = null;
  let finaleFit = null;

  function startFinale() {
    playing = false;
    playBtn.textContent = '▶';
    lastT = null;
    // Labels project badly once the camera pulls away — hide them.
    labelLayer.style.display = 'none';
    // Zoom out to the full route, no rotation: compute the exact camera
    // with maplibre's own fitBounds math so pitch is accounted for and
    // the whole track (start included) stays inside the frame.
    const lats = track.map(p => p[0]), lons = track.map(p => p[1]);
    finaleFit = {
      bounds: [[Math.min(...lons), Math.min(...lats)],
               [Math.max(...lons), Math.max(...lats)]],
      pitch: 30,
    };
    // Freeze the bearing: use fitBounds with the current bearing, then
    // interpolate center/zoom/pitch only (no rotation during the move).
    const cur = {
      center: flyoverMap.getCenter(),
      zoom: flyoverMap.getZoom(),
      pitch: flyoverMap.getPitch(),
      bearing: flyoverMap.getBearing(),
    };
    // Compute the target camera via the internal fitBounds calculation:
    // maplibre's Camera.fitBounds returns void but we can read the
    // resulting transform by fitting with duration 0 on a helper.
    flyoverMap.jumpTo(cur);
    flyoverMap.fitBounds(finaleFit.bounds, {
      padding: 80,
      pitch: finaleFit.pitch,
      bearing: cur.bearing,
      duration: 0,
    });
    finaleFit.cam = {
      center: flyoverMap.getCenter(),
      zoom: flyoverMap.getZoom(),
      pitch: flyoverMap.getPitch(),
      bearing: cur.bearing,
    };
    flyoverMap.jumpTo(cur);  // restore, we animate manually from here

    finaleT0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - finaleT0) / (FINALE_S * 1000));
      const e = 1 - Math.pow(1 - p, 3);   // ease-out cubic
      flyoverMap.jumpTo({
        center: [
          cur.center.lng + (finaleFit.cam.center.lng - cur.center.lng) * e,
          cur.center.lat + (finaleFit.cam.center.lat - cur.center.lat) * e,
        ],
        zoom: cur.zoom + (finaleFit.cam.zoom - cur.zoom) * e,
        pitch: cur.pitch + (finaleFit.cam.pitch - cur.pitch) * e,
        bearing: cur.bearing,
      });
      if (p < 1) animState = requestAnimationFrame(step);
      else animState = null;
    };
    animState = requestAnimationFrame(step);
  }

  function play() {
    playing = true;
    playBtn.textContent = '⏸';
    lastT = null;
    animState = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    playBtn.textContent = '▶';
    cancelAnimationFrame(animState);
    animState = null;
    lastT = null;
    finaleT0 = null;
  }

  playBtn.addEventListener('click', () => {
    if (playing) pause();
    else {
      if (posM >= totalM) { posM = 0; smoothBearing = null; }
      // Cancel any running finale before (re)starting playback.
      if (finaleT0 != null) {
        cancelAnimationFrame(animState);
        animState = null;
        finaleT0 = null;
        labelLayer.style.display = '';
      }
      play();
    }
  });

  progress.addEventListener('input', () => {
    posM = (parseFloat(progress.value) / 100) * totalM;
    // Scrubbing away from the end cancels the finale.
    if (finaleT0 != null) {
      cancelAnimationFrame(animState);
      animState = null;
      finaleT0 = null;
      labelLayer.style.display = '';
    }
    updateCamera(indexAt(posM));
  });

  // Fullscreen on the whole card so the HUD and controls stay visible.
  fsBtn.addEventListener('click', () => {
    const el = document.getElementById('flyover-container');
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen().then(() => {
      document.getElementById('flyover-map').style.height = '100vh';
      flyoverMap.resize();
    });
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      document.getElementById('flyover-map').style.height = '75vh';
      flyoverMap.resize();
    }
  }, { once: true });

  // Server-side render: click download, the server spawns headless
  // Chrome, renders every frame off-screen and assembles the MP4 with
  // ffmpeg. We just poll the job and download when ready — nothing to
  // watch, the tab can even be closed while it runs.
  let recording = false;
  let pollTimer = null;

  recBtn.addEventListener('click', async () => {
    if (recording) { clearTimeout(pollTimer); recording = false; recBtn.textContent = '⏺ Download video'; return; }
    recording = true;
    recBtn.textContent = '⏺ Queued…';
    try {
      const res = await fetch('/api/flyover-render/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: activityId, seconds: 60 }),
      });
      const { id: renderId } = await res.json();

      const poll = async () => {
        const st = await (await fetch(`/api/flyover-render/${renderId}`)).json();
        if (st.error && st.status !== 'done') { throw new Error(st.error); }
        if (st.status === 'done') {
          const a = document.createElement('a');
          a.href = st.video;
          a.download = 'flyover.mp4';
          a.click();
          recBtn.textContent = '⏺ Download video';
          recording = false;
          return;
        }
        if (st.status === 'error') throw new Error(st.error || 'render failed');
        const pct = st.total ? Math.round(st.frame / st.total * 100) : 0;
        recBtn.textContent = `⏺ ${st.status} ${pct}%`;
        pollTimer = setTimeout(poll, 1000);
      };
      poll().catch(err => {
        alert('Render failed: ' + (err?.message || err));
        recBtn.textContent = '⏺ Download video';
        recording = false;
      });
    } catch (err) {
      alert('Could not start render: ' + (err?.message || err));
      recBtn.textContent = '⏺ Download video';
      recording = false;
    }
  });

  updateCamera(0);
}
