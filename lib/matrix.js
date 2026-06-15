'use strict';

/**
 * YAHEMS device-decision matrix — pure logic, no Homey imports.
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * Given a DEFCON level (computed elsewhere, see lib/engine.js) plus the
 * currently-known house state, resolve a concrete decision per device.
 * Setpoints live as DATA in DEFAULT_MATRIX (dry-run seed values, easy to
 * retune). decideDevices() layers the safety/price/load-balance rules on
 * top of the raw matrix lookup. This module NEVER actuates anything —
 * Homey wiring lives only in drivers/controller/device.js.
 *
 * DEFCON: 5 = calm/surplus ... 1 = critical peak.
 * priceLevel: 1 = most expensive ... 5 = cheapest.
 */

// Band keys 5..1 mapped to setpoints. One entry per device, data-driven.
const DEFAULT_MATRIX = {
  // 1. Nibe heat pump — frost protection ALWAYS on, even at D1.
  nibe: {
    kind: 'thermal',
    vvMax: 65,   // Nibe S735 hot-water hardware ceiling (°C). FLAG to owner for confirm.
    bands: {
      5: { vv: 53, offset: 1, frost: true },
      4: { vv: 50, offset: 0, frost: true },
      3: { vv: 50, offset: 0, frost: true },
      2: { vv: 45, offset: -2, frost: true },
      1: { vv: 40, offset: -5, frost: true }, // legionella/frost floor: vv stays >= 40
    },
  },

  // 2. Spa (Balboa) — D1 frost guard: circulation pump ON, electric heat OFF.
  spa: {
    kind: 'thermal',
    tempMax: 40,  // Balboa hardware ceiling (°C). FLAG to owner for confirm.
    bands: {
      5: { temp: 38, heat: true },
      4: { temp: 38, heat: true },
      3: { temp: 36, heat: true },
      2: { temp: 36, heat: true },
      1: { temp: 10, heat: false, frostGuard: true }, // never stop the pump
    },
  },

  // 3. EV charger (Zaptec). gateOre = device-level price gate (ore/kWh).
  ev: {
    kind: 'ev',
    gateOre: 300,
    maxAmp: 32,       // Zaptec hardware ceiling (A). FLAG to owner for confirm.
    minAmp: 6,        // SAE/IEC minimum deliverable amp — below this a charger cannot run.
    overrideFloorA: { 3: 3, 2: 6 }, // (b)-override "car always drivable" raw floors per DEFCON band.
    bands: {
      5: { amp: 32 },
      4: { amp: 32 },
      3: { amp: 16 },
      2: { amp: 10 },
      1: { amp: 0 },
    },
  },

  // 4. Battery (Dyness TP7, 7.68 kWh). Gates carried on the entry.
  battery: {
    kind: 'battery',
    soc_reserve: 15,
    soc_safety: 5,
    soc_ceil: 97,
    rated_charge_w: 7680,
    // Minimum charge power in WATTS. Derived: 6 A × (7680 W / 40 A) = 1152 W.
    // The battery must charge with at least this power or YAHEMS returns IDLE
    // (mirrors the EV rule: below the deliverable minimum → 0, no grid import forced).
    // TUNABLE — FLAG this exact default (1152 W / 6 A on the charge bus) to the owner for confirm.
    min_charge_w: 1152,
    charge_price_gate: 0,
    bands: {
      5: { mode: 'charge', pct: 100, power_w: 7680, charge_mode: 'headroom' },
      4: { mode: 'charge', pct: 50, power_w: 3840, charge_mode: 'fixed' },
      3: { mode: 'discharge', power_w: 0 }, // 0 = auto/max
      2: { mode: 'discharge', power_w: 0 },
      1: { mode: 'discharge', power_w: 0 },
    },
  },

  // 5. Home Connect appliances (dishwasher/washer/dryer). NEVER heating elements.
  appliances: {
    kind: 'appliance',
    highPowerW: 1500,
    bands: {
      5: { action: 'run' },
      4: { action: 'run' },
      3: { action: 'run' },
      2: { action: 'pause' },
      1: { action: 'pause' },
    },
  },

  // 6. Comfort loads (microwave/coffee). Always allowed, even D1.
  comfort: {
    kind: 'comfort',
    bands: {
      5: { action: 'allow' },
      4: { action: 'allow' },
      3: { action: 'allow' },
      2: { action: 'allow' },
      1: { action: 'allow' },
    },
  },
};

// Back-compat exports — these now live on DEFAULT_MATRIX.ev but are re-exported
// here so any existing external reference (e.g. old test snapshots) still resolves.
// Do not use these constants inside this module — read from matrix.ev instead.
const OVERRIDE_FLOOR_A = DEFAULT_MATRIX.ev.overrideFloorA;
const EV_MIN_AMP = DEFAULT_MATRIX.ev.minAmp;

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// Fill in safe defaults for every signal the app may not have yet.
function normalize(input) {
  const i = input || {};
  const ev = i.ev || {};
  return {
    defcon: Number.isFinite(i.defcon) ? i.defcon : 3,
    socPct: i.socPct == null ? null : Number(i.socPct),
    priceLevel: Number.isFinite(i.priceLevel) ? i.priceLevel : 3,
    priceOre: i.priceOre == null ? null : Number(i.priceOre),
    consumptionW: Number.isFinite(i.consumptionW) ? i.consumptionW : 0,
    localHour: Number.isFinite(i.localHour) ? i.localHour : 0,
    ev: {
      connected: ev.connected === true,
      mustCharge: ev.mustCharge !== false, // default true
      targetSocPct: Number.isFinite(ev.targetSocPct) ? ev.targetSocPct : 80,
      batterySocPct: ev.batterySocPct == null ? null : Number(ev.batterySocPct),
      deadlineHour: Number.isFinite(ev.deadlineHour) ? ev.deadlineHour : 7,
      expensiveConfirmNeeded: ev.expensiveConfirmNeeded === true,
      expensiveConfirmed: ev.expensiveConfirmed === true,
    },
    mainFuseA: Number.isFinite(i.mainFuseA) ? i.mainFuseA : 25,
    phases: Number.isFinite(i.phases) ? i.phases : 3,
    volts: Number.isFinite(i.volts) ? i.volts : 230,
  };
}

function decideThermalNibe(band) {
  // Always keep frost protection on regardless of band.
  return {
    kind: 'thermal',
    vv: band.vv,
    offset: band.offset,
    frost: true,
  };
}

function decideThermalSpa(band) {
  const d = { kind: 'thermal', temp: band.temp, heat: band.heat === true };
  if (band.frostGuard === true) {
    d.frostGuard = true; // circulation pump stays ON, heat off — never stop the pump
  }
  return d;
}

