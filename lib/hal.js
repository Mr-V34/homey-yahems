'use strict';

/**
 * YAHEMS Hardware Abstraction Layer (HAL).
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * Maps a per-user device map (stored as JSON in the `device_map` driver setting)
 * plus a snapshot of raw Homey device capability values into the canonical signal
 * object that `lib/matrix.js` `decideDevices(input)` consumes.
 *
 * This module is PURE: it imports nothing from `homey` and can be exercised
 * directly by `test/selftest.js`. All Homey API calls live in device.js.
 *
 * ---
 * DEVICE MAP SHAPE (stored as JSON string in driver setting `device_map`):
 *
 * {
 *   "inputs": [
 *     {
 *       "signal":     "home_consumption_w",          // canonical signal key (see table below)
 *       "deviceId":   "<homey-device-uuid>",          // device.id from Homey
 *       "capability": "measure_power",                // capability id on that device
 *       "activeAbove": 15                             // optional — turns numeric → boolean "active"
 *     },
 *     ...
 *   ],
 *   "control": {
 *     "house_meter_present": false                    // replicated from settings for quick read
 *   }
 * }
 *
 * Supported canonical signal keys and their matrix.js field mapping:
 *
 *   grid_power_w          → gridPowerW            (number, watts, signed: + import / − export)
 *   home_consumption_w    → consumptionW          (number, watts, net house draw)
 *   battery_soc_pct       → socPct                (number 0-100, house battery)
 *   price_ore             → priceOre              (number, ore/kWh spot price)
 *   ev_connected          → ev.connected          (boolean — or truthy numeric via activeAbove)
 *   ev_battery_soc_pct    → ev.batterySocPct      (number 0-100, car battery)
 *   solar_production_w    → solarProductionW      (number, watts, PV production)
 *   dishwasher_power_w    → dishwasherPowerW      (number, watts)
 *   washer_power_w        → washerPowerW          (number, watts)
 *   dryer_power_w         → dryerPowerW           (number, watts)
 *
 * Unknown signal keys are collected into the returned warnings list and ignored.
 *
 * SNAPSHOT SHAPE (built by device.js from HomeyAPI):
 *   { [deviceId]: { [capabilityId]: value } }
 *
 * resolveSignals() returns:
 *   { signals, warnings }
 *   where signals is a PARTIAL object ready to spread into decideDevices() input.
 *   If a device or capability is missing from the snapshot the signal is OMITTED
 *   entirely so matrix.normalize() uses its safe default — a zero is never injected
 *   as a substitute for "we don't know".
 */

const signals = require('./signals');

// Supported signal → matrix field mappings.
// Top-level fields are plain; nested fields are dotted paths.
// Keys MUST stay in sync with lib/signals.js CATALOGUE — selfTest asserts parity.
const SIGNAL_MAP = {
  grid_power_w:        { field: 'gridPowerW',         type: 'number' },
  home_consumption_w:  { field: 'consumptionW',       type: 'number' },
  battery_soc_pct:     { field: 'socPct',             type: 'number' },
  price_ore:           { field: 'priceOre',           type: 'number' },
  ev_connected:        { field: 'ev.connected',       type: 'boolean' },
  ev_battery_soc_pct:  { field: 'ev.batterySocPct',   type: 'number' },
  solar_production_w:  { field: 'solarProductionW',   type: 'number' },
  dishwasher_power_w:  { field: 'dishwasherPowerW',   type: 'number' },
  washer_power_w:      { field: 'washerPowerW',        type: 'number' },
  dryer_power_w:       { field: 'dryerPowerW',         type: 'number' },
};

// Safe empty map returned on any parse/validation error.
const EMPTY_MAP = Object.freeze({
  inputs: [],
  control: { house_meter_present: false },
  controls: {},   // per controlled-device presence config (settings v2)
  custom: [],     // user-added consumers (settings v2)
});

// Presence values a controlled-device may take in the `controls` block.
const PRESENCE = new Set(['installed', 'absent', 'simulate']);
// Modes a custom consumer may take.
const CUSTOM_MODES = new Set(['pausable', 'monitor']);
// Cap on custom consumers — generous for any home.
const MAX_CUSTOM = 30;

// Payload size guard: reject JSON strings over 32 KB before parsing.
// A valid device_map with 50 well-formed entries is well under this limit.
const MAX_MAP_BYTES = 32 * 1024;

