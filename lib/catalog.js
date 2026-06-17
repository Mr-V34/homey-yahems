'use strict';

/**
 * YAHEMS device taxonomy — Main group → Subgroup → functions.
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * PURE module (no `homey` import). Single source of truth for how the settings
 * page groups devices and which Homey devices/capabilities qualify for each slot.
 *
 * Each subgroup has a ROLE:
 *   - 'control' : YAHEMS drives it; has a row in the editable DEFCON level table.
 *                 `matrixKey` links it to the lib/matrix.js device of the same role.
 *   - 'input'   : only feeds a signal (e.g. solar production); not controlled.
 *   - 'comfort' : always allowed, monitored, never paused (cooking).
 *
 * Each function maps a real-world quantity to (optionally) a canonical signal key
 * from lib/signals.js (`signalKey`) and to suggested Homey capabilities. A parity
 * self-test asserts every referenced signalKey exists in the signal catalogue.
 */

const signals = require('./signals');

const CATALOG = [
  {
    key: 'climate', labelEn: 'Climate', labelSv: 'Klimat & Värme',
    subgroups: [
      {
        key: 'heatpump', labelEn: 'Heat pump', labelSv: 'Luftvärmepump',
        role: 'control', matrixKey: 'nibe',
        filterCaps: ['target_temperature', 'measure_power'],
        filterClasses: ['heatpump', 'thermostat'],
        functions: [
          { key: 'target_temperature', labelEn: 'Target temperature', labelSv: 'Måltemperatur', direction: 'control', suggestCaps: ['target_temperature'] },
          { key: 'current_power_w', labelEn: 'Current power', labelSv: 'Aktuell effekt', direction: 'read', suggestCaps: ['measure_power'] },
          { key: 'mode', labelEn: 'Mode', labelSv: 'Läge', direction: 'control', suggestCaps: ['thermostat_mode'] },
        ],
      },
      {
        key: 'hottub', labelEn: 'Hot tub', labelSv: 'Spabad',
        role: 'control', matrixKey: 'spa',
        filterCaps: ['target_temperature'],
        filterClasses: ['thermostat'],
        functions: [
          { key: 'target_water_temp', labelEn: 'Target water temp', labelSv: 'Måltemp vatten', direction: 'control', suggestCaps: ['target_temperature'] },
          { key: 'heating_status', labelEn: 'Heating status', labelSv: 'Värmestatus', direction: 'read', suggestCaps: ['onoff'] },
        ],
      },
    ],
  },
  {
    key: 'energy', labelEn: 'Energy', labelSv: 'Energi & Produktion',
    subgroups: [
      {
        key: 'solar', labelEn: 'Solar panels', labelSv: 'Solceller',
        role: 'input',
        filterCaps: ['measure_power'],
        functions: [
          { key: 'production_w', labelEn: 'Production', labelSv: 'Produktion', direction: 'read', signalKey: 'solar_production_w', suggestCaps: ['measure_power'] },
          { key: 'daily_yield_kwh', labelEn: 'Daily yield', labelSv: 'Dagsproduktion', direction: 'read', suggestCaps: ['meter_power'] },
        ],
      },
      {
        key: 'battery', labelEn: 'Home battery', labelSv: 'Husbatteri',
        role: 'control', matrixKey: 'battery',
        filterCaps: ['measure_battery'],
        filterClasses: ['battery'],
        functions: [
          { key: 'soc_percent', labelEn: 'Charge level', labelSv: 'Laddningsnivå', direction: 'read', signalKey: 'battery_soc_pct', suggestCaps: ['measure_battery'] },
          { key: 'charge_power_w', labelEn: 'Charge power', labelSv: 'Laddeffekt', direction: 'control', suggestCaps: ['measure_power'] },
          { key: 'discharge_power_w', labelEn: 'Discharge power', labelSv: 'Urladdningseffekt', direction: 'control', suggestCaps: ['measure_power'] },
        ],
      },
    ],
  },
  {
    key: 'ev', labelEn: 'EV', labelSv: 'Fordon',
    subgroups: [
      {
        key: 'evcharger', labelEn: 'EV charger', labelSv: 'Elbilsladdare',
        role: 'control', matrixKey: 'ev',
        filterCaps: ['evcharger_charging', 'evcharger_charging_state'],
        filterClasses: ['evcharger'],
        functions: [
          { key: 'status', labelEn: 'Connected', labelSv: 'Ansluten', direction: 'read', signalKey: 'ev_connected', suggestCaps: ['evcharger_charging_state', 'onoff'] },
          { key: 'charge_rate_a', labelEn: 'Charge current (A)', labelSv: 'Laddström (A)', direction: 'control', suggestCaps: ['measure_current'] },
          { key: 'car_target_pct', labelEn: 'Car charge level', labelSv: 'Bilens laddningsnivå', direction: 'read', signalKey: 'ev_battery_soc_pct', suggestCaps: ['measure_battery'] },
        ],
      },
    ],
  },
  {
    key: 'appliances', labelEn: 'Appliances', labelSv: 'Vitvaror',
    subgroups: [
      {
        key: 'dishwasher', labelEn: 'Dishwasher', labelSv: 'Diskmaskin',
        role: 'control', matrixKey: 'dishwasher',
        filterCaps: ['measure_power', 'onoff'], filterClasses: ['socket'],
        functions: [
          { key: 'power', labelEn: 'Power', labelSv: 'Effekt', direction: 'read', signalKey: 'dishwasher_power_w', suggestCaps: ['measure_power'] },
          { key: 'state', labelEn: 'State', labelSv: 'Status', direction: 'read', suggestCaps: ['onoff'] },
        ],
      },
      {
        key: 'washer', labelEn: 'Washing machine', labelSv: 'Tvättmaskin',
        role: 'control', matrixKey: 'washer',
        filterCaps: ['measure_power', 'onoff'], filterClasses: ['socket'],
        functions: [
          { key: 'power', labelEn: 'Power', labelSv: 'Effekt', direction: 'read', signalKey: 'washer_power_w', suggestCaps: ['measure_power'] },
          { key: 'state', labelEn: 'State', labelSv: 'Status', direction: 'read', suggestCaps: ['onoff'] },
        ],
      },
      {
        key: 'dryer', labelEn: 'Tumble dryer', labelSv: 'Torktumlare',
        role: 'control', matrixKey: 'dryer',
        filterCaps: ['measure_power', 'onoff'], filterClasses: ['socket'],
        functions: [
          { key: 'power', labelEn: 'Power', labelSv: 'Effekt', direction: 'read', signalKey: 'dryer_power_w', suggestCaps: ['measure_power'] },
          { key: 'state', labelEn: 'State', labelSv: 'Status', direction: 'read', suggestCaps: ['onoff'] },
        ],
      },
    ],
  },
  {
    key: 'cooking', labelEn: 'Cooking', labelSv: 'Matlagning',
    subgroups: [
      {
        key: 'oven', labelEn: 'Oven', labelSv: 'Ugn',
        role: 'comfort',
        filterCaps: ['onoff', 'measure_power'], filterClasses: ['socket'],
        functions: [{ key: 'is_active', labelEn: 'Active', labelSv: 'Aktiv', direction: 'read', suggestCaps: ['onoff'] }],
      },
      {
        key: 'microwave', labelEn: 'Microwave', labelSv: 'Mikrovågsugn',
        role: 'comfort',
        filterCaps: ['onoff', 'measure_power'], filterClasses: ['socket'],
        functions: [{ key: 'is_active', labelEn: 'Active', labelSv: 'Aktiv', direction: 'read', suggestCaps: ['onoff'] }],
      },
      {
        key: 'coffee', labelEn: 'Coffee maker', labelSv: 'Kaffemaskin',
        role: 'comfort',
        filterCaps: ['onoff', 'measure_power'], filterClasses: ['socket'],
        functions: [{ key: 'status', labelEn: 'Status', labelSv: 'Status', direction: 'read', suggestCaps: ['onoff'] }],
      },
    ],
  },
];

