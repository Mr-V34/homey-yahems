'use strict';

/**
 * YAHEMS sim-feeder — synthetic 24-hour dry-run data.
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * Generates a realistic 24-hour profile (solar production, house load,
 * spot price, battery SOC) and pipes each hourly tick through the YAHEMS
 * engine (DEFCON) + device matrix. Produces a log of per-hour decisions.
 * No real devices are touched — all output is data only.
 *
 * This module is ONLY valid when sim_mode is enabled via lib/simgate.
 * runDay() enforces this: it throws if simgate says OFF, so stray calls
 * from live code cannot accidentally execute the simulation.
 *
 * Usage from test/selftest.js (auto-discovered):
 *   const feeder = require('./lib/simfeeder');
 *   feeder.selfTest();  // runs assertion suite, returns { pass, fails }
 *
 * Standalone usage (for manual dry-runs, not wired to Homey events):
 *   const { runDay } = require('./lib/simfeeder');
 *   const simgate = require('./lib/simgate');
 *   simgate.enable();
 *   const rows = runDay({ month: 7, outdoor_temp: 22, battery_soc_start: 40 });
 *   simgate.disable();
 */

const engine = require('./engine');
const { decideDevices, DEFAULT_MATRIX } = require('./matrix');
const simgate = require('./simgate');

// ----------------------------------------------------------------
// Solar production model (Åketorp 112: 42 × 370 W = 15.5 kWp,
// latitude factor 0.82 for 58°N).
// ----------------------------------------------------------------

const PEAK_KWP = 15.5;
const LAT_FACTOR = 0.82;

const SUNRISE = { 1: 8.5, 2: 7.5, 3: 6.5, 4: 5.5, 5: 4.5, 6: 4.0,
                  7: 4.5, 8: 5.5, 9: 6.5, 10: 7.5, 11: 8.0, 12: 8.5 };
const SUNSET  = { 1: 15.5, 2: 17.0, 3: 18.0, 4: 20.0, 5: 21.5, 6: 22.0,
                  7: 21.5, 8: 20.0, 9: 18.5, 10: 17.0, 11: 15.5, 12: 14.5 };

function solarW(hour, month, cloudPct) {
  const rise = SUNRISE[month] || 7;
  const set = SUNSET[month] || 17;
  if (hour < rise || hour > set) return 0;
  const dayFrac = (hour - rise) / (set - rise);
  const angle = Math.sin(Math.PI * dayFrac);
  const cloudFactor = 1 - (cloudPct / 100) * 0.85;
  return Math.round(Math.max(0, PEAK_KWP * 1000 * angle * LAT_FACTOR * cloudFactor));
}

// ----------------------------------------------------------------
// House load model.
// Base load = 350 W (cold appliances, network, standby).
// Nibe heat pump scales linearly with outdoor temp (calibrated).
// ----------------------------------------------------------------

const BASE_LOAD_W = 350;

function nibeLoadW(outdoorTempC) {
  if (outdoorTempC >= 18) return 300;
  return Math.round(Math.min(3000, 300 + (18 - outdoorTempC) * 95));
}

function houseLoadW(hour, outdoorTempC, cfg) {
  let w = BASE_LOAD_W + nibeLoadW(outdoorTempC);
  // Dishwasher active 10:00–12:00 and optionally user-supplied.
  const dishHour = cfg.dishwasher ? cfg.dishwasher(hour) : (hour >= 10 && hour < 12);
  if (dishHour) w += 1800;
  const washerHour = cfg.washer ? cfg.washer(hour) : (hour >= 14 && hour < 16);
  if (washerHour) w += 2000;
  return Math.round(w);
}

// Rough monthly outdoor-temperature norm for the target site (58°N, Spekeröd).
// Used only as a fallback when no real outdoor temperature is available, to make
// the no-meter consumption estimate season-aware.
const MONTH_TEMP_C = { 1: -2, 2: -2, 3: 2, 4: 7, 5: 12, 6: 16,
                       7: 18, 8: 17, 9: 13, 10: 8, 11: 3, 12: -1 };

