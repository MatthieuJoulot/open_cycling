"""Segment timing semantics (Strava-style).

Segment time = elapsed clock time from the start crossing to the
ARRIVAL at the end point. Pauses inside the segment count (Strava
counts them too). What is excluded is time AFTER the arrival: riders
often stop at the col (photo, layer change) before continuing, and the
device keeps writing records at ~0 km/h plus a resume gap — that
trailing stopped time is not part of the climb.

The end of the segment is where motion stops near the end distance:
records at (or piled up at) the end with speed below STOP_SPEED_KMH
belong to the stop, not the climb. The clock closes at the first of
those records.
"""

STOP_SPEED_KMH = 3.0


def parse_timestamp(value):
    """Epoch seconds from a GarminDB timestamp value (int/float/iso str)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        import datetime
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None
    return None


def moving_seconds(rows):
    """Strava-style segment time for an ordered record window.

    Returns (elapsed, raw_elapsed):
    - raw_elapsed: last timestamp - first timestamp (as before).
    - elapsed: clock time from the first record to the ARRIVAL at the
      end — trailing records below the stop speed (the stop at/after
      the col, including the resume gap they introduce) are excluded.
    Mid-segment pauses count, like Strava.
    """
    if not rows:
        return None, None

    ts = [parse_timestamp(r["timestamp"]) for r in rows]
    if ts[0] is None or ts[-1] is None:
        return None, None
    raw = ts[-1] - ts[0]

    has_speed = any("speed" in r.keys() and r["speed"] is not None for r in rows)
    if not has_speed:
        return raw, raw

    # Arrival index: the last record that is genuinely in motion, where
    # "in motion" means moving at (or above) stop speed AND not sitting
    # after a big time hole. A stop at the top shows up as: slow records
    # at the end distance, then a long gap (the device auto-paused), then
    # records again (often still inside the end-distance window because
    # the rider rolls only a few more metres before the query cuts off).
    # Any such trailing hole is not climb time.
    arrival = None
    for i in range(len(rows) - 1, -1, -1):
        s = rows[i]["speed"] if "speed" in rows[i].keys() else None
        if s is not None and s < STOP_SPEED_KMH:
            continue
        arrival = i
        break
    if arrival is None:
        # Never "moved" per the speed column (bad data): keep raw.
        return raw, raw

    # Walk back over trailing time holes: a pair with dt far above the
    # record cadence is a device pause; the climb ended when it started.
    # Typical cadence here is ~1 s; the hole threshold must tolerate
    # longer units (some devices record every 5-10 s).
    def _pair_dt(i):
        a, b = ts[i - 1], ts[i]
        if a is None or b is None:
            return None
        return b - a
    dts = [d for d in (_pair_dt(i) for i in range(1, len(rows))) if d and d > 0]
    cadence = sorted(dts)[len(dts) // 2] if dts else None
    if cadence:
        hole_min = max(cadence * 4, 15.0)   # never treat <15s holes as pauses
        while arrival >= 2:
            d = _pair_dt(arrival)
            if d is not None and d > hole_min:
                arrival -= 1   # the hole belongs to the stop: arrival moves back
            else:
                break
    if arrival >= len(rows) - 1:
        # No trailing stop: plain elapsed, stops inside count.
        return raw, raw

    ta = ts[0]
    tb = ts[arrival]
    if ta is None or tb is None or tb - ta <= 0:
        return raw, raw
    return tb - ta, raw