// Maximum number of input entries allowed in a device_map.
// 50 is a generous ceiling for any foreseeable single-home installation.
const MAX_MAP_INPUTS = 50;

/**
 * Set a value at a dotted path inside an object.
 * Supports one level of nesting (e.g. 'ev.connected').
 * @private
 */
function _setPath(obj, path, value) {
  const dot = path.indexOf('.');
  if (dot === -1) {
    obj[path] = value;
  } else {
    const head = path.slice(0, dot);
    const tail = path.slice(dot + 1);
    if (obj[head] == null || typeof obj[head] !== 'object') obj[head] = {};
    obj[head][tail] = value;
  }
}

/**
 * Resolve canonical signals from a device map + a capability snapshot.
 *
 * @param {object} map      validated map object (from validateMap)
 * @param {object} snapshot { [deviceId]: { [capabilityId]: value } }
 * @returns {{ signals: object, warnings: string[] }}
 */
function resolveSignals(map, snapshot) {
  const signals = {};
  const warnings = [];
  const safeMap = (map && Array.isArray(map.inputs)) ? map : EMPTY_MAP;
  const safeSnap = snapshot && typeof snapshot === 'object' ? snapshot : {};

  for (const entry of safeMap.inputs) {
    const { signal, deviceId, capability, activeAbove } = entry;

    // Unknown signal key — skip but warn.
    const meta = SIGNAL_MAP[signal];
    if (!meta) {
      warnings.push(`Unknown signal key "${signal}" — ignored`);
      continue;
    }

    // Device missing from snapshot — omit (not zero).
    const devSnap = safeSnap[deviceId];
    if (devSnap == null) continue;

    // Capability missing or undefined on this device — omit (not zero).
    if (!(capability in devSnap) || devSnap[capability] === undefined) continue;

    const raw = devSnap[capability];

    // Null capability value (device reported null) — omit.
    if (raw === null) continue;

    let value;
    if (meta.type === 'boolean') {
      // Direct boolean capability, or numeric interpreted via activeAbove.
      if (activeAbove != null && typeof raw === 'number') {
        value = raw > activeAbove;
      } else {
        value = Boolean(raw);
      }
    } else {
      // Numeric. Apply activeAbove if present (converts to boolean-as-number 0/1).
      const num = Number(raw);
      if (!Number.isFinite(num)) continue; // non-numeric raw — omit
      if (activeAbove != null) {
        value = num > activeAbove; // boolean result
      } else {
        value = num;
      }
    }

    _setPath(signals, meta.field, value);
  }

  return { signals, warnings };
}

/**
 * Validate and parse a device map.
 * Accepts either a plain object or a JSON string.
 * Never throws. Returns ok:false with safe empty map on any error.
 *
 * @param {string|object} rawMapOrString
 * @returns {{ ok: boolean, map: object, errors: string[] }}
 */
