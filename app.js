'use strict';

const Homey = require('homey');
const engine = require('./lib/engine');
const signals = require('./lib/signals');

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
        zone: (zonesObj && dev.zone && zonesObj[dev.zone]) ? zonesObj[dev.zone].name : '',
        capabilities: caps,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Settings-page data: the canonical signal catalogue (labels, kinds, hints). */
  apiGetSignals() {
    return signals.CATALOGUE;
  }

};
