'use strict';

/**
 * YAHEMS DEFCON engine — pure net-power model.
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * DEFCON is derived only from the net power at the grid connection
 * (averaged), measured against an adjustable power target (anchor).
 * 5 = calm/surplus, 1 = critical peak. Solar is already included in
 * the net figure; price and battery act in the device layer, not here.
 */

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

/**
 * Map averaged net grid power (W, positive = import) to a DEFCON level.
 * Bands are fixed thirds of the anchor; the boundary belongs to the
 * calmer level. Export / near-zero net is always DEFCON 5.
 */
function defconFromNet(gridAvgW, anchorW) {
  if (gridAvgW <= 5) return 5;
  const s1 = Math.round(anchorW / 3);
  const s2 = Math.round((2 * anchorW) / 3);
  if (gridAvgW <= s1) return 4;
  if (gridAvgW <= s2) return 3;
  if (gridAvgW <= anchorW) return 2;
  return 1;
}

/**
 * Push a new sample into a rolling buffer and return the rounded average.
 * Keeps the last `size` samples. Used for the short, responsive "current power"
 * figure (measure_power) — distinct from the 7.5-min average window below.
 */
function rollingAverage(buffer, sample, size = 3) {
  const buf = Array.isArray(buffer) ? buffer.slice() : [];
  buf.push(sample);
  while (buf.length > size) buf.shift();
  const avg = Math.round(buf.reduce((a, b) => a + b, 0) / buf.length);
  return { buffer: buf, average: avg };
}

// --- 7.5-minute rolling average (responsive, half a billing quarter-hour) ---
// The grid does not bill instantaneous power; it bills the average over a window.
// A Swedish effekttariff settles per quarter-hour (15 min). YAHEMS judges on HALF
// that window — a plain rolling 7.5-minute average — so it stays awake and reacts
// quickly to a building load while still smoothing 60-second instantaneous spikes.
// Computing it from timestamped samples (rather than a fixed-size buffer) keeps it
// correct regardless of the recompute cadence.

const MEASURE_WINDOW_MS = 7.5 * 60 * 1000; // 7.5-minute measurement window

/**
 * Append a timestamped sample and drop anything older than the measurement window.
 * `samples` is an array of { t: epochMs, w: watts }. Pure — returns a new array.
 */
function pushSample(samples, watts, nowMs, horizonMs = MEASURE_WINDOW_MS) {
  const arr = (Array.isArray(samples) ? samples : []).filter((x) => nowMs - x.t < horizonMs);
  arr.push({ t: nowMs, w: watts });
  return arr;
}

/**
 * The rolling average watts over the last `windowMs`, or null if no sample falls
 * inside the window (so a cold buffer is honest, not a fake zero).
 */
function windowAverage(samples, nowMs, windowMs = MEASURE_WINDOW_MS) {
  const lo = nowMs - windowMs;
  const inWin = (Array.isArray(samples) ? samples : []).filter((x) => x.t > lo && x.t <= nowMs);
  if (!inWin.length) return null;
  return Math.round(inWin.reduce((a, b) => a + b.w, 0) / inWin.length);
}

/** Self-test against the reference thresholds (T=4500/6000/2000). */
function selfTest() {
  const cases = [
    [4500, [[3, 5], [1500, 4], [1501, 3], [3000, 3], [3001, 2], [4500, 2], [4501, 1]]],
    [6000, [[2000, 4], [2001, 3], [4000, 3], [4001, 2], [6000, 2], [6001, 1]]],
    [2000, [[667, 4], [668, 3], [1333, 3], [1334, 2], [2000, 2], [2001, 1]]],
  ];
  const fails = [];
  for (const [T, rows] of cases) {
    for (const [w, expected] of rows) {
      const got = defconFromNet(w, T);
      if (got !== expected) fails.push(`T${T} ${w}=>D${got}(want ${expected})`);
    }
  }

  // --- 7.5-minute rolling average ---
  const now = 1_000_000;
  // window = (now-450000, now] = (550000, 1000000]: 600, 1000 & 2000 → mean 1200
  const samples = [
    { t: 200_000, w: 100 },   // outside the 7.5-min window → ignored
    { t: 600_000, w: 600 },
    { t: 800_000, w: 1000 }, { t: 900_000, w: 2000 },
  ];
  const avg = windowAverage(samples, now);
  if (avg !== 1200) fails.push(`windowAverage=>${avg} (want 1200)`);

  // Cold buffer is honest, not a fake zero.
  if (windowAverage([], now) !== null) fails.push('windowAverage([]) should be null');
  if (windowAverage([{ t: now - 10 * 60 * 1000, w: 500 }], now) !== null) {
    fails.push('windowAverage with only stale samples should be null');
  }
  if (windowAverage([{ t: now, w: 500 }], now) !== 500) {
    fails.push('single in-window sample avg should equal that sample');
  }

  // pushSample prunes outside the 7.5-min horizon and keeps fresh ones.
  const pruned = pushSample([{ t: 0, w: 5 }], 10, now);
  if (pruned.length !== 1 || pruned[0].w !== 10) {
    fails.push(`pushSample prune=>${JSON.stringify(pruned)} (want single fresh sample)`);
  }
  const kept = pushSample([{ t: now - 60_000, w: 5 }], 10, now);
  if (kept.length !== 2) fails.push(`pushSample should keep an in-horizon sample (got ${kept.length})`);

  return { pass: fails.length === 0, fails };
}

module.exports = {
  clamp, defconFromNet, rollingAverage,
  pushSample, windowAverage,
  MEASURE_WINDOW_MS,
  selfTest,
};