function validateMap(rawMapOrString) {
  const errors = [];
  let raw;

  // Parse if string.
  if (typeof rawMapOrString === 'string') {
    // Payload size guard: reject before parsing to protect the CPU.
    if (rawMapOrString.length > MAX_MAP_BYTES) {
      errors.push(
        `device_map payload too large (${rawMapOrString.length} chars, max ${MAX_MAP_BYTES})`
      );
      return { ok: false, map: JSON.parse(JSON.stringify(EMPTY_MAP)), errors };
    }
    const trimmed = rawMapOrString.trim();
    if (trimmed === '') {
      // Empty string → treat as empty map with no error.
      return { ok: true, map: JSON.parse(JSON.stringify(EMPTY_MAP)), errors: [] };
    }
    try {
      raw = JSON.parse(trimmed);
    } catch (e) {
      errors.push(`JSON parse error: ${e.message}`);
      return { ok: false, map: JSON.parse(JSON.stringify(EMPTY_MAP)), errors };
    }
  } else if (rawMapOrString != null && typeof rawMapOrString === 'object') {
    raw = rawMapOrString;
  } else {
    errors.push('Map must be a JSON string or object');
    return { ok: false, map: JSON.parse(JSON.stringify(EMPTY_MAP)), errors };
  }

  // Validate shape.
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('Map root must be a JSON object');
    return { ok: false, map: JSON.parse(JSON.stringify(EMPTY_MAP)), errors };
  }

  if (!Array.isArray(raw.inputs)) {
    errors.push('"inputs" must be an array');
    return { ok: false, map: JSON.parse(JSON.stringify(EMPTY_MAP)), errors };
  }

  // Entry count guard: reject maps with more than MAX_MAP_INPUTS entries.
  // Keeps processing cheap and signals a misconfiguration clearly.
  if (raw.inputs.length > MAX_MAP_INPUTS) {
    errors.push(
      `device_map has ${raw.inputs.length} inputs, max allowed is ${MAX_MAP_INPUTS}`
    );
    return { ok: false, map: JSON.parse(JSON.stringify(EMPTY_MAP)), errors };
  }

  // Validate each input entry.
  const validInputs = [];
  for (let i = 0; i < raw.inputs.length; i++) {
    const e = raw.inputs[i];
    const prefix = `inputs[${i}]`;
    if (typeof e !== 'object' || e == null) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }
    if (typeof e.signal !== 'string' || !e.signal) {
      errors.push(`${prefix}: "signal" must be a non-empty string`);
      continue;
    }
    if (typeof e.deviceId !== 'string' || !e.deviceId) {
      errors.push(`${prefix}: "deviceId" must be a non-empty string`);
      continue;
    }
    if (typeof e.capability !== 'string' || !e.capability) {
      errors.push(`${prefix}: "capability" must be a non-empty string`);
      continue;
    }
    if (e.activeAbove != null && !Number.isFinite(Number(e.activeAbove))) {
      errors.push(`${prefix}: "activeAbove" must be a finite number if provided`);
      continue;
    }
    const clean = { signal: e.signal, deviceId: e.deviceId, capability: e.capability };
    if (e.activeAbove != null) clean.activeAbove = Number(e.activeAbove);
    validInputs.push(clean);
  }

  // Build control block with safe defaults.
  const rawControl = (raw.control && typeof raw.control === 'object') ? raw.control : {};
  const control = {
    house_meter_present: rawControl.house_meter_present === true,
  };

  // --- controls block (settings v2): per controlled-device presence config. ---
  // Additive + lenient: bad entries are skipped (with a warning), good ones kept,
  // so an older map without this block still validates fine.
  const controls = {};
  const rawControls = (raw.controls && typeof raw.controls === 'object' && !Array.isArray(raw.controls))
    ? raw.controls : {};
  for (const [key, val] of Object.entries(rawControls)) {
    if (!val || typeof val !== 'object') { errors.push(`controls.${key}: must be an object`); continue; }
    const presence = PRESENCE.has(val.presence) ? val.presence : 'absent';
    const clean = { presence };
    if (typeof val.deviceId === 'string' && val.deviceId) clean.deviceId = val.deviceId;
    // "Storförbrukare" (big-load): when true this device follows the price slider.
    if (val.bigLoad === true) clean.bigLoad = true;
    if (val.functions && typeof val.functions === 'object' && !Array.isArray(val.functions)) {
      const fns = {};
      for (const [fk, fv] of Object.entries(val.functions)) {
        if (fv && typeof fv === 'object' && typeof fv.deviceId === 'string' && typeof fv.capability === 'string') {
          fns[fk] = { deviceId: fv.deviceId, capability: fv.capability };
        }
      }
      if (Object.keys(fns).length) clean.functions = fns;
    }
    controls[key] = clean;
  }

  // --- custom consumers (settings v2): user-added loads. ---
  const custom = [];
  const rawCustom = Array.isArray(raw.custom) ? raw.custom : [];
  if (rawCustom.length > MAX_CUSTOM) {
    errors.push(`custom has ${rawCustom.length} entries, max allowed is ${MAX_CUSTOM}`);
  } else {
    for (let i = 0; i < rawCustom.length; i++) {
      const c = rawCustom[i];
      const p = `custom[${i}]`;
      if (!c || typeof c !== 'object') { errors.push(`${p}: must be an object`); continue; }
      if (typeof c.deviceId !== 'string' || !c.deviceId) { errors.push(`${p}: deviceId required`); continue; }
      if (typeof c.capability !== 'string' || !c.capability) { errors.push(`${p}: capability required`); continue; }
      const mode = CUSTOM_MODES.has(c.mode) ? c.mode : 'monitor';
      const clean = {
        id: (typeof c.id === 'string' && c.id) ? c.id : `custom-${i}`,
        name: (typeof c.name === 'string' && c.name) ? c.name : `Consumer ${i + 1}`,
        deviceId: c.deviceId,
        capability: c.capability,
        mode,
      };
      if (mode === 'pausable' && Number.isFinite(Number(c.pauseAtOrBelow))) {
        clean.pauseAtOrBelow = clamp(Math.round(Number(c.pauseAtOrBelow)), 1, 5);
      }
      custom.push(clean);
    }
  }

  const map = { inputs: validInputs, control, controls, custom };
  const ok = errors.length === 0;
  return { ok, map, errors };
}

