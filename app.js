'use strict';

const Homey = require('homey');
const engine = require('./lib/engine');
const signals = require('./lib/signals');
const matrix = require('./lib/matrix');
const catalog = require('./lib/catalog');

module.exports = class YahemsApp extends Homey.App {

  async onInit() {
    const st = engine.selfTest();
    this.log(`YAHEMS initialized. DEFCON engine self-test: ${st.pass ? 'PASS' : `FAIL ${st.fails.join('; ')}`}`);
    this._api = null; // lazy HomeyAPI for the settings page device picker
  }

  /** Lazily create (and cache) an app-scoped HomeyAPI instance. */
  async _getApi() {
    if (this._api) return this._api;
    const { HomeyAPI } = require('homey-api');
    this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
    return this._api;
  }

  /**
   * Settings-page data: every device with its capabilities, for the map builder.
   * Returns: [{ id, name, zone, capabilities: [{ id, title, type }] }] sorted by name.
   * Used by api.js `getDevices`.
   */
  async apiGetDevices() {
    const api = await this._getApi();
    const [devicesObj, zonesObj] = await Promise.all([
      api.devices.getDevices(),
      api.zones.getZones().catch(() => ({})),
    ]);

    const out = [];
    for (const dev of Object.values(devicesObj || {})) {
      if (!dev || dev.id == null) continue;
      const caps = [];
      const capObj = dev.capabilitiesObj || {};
      for (const [capId, c] of Object.entries(capObj)) {
        caps.push({
          id: capId,
          title: (c && c.title) ? c.title : capId,
          type: (c && c.type) ? c.type : 'unknown',
        });
      }
      caps.sort((a, b) => a.id.localeCompare(b.id));
      out.push({
        id: dev.id,
        name: dev.name || dev.id,
        class: dev.class || 'other',
        zone: (zonesObj && dev.zone && zonesObj[dev.zone]) ? zonesObj[dev.zone].name : '',
        capabilities: caps,
        // YAHEMS's own devices (the controller) must never appear in the pickers —
        // mapping ourselves would create a reading loop.
        ours: typeof dev.driverId === 'string' && dev.driverId.indexOf('com.v34.yahems') !== -1,
        // Whole-home cumulative meter (P1/HAN, grid CT). Used to filter the grid /
        // house-consumption slots to real meters instead of every power-metered plug.
        cumulative: !!(dev.energyObj && dev.energyObj.cumulative === true),
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Settings-page data: the canonical signal catalogue (labels, kinds, hints). */
  apiGetSignals() {
    return signals.CATALOGUE;
  }

  /** Settings-page data: the device taxonomy (groups → subgroups → functions). */
  apiGetCatalog() {
    return catalog.CATALOG;
  }

  /**
   * Live overview for the settings page: the controller's current per-consumer
   * allowed/paused state plus mode/DEFCON/source. Reads the single controller
   * device's snapshot; returns { available:false } if it isn't paired yet.
   */
  apiGetStatus() {
    try {
      const driver = this.homey.drivers.getDriver('controller');
      const devices = driver ? driver.getDevices() : [];
      const dev = devices && devices[0];
      if (!dev || typeof dev.getStatusSnapshot !== 'function') return { available: false };
      return Object.assign({ available: true }, dev.getStatusSnapshot());
    } catch (err) {
      return { available: false, error: err.message };
    }
  }

  /** The effective matrix (defaults merged with the saved override, if valid). */
  _effectiveMatrix() {
    let raw;
    try { raw = this.homey.settings.get('matrix_override'); } catch (_) { raw = null; }
    if (!raw) return matrix.DEFAULT_MATRIX;
    const v = matrix.validateMatrixOverride(raw);
    if (!v.ok) return matrix.DEFAULT_MATRIX;
    const merged = matrix.mergeMatrix(matrix.DEFAULT_MATRIX, v.override);
    return matrix.validateMatrix(merged).ok ? merged : matrix.DEFAULT_MATRIX;
  }

  /**
   * Settings-page data: a compact per-device, per-DEFCON summary of what YAHEMS
   * does at each level, read from the matrix defaults. Raw values — the page
   * formats units and translates words (run/pause/charge/…).
   */
  apiGetLevels() {
    const m = this._effectiveMatrix();
    const band = (dev, lvl) => (m[dev] && m[dev].bands && m[dev].bands[lvl]) || {};
    const out = {
      levels: [5, 4, 3, 2, 1],
      ev: {}, spa: {}, nibe: {}, battery: {}, dishwasher: {}, washer: {}, dryer: {},
    };
    for (const lvl of out.levels) {
      out.ev[lvl] = band('ev', lvl).amp;
      out.spa[lvl] = { temp: band('spa', lvl).temp, heat: band('spa', lvl).heat };
      out.nibe[lvl] = band('nibe', lvl).vv;
      out.battery[lvl] = band('battery', lvl).mode;
      out.dishwasher[lvl] = band('dishwasher', lvl).action;
      out.washer[lvl] = band('washer', lvl).action;
      out.dryer[lvl] = band('dryer', lvl).action;
    }
    return out;
  }

};