function decideEv(s, matrix, boosted) {
  const entry = matrix.ev;
  const battery = matrix.battery;
  const flags = [];

  // a. raw matrix intent — boost uses D5 band regardless of house DEFCON
  const evDefcon = boosted ? 5 : s.defcon;
  let amp = entry.bands[evDefcon].amp;
  if (boosted) flags.push('boosted');

  // EV's own SoC (the car's battery) decides "below target".
  const carSoc = s.ev.batterySocPct;
  const belowTarget = carSoc == null || carSoc < s.ev.targetSocPct;
  const chargingIntended = s.ev.connected && s.ev.mustCharge && belowTarget;

  // b. (b)-OVERRIDE "car always drivable": guarantee a min trickle even when
  // DEFCON would cut it. D1 is excluded (critical-peak safety stop).
  // When boosted, evDefcon is 5 so D1 exclusion only applies to the HOUSE defcon.
  if (chargingIntended && s.defcon !== 1) {
    const floor = entry.overrideFloorA[evDefcon];
    if (floor != null) {
      // Lift to at least the deliverable charger minimum (see entry.minAmp note).
      const target = Math.max(floor, entry.minAmp);
      if (amp < target) {
        amp = target;
        flags.push('override-floor');
      }
    }
  }

  // c. PRICE control-question. Only relevant if we actually intend to charge.
  // When boosted, the price gate is bypassed entirely — user explicitly accepts
  // the current price by issuing a boost ("I'll pay to run it now").
  let expensiveConfirmNeeded = false;
  if (!boosted && chargingIntended && amp > 0) {
    const expensive = s.priceLevel <= 2
      || (s.priceOre != null && s.priceOre > entry.gateOre);
    if (expensive && !s.ev.expensiveConfirmed) {
      expensiveConfirmNeeded = true;
      amp = 0;
      flags.push('await-price-confirm');
    }
  }

  // d. LOAD BALANCE — hard ceiling over everything, including the override.
  // availableEvAmp = remaining headroom on the main fuse given known consumption.
  const denom = s.volts * s.phases;
  const availableEvAmp = Math.floor(s.mainFuseA - s.consumptionW / denom);
  if (amp > availableEvAmp) {
    amp = availableEvAmp;
    flags.push('load-balance');
  }
  if (amp < entry.minAmp) {
    amp = 0;
    if (!flags.includes('load-balance')) flags.push('load-balance');
  }

  // e. BATTERY SAFETY VETO — house battery critically low cuts EV.
  if (s.socPct != null && s.socPct < battery.soc_safety) {
    amp = 0;
    flags.push('battery-safety-veto');
  }

  return {
    kind: 'ev',
    amp: Math.max(0, amp),
    chargingIntended,
    expensiveConfirmNeeded,
    availableEvAmp,
    flags,
  };
}

function decideBattery(s, matrix, boosted) {
  const e = matrix.battery;
  const battDefcon = boosted ? 5 : s.defcon;
  const band = e.bands[battDefcon];
  const soc = s.socPct;
  const flags = [];
  if (boosted) flags.push('boosted');

  if (band.mode === 'charge') {
    // Charge only if SoC unknown or below ceiling.
    if (soc != null && soc >= e.soc_ceil) {
      flags.push('soc-ceil');
      return { kind: 'battery', mode: 'idle', power_w: 0, flags };
    }
    let power;
    if (band.charge_mode === 'headroom') {
      // Headroom mode = charge with available grid surplus. We don't have a
      // surplus signal yet, so approximate as rated power. DOCUMENTED limitation.
      power = e.rated_charge_w;
    } else {
      power = band.power_w;
    }
    power = clamp(power, 0, e.rated_charge_w); // cap at rated
    // Min-charge-floor: if computed power is above 0 but below the minimum
    // deliverable power (min_charge_w), return IDLE — do NOT force grid import
    // to satisfy the charge floor. Mirrors the EV "below deliverable minimum → 0" rule.
    const minChargeW = e.min_charge_w != null ? e.min_charge_w : 0;
    if (power > 0 && power < minChargeW) {
      flags.push('min-charge-floor');
      return { kind: 'battery', mode: 'idle', power_w: 0, flags };
    }
    return {
      kind: 'battery',
      mode: 'charge',
      power_w: power,
      charge_mode: band.charge_mode,
      flags,
    };
  }

  // discharge band
  if (soc != null && soc <= e.soc_safety) {
    flags.push('soc-safety');
    return { kind: 'battery', mode: 'idle', power_w: 0, flags };
  }
  if (soc != null && soc <= e.soc_reserve) {
    flags.push('soc-reserve'); // stop supporting the house, protect reserve
    return { kind: 'battery', mode: 'idle', power_w: 0, flags };
  }
  // power 0 in band => auto/max
  const power = band.power_w === 0 ? e.rated_charge_w : band.power_w;
  return { kind: 'battery', mode: 'discharge', power_w: power, flags };
}

function decideAppliances(s, matrix, boosted) {
  const e = matrix.appliances;
  const applDefcon = boosted ? 5 : s.defcon;
  let action = e.bands[applDefcon].action;
  const flags = [];
  if (boosted) flags.push('boosted');
  // If a high-power measurement is present and exceeds the threshold at D2/D1,
  // force pause regardless of band. Never touches heating elements.
  // Use the HOUSE defcon (not boosted defcon) for the high-power-pause guard —
  // the house is still under load even when the appliance band is boosted.
  if ((s.defcon === 2 || s.defcon === 1)
    && Number.isFinite(s.appliancePowerW)
    && s.appliancePowerW > e.highPowerW) {
    action = 'pause';
    flags.push('high-power-pause');
  }
  return { kind: 'appliance', action, flags };
}

