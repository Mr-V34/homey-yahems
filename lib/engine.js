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
 * figure (measure_power) — distinct from the billed 15-min window below.
 */
function rollingAverage(buffer, sample, size = 3) {
  const buf = Array.isArray(buffer) ? buffer.slice() : [];
  buf.push(sample);
  while (buf.length > size) buf.shift();
  const avg = Math.round(buf.reduce((a, b) => a + b, 0) / buf.length);
  return { buffer: buf, average: avg };
}

// --- 15-minute window average (the figure a Swedish effekttariff actually bills) ---
// The grid does not bill instantaneous power; it bills the average over a window.
// YAHEMS mirrors that by averaging the last 15 minutes as THREE consecutive
// 5-minute sub-averages, then averaging those. Computing it from timestamped
// samples (rather than a fixed-size buffer) keeps it correct regardless of the
// recompute cadence.

const WINDOW_MS = 5 * 60 * 1000;    // one 5-minute sub-window
const HORIZON_MS = 3 * WINDOW_MS;   // 15-minute total horizon

/**
 * Append a timestamped sample and drop anything older than the 15-min horizon.
 * `samples` is an array of { t: epochMs, w: watts }. Pure — returns a new array.
 */
function pushSample(samples, watts, nowMs, horizonMs = HORIZON_MS) {
  const arr = (Array.isArray(samples) ? samples : []).filter((x) => nowMs - x.t < horizonMs);
  arr.push({ t: nowMs, w: watts });
  return arr;
}

/**
 * The three 5-minute sub-averages over the last 15 minutes, newest first.
 * A sub-window with no samples yields null (so a half-warm buffer is honest).
 * @returns {Array<number|null>} [recent5min, mid5min, oldest5min]
 */
function windowAverages(samples, nowMs, windowMs = WINDOW_MS, slots = 3) {
  const arr = Array.isArray(samples) ? samples : [];
  const out = [];
  for (let i = 0; i < slots; i++) {
    const hi = nowMs - i * windowMs;
    const lo = hi - windowMs;
    const inWin = arr.filter((x) => x.t > lo && x.t <= hi);
    out.push(inWin.length ? Math.round(inWin.reduce((a, b) => a + b.w, 0) / inWin.length) : null);
  }
  return out;
}

/**
 * The 15-minute average = mean of the available 5-minute sub-averages.
 * Returns null until at least one sub-window has data.
 */
function fifteenMinAverage(windows) {
  const vals = (Array.isArray(windows) ? windows : []).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
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

  // --- 15-minute window average ---
  const now = 1_000_000;
  // recent (700000,1000000]: 1000 & 2000 → 1500
  // mid    (400000, 700000]: 400        → 400
  // oldest (100000, 400000]: 100 & 300  → 200
  const samples = [
    { t: 200_000, w: 100 }, { t: 300_000, w: 300 },
    { t: 500_000, w: 400 },
    { t: 800_000, w: 1000 }, { t: 900_000, w: 2000 },
  ];
  const wins = windowAverages(samples, now);
  if (JSON.stringify(wins) !== JSON.stringify([1500, 400, 200])) {
    fails.push(`windowAverages=>${JSON.stringify(wins)} (want [1500,400,200])`);
  }
  const avg15 = fifteenMinAverage(wins);
  if (avg15 !== 700) fails.push(`fifteenMinAverage=>${avg15} (want 700)`);

  // Empty / half-warm buffer is honest, not a fake zero.
  if (fifteenMinAverage([null, null, null]) !== null) fails.push('fifteenMinAverage([nulls]) should be null');
  if (JSON.stringify(windowAverages([], now)) !== JSON.stringify([null, null, null])) {
    fails.push('windowAverages([]) should be [null,null,null]');
  }
  if (fifteenMinAverage(windowAverages([{ t: now, w: 500 }], now)) !== 500) {
    fails.push('single-sample 15-min avg should equal that sample');
  }

  // pushSample prunes outside the 15-min horizon and keeps fresh ones.
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
  pushSample, windowAverages, fifteenMinAverage,
  WINDOW_MS, HORIZON_MS,
  selfTest,
};
