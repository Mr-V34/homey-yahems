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
 * Keeps the last `size` samples (default 3 = 15 min at 5-min cadence).
 */
function rollingAverage(buffer, sample, size = 3) {
  const buf = Array.isArray(buffer) ? buffer.slice() : [];
  buf.push(sample);
  while (buf.length > size) buf.shift();
  const avg = Math.round(buf.reduce((a, b) => a + b, 0) / buf.length);
  return { buffer: buf, average: avg };
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
  return { pass: fails.length === 0, fails };
}

module.exports = { clamp, defconFromNet, rollingAverage, selfTest };