function decideComfort(s, matrix) {
  // Always 'allow', even at D1.
  return { kind: 'comfort', action: matrix.comfort.bands[s.defcon].action, flags: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Matrix monotonicity validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the matrix bands D5→D4→D3→D2→D1 (calm→critical) and assert that every
 * quantity is non-increasing in load as DEFCON drops. Any violation means a
 * device would work HARDER during a worse peak — which the matrix must never
 * allow by construction.
 *
 * Returns { ok: boolean, errors: string[] }.
 * An empty errors array means the matrix is fully monotone.
 *
 * Rules per device kind:
 *   nibe      — vv non-increasing; offset non-increasing; frost===true in every band
 *   spa       — temp non-increasing; heat: once false stays false; frostGuard may
 *               only turn ON as DEFCON drops (never off once on)
 *   ev        — amp non-increasing across authored bands (runtime override floors
 *               are documented deliberate exceptions, not validated here)
 *   appliance — action mapped run=1 > pause=0, value non-increasing
 *   battery   — mode mapped charge=2 > idle=1 > discharge=0, non-increasing;
 *               on charge bands pct and power_w also non-increasing
 *   comfort   — action must be 'allow' in every band (constant invariant)
 */
function validateMatrix(m) {
  const errors = [];
  const BANDS = [5, 4, 3, 2, 1]; // calm → critical

  function err(device, pair, field, prev, curr) {
    errors.push(
      `${device}: band D${pair[0]}→D${pair[1]} '${field}' increased (${prev} → ${curr})`
    );
  }

  // nibe
  {
    const e = m.nibe;
    for (let i = 0; i < BANDS.length - 1; i++) {
      const [hi, lo] = [BANDS[i], BANDS[i + 1]];
      const bHi = e.bands[hi];
      const bLo = e.bands[lo];
      if (bHi.vv < bLo.vv) err('nibe', [hi, lo], 'vv', bHi.vv, bLo.vv);
      if (bHi.offset < bLo.offset) err('nibe', [hi, lo], 'offset', bHi.offset, bLo.offset);
    }
    for (const b of BANDS) {
      if (e.bands[b].frost !== true) {
        errors.push(`nibe: band D${b} frost must be true (frost invariant violated)`);
      }
    }
  }

  // spa
  {
    const e = m.spa;
    let frostGuardOn = false;
    let heatOff = false;
    for (let i = 0; i < BANDS.length - 1; i++) {
      const [hi, lo] = [BANDS[i], BANDS[i + 1]];
      const bHi = e.bands[hi];
      const bLo = e.bands[lo];
      if (bHi.temp < bLo.temp) err('spa', [hi, lo], 'temp', bHi.temp, bLo.temp);
    }
    for (const b of BANDS) {
      const band = e.bands[b];
      // heat: once false must stay false at lower DEFCON
      if (heatOff && band.heat === true) {
        errors.push(`spa: band D${b} heat turned ON after being OFF (non-monotone)`);
      }
      if (band.heat === false) heatOff = true;
      // frostGuard: once ON must stay ON
      if (frostGuardOn && !band.frostGuard) {
        errors.push(`spa: band D${b} frostGuard turned OFF after being ON (non-monotone)`);
      }
      if (band.frostGuard === true) frostGuardOn = true;
    }
  }

  // ev
  {
    const e = m.ev;
    for (let i = 0; i < BANDS.length - 1; i++) {
      const [hi, lo] = [BANDS[i], BANDS[i + 1]];
      const bHi = e.bands[hi];
      const bLo = e.bands[lo];
      if (bHi.amp < bLo.amp) err('ev', [hi, lo], 'amp', bHi.amp, bLo.amp);
    }
  }

  // appliance — map action to ordered scale: run=1 > pause=0
  {
    const ACTION_RANK = { run: 1, pause: 0 };
    const e = m.appliances;
    for (let i = 0; i < BANDS.length - 1; i++) {
      const [hi, lo] = [BANDS[i], BANDS[i + 1]];
      const rankHi = ACTION_RANK[e.bands[hi].action] ?? -1;
      const rankLo = ACTION_RANK[e.bands[lo].action] ?? -1;
      if (rankHi < rankLo) {
        err('appliances', [hi, lo], 'action',
          e.bands[hi].action, e.bands[lo].action);
      }
    }
  }

  // battery — mode: charge=2 > idle=1 > discharge=0, non-increasing;
  //           on charge bands pct and power_w also non-increasing
  {
    const MODE_RANK = { charge: 2, idle: 1, discharge: 0 };
    const e = m.battery;
    let lastChargePct = Infinity;
    let lastChargePowerW = Infinity;
    for (let i = 0; i < BANDS.length - 1; i++) {
      const [hi, lo] = [BANDS[i], BANDS[i + 1]];
      const bHi = e.bands[hi];
      const bLo = e.bands[lo];
      const rankHi = MODE_RANK[bHi.mode] ?? -1;
      const rankLo = MODE_RANK[bLo.mode] ?? -1;
      if (rankHi < rankLo) {
        err('battery', [hi, lo], 'mode', bHi.mode, bLo.mode);
      }
    }
    // Check pct and power_w on charge bands only, in band order
    for (const b of BANDS) {
      const band = e.bands[b];
      if (band.mode === 'charge') {
        if (band.pct != null && band.pct > lastChargePct) {
          errors.push(
            `battery: charge band D${b} pct (${band.pct}) exceeds previous charge band pct (${lastChargePct})`
          );
        }
        if (band.power_w != null && band.power_w > lastChargePowerW) {
          errors.push(
            `battery: charge band D${b} power_w (${band.power_w}) exceeds previous charge band power_w (${lastChargePowerW})`
          );
        }
        if (band.pct != null) lastChargePct = band.pct;
        if (band.power_w != null) lastChargePowerW = band.power_w;
      }
    }
  }

  // comfort — action must be 'allow' in every band
  {
    const e = m.comfort;
    for (const b of BANDS) {
      if (e.bands[b].action !== 'allow') {
        errors.push(`comfort: band D${b} action must be 'allow', got '${e.bands[b].action}'`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a decision for every device given the current state.
 *
 * @param {object} input    partial state (missing signals default sensibly)
 * @param {object} matrix   data-driven setpoint matrix (default DEFAULT_MATRIX)
 * @param {object} boosts   optional per-device boost flags, e.g. { nibe:true, ev:true }.
 *                          A boosted device computes its decision as if DEFCON were 5
 *                          (calm/surplus = full setpoints) AND bypasses its price gate.
 *                          ALL safety layers (frost, load-balance, battery SoC veto)
 *                          still apply unchanged. comfort is unaffected (always 'allow').
 *                          Boosts are runtime intent only — the matrix is NOT mutated.
 *                          Non-persistence: boosts live in caller memory; on app restart
 *                          they are lost, which fails safe (device returns to normal DEFCON).
 * @returns {object} keyed by device name with the resolved decision + flags
 */
function decideDevices(input, matrix = DEFAULT_MATRIX, boosts = {}) {
  const s = normalize(input);
  const b = boosts && typeof boosts === 'object' ? boosts : {};

  // Nibe and spa: boost simply selects the D5 band for setpoint lookup.
  // Frost protection is unconditional in decideThermalNibe (applied regardless of band).
  const nibeDefcon = b.nibe ? 5 : s.defcon;
  const spaDefcon  = b.spa  ? 5 : s.defcon;

  const nibeResult = decideThermalNibe(matrix.nibe.bands[nibeDefcon]);
  if (b.nibe) nibeResult.boosted = true;

  const spaResult = decideThermalSpa(matrix.spa.bands[spaDefcon]);
  if (b.spa) spaResult.boosted = true;

  return {
    defcon: s.defcon,
    nibe: nibeResult,
    spa: spaResult,
    ev: decideEv(s, matrix, !!b.ev),
    battery: decideBattery(s, matrix, !!b.battery),
    appliances: decideAppliances(s, matrix, !!b.appliances),
    comfort: decideComfort(s, matrix),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Part B/C: matrix_override validation, deep-merge, and safe clamp
// ─────────────────────────────────────────────────────────────────────────────

// Payload size guard: reject JSON strings over 16 KB before parsing.
const MAX_OVERRIDE_BYTES = 16 * 1024;

// Known top-level device keys and their known fields that may be overridden.
// Unknown keys are collected as errors/warnings but do not crash.
const KNOWN_DEVICE_KEYS = new Set(['nibe', 'spa', 'ev', 'battery', 'appliances', 'comfort']);

/**
 * Validate a raw matrix_override value (JSON string or object).
 * Never throws. Returns { ok, override, errors } where:
 *   - ok: true means the value is safe to pass to mergeMatrix()
 *   - override: a clean object (possibly {}  if ok:false)
 *   - errors: array of descriptive strings
 *
 * Checks: payload size guard; JSON parseable; root is a plain object;
 * only known device keys present (unknown keys → warning in errors but ok
 * still reflects whether the shape is otherwise usable); sub-values are
 * objects (band entries, numeric scalars).
 */
function validateMatrixOverride(rawStringOrObj) {
  const errors = [];

  let raw;

  // --- Payload size guard ---
  if (typeof rawStringOrObj === 'string') {
    if (rawStringOrObj.length > MAX_OVERRIDE_BYTES) {
      errors.push(
        `matrix_override payload too large (${rawStringOrObj.length} chars, max ${MAX_OVERRIDE_BYTES})`
      );
      return { ok: false, override: {}, errors };
    }
    const trimmed = rawStringOrObj.trim();
    if (trimmed === '' || trimmed === '{}') {
      return { ok: true, override: {}, errors: [] };
    }
    try {
      raw = JSON.parse(trimmed);
    } catch (e) {
      errors.push(`matrix_override JSON parse error: ${e.message}`);
      return { ok: false, override: {}, errors };
    }
  } else if (rawStringOrObj != null && typeof rawStringOrObj === 'object') {
    raw = rawStringOrObj;
  } else if (rawStringOrObj == null || rawStringOrObj === '') {
    return { ok: true, override: {}, errors: [] };
  } else {
    errors.push('matrix_override must be a JSON string or plain object');
    return { ok: false, override: {}, errors };
  }

  // --- Root must be a plain object ---
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    errors.push('matrix_override root must be a JSON object');
    return { ok: false, override: {}, errors };
  }

  // --- Collect unknown top-level keys as errors/warnings (but do not crash) ---
  const cleanOverride = {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_DEVICE_KEYS.has(key)) {
      errors.push(`matrix_override: unknown device key "${key}" — ignored`);
      continue; // skip unknown keys silently after logging
    }
    const devVal = raw[key];
    if (typeof devVal !== 'object' || devVal === null || Array.isArray(devVal)) {
      errors.push(`matrix_override.${key}: must be a plain object — ignored`);
      continue;
    }
    cleanOverride[key] = devVal;
  }

  // If we had errors but only from unknown keys, ok is still true (we accepted
  // the shape but stripped the unknown entries). Structural errors (non-object
  // root, parse failure) already returned ok:false above.
  const hasStructuralError = errors.some((e) => !e.includes('unknown device key'));
  return { ok: !hasStructuralError, override: cleanOverride, errors };
}

/**
 * Deep-merge an override onto a base matrix and apply safety clamps.
 * Never mutates base. Returns a new matrix.
 *
 * Merge strategy: for each known device key present in override, merge
 * band entries and known scalar fields onto a deep clone of base.
 * After merging, clamp every numeric setpoint to its safe range:
 *   nibe bands: vv → [40, nibe.vvMax]
 *   spa  bands: temp → [10, spa.tempMax]
 *   ev   bands: amp  → [0, ev.maxAmp]; ev.minAmp → [0, ev.maxAmp]
 *   battery bands: power_w → [0, rated_charge_w]; pct → [0,100]
 *   battery: min_charge_w → [0, rated_charge_w]
 *
 * Safety invariants that may NOT be overridden:
 *   - nibe frost must remain true in every band.
 *   - comfort bands must remain 'allow'.
 *
 * @param {object} base     a valid matrix (use DEFAULT_MATRIX)
 * @param {object} override output of validateMatrixOverride().override
 * @returns {object} new merged+clamped matrix
 */
function mergeMatrix(base, override) {
  // Deep clone the base so we never mutate it.
  const m = JSON.parse(JSON.stringify(base));

  if (!override || typeof override !== 'object') return m;

  const BANDS = [5, 4, 3, 2, 1];

  // Helper: merge band-level scalar fields from override entry onto merged entry.
  function mergeBands(mDev, oDev) {
    if (!oDev || !oDev.bands || typeof oDev.bands !== 'object') return;
    for (const b of BANDS) {
      if (!(b in oDev.bands)) continue;
      const ob = oDev.bands[b];
      if (typeof ob !== 'object' || ob === null) continue;
      // Shallow-merge known numeric/boolean fields from override band onto merged band.
      // We do NOT replace the entire band object — only known scalar fields.
      for (const [k, v] of Object.entries(ob)) {
        // Ignore attempts to disable frost or change frostGuard to false.
        if (k === 'frost' || k === 'frostGuard') continue;
        // Ignore attempts to set comfort action to anything but 'allow'.
        // (comfort is handled separately below)
        mDev.bands[b][k] = v;
      }
    }
  }

  // --- nibe ---
  if (override.nibe) {
    const on = override.nibe;
    // Scalar overrides.
    if (typeof on.vvMax === 'number') m.nibe.vvMax = on.vvMax;
    mergeBands(m.nibe, on);
    // Clamp vv and enforce frost invariant.
    for (const b of BANDS) {
      const band = m.nibe.bands[b];
      if (typeof band.vv === 'number') {
        band.vv = clamp(band.vv, 40, m.nibe.vvMax); // frost floor = 40 °C
      }
      band.frost = true; // unconditional: frost is never overrideable
    }
  }

  // --- spa ---
  if (override.spa) {
    const os = override.spa;
    if (typeof os.tempMax === 'number') m.spa.tempMax = os.tempMax;
    mergeBands(m.spa, os);
    // Clamp temp.
    for (const b of BANDS) {
      const band = m.spa.bands[b];
      if (typeof band.temp === 'number') {
        band.temp = clamp(band.temp, 10, m.spa.tempMax); // frost floor = 10 °C
      }
    }
  }

  // --- ev ---
  if (override.ev) {
    const oe = override.ev;
    if (typeof oe.maxAmp === 'number') m.ev.maxAmp = oe.maxAmp;
    if (typeof oe.minAmp === 'number') m.ev.minAmp = clamp(oe.minAmp, 0, m.ev.maxAmp);
    if (typeof oe.gateOre === 'number') m.ev.gateOre = oe.gateOre;
    // overrideFloorA: only merge if it's an object
    if (oe.overrideFloorA && typeof oe.overrideFloorA === 'object'
        && !Array.isArray(oe.overrideFloorA)) {
      for (const [k, v] of Object.entries(oe.overrideFloorA)) {
        if (Number.isFinite(Number(v))) m.ev.overrideFloorA[k] = Number(v);
      }
    }
    mergeBands(m.ev, oe);
    // Clamp amp.
    for (const b of BANDS) {
      const band = m.ev.bands[b];
      if (typeof band.amp === 'number') {
        band.amp = clamp(band.amp, 0, m.ev.maxAmp);
      }
    }
    // Clamp minAmp after all band merges (maxAmp might have changed).
    m.ev.minAmp = clamp(m.ev.minAmp, 0, m.ev.maxAmp);
  }

  // --- battery ---
  if (override.battery) {
    const ob = override.battery;
    // Scalar safety config (SoC gates, etc.) — merge only known fields.
    for (const f of ['soc_reserve', 'soc_safety', 'soc_ceil', 'rated_charge_w',
      'min_charge_w', 'charge_price_gate']) {
      if (typeof ob[f] === 'number') m.battery[f] = ob[f];
    }
    mergeBands(m.battery, ob);
    // Clamp band power_w and pct.
    for (const b of BANDS) {
      const band = m.battery.bands[b];
      if (typeof band.power_w === 'number') {
        band.power_w = clamp(band.power_w, 0, m.battery.rated_charge_w);
      }
      if (typeof band.pct === 'number') {
        band.pct = clamp(band.pct, 0, 100);
      }
    }
    // Clamp min_charge_w.
    m.battery.min_charge_w = clamp(m.battery.min_charge_w, 0, m.battery.rated_charge_w);
  }

  // --- appliances ---
  if (override.appliances) {
    const oa = override.appliances;
    if (typeof oa.highPowerW === 'number') m.appliances.highPowerW = oa.highPowerW;
    mergeBands(m.appliances, oa);
  }

  // --- comfort ---
  // Comfort is protected: action is always 'allow'. Override attempts are silently
  // ignored — the field is not in the mergeBands loop's write path anyway because
  // we guard 'frost'/'frostGuard' above, but comfort action is an additional invariant.
  // Force it just in case an override snuck something in via mergeBands.
  if (override.comfort) {
    mergeBands(m.comfort, override.comfort);
    for (const b of BANDS) {
      m.comfort.bands[b].action = 'allow'; // invariant: always allow, cannot be overridden
    }
  }

  return m;
}

/** Self-test of the device-decision invariants. */
function selfTest() {
  const fails = [];
  const chk = (cond, msg) => { if (!cond) fails.push(msg); };

  // --- D1 invariants ---
  const d1 = decideDevices({ defcon: 1, ev: { connected: true, mustCharge: true } });
  chk(d1.nibe.frost === true && d1.nibe.vv >= 40, `D1 nibe frost/vv: ${JSON.stringify(d1.nibe)}`);
  chk(d1.spa.frostGuard === true && d1.spa.heat === false, `D1 spa frostGuard/heat: ${JSON.stringify(d1.spa)}`);
  chk(d1.ev.amp === 0, `D1 ev amp should be 0, got ${d1.ev.amp}`);
  chk(d1.battery.mode === 'discharge' || d1.battery.mode === 'idle', `D1 battery mode: ${d1.battery.mode}`);
  chk(d1.battery.mode === 'discharge', `D1 battery should discharge (socPct null), got ${d1.battery.mode}`);
  chk(d1.comfort.action === 'allow', `D1 comfort should be allow, got ${d1.comfort.action}`);

  // --- D5 invariants ---
  const d5 = decideDevices({ defcon: 5 });
  chk(d5.battery.mode === 'charge' && d5.battery.power_w === 7680, `D5 battery charge 7680: ${JSON.stringify(d5.battery)}`);
  chk(d5.appliances.action === 'run', `D5 appliances run, got ${d5.appliances.action}`);
  chk(d5.comfort.action === 'allow', `D5 comfort allow, got ${d5.comfort.action}`);

  // --- Load balance: high consumption forces EV amp down to fuse headroom ---
  // 25A fuse, 3x230 = 15870 W per amp-step base. consumption ~ 17A worth.
  const lbHigh = decideDevices({
    defcon: 5, consumptionW: 17 * 230 * 3, ev: { connected: true, mustCharge: true },
  });
  // headroom = 25 - 17 = 8A, band wants 32 => clamped to 8
  chk(lbHigh.ev.amp === 8, `load-balance clamp to 8A, got ${lbHigh.ev.amp}`);
  chk(lbHigh.ev.flags.includes('load-balance'), 'load-balance flag missing on clamp');

  // headroom < 6A => amp 0
  const lbZero = decideDevices({
    defcon: 5, consumptionW: 20 * 230 * 3, ev: { connected: true, mustCharge: true },
  });
  chk(lbZero.ev.amp === 0, `load-balance headroom<6 => 0, got ${lbZero.ev.amp}`);

  // --- (b)-override: D2 with mustCharge & connected & headroom => amp>=6 ---
  // No consumption => plenty headroom; band D2 amp=10, override floor=6 (no effect
  // since 10>6), so verify >=6 and not exceeding headroom.
  const ovr = decideDevices({
    defcon: 2, consumptionW: 0,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
    priceLevel: 5,
  });
  chk(ovr.ev.amp >= 6, `(b)-override D2 amp>=6, got ${ovr.ev.amp}`);
  // override actually lifts a cut band: simulate by retuning would be data; instead
  // confirm override floor lifts D3 below-floor case. Use a matrix clone w/ D3 amp 1.
  const m2 = JSON.parse(JSON.stringify(DEFAULT_MATRIX));
  m2.ev.bands[3].amp = 1;
  const ovrLift = decideDevices({
    defcon: 3, consumptionW: 0,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
    priceLevel: 5,
  }, m2);
  chk(ovrLift.ev.amp >= DEFAULT_MATRIX.ev.overrideFloorA[3] && ovrLift.ev.flags.includes('override-floor'),
    `(b)-override D3 lift to floor, got ${ovrLift.ev.amp}`);

  // override must never exceed load-balance headroom
  const ovrCap = decideDevices({
    defcon: 2, consumptionW: 22 * 230 * 3,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
    priceLevel: 5,
  });
  // headroom 3A < 6 => 0
  chk(ovrCap.ev.amp === 0, `(b)-override capped by load-balance, got ${ovrCap.ev.amp}`);

  // --- Price control-question ---
  const priceQ = decideDevices({
    defcon: 5, consumptionW: 0, priceLevel: 2,
    ev: { connected: true, mustCharge: true },
  });
  chk(priceQ.ev.expensiveConfirmNeeded === true && priceQ.ev.amp === 0,
    `price unconfirmed => need confirm & amp 0, got ${JSON.stringify(priceQ.ev)}`);
  const priceOK = decideDevices({
    defcon: 5, consumptionW: 0, priceLevel: 2,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
  });
  chk(priceOK.ev.amp > 0 && priceOK.ev.expensiveConfirmNeeded === false,
    `price confirmed => amp>0, got ${JSON.stringify(priceOK.ev)}`);

  // --- SoC gates ---
  // socPct < 5 => battery idle & ev amp 0
  const socCrit = decideDevices({
    defcon: 3, socPct: 4, consumptionW: 0,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
  });
  chk(socCrit.battery.mode === 'idle', `socPct<5 battery idle, got ${socCrit.battery.mode}`);
  chk(socCrit.ev.amp === 0, `socPct<5 ev amp 0, got ${socCrit.ev.amp}`);

  // 5..15 => battery idle on discharge bands (D3 is discharge)
  const socLow = decideDevices({ defcon: 3, socPct: 12 });
  chk(socLow.battery.mode === 'idle', `socPct 12 discharge band => idle, got ${socLow.battery.mode}`);

  // socPct >= 97 => no charge on charge bands (D5 is charge)
  const socFull = decideDevices({ defcon: 5, socPct: 98 });
  chk(socFull.battery.mode === 'idle', `socPct>=97 charge band => idle, got ${socFull.battery.mode}`);

  // --- Monotonicity: DEFAULT_MATRIX must pass validateMatrix ---
  const mv = validateMatrix(DEFAULT_MATRIX);
  chk(mv.ok === true, `DEFAULT_MATRIX failed monotonicity check: ${mv.errors.join('; ')}`);

  // --- Monotonicity: negative cases (deliberate violations) ---

  // Break EV amp monotonicity: D3 amp above D4 amp
  const mBadEv = JSON.parse(JSON.stringify(DEFAULT_MATRIX));
  mBadEv.ev.bands[3].amp = mBadEv.ev.bands[4].amp + 1; // D3 > D4 → violation
  const mvBadEv = validateMatrix(mBadEv);
  chk(mvBadEv.ok === false, 'validateMatrix should catch EV amp increase D4→D3');
  chk(mvBadEv.errors.some((e) => e.includes('ev') && e.includes('amp')),
    `Expected ev/amp error, got: ${mvBadEv.errors.join('; ')}`);

  // Break nibe vv monotonicity: D2 vv above D3 vv
  const mBadNibe = JSON.parse(JSON.stringify(DEFAULT_MATRIX));
  mBadNibe.nibe.bands[2].vv = mBadNibe.nibe.bands[3].vv + 2; // D2 > D3 → violation
  const mvBadNibe = validateMatrix(mBadNibe);
  chk(mvBadNibe.ok === false, 'validateMatrix should catch nibe vv increase D3→D2');
  chk(mvBadNibe.errors.some((e) => e.includes('nibe') && e.includes('vv')),
    `Expected nibe/vv error, got: ${mvBadNibe.errors.join('; ')}`);

  // Break battery mode monotonicity: charge at D2 (discharge already at D3)
  const mBadBatt = JSON.parse(JSON.stringify(DEFAULT_MATRIX));
  mBadBatt.battery.bands[2].mode = 'charge'; // D2=charge after D3=discharge → violation
  const mvBadBatt = validateMatrix(mBadBatt);
  chk(mvBadBatt.ok === false, 'validateMatrix should catch battery mode non-monotone D3→D2');
  chk(mvBadBatt.errors.some((e) => e.includes('battery') && e.includes('mode')),
    `Expected battery/mode error, got: ${mvBadBatt.errors.join('; ')}`);

  // Break comfort invariant: set D3 action to something other than 'allow'
  const mBadComfort = JSON.parse(JSON.stringify(DEFAULT_MATRIX));
  mBadComfort.comfort.bands[3].action = 'deny';
  const mvBadComfort = validateMatrix(mBadComfort);
  chk(mvBadComfort.ok === false, 'validateMatrix should catch comfort non-allow');
  chk(mvBadComfort.errors.some((e) => e.includes('comfort')),
    `Expected comfort error, got: ${mvBadComfort.errors.join('; ')}`);

  // --- Part A: matrix.ev.minAmp / overrideFloorA are on the matrix object ---
  chk(DEFAULT_MATRIX.ev.minAmp === 6, `ev.minAmp should be 6, got ${DEFAULT_MATRIX.ev.minAmp}`);
  chk(DEFAULT_MATRIX.ev.overrideFloorA[2] === 6, `overrideFloorA[2] should be 6, got ${DEFAULT_MATRIX.ev.overrideFloorA[2]}`);
  chk(DEFAULT_MATRIX.ev.overrideFloorA[3] === 3, `overrideFloorA[3] should be 3, got ${DEFAULT_MATRIX.ev.overrideFloorA[3]}`);

  // --- Part A: battery.min_charge_w floor: power below floor → idle ---
  // Matrix clone with a high min_charge_w so D4 (power_w=3840) triggers the floor.
  const mHighMinCharge = JSON.parse(JSON.stringify(DEFAULT_MATRIX));
  mHighMinCharge.battery.min_charge_w = 5000;
  // D4: band power_w=3840 < min_charge_w=5000 → should return idle with 'min-charge-floor' flag
  const battLow = decideDevices({ defcon: 4 }, mHighMinCharge);
  chk(battLow.battery.mode === 'idle',
    `min_charge_w floor: power 3840 < 5000 → idle, got ${battLow.battery.mode}`);
  chk(battLow.battery.flags.includes('min-charge-floor'),
    `min_charge_w floor: flag 'min-charge-floor' missing, got ${JSON.stringify(battLow.battery.flags)}`);
  chk(battLow.battery.power_w === 0,
    `min_charge_w floor: power_w should be 0, got ${battLow.battery.power_w}`);

  // D5: headroom mode → power=rated_charge_w=7680 ≥ min_charge_w=5000 → charge (not idle)
  const battOk = decideDevices({ defcon: 5 }, mHighMinCharge);
  chk(battOk.battery.mode === 'charge',
    `min_charge_w: rated power 7680 >= 5000 → charge, got ${battOk.battery.mode}`);

  // DEFAULT_MATRIX: D5 power 7680 >= min_charge_w 1152 → charge (unchanged default behaviour)
  chk(d5.battery.mode === 'charge' && d5.battery.power_w === 7680,
    `default D5 charge unaffected by min_charge_w, got ${JSON.stringify(d5.battery)}`);

  // min_charge_w=0 (disabled): power > 0 and power >= 0 → no idle forced
  const mNoMinCharge = JSON.parse(JSON.stringify(DEFAULT_MATRIX));
  mNoMinCharge.battery.min_charge_w = 0;
  const battNoMin = decideDevices({ defcon: 4 }, mNoMinCharge);
  chk(battNoMin.battery.mode === 'charge',
    `min_charge_w=0 disabled: D4 should charge, got ${battNoMin.battery.mode}`);

  // --- Part A: hardware ceiling fields exist on the matrix ---
  chk(DEFAULT_MATRIX.ev.maxAmp === 32,
    `ev.maxAmp should be 32, got ${DEFAULT_MATRIX.ev.maxAmp}`);
  chk(DEFAULT_MATRIX.nibe.vvMax === 65,
    `nibe.vvMax should be 65, got ${DEFAULT_MATRIX.nibe.vvMax}`);
  chk(DEFAULT_MATRIX.spa.tempMax === 40,
    `spa.tempMax should be 40, got ${DEFAULT_MATRIX.spa.tempMax}`);
  chk(DEFAULT_MATRIX.battery.min_charge_w === 1152,
    `battery.min_charge_w default should be 1152, got ${DEFAULT_MATRIX.battery.min_charge_w}`);

  // =========================================================================
  // Part B/C: validateMatrixOverride + mergeMatrix selfTests
  // =========================================================================

  // --- validateMatrixOverride: valid override (lowers EV amp) ---
  const vo1 = validateMatrixOverride('{"ev":{"bands":{"5":{"amp":16},"4":{"amp":10}}}}');
  chk(vo1.ok === true, `valid override should be ok:true, errors: ${vo1.errors.join(', ')}`);
  chk(vo1.override.ev != null, 'valid override should have ev key');

  // --- validateMatrixOverride: empty string → ok:true, empty override ---
  const vo2 = validateMatrixOverride('');
  chk(vo2.ok === true, 'empty string override → ok:true');
  chk(Object.keys(vo2.override).length === 0, 'empty string → empty override object');

  // --- validateMatrixOverride: {} string → ok:true, empty override ---
  const vo3 = validateMatrixOverride('{}');
  chk(vo3.ok === true, 'empty {} override → ok:true');

  // --- validateMatrixOverride: invalid JSON → ok:false, safe empty override ---
  const vo4 = validateMatrixOverride('{bad json');
  chk(vo4.ok === false, 'invalid JSON override → ok:false');
  chk(Object.keys(vo4.override).length === 0, 'invalid JSON → empty override');
  chk(vo4.errors.length > 0, 'invalid JSON → errors array non-empty');

  // --- validateMatrixOverride: oversized payload → ok:false ---
  const bigPayload = 'x'.repeat(MAX_OVERRIDE_BYTES + 1);
  const vo5 = validateMatrixOverride(bigPayload);
  chk(vo5.ok === false, 'oversized payload → ok:false');
  chk(vo5.errors.some((e) => e.includes('too large')), 'oversized payload → "too large" error');

  // --- validateMatrixOverride: unknown device key → warning in errors, ok:true ---
  const vo6 = validateMatrixOverride('{"unknown_device":{"bands":{}}}');
  chk(vo6.ok === true, 'unknown device key → ok:true (stripped, not fatal)');
  chk(vo6.errors.some((e) => e.includes('unknown_device')), 'unknown key produces a warning message');
  chk(!('unknown_device' in vo6.override), 'unknown key must be stripped from override');

  // --- validateMatrixOverride: non-object root → ok:false ---
  const vo7 = validateMatrixOverride('"just a string"');
  chk(vo7.ok === false, 'non-object JSON root → ok:false');

  // --- validateMatrixOverride: plain object input ---
  const vo8 = validateMatrixOverride({ ev: { bands: { 5: { amp: 20 } } } });
  chk(vo8.ok === true, 'plain object override → ok:true');
  chk(vo8.override.ev != null, 'plain object override → ev key present');

  // --- mergeMatrix: valid override lowers EV amp at D5 ---
  const mMerge1 = mergeMatrix(DEFAULT_MATRIX, { ev: { bands: { 5: { amp: 16 } } } });
  chk(mMerge1.ev.bands[5].amp === 16, `mergeMatrix lowered D5 amp to 16, got ${mMerge1.ev.bands[5].amp}`);
  // Default matrix must be unchanged (no mutation).
  chk(DEFAULT_MATRIX.ev.bands[5].amp === 32, 'DEFAULT_MATRIX must not be mutated by mergeMatrix');

  // --- mergeMatrix: override trying to RAISE amp above maxAmp is clamped ---
  const mMerge2 = mergeMatrix(DEFAULT_MATRIX, { ev: { bands: { 5: { amp: 99 } } } });
  chk(mMerge2.ev.bands[5].amp === 32,
    `amp 99 clamped to maxAmp 32, got ${mMerge2.ev.bands[5].amp}`);

  // --- mergeMatrix: nibe vv clamped to vvMax (65) ---
  const mMerge3 = mergeMatrix(DEFAULT_MATRIX, { nibe: { bands: { 5: { vv: 80 } } } });
  chk(mMerge3.nibe.bands[5].vv === 65, `nibe vv 80 clamped to vvMax 65, got ${mMerge3.nibe.bands[5].vv}`);

  // --- mergeMatrix: nibe vv clamped to frost floor (40) ---
  const mMerge4 = mergeMatrix(DEFAULT_MATRIX, { nibe: { bands: { 5: { vv: 30 } } } });
  chk(mMerge4.nibe.bands[5].vv === 40, `nibe vv 30 clamped to frost floor 40, got ${mMerge4.nibe.bands[5].vv}`);

  // --- mergeMatrix: frost invariant cannot be overridden ---
  const mMerge5 = mergeMatrix(DEFAULT_MATRIX, { nibe: { bands: { 1: { frost: false } } } });
  chk(mMerge5.nibe.bands[1].frost === true, 'frost invariant: override frost=false must be ignored');

  // --- mergeMatrix: comfort action cannot be overridden ---
  const mMerge6 = mergeMatrix(DEFAULT_MATRIX, { comfort: { bands: { 1: { action: 'deny' } } } });
  chk(mMerge6.comfort.bands[1].action === 'allow',
    `comfort invariant: action 'deny' override must be reset to 'allow', got ${mMerge6.comfort.bands[1].action}`);

  // --- mergeMatrix: spa temp clamped to [10, tempMax=40] ---
  const mMerge7 = mergeMatrix(DEFAULT_MATRIX, { spa: { bands: { 5: { temp: 50 } } } });
  chk(mMerge7.spa.bands[5].temp === 40, `spa temp 50 clamped to tempMax 40, got ${mMerge7.spa.bands[5].temp}`);
  const mMerge8 = mergeMatrix(DEFAULT_MATRIX, { spa: { bands: { 5: { temp: 5 } } } });
  chk(mMerge8.spa.bands[5].temp === 10, `spa temp 5 clamped to frost floor 10, got ${mMerge8.spa.bands[5].temp}`);

  // --- mergeMatrix: battery power_w clamped to [0, rated_charge_w] ---
  const mMerge9 = mergeMatrix(DEFAULT_MATRIX, { battery: { bands: { 5: { power_w: 99999 } } } });
  chk(mMerge9.battery.bands[5].power_w === 7680,
    `battery power_w 99999 clamped to rated 7680, got ${mMerge9.battery.bands[5].power_w}`);

  // --- mergeMatrix: min_charge_w clamped to [0, rated_charge_w] ---
  const mMerge10 = mergeMatrix(DEFAULT_MATRIX, { battery: { min_charge_w: 9999 } });
  chk(mMerge10.battery.min_charge_w === 7680,
    `min_charge_w 9999 clamped to rated 7680, got ${mMerge10.battery.min_charge_w}`);

  // --- mergeMatrix + validateMatrix: monotonicity-breaking override → validateMatrix ok:false ---
  // Set D4=8 and D3=16: D3 > D4 → monotonicity violation. Both values are within
  // [0, maxAmp=32] so the clamp does not mask the violation.
  const mMergeBad = mergeMatrix(DEFAULT_MATRIX, {
    ev: { bands: { 4: { amp: 8 }, 3: { amp: 16 } } },
  });
  const mvMergeBad = validateMatrix(mMergeBad);
  chk(mvMergeBad.ok === false,
    'monotonicity-breaking override must fail validateMatrix after merge');
  chk(mvMergeBad.errors.some((e) => e.includes('ev')),
    `expected ev monotonicity error, got: ${mvMergeBad.errors.join('; ')}`);

  // --- mergeMatrix + validateMatrix: valid override passes validateMatrix ---
  const mMergeGood = mergeMatrix(DEFAULT_MATRIX, {
    ev: { bands: { 5: { amp: 20 }, 4: { amp: 16 }, 3: { amp: 10 }, 2: { amp: 6 }, 1: { amp: 0 } } },
  });
  const mvMergeGood = validateMatrix(mMergeGood);
  chk(mvMergeGood.ok === true, `valid monotone override must pass validateMatrix, errors: ${mvMergeGood.errors.join('; ')}`);

  // --- ev.minAmp clamped to [0, ev.maxAmp] ---
  const mMinAmpClamp = mergeMatrix(DEFAULT_MATRIX, { ev: { minAmp: 99 } });
  chk(mMinAmpClamp.ev.minAmp === 32,
    `ev.minAmp 99 clamped to maxAmp 32, got ${mMinAmpClamp.ev.minAmp}`);

  // =========================================================================
  // PLAN 6: boost / per-device override selfTests
  // =========================================================================

  // --- backward compat: boosts omitted → identical to existing behaviour ---
  const bkCompat = decideDevices({ defcon: 2, consumptionW: 0, priceLevel: 5,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true } });
  chk(bkCompat.ev.amp === DEFAULT_MATRIX.ev.bands[2].amp,
    `backward compat D2 ev amp, got ${bkCompat.ev.amp}`);
  chk(bkCompat.nibe.vv === DEFAULT_MATRIX.nibe.bands[2].vv,
    `backward compat D2 nibe.vv, got ${bkCompat.nibe.vv}`);

  // --- boosted EV at house D2 with expensive price (priceLevel 2, unconfirmed) ---
  // Expects: D5 amp (32), price gate bypassed → amp NOT zeroed.
  // consumptionW=0 → headroom=25A, but D5 band=32 clamped to 25A by load-balance.
  // Wait — 32 > 25, so load-balance kicks in → amp=25. That is still > 6 (minAmp), so amp=25.
  const boostEvD2Expensive = decideDevices(
    { defcon: 2, consumptionW: 0, priceLevel: 2,
      ev: { connected: true, mustCharge: true, expensiveConfirmed: false } },
    DEFAULT_MATRIX,
    { ev: true },
  );
  // D5 band amp=32, headroom=25A → clamped to 25; price gate bypassed.
  chk(boostEvD2Expensive.ev.amp > 0,
    `boosted ev D2 expensive price: amp should be >0 (price bypassed), got ${boostEvD2Expensive.ev.amp}`);
  chk(boostEvD2Expensive.ev.expensiveConfirmNeeded === false,
    `boosted ev: expensiveConfirmNeeded must be false (price bypassed), got ${boostEvD2Expensive.ev.expensiveConfirmNeeded}`);
  chk(boostEvD2Expensive.ev.flags.includes('boosted'),
    `boosted ev: flags must include 'boosted', got ${JSON.stringify(boostEvD2Expensive.ev.flags)}`);
  // House defcon is still D2 (boost doesn't change reported defcon)
  chk(boostEvD2Expensive.defcon === 2,
    `boosted ev: house defcon still 2, got ${boostEvD2Expensive.defcon}`);
  // D5 amp was 32; headroom with consumption=0 is floor(25 - 0/690)=25; 32>25 → clamped to 25
  chk(boostEvD2Expensive.ev.amp === 25,
    `boosted ev D2: amp clamped by load-balance to 25A, got ${boostEvD2Expensive.ev.amp}`);

  // --- boosted nibe at house D1: vv must be D5 value (53), frost still true ---
  const boostNibeD1 = decideDevices({ defcon: 1 }, DEFAULT_MATRIX, { nibe: true });
  chk(boostNibeD1.nibe.vv === DEFAULT_MATRIX.nibe.bands[5].vv,
    `boosted nibe D1: vv should be D5 (${DEFAULT_MATRIX.nibe.bands[5].vv}), got ${boostNibeD1.nibe.vv}`);
  chk(boostNibeD1.nibe.frost === true,
    `boosted nibe D1: frost must still be true, got ${boostNibeD1.nibe.frost}`);
  // Other devices unaffected
  chk(boostNibeD1.ev.amp === 0, `boosted nibe D1: ev must still be 0 at D1, got ${boostNibeD1.ev.amp}`);
  chk(boostNibeD1.nibe.boosted === true, `boosted nibe: boosted flag must be set`);

  // --- boosted battery at house D1: mode='charge' (D5), but soc-ceil veto still wins ---
  // soc=98 ≥ soc_ceil=97 → idle even when boosted
  const boostBattD1SocFull = decideDevices({ defcon: 1, socPct: 98 }, DEFAULT_MATRIX, { battery: true });
  chk(boostBattD1SocFull.battery.mode === 'idle',
    `boosted battery D1 soc=98: soc-ceil veto must win, got ${boostBattD1SocFull.battery.mode}`);
  chk(boostBattD1SocFull.battery.flags.includes('soc-ceil'),
    `boosted battery D1 soc=98: soc-ceil flag must be present, got ${JSON.stringify(boostBattD1SocFull.battery.flags)}`);
  // soc low enough → mode='charge'
  const boostBattD1SocOk = decideDevices({ defcon: 1, socPct: 50 }, DEFAULT_MATRIX, { battery: true });
  chk(boostBattD1SocOk.battery.mode === 'charge',
    `boosted battery D1 soc=50: must be charge (D5 band), got ${boostBattD1SocOk.battery.mode}`);
  chk(boostBattD1SocOk.battery.flags.includes('boosted'),
    `boosted battery: 'boosted' flag must be present, got ${JSON.stringify(boostBattD1SocOk.battery.flags)}`);

  // --- boosted EV while house battery socPct<5: battery-safety veto still wins ---
  const boostEvLowSoc = decideDevices(
    { defcon: 5, consumptionW: 0, priceLevel: 5, socPct: 3,
      ev: { connected: true, mustCharge: true, expensiveConfirmed: true } },
    DEFAULT_MATRIX,
    { ev: true },
  );
  chk(boostEvLowSoc.ev.amp === 0,
    `boosted ev socPct<5: battery-safety veto wins, amp must be 0, got ${boostEvLowSoc.ev.amp}`);
  chk(boostEvLowSoc.ev.flags.includes('battery-safety-veto'),
    `boosted ev socPct<5: battery-safety-veto flag must be set, got ${JSON.stringify(boostEvLowSoc.ev.flags)}`);

  // --- boosted EV with high consumption: load-balance fuse ceiling still wins ---
  // consumption=22*230*3=15180W → headroom=floor(25-15180/690)=floor(25-22)=3A < 6A → 0A
  const boostEvHighLoad = decideDevices(
    { defcon: 2, consumptionW: 22 * 230 * 3, priceLevel: 5,
      ev: { connected: true, mustCharge: true, expensiveConfirmed: true } },
    DEFAULT_MATRIX,
    { ev: true },
  );
  chk(boostEvHighLoad.ev.amp === 0,
    `boosted ev high consumption: load-balance wins, amp must be 0, got ${boostEvHighLoad.ev.amp}`);
  chk(boostEvHighLoad.ev.flags.includes('load-balance'),
    `boosted ev high consumption: load-balance flag must be set, got ${JSON.stringify(boostEvHighLoad.ev.flags)}`);

  // --- DEFAULT_MATRIX not mutated by any boost call ---
  chk(DEFAULT_MATRIX.ev.bands[2].amp === 10,
    `DEFAULT_MATRIX must not be mutated by boost, ev D2 amp=${DEFAULT_MATRIX.ev.bands[2].amp}`);
  chk(DEFAULT_MATRIX.nibe.bands[1].vv === 40,
    `DEFAULT_MATRIX must not be mutated by boost, nibe D1 vv=${DEFAULT_MATRIX.nibe.bands[1].vv}`);
  chk(DEFAULT_MATRIX.battery.bands[1].mode === 'discharge',
    `DEFAULT_MATRIX must not be mutated by boost, battery D1 mode=${DEFAULT_MATRIX.battery.bands[1].mode}`);

  // --- comfort is unaffected by boosts (always 'allow') ---
  const boostAll = decideDevices({ defcon: 1 }, DEFAULT_MATRIX,
    { nibe: true, spa: true, ev: true, battery: true, appliances: true });
  chk(boostAll.comfort.action === 'allow',
    `comfort must always be allow regardless of boosts, got ${boostAll.comfort.action}`);

  return { pass: fails.length === 0, fails };
}

module.exports = {
  DEFAULT_MATRIX,
  OVERRIDE_FLOOR_A,       // back-compat: alias to DEFAULT_MATRIX.ev.overrideFloorA
  MAX_OVERRIDE_BYTES,
  decideDevices,
  validateMatrix,
  validateMatrixOverride,
  mergeMatrix,
  selfTest,
};
