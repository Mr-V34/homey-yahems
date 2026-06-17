'use strict';

/**
 * elprisetjustnu.se price helper — pure logic only.
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * The free elprisetjustnu.se API serves one static JSON file per day and price
 * area (SE1–SE4) at:
 *   https://www.elprisetjustnu.se/api/v1/prices/YYYY/MM-DD_SEx.json
 * Each file is an array of hourly rows:
 *   { SEK_per_kWh, EUR_per_kWh, EXR, time_start, time_end }
 *
 * This module only builds URLs, parses the payload and picks the current hour.
 * The HTTP fetch / retry / caching live in the device (network I/O is not pure).
 */

const AREAS = ['SE1', 'SE2', 'SE3', 'SE4'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** True for a valid Swedish price area code. */
function isValidArea(area) {
  return AREAS.includes(area);
}

/** Build the daily price URL for a JS Date (local) and area. */
function buildUrl(date, area) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `https://www.elprisetjustnu.se/api/v1/prices/${y}/${m}-${d}_${area}.json`;
}

/**
 * Parse the API array into [{ start, end, ore }] where ore = öre/kWh and
 * start/end are epoch ms. Tolerant: skips malformed rows, returns [] for junk.
 */
function parsePrices(json) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const row of json) {
    if (!row || typeof row !== 'object') continue;
    const sek = Number(row.SEK_per_kWh);
    const start = Date.parse(row.time_start);
    const end = Date.parse(row.time_end);
    if (!Number.isFinite(sek) || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ start, end, ore: Math.round(sek * 100 * 100) / 100 }); // öre/kWh, 2 dp
  }
  return out;
}

/** The price (öre/kWh) whose [start, end) window contains nowMs, else null. */
function priceAt(prices, nowMs) {
  if (!Array.isArray(prices)) return null;
  for (const p of prices) {
    if (nowMs >= p.start && nowMs < p.end) return p.ore;
  }
  return null;
}

function selfTest() {
  const fails = [];

  // buildUrl: zero-padded month/day, exact path.
  const url = buildUrl(new Date(2026, 5, 17), 'SE3');
  if (url !== 'https://www.elprisetjustnu.se/api/v1/prices/2026/06-17_SE3.json') {
    fails.push(`buildUrl=>${url}`);
  }

  // isValidArea.
  if (!isValidArea('SE1') || isValidArea('SE5') || isValidArea('') || isValidArea(null)) {
    fails.push('isValidArea wrong');
  }

  // parsePrices: SEK→öre, malformed rows skipped.
  const sample = [
    { SEK_per_kWh: 0.5, time_start: '2026-06-17T00:00:00+02:00', time_end: '2026-06-17T01:00:00+02:00' },
    { SEK_per_kWh: 1.2345, time_start: '2026-06-17T01:00:00+02:00', time_end: '2026-06-17T02:00:00+02:00' },
    { SEK_per_kWh: 'x', time_start: 'bad', time_end: 'bad' }, // skipped
    { foo: 1 }, // skipped
  ];
  const parsed = parsePrices(sample);
  if (parsed.length !== 2) fails.push(`parsePrices length ${parsed.length} (want 2)`);
  if (parsed[0] && parsed[0].ore !== 50) fails.push(`parse ore0 ${parsed[0] && parsed[0].ore} (want 50)`);
  if (parsed[1] && parsed[1].ore !== 123.45) fails.push(`parse ore1 ${parsed[1] && parsed[1].ore} (want 123.45)`);
  if (parsePrices(null).length !== 0 || parsePrices({}).length !== 0) fails.push('parsePrices junk not []');

  // priceAt: window selection, boundary belongs to the next window (end exclusive).
  const at0 = priceAt(parsed, Date.parse('2026-06-17T00:30:00+02:00'));
  if (at0 !== 50) fails.push(`priceAt mid0 ${at0} (want 50)`);
  const atBoundary = priceAt(parsed, Date.parse('2026-06-17T01:00:00+02:00'));
  if (atBoundary !== 123.45) fails.push(`priceAt boundary ${atBoundary} (want 123.45)`);
  const atNone = priceAt(parsed, Date.parse('2026-06-17T05:00:00+02:00'));
  if (atNone !== null) fails.push(`priceAt out-of-range ${atNone} (want null)`);

  return { pass: fails.length === 0, fails };
}

module.exports = { AREAS, isValidArea, buildUrl, parsePrices, priceAt, selfTest };