/**
 * Estimate live house consumption (W) when NO real meter/source is mapped.
 *
 * This is the advisory no-meter fallback: it reuses the same base + heat-pump
 * load model as the dry-run feeder so YAHEMS can show honest DEFCON guidance out
 * of the box, on a Homey with no P1/energy dongle. It deliberately EXCLUDES the
 * feeder's scripted dishwasher/washer windows (those are dry-run scenario spikes,
 * not a steady live baseline).
 *
 * IMPORTANT: this is plain math for ADVISORY display only — it is NOT `sim_mode`
 * and does not touch lib/simgate. The actuation kill-switch is unaffected; no
 * meter ⇒ advisory mode ⇒ _applyDecisions() never writes anyway.
 *
 * @param {object} cfg
 * @param {number} [cfg.month]        1–12 (defaults to current month)
 * @param {number} [cfg.outdoorTempC] real outdoor °C if known; else seasonal norm
 * @returns {number} estimated consumption in watts (always ≥ base load)
 */
function estimateConsumptionW(cfg = {}) {
  const now = new Date();
  const month = Number.isFinite(cfg.month) ? cfg.month : now.getMonth() + 1;
  const temp = Number.isFinite(cfg.outdoorTempC)
    ? cfg.outdoorTempC
    : (MONTH_TEMP_C[month] != null ? MONTH_TEMP_C[month] : 8);
  return BASE_LOAD_W + nibeLoadW(temp);
}

/**
 * Extract net house power (W) from a Homey Energy live report.
 *
 * Homey Energy already sums every mapped device's `measure_power` into a
 * whole-home live total. On a Homey with NO dedicated P1/HAN/CT meter (e.g. an
 * apartment) that aggregate is a real, honest stand-in for "house consumption"
 * — better than the synthetic estimate because it reflects what is actually
 * plugged in. We take the net grid-equivalent draw = consumed − generated,
 * clamped to ≥ 0 (export reads as 0, matching the engine's convention).
 *
 * This is plain parsing of data Homey already computes — it is NOT `sim_mode`
 * and does not touch lib/simgate. As a no-meter source it stays advisory.
 *
 * Tolerant of field-name variants across Homey firmware; returns null when no
 * usable consumption figure is present so the caller can fall through to the
 * next source.
 *
 * @param {object|null} report  result of ManagerEnergy.getLiveReport()
 * @returns {number|null} net watts (≥0) or null if unavailable
 */
function houseNetFromLiveReport(report) {
  if (!report || typeof report !== 'object') return null;
  // Homey's live report carries each figure as a { W, cost } object
  // (e.g. totalConsumed: { W: 1051.15, cost: null }); be tolerant of a bare
  // number too in case the shape varies by firmware.
  const watts = (v) => {
    if (Number.isFinite(v)) return v;
    if (v && typeof v === 'object' && Number.isFinite(v.W)) return v.W;
    return null;
  };
  const consumed = watts(report.totalConsumed)
    ?? watts(report.totalConsumption)
    ?? watts(report.W);
  if (consumed == null) return null;
  const generated = watts(report.totalGenerated)
    ?? watts(report.totalGeneration)
    ?? 0;
  return Math.max(0, consumed - generated);
}

// ----------------------------------------------------------------
// Price model — realistic Swedish SE3/SE4 curves (öre/kWh incl. VAT+grid).
// priceLevel 5 = cheap, 1 = very expensive.
// ----------------------------------------------------------------

const PRICE_CURVE_WINTER = [85, 80, 78, 80, 95, 130, 180, 220, 210, 160, 130, 115,
                             110, 105, 110, 125, 170, 240, 250, 215, 160, 130, 105, 90];
const PRICE_CURVE_SUMMER = [42, 38, 36, 36, 40, 55, 70, 85, 80, 70, 60, 55,
                             50, 48, 50, 58, 72, 95, 105, 90, 75, 62, 52, 46];

function priceCurve(month) {
  return (month >= 11 || month <= 3) ? PRICE_CURVE_WINTER : PRICE_CURVE_SUMMER;
}

function priceOre(hour, month) {
  return priceCurve(month)[hour];
}

function priceLevel(hour, month) {
  const curve = priceCurve(month);
  const avg = curve.reduce((a, b) => a + b, 0) / curve.length;
  const ratio = curve[hour] / avg;
  if (ratio <= 0.60) return 5;
  if (ratio <= 0.90) return 4;
  if (ratio <= 1.15) return 3;
  if (ratio <= 1.40) return 2;
  return 1;
}