// Matrix device keys that the editable level table renders, in display order.
// Mirrors the lib/matrix.js control devices reachable via subgroup.matrixKey.
const CONTROL_MATRIX_KEYS = ['nibe', 'spa', 'ev', 'battery', 'dishwasher', 'washer', 'dryer'];

/** Flatten to subgroups (with their group labels attached) for convenience. */
function subgroups() {
  const out = [];
  for (const g of CATALOG) {
    for (const sg of g.subgroups) {
      out.push({ ...sg, groupKey: g.key, groupLabelEn: g.labelEn, groupLabelSv: g.labelSv });
    }
  }
  return out;
}

/** Self-test: structure + signalKey parity with lib/signals.js. */
function selfTest() {
  const fails = [];
  const chk = (cond, msg) => { if (!cond) fails.push(msg); };
  const ROLES = new Set(['control', 'input', 'comfort']);
  const signalKeys = new Set(signals.keys());
  const matrixKeysSeen = new Set();
  const sgKeys = new Set();

  for (const g of CATALOG) {
    chk(g.key && g.labelEn && g.labelSv, `group needs key+labels: ${JSON.stringify(g)}`);
    chk(Array.isArray(g.subgroups) && g.subgroups.length > 0, `${g.key}: needs subgroups`);
    for (const sg of g.subgroups) {
      chk(!sgKeys.has(sg.key), `duplicate subgroup key: ${sg.key}`);
      sgKeys.add(sg.key);
      chk(ROLES.has(sg.role), `${sg.key}: invalid role ${sg.role}`);
      chk(Array.isArray(sg.filterCaps), `${sg.key}: filterCaps must be an array`);
      if (sg.role === 'control') {
        chk(typeof sg.matrixKey === 'string' && sg.matrixKey,
          `${sg.key}: control subgroup needs matrixKey`);
        chk(CONTROL_MATRIX_KEYS.includes(sg.matrixKey),
          `${sg.key}: matrixKey ${sg.matrixKey} not in CONTROL_MATRIX_KEYS`);
        matrixKeysSeen.add(sg.matrixKey);
      }
      for (const fn of (sg.functions || [])) {
        chk(fn.key && fn.labelEn && fn.labelSv, `${sg.key}.${fn.key}: needs key+labels`);
        chk(fn.direction === 'read' || fn.direction === 'control',
          `${sg.key}.${fn.key}: direction must be read|control`);
        if (fn.signalKey) {
          chk(signalKeys.has(fn.signalKey),
            `${sg.key}.${fn.key}: signalKey '${fn.signalKey}' not in signals catalogue`);
        }
      }
    }
  }

  // Every control matrix key must be represented by exactly one subgroup.
  for (const k of CONTROL_MATRIX_KEYS) {
    chk(matrixKeysSeen.has(k), `no control subgroup maps to matrix key '${k}'`);
  }

  return { pass: fails.length === 0, fails };
}

module.exports = { CATALOG, CONTROL_MATRIX_KEYS, subgroups, selfTest };
