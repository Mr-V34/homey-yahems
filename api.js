'use strict';

/**
 * YAHEMS app Web API — backs the App Settings page (settings/index.html).
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * Each handler is declared in the manifest `api` section (.homeycompose/app.json)
 * — required by the SDK runtime — and routed by method + path. The settings page
 * calls them via `Homey.api('GET', '/devices')` and `Homey.api('GET', '/signals')`.
 * These endpoints are READ-ONLY: they enumerate devices and serve the signal
 * catalogue. The map itself is written by the page directly via
 * `Homey.set('device_map', ...)` into app ManagerSettings — no write endpoint
 * exists here, keeping the API surface read-only.
 */

module.exports = {

  /** GET /devices → [{ id, name, zone, capabilities:[{id,title,type}] }] */
  async getDevices({ homey }) {
    return homey.app.apiGetDevices();
  },

  /** GET /signals → the canonical signal catalogue (lib/signals.js). */
  async getSignals({ homey }) {
    return homey.app.apiGetSignals();
  },

  /** GET /levels → per-device, per-DEFCON behaviour summary (effective matrix). */
  async getLevels({ homey }) {
    return homey.app.apiGetLevels();
  },

  /** GET /catalog → device taxonomy (groups → subgroups → functions). */
  async getCatalog({ homey }) {
    return homey.app.apiGetCatalog();
  },

  /** GET /status → live overview: per-consumer allowed/paused + mode/defcon. */
  async getStatus({ homey }) {
    return homey.app.apiGetStatus();
  },

};
