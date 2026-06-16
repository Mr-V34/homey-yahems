'use strict';

/**
 * YAHEMS canonical signal catalogue — SINGLE SOURCE OF TRUTH.
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * This module is PURE (imports nothing from `homey`) so it can be required by
 * both `lib/hal.js` (validation / resolution) and the App Settings page
 * (via api.js `GET /signals`). Keeping the catalogue here means the friendly
 * labels and the HAL field-mapping can never drift apart — hal.js derives its
 * SIGNAL_MAP keys from CATALOGUE and a parity self-test asserts they match.
 *
 * Each entry:
 *   key         canonical signal key (matches hal.SIGNAL_MAP)
 *   labelEn     human label, English
 *   labelSv     human label, Swedish
 *   kind        'number' | 'boolean' — drives the UI input + capability filtering
 *   group       UI grouping: 'power' | 'battery' | 'price' | 'ev' | 'appliance'
 *   suggestCaps Homey capability ids commonly carrying this signal (auto-select hint)
 *   filterCaps  Homey capability ids that QUALIFY a device for this slot. The
 *               settings page shows ONLY devices that expose one of these (so a
 *               grid slot lists power meters, not motion sensors). Empty = no
 *               capability filter.
 *   filterClasses  Homey device classes that also qualify (e.g. 'evcharger').
 *   signed      (number signals) true when negative values are meaningful
 *   note        short UI helper text (optional)
 *
 * The catalogue order is the order the settings page renders rows in.
 */

const CATALOGUE = [
  {
    key: 'grid_power_w',
    labelEn: 'Net grid power (signed: + import / − export)',
    labelSv: 'Näteffekt (tecken: + köp / − sälj)',
    kind: 'number',
    group: 'power',
    signed: true,
    suggestCaps: ['measure_power'],
    filterCaps: ['measure_power'],
    note: 'A hybrid-inverter grid CT or a Shelly EM. Preferred grid source.',
  },
  {
    key: 'home_consumption_w',
    labelEn: 'House consumption (W)',
    labelSv: 'Husförbrukning (W)',
    kind: 'number',
    group: 'power',
    signed: false,
    suggestCaps: ['measure_power'],
    filterCaps: ['measure_power'],
    note: 'Total house draw, e.g. a P1/HAN reader or Power by the Hour.',
  },
  {
    key: 'battery_soc_pct',
    labelEn: 'Home battery charge level (%)',
    labelSv: 'Husbatteriets laddningsnivå (%)',
    kind: 'number',
    group: 'battery',
    signed: false,
    suggestCaps: ['measure_battery'],
    filterCaps: ['measure_battery'],
  },
  {
    key: 'price_level',
    labelEn: 'Electricity price level (1 = expensive … 5 = cheap)',
    labelSv: 'Elprisnivå (1 = dyrt … 5 = billigt)',
    kind: 'number',
    group: 'price',
    signed: false,
    suggestCaps: ['price_level'],
    filterCaps: ['price_level', 'measure_price', 'meter_price', 'meter_tariff'],
  },
  {
    key: 'price_ore',
    labelEn: 'Electricity price (öre/kWh)',
    labelSv: 'Elpris (öre/kWh)',
    kind: 'number',
    group: 'price',
    signed: false,
    suggestCaps: ['measure_price', 'price_total'],
    filterCaps: ['measure_price', 'price_total', 'meter_price', 'meter_tariff'],
  },
  {
    key: 'ev_connected',
    labelEn: 'EV charger connected',
    labelSv: 'Elbilsladdare ansluten',
    kind: 'boolean',
    group: 'ev',
    suggestCaps: ['evcharger_charging_state', 'onoff'],
    filterCaps: ['evcharger_charging', 'evcharger_charging_state'],
    filterClasses: ['evcharger'],
  },
  {
    key: 'ev_battery_soc_pct',
    labelEn: 'EV charge level (%)',
    labelSv: 'Elbilens laddningsnivå (%)',
    kind: 'number',
    group: 'ev',
    signed: false,
    suggestCaps: ['measure_battery'],
    filterCaps: ['measure_battery'],
  },
  {
    key: 'solar_production_w',
    labelEn: 'Solar production (W)',
    labelSv: 'Solproduktion (W)',
    kind: 'number',
    group: 'power',
    signed: false,
    suggestCaps: ['measure_power'],
    filterCaps: ['measure_power'],
  },
  {
    key: 'dishwasher_power_w',
    labelEn: 'Dishwasher power (W)',
    labelSv: 'Diskmaskin effekt (W)',
    kind: 'number',
    group: 'appliance',
    signed: false,
    suggestCaps: ['measure_power'],
    filterCaps: ['measure_power'],
  },
  {
    key: 'washer_power_w',
    labelEn: 'Washing machine power (W)',
    labelSv: 'Tvättmaskin effekt (W)',
    kind: 'number',
    group: 'appliance',
    signed: false,
    suggestCaps: ['measure_power'],
    filterCaps: ['measure_power'],
  },
  {
    key: 'dryer_power_w',
    labelEn: 'Tumble dryer power (W)',
    labelSv: 'Torktumlare effekt (W)',
    kind: 'number',
    group: 'appliance',
    signed: false,
    suggestCaps: ['measure_power'],
    filterCaps: ['measure_power'],
  },
];

// Fast key → entry lookup.
const BY_KEY = Object.freeze(
  CATALOGUE.reduce((acc, e) => { acc[e.key] = Object.freeze(e); return acc; }, {}),
);

/** All catalogue keys, in render order. */
function keys() {
  return CATALOGUE.map((e) => e.key);
}

/** Look up a single catalogue entry by key (or undefined). */
function get(key) {
  return BY_KEY[key];
}

/** Self-test: catalogue internal consistency. */
function selfTest() {
  const fails = [];
  const chk = (cond, msg) => { if (!cond) fails.push(msg); };

  const seen = new Set();
  for (const e of CATALOGUE) {
    chk(typeof e.key === 'string' && e.key, `entry missing key: ${JSON.stringify(e)}`);
    chk(!seen.has(e.key), `duplicate catalogue key: ${e.key}`);
    seen.add(e.key);
    chk(typeof e.labelEn === 'string' && e.labelEn, `${e.key}: labelEn required`);
    chk(typeof e.labelSv === 'string' && e.labelSv, `${e.key}: labelSv required`);
    chk(e.kind === 'number' || e.kind === 'boolean', `${e.key}: kind must be number|boolean`);
    chk(Array.isArray(e.suggestCaps), `${e.key}: suggestCaps must be an array`);
    chk(Array.isArray(e.filterCaps), `${e.key}: filterCaps must be an array`);
    chk(e.filterClasses === undefined || Array.isArray(e.filterClasses),
      `${e.key}: filterClasses must be an array when present`);
  }

  chk(get('grid_power_w') != null, 'grid_power_w must be in the catalogue');
  chk(get('grid_power_w').signed === true, 'grid_power_w must be signed');
  chk(get('nope_xyz') === undefined, 'unknown key must return undefined');

  return { pass: fails.length === 0, fails };
}

module.exports = { CATALOGUE, keys, get, selfTest };
