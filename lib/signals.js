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
 *   suggestCaps Homey capability ids commonly carrying this signal (UI hints only)
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
    note: 'Total house draw, e.g. a P1/HAN reader or Power by the Hour.',
  },
  {
    key: 'battery_soc_pct',
    labelEn: 'House battery SOC (%)',
    labelSv: 'Husbatteri SOC (%)',
    kind: 'number',
    group: 'battery',
    signed: false,
    suggestCaps: ['measure_battery'],
  },
  {
    key: 'price_level',
    labelEn: 'Spot price level (1 expensive … 5 cheap)',
    labelSv: 'Spotprisnivå (1 dyr … 5 billig)',
    kind: 'number',
    group: 'price',
    signed: false,
    suggestCaps: [],
  },
  {
    key: 'price_ore',
    labelEn: 'Spot price (öre/kWh)',
    labelSv: 'Spotpris (öre/kWh)',
    kind: 'number',
    group: 'price',
    signed: false,
    suggestCaps: ['measure_price', 'price_total'],
  },
  {
    key: 'ev_connected',
    labelEn: 'EV charger connected',
    labelSv: 'Elbilsladdare ansluten',
    kind: 'boolean',
    group: 'ev',
    suggestCaps: ['onoff', 'alarm_generic'],
  },
  {
    key: 'ev_battery_soc_pct',
    labelEn: 'EV battery SOC (%)',
    labelSv: 'Elbilsbatteri SOC (%)',
    kind: 'number',
    group: 'ev',
    signed: false,
    suggestCaps: ['measure_battery'],
  },
  {
    key: 'appliance_power_w',
    labelEn: 'High-power appliance draw (W)',
    labelSv: 'Effektkrävande vitvara (W)',
    kind: 'number',
    group: 'appliance',
    signed: false,
    suggestCaps: ['measure_power'],
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
  }

  chk(get('grid_power_w') != null, 'grid_power_w must be in the catalogue');
  chk(get('grid_power_w').signed === true, 'grid_power_w must be signed');
  chk(get('nope_xyz') === undefined, 'unknown key must return undefined');

  return { pass: fails.length === 0, fails };
}

module.exports = { CATALOGUE, keys, get, selfTest };