// ----------------------------------------------------------------
// Battery SOC evolution — simplified physics, 1-hour ticks.
// Grid positive = import, negative = export.
// ----------------------------------------------------------------

const BATTERY_KWH = 7.68;

function evolveSOC(socPct, gridW, solarW_, loadW) {
  // Net energy exchange with battery over 1 hour (Wh).
  // If solar > load: surplus charges the battery.
  // If load > solar: battery discharges to limit grid import.
  const surplus = solarW_ - loadW; // W, positive = we have extra solar
  let deltaWh;
  if (surplus > 0) {
    // Charge at surplus rate, capped at rated 7680 W.
    deltaWh = Math.min(surplus, 7680);
  } else {
    // Battery covers deficit unless gridW indicates it's already helping.
    // For dry-run: assume battery covers deficit entirely.
    deltaWh = surplus; // negative = discharge
  }
  const deltaPct = (deltaWh / (BATTERY_KWH * 1000)) * 100;
  return Math.max(0, Math.min(100, socPct + deltaPct));
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

/**
 * Generate a 24-hour profile without running decisions.
 * Returns an array of 24 objects, one per hour.
 * Safe to call regardless of sim_mode (pure data, no actuation).
 *
 * @param {object} cfg  profile parameters
 * @param {number} cfg.month          1–12
 * @param {number} cfg.outdoor_temp   outdoor temperature °C
 * @param {number} cfg.battery_soc_start  starting SOC %
 * @param {number} [cfg.cloud_pct]    0–100 cloud cover (constant; overridden by cloud fn)
 * @param {Function} [cfg.cloud]      (hour) => cloudPct
 * @param {Function} [cfg.dishwasher] (hour) => bool
 * @param {Function} [cfg.washer]     (hour) => bool
 */
function generateProfile(cfg = {}) {
  const month = cfg.month || 7;
  const outdoorTemp = cfg.outdoor_temp != null ? cfg.outdoor_temp : 15;
  const cloudFn = cfg.cloud || (() => (cfg.cloud_pct != null ? cfg.cloud_pct : 20));

  let soc = cfg.battery_soc_start != null ? cfg.battery_soc_start : 50;

  const rows = [];
  for (let h = 0; h < 24; h++) {
    const cloudPct = cloudFn(h);
    const solar = solarW(h, month, cloudPct);
    const load = houseLoadW(h, outdoorTemp, cfg);
    const gridNet = Math.max(-solar, load - solar); // simplified: battery covers rest
    const ore = priceOre(h, month);
    const level = priceLevel(h, month);

    rows.push({
      hour: h,
      month,
      solar_w: solar,
      load_w: load,
      grid_net_w: Math.round(gridNet),
      battery_soc_pct: Math.round(soc),
      price_ore: ore,
      price_level: level,
      outdoor_temp_c: outdoorTemp,
      cloud_pct: cloudPct,
    });

    soc = evolveSOC(soc, gridNet, solar, load);
  }
  return rows;
}

/**
 * Run a full 24-hour dry-run through the YAHEMS decision engine.
 * REQUIRES sim_mode to be ON — throws if called with sim_mode OFF.
 * Returns an array of 24 row objects, each containing the profile values
 * plus the resolved DEFCON level and per-device decisions.
 *
 * @param {object} cfg  same as generateProfile() cfg, plus:
 * @param {number} [cfg.anchor_w]  DEFCON anchor (default 4500 W)
 * @param {object} [cfg.ev]       EV state override (connected, mustCharge, …)
 */
function runDay(cfg = {}) {
  if (!simgate.isEnabled()) {
    throw new Error(
      'runDay() called with sim_mode OFF. '
      + 'Enable via simgate.enable() for dry-run only. '
      + 'Never enable in live production code.',
    );
  }

  const anchorW = cfg.anchor_w || 4500;
  const profile = generateProfile(cfg);
  const evBase = cfg.ev || {};
  let rollingBuf = [];

  const results = [];
  for (const row of profile) {
    const r = engine.rollingAverage(rollingBuf, row.grid_net_w, 3);
    rollingBuf = r.buffer;
    const defcon = engine.defconFromNet(r.average, anchorW);

    const decisions = decideDevices({
      defcon,
      socPct: row.battery_soc_pct,
      priceLevel: row.price_level,
      priceOre: row.price_ore,
      consumptionW: Math.max(0, row.load_w),
      localHour: row.hour,
      ev: {
        connected: evBase.connected !== undefined ? evBase.connected : true,
        mustCharge: evBase.mustCharge !== false,
        targetSocPct: evBase.targetSocPct || 80,
        batterySocPct: evBase.batterySocPct != null ? evBase.batterySocPct : 50,
        expensiveConfirmed: evBase.expensiveConfirmed === true,
      },
    }, DEFAULT_MATRIX);

    results.push({ ...row, defcon, decisions });
  }
  return results;
}

// ----------------------------------------------------------------
// Self-test
// ----------------------------------------------------------------

function selfTest() {
  const fails = [];
  const chk = (cond, msg) => { if (!cond) fails.push(msg); };

  // --- generateProfile sanity ---
  const summerProfile = generateProfile({ month: 7, outdoor_temp: 22, battery_soc_start: 40 });
  chk(summerProfile.length === 24, 'profile must have 24 rows');

  // Daytime hours must have positive solar on a clear day.
  const clearProfile = generateProfile({ month: 7, outdoor_temp: 22, battery_soc_start: 40, cloud_pct: 0 });
  const midday = clearProfile[13]; // 13:00
  chk(midday.solar_w > 5000, `solar at noon July clear day must be >5000 W, got ${midday.solar_w}`);

  // Nighttime must have zero solar.
  const midnight = clearProfile[2];
  chk(midnight.solar_w === 0, `solar at 02:00 must be 0, got ${midnight.solar_w}`);

  // Load is always > 0 (base load + nibe at minimum).
  for (const row of clearProfile) {
    chk(row.load_w > 0, `load must be positive at hour ${row.hour}, got ${row.load_w}`);
  }

  // SOC evolves (starts at 40, should be higher by afternoon on sunny day).
  const soc0 = clearProfile[0].battery_soc_pct;
  const soc14 = clearProfile[14].battery_soc_pct;
  chk(soc14 >= soc0, `SOC should not fall during sunny day (${soc0} → ${soc14})`);

  // Price levels span a range in winter profile.
  const winterProfile = generateProfile({ month: 1, outdoor_temp: -5, battery_soc_start: 60 });
  const levels = winterProfile.map((r) => r.price_level);
  const uniqueLevels = new Set(levels).size;
  chk(uniqueLevels >= 2, `winter price levels must vary, got ${uniqueLevels} unique levels`);

  // Price ore must be > 0 everywhere.
  for (const row of winterProfile) {
    chk(row.price_ore > 0, `price_ore must be positive at hour ${row.hour}`);
  }

  // --- estimateConsumptionW: advisory no-meter fallback ---
  const estWarm = estimateConsumptionW({ month: 7, outdoorTempC: 22 });
  const estCold = estimateConsumptionW({ month: 1, outdoorTempC: -5 });
  const estDefault = estimateConsumptionW({}); // uses current month + seasonal norm
  chk(Number.isFinite(estWarm) && estWarm >= BASE_LOAD_W,
    `estimate (warm) must be ≥ base load ${BASE_LOAD_W}, got ${estWarm}`);
  chk(Number.isFinite(estDefault) && estDefault >= BASE_LOAD_W,
    `estimate (default) must be finite ≥ base load, got ${estDefault}`);
  chk(estCold > estWarm,
    `cold estimate (${estCold}) must exceed warm estimate (${estWarm})`);
  chk(estimateConsumptionW({ month: 7 }) > 0,
    'estimate with seasonal-default temp must be positive');

  // --- houseNetFromLiveReport: Homey Energy aggregate parser ---
  chk(houseNetFromLiveReport(null) === null, 'live report: null → null');
  chk(houseNetFromLiveReport({}) === null, 'live report: empty object → null');
  chk(houseNetFromLiveReport({ totalConsumed: 1200 }) === 1200,
    'live report: consumed only → consumed');
  chk(houseNetFromLiveReport({ totalConsumed: 1200, totalGenerated: 500 }) === 700,
    'live report: net = consumed − generated');
  chk(houseNetFromLiveReport({ totalConsumed: 300, totalGenerated: 900 }) === 0,
    'live report: net export clamps to 0');
  chk(houseNetFromLiveReport({ totalConsumption: 800 }) === 800,
    'live report: alt field totalConsumption accepted');
  // Real Homey shape: figures are { W, cost } objects, generated W often null.
  chk(houseNetFromLiveReport({ totalConsumed: { W: 1051.15, cost: null }, totalGenerated: { W: null } }) === 1051.15,
    'live report: { W } object shape (real Homey)');
  chk(houseNetFromLiveReport({ totalConsumed: { W: 1200 }, totalGenerated: { W: 500 } }) === 700,
    'live report: { W } net = consumed − generated');
  chk(houseNetFromLiveReport({ totalConsumed: { W: 300 }, totalGenerated: { W: 900 } }) === 0,
    'live report: { W } export clamps to 0');
  chk(houseNetFromLiveReport({ totalGenerated: { W: 0 } }) === null,
    'live report: no consumed figure → null');

  // --- runDay: must throw when sim_mode OFF ---
  simgate.disable();
  let threwOff = false;
  try { runDay({ month: 7 }); } catch (_) { threwOff = true; }
  chk(threwOff, 'runDay() must throw when sim_mode is OFF');

  // --- runDay: must succeed when sim_mode ON ---
  simgate.enable();
  let dayResults;
  try {
    dayResults = runDay({ month: 7, outdoor_temp: 22, battery_soc_start: 40, cloud_pct: 20 });
  } catch (e) {
    fails.push(`runDay() threw unexpectedly: ${e.message}`);
  } finally {
    simgate.disable(); // always restore OFF after test
  }

  if (dayResults) {
    chk(dayResults.length === 24, 'runDay result must have 24 rows');

    // Every row must have a valid DEFCON (1–5).
    for (const row of dayResults) {
      chk(row.defcon >= 1 && row.defcon <= 5,
        `DEFCON out of range at hour ${row.hour}: ${row.defcon}`);
    }

    // Every row must have decisions for all devices.
    const requiredDevices = ['nibe', 'spa', 'ev', 'battery', 'dishwasher', 'washer', 'dryer', 'comfort'];
    for (const row of dayResults) {
      for (const dev of requiredDevices) {
        chk(row.decisions[dev] !== undefined,
          `missing decision for ${dev} at hour ${row.hour}`);
      }
    }

    // Battery frost guard must never be violated (nibe vv >= 40 always).
    for (const row of dayResults) {
      chk(row.decisions.nibe.vv >= 40,
        `nibe vv below 40°C at hour ${row.hour}: ${row.decisions.nibe.vv}`);
      chk(row.decisions.nibe.frost === true,
        `nibe frost guard off at hour ${row.hour}`);
    }

    // Spa frostGuard implies heat=false at D1.
    const d1Rows = dayResults.filter((r) => r.defcon === 1);
    for (const row of d1Rows) {
      chk(row.decisions.spa.heat === false,
        `spa heat should be OFF at D1, hour ${row.hour}`);
    }

    // Winter profile with cold snap: load should be high.
    simgate.enable();
    let winterDay;
    try {
      winterDay = runDay({ month: 1, outdoor_temp: -5, battery_soc_start: 60, cloud_pct: 90 });
    } finally {
      simgate.disable();
    }
    const winterLoads = winterDay.map((r) => r.load_w);
    const avgWinterLoad = winterLoads.reduce((a, b) => a + b, 0) / winterLoads.length;
    chk(avgWinterLoad > 1500,
      `avg winter load at -5°C should be >1500 W, got ${Math.round(avgWinterLoad)}`);
  }

  // --- Final guard: simgate must be OFF after test ---
  chk(simgate.isEnabled() === false, 'simgate must be OFF after selfTest() completes');

  return { pass: fails.length === 0, fails };
}

module.exports = { generateProfile, runDay, estimateConsumptionW, houseNetFromLiveReport, solarW, priceLevel, priceOre, selfTest };