/** Clamp helper (local; matches matrix.js semantics). */
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

/** Self-test. */
function selfTest() {
  const fails = [];
  const chk = (cond, msg) => { if (!cond) fails.push(msg); };

  // --- 1. Valid map resolves correct signals ---
  const map1 = {
    inputs: [
      { signal: 'home_consumption_w', deviceId: 'dev-1', capability: 'measure_power' },
      { signal: 'battery_soc_pct',    deviceId: 'dev-2', capability: 'measure_battery' },
      { signal: 'ev_connected',       deviceId: 'dev-3', capability: 'connected' },
    ],
    control: { house_meter_present: false },
  };
  const snap1 = {
    'dev-1': { measure_power: 1250 },
    'dev-2': { measure_battery: 72 },
    'dev-3': { connected: true },
  };
  const r1 = resolveSignals(map1, snap1);
  chk(r1.signals.consumptionW === 1250, `consumptionW should be 1250, got ${r1.signals.consumptionW}`);
  chk(r1.signals.socPct === 72, `socPct should be 72, got ${r1.signals.socPct}`);
  chk(r1.signals.ev != null && r1.signals.ev.connected === true,
    `ev.connected should be true, got ${JSON.stringify(r1.signals.ev)}`);
  chk(r1.warnings.length === 0, `unexpected warnings: ${r1.warnings.join(', ')}`);

  // --- 2. Missing device omits signal (not zero) ---
  const snap2 = {
    // dev-1 present, dev-2 absent
    'dev-1': { measure_power: 800 },
  };
  const r2 = resolveSignals(map1, snap2);
  chk(r2.signals.consumptionW === 800, `consumptionW should be 800, got ${r2.signals.consumptionW}`);
  chk(!('socPct' in r2.signals), `socPct must be absent when device missing, got ${r2.signals.socPct}`);
  chk(!('ev' in r2.signals), `ev must be absent when device missing, got ${JSON.stringify(r2.signals.ev)}`);

  // --- 3. Missing capability omits signal (not zero) ---
  const snap3 = {
    'dev-1': { measure_power: 500 },
    'dev-2': {}, // no measure_battery key
    'dev-3': { connected: false },
  };
  const r3 = resolveSignals(map1, snap3);
  chk(!('socPct' in r3.signals), `socPct must be absent when capability missing`);
  chk(r3.signals.ev != null && r3.signals.ev.connected === false,
    `ev.connected should be false, got ${JSON.stringify(r3.signals.ev)}`);

  // --- 4. null capability value omits signal ---
  const snap4 = {
    'dev-1': { measure_power: null },
  };
  const r4 = resolveSignals(map1, snap4);
  chk(!('consumptionW' in r4.signals), `null capability value must omit signal`);

  // --- 5. activeAbove threshold (numeric → boolean) ---
  const mapAA = {
    inputs: [
      { signal: 'ev_connected', deviceId: 'd1', capability: 'measure_power', activeAbove: 15 },
    ],
    control: { house_meter_present: false },
  };
  const snapAbove = { 'd1': { measure_power: 100 } };
  const snapBelow = { 'd1': { measure_power: 10 } };
  const rAbove = resolveSignals(mapAA, snapAbove);
  const rBelow = resolveSignals(mapAA, snapBelow);
  chk(rAbove.signals.ev != null && rAbove.signals.ev.connected === true,
    `activeAbove 15: 100>15 should be true, got ${JSON.stringify(rAbove.signals.ev)}`);
  chk(rBelow.signals.ev != null && rBelow.signals.ev.connected === false,
    `activeAbove 15: 10>15 should be false, got ${JSON.stringify(rBelow.signals.ev)}`);

  // --- 6. Unknown signal key → warning, not error ---
  const mapUnk = {
    inputs: [
      { signal: 'unknown_signal_xyz', deviceId: 'd1', capability: 'measure_power' },
    ],
    control: { house_meter_present: false },
  };
  const rUnk = resolveSignals(mapUnk, { 'd1': { measure_power: 50 } });
  chk(Object.keys(rUnk.signals).length === 0, 'Unknown signal must produce empty signals');
  chk(rUnk.warnings.length === 1 && rUnk.warnings[0].includes('unknown_signal_xyz'),
    `Expected warning about unknown_signal_xyz, got: ${rUnk.warnings.join(', ')}`);

  // --- 7. Invalid JSON string → ok:false, safe empty map ---
  const v1 = validateMap('{ bad json }}}');
  chk(v1.ok === false, 'invalid JSON must return ok:false');
  chk(Array.isArray(v1.map.inputs) && v1.map.inputs.length === 0,
    `safe empty map after invalid JSON, got ${JSON.stringify(v1.map)}`);
  chk(v1.map.control.house_meter_present === false,
    'safe map control.house_meter_present must default false');
  chk(v1.errors.length > 0, 'invalid JSON must return at least one error');

  // --- 8. Valid JSON string round-trips correctly ---
  const jsonStr = JSON.stringify({
    inputs: [
      { signal: 'home_consumption_w', deviceId: 'abc', capability: 'measure_power' },
    ],
    control: { house_meter_present: true },
  });
  const v2 = validateMap(jsonStr);
  chk(v2.ok === true, `valid JSON string should be ok:true, errors: ${v2.errors.join(', ')}`);
  chk(v2.map.inputs.length === 1, `should have 1 input, got ${v2.map.inputs.length}`);
  chk(v2.map.control.house_meter_present === true, 'house_meter_present should be true');

  // --- 9. Empty string → ok:true, empty map ---
  const v3 = validateMap('');
  chk(v3.ok === true, 'empty string should be ok:true');
  chk(v3.map.inputs.length === 0, 'empty string → empty inputs');

  // --- 10. Missing "inputs" key → ok:false ---
  const v4 = validateMap({ control: { house_meter_present: false } });
  chk(v4.ok === false, 'missing inputs array → ok:false');

  // --- 11. Empty map → empty signals ---
  const rEmpty = resolveSignals(EMPTY_MAP, {});
  chk(Object.keys(rEmpty.signals).length === 0, 'empty map must produce empty signals');
  chk(rEmpty.warnings.length === 0, 'empty map must produce no warnings');

  // --- 12. Entry with missing required fields is rejected ---
  const v5 = validateMap({
    inputs: [
      { signal: 'home_consumption_w', deviceId: '', capability: 'measure_power' },
    ],
    control: { house_meter_present: false },
  });
  chk(v5.ok === false, 'entry with empty deviceId must be rejected');

  // --- 13. dishwasher_power_w resolves numeric watts (per-appliance high-power) ---
  const mapAppl = {
    inputs: [
      { signal: 'dishwasher_power_w', deviceId: 'd1', capability: 'measure_power' },
    ],
    control: { house_meter_present: false },
  };
  const rApplHigh = resolveSignals(mapAppl, { 'd1': { measure_power: 2000 } });
  chk(rApplHigh.signals.dishwasherPowerW === 2000,
    `dishwasherPowerW should be 2000, got ${rApplHigh.signals.dishwasherPowerW}`);

  // =========================================================================
  // PLAN 7 Part B: validateMap payload hardening
  // =========================================================================

  // --- B1. Oversized string → ok:false, safe empty map ---
  const bigStr = 'x'.repeat(MAX_MAP_BYTES + 1);
  const vB1 = validateMap(bigStr);
  chk(vB1.ok === false, 'oversized device_map string → ok:false');
  chk(Array.isArray(vB1.map.inputs) && vB1.map.inputs.length === 0,
    'oversized device_map → safe empty map inputs');
  chk(vB1.map.control.house_meter_present === false,
    'oversized device_map → safe map control defaults false');
  chk(vB1.errors.some((e) => e.includes('too large')),
    `oversized device_map → "too large" error, got: ${vB1.errors.join(', ')}`);

  // --- B2. >50 inputs → ok:false, safe empty map ---
  const manyInputs = [];
  for (let n = 0; n < MAX_MAP_INPUTS + 1; n++) {
    manyInputs.push({ signal: 'home_consumption_w', deviceId: `dev-${n}`, capability: 'measure_power' });
  }
  const vB2 = validateMap({ inputs: manyInputs, control: { house_meter_present: false } });
  chk(vB2.ok === false, `${MAX_MAP_INPUTS + 1} inputs → ok:false`);
  chk(vB2.map.inputs.length === 0, `${MAX_MAP_INPUTS + 1} inputs → safe empty map`);
  chk(vB2.errors.some((e) => e.includes('max allowed')),
    `${MAX_MAP_INPUTS + 1} inputs → error mentions max, got: ${vB2.errors.join(', ')}`);

  // --- B3. Exactly MAX_MAP_INPUTS inputs → ok:true ---
  const exactInputs = [];
  for (let n = 0; n < MAX_MAP_INPUTS; n++) {
    exactInputs.push({ signal: 'home_consumption_w', deviceId: `dev-${n}`, capability: 'measure_power' });
  }
  const vB3 = validateMap({ inputs: exactInputs, control: { house_meter_present: false } });
  chk(vB3.ok === true,
    `exactly ${MAX_MAP_INPUTS} inputs → ok:true, errors: ${vB3.errors.join(', ')}`);
  chk(vB3.map.inputs.length === MAX_MAP_INPUTS,
    `exactly ${MAX_MAP_INPUTS} inputs → all accepted, got ${vB3.map.inputs.length}`);

  // --- B4. Normal small map → unchanged, ok:true ---
  const vB4 = validateMap({
    inputs: [
      { signal: 'home_consumption_w', deviceId: 'dev-a', capability: 'measure_power' },
    ],
    control: { house_meter_present: true },
  });
  chk(vB4.ok === true, 'small normal map → ok:true');
  chk(vB4.map.inputs.length === 1, 'small normal map → 1 input');
  chk(vB4.map.control.house_meter_present === true,
    'small normal map → house_meter_present preserved');

  // --- 15. grid_power_w (signed) resolves to gridPowerW, sign preserved ---
  const mapGrid = {
    inputs: [
      { signal: 'grid_power_w', deviceId: 'g1', capability: 'measure_power' },
    ],
    control: { house_meter_present: false },
  };
  const rImport = resolveSignals(mapGrid, { g1: { measure_power: 1800 } });
  const rExport = resolveSignals(mapGrid, { g1: { measure_power: -2200 } });
  chk(rImport.signals.gridPowerW === 1800,
    `gridPowerW import should be 1800, got ${rImport.signals.gridPowerW}`);
  chk(rExport.signals.gridPowerW === -2200,
    `gridPowerW export (negative) should be -2200, got ${rExport.signals.gridPowerW}`);

  // --- 16. SIGNAL_MAP ↔ signals.CATALOGUE parity (no drift) ---
  const mapKeys = Object.keys(SIGNAL_MAP).sort();
  const catKeys = signals.keys().slice().sort();
  chk(mapKeys.length === catKeys.length && mapKeys.every((k, i) => k === catKeys[i]),
    `SIGNAL_MAP keys must equal catalogue keys.\n  map: ${mapKeys.join(',')}\n  cat: ${catKeys.join(',')}`);

  // --- 17. controls block validation (settings v2) ---
  const vCtrl = validateMap({
    inputs: [],
    control: { house_meter_present: false },
    controls: {
      ev: { presence: 'installed', deviceId: 'dev-ev', bigLoad: true, functions: { charge_rate_a: { deviceId: 'dev-ev', capability: 'measure_current' } } },
      spa: { presence: 'simulate' },
      nibe: { presence: 'bogus' }, // invalid presence → defaults to 'absent'
    },
  });
  chk(vCtrl.ok === true, `controls map should be ok, errors: ${vCtrl.errors.join(', ')}`);
  chk(vCtrl.map.controls.ev.presence === 'installed' && vCtrl.map.controls.ev.deviceId === 'dev-ev',
    `controls.ev should round-trip, got ${JSON.stringify(vCtrl.map.controls.ev)}`);
  chk(vCtrl.map.controls.ev.functions.charge_rate_a.capability === 'measure_current',
    'controls.ev function should round-trip');
  chk(vCtrl.map.controls.ev.bigLoad === true, 'controls.ev bigLoad flag should round-trip');
  chk(vCtrl.map.controls.spa.bigLoad === undefined, 'controls.spa without bigLoad stays unset');
  chk(vCtrl.map.controls.spa.presence === 'simulate', 'controls.spa simulate preserved');
  chk(vCtrl.map.controls.nibe.presence === 'absent', 'invalid presence defaults to absent');

  // --- 18. custom consumers validation ---
  const vCustom = validateMap({
    inputs: [],
    control: { house_meter_present: false },
    custom: [
      { name: 'Sauna', deviceId: 'dev-sauna', capability: 'onoff', mode: 'pausable', pauseAtOrBelow: 3 },
      { name: 'Server', deviceId: 'dev-srv', capability: 'measure_power', mode: 'monitor' },
      { name: 'Bad', capability: 'onoff' }, // missing deviceId → rejected
    ],
  });
  chk(vCustom.ok === false, 'custom with a bad entry → ok:false (missing deviceId)');
  chk(vCustom.map.custom.length === 2, `2 valid custom kept, got ${vCustom.map.custom.length}`);
  chk(vCustom.map.custom[0].mode === 'pausable' && vCustom.map.custom[0].pauseAtOrBelow === 3,
    `custom pausable round-trip, got ${JSON.stringify(vCustom.map.custom[0])}`);

  // Backward-compat: a v1 map (no controls/custom) still validates and gains empty blocks.
  const vOld = validateMap({ inputs: [{ signal: 'grid_power_w', deviceId: 'g', capability: 'measure_power' }], control: { house_meter_present: false } });
  chk(vOld.ok === true && Array.isArray(vOld.map.custom) && vOld.map.custom.length === 0,
    'v1 map gains empty custom[]');
  chk(vOld.map.controls && typeof vOld.map.controls === 'object',
    'v1 map gains empty controls{}');

  // --- 14. isStale ---
  const WINDOW = 3600000; // 60 min in ms

  // Changed value is never stale, regardless of age.
  chk(isStale(1000, 1200, WINDOW + 1, WINDOW) === false,
    'isStale: changed value must not be stale');

  // Unchanged but within window: not stale.
  chk(isStale(1000, 1000, WINDOW - 1, WINDOW) === false,
    'isStale: unchanged within window must not be stale');

  // Unchanged at exactly the window boundary: stale.
  chk(isStale(1000, 1000, WINDOW, WINDOW) === true,
    'isStale: unchanged at window boundary must be stale');

  // Unchanged beyond window: stale.
  chk(isStale(1000, 1000, WINDOW * 2, WINDOW) === true,
    'isStale: unchanged beyond window must be stale');

  // First-seen (null prevValue): never stale.
  chk(isStale(null, 1000, WINDOW * 10, WINDOW) === false,
    'isStale: null prevValue (first-seen) must not be stale');

  // First-seen (undefined prevValue): never stale.
  chk(isStale(undefined, 1000, WINDOW * 10, WINDOW) === false,
    'isStale: undefined prevValue must not be stale');

  // Boolean signal: unchanged true is stale beyond window.
  chk(isStale(true, true, WINDOW + 1, WINDOW) === true,
    'isStale: unchanged boolean beyond window must be stale');

  // Boolean signal: changed false→true is not stale.
  chk(isStale(false, true, WINDOW + 1, WINDOW) === false,
    'isStale: changed boolean must not be stale');

  return { pass: fails.length === 0, fails };
}

/**
 * Detect a stale signal: returns true when the current value is byte-identical
 * to the previous value AND the signal has not changed for at least `windowMs`.
 *
 * Design rules:
 *  - Pure: takes ageMs as a parameter; the caller provides the clock delta.
 *  - A null/undefined prevValue means "first seen" — never stale.
 *  - Values are compared with strict equality (===) — this is the right
 *    test for numbers and booleans from capability reads.
 *
 * @param {*}      prevValue   the previous known value (null/undefined = first-seen)
 * @param {*}      currValue   the current value
 * @param {number} ageMs       milliseconds since the signal last changed
 * @param {number} windowMs    staleness window in milliseconds
 * @returns {boolean}
 */
function isStale(prevValue, currValue, ageMs, windowMs) {
  // First-seen: no previous value to compare against.
  if (prevValue === null || prevValue === undefined) return false;
  // Value changed: not stale.
  if (currValue !== prevValue) return false;
  // Unchanged AND beyond window: stale.
  return ageMs >= windowMs;
}

module.exports = { SIGNAL_MAP, EMPTY_MAP, MAX_MAP_BYTES, MAX_MAP_INPUTS, resolveSignals, validateMap, isStale, selfTest };
