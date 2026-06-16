'use strict';

/**
 * YAHEMS app Web API — backs the App Settings page (settings/index.html).
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * SDK3 routes each named handler to `Homey.api('<METHOD>', '/<name>')` from the
 * settings frontend. These endpoints are READ-ONLY: they enumerate devices and
 * serve the signal catalogue. The map itself is written by the page directly via
 * `Homey.set('device_map', ...)` into app ManagerSettings — no write endpoint
 * exists here, keeping the API surface read-only.
 */

module.exports = {

  /** GET /getDevices → [{ id, name, zone, capabilities:[{id,title,type}] }] */
  async getDevices({ homey }) {
    return homey.app.apiGetDevices();
  },

  /** GET /getSignals → the canonical signal catalogue (lib/signals.js). */
  async getSignals({ homey }) {
    return homey.app.apiGetSignals();
  },

};
