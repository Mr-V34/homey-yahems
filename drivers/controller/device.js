'use strict';

const Homey = require('homey');
const engine = require('../../lib/engine');
const matrix = require('../../lib/matrix');
const hal = require('../../lib/hal');

// =============================================================================
// ACTUATION GATE — read before changing this file
// =============================================================================
// READ PATH: live. device.js fetches mapped device capability values from
// HomeyAPI on every recompute cycle and feeds them through hal.resolveSignals()
// into decideDevices(). See lib/hal.js for the map shape and signal keys.
//
// ADVISORY / CONTROL GATE: functional. The `house_meter_present` device setting
// (checked first) or map.control.house_meter_present (fallback) determines the
// mode string written to the `yahems_mode` capability:
//   - 'advisory'  — compute and log decisions but perform no device writes.
//   - 'control'   — (future) allow _applyDecisions() to actuate devices.
//
// WRITES: UNWIRED AND COMPUTE-ONLY.
// _applyDecisions() is the SOLE place where future writes would live. It
// currently performs zero device writes. When wiring actuation:
//   1. Import simgate and wrap EVERY real capability write in
//      simgate.guardActuation(() => ...).
//   2. Only execute when mode === 'control'.
//   3. Thread sim_mode from onSettings() into simgate.setMode().
// Do NOT add a sim_mode UI setting until that step — it would introduce
// locale keys with no backing setting definition.
// =============================================================================

module.exports = class ControllerDevice extends Homey.Device {

  async onInit() {
    this.buffer   = [];
    this.gridW    = 0;        // fallback grid reading from flow action
    this._lastDefcon = null;
    this._decisions  = null;
    this._api        = null;  // HomeyAPI instance (null if unavailable)
    this._deviceMap  = hal.validateMap('').map; // safe empty default

    // Ensure required capabilities exist.
    for (const c of ['yahems_defcon', 'yahems_mode', 'measure_power']) {
      if (!this.hasCapability(c)) await this.addCapability(c).catch(this.error);
    }

    // Set up flow trigger cards.
    this._trigChanged = this.homey.flow.getDeviceTriggerCard('defcon_changed');
    this._trigRed     = this.homey.flow.getDeviceTriggerCard('red_alert');

    // Initialise HomeyAPI for cross-device reads.
    try {
      const { HomeyAPI } = require('homey-api');
      this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
      this.log('HomeyAPI initialised — device-map read path active');
    } catch (err) {
      this.log(`HomeyAPI unavailable (${err.message}) — running without mapped device reads`);
      this._api = null;
    }

    // Load the device_map setting.
    this._loadDeviceMap();

    // Periodic recompute (every 60 s) plus an immediate run.
    this._interval = this.homey.setInterval(() => this.recompute().catch(this.error), 60000);
    await this.recompute();
    this.log('YAHEMS Controller device initialized');
  }

  // ---------------------------------------------------------------------------
  // Settings helpers
  // ---------------------------------------------------------------------------

  /** (Re)load and validate the device_map setting. Logs validation errors. */
  _loadDeviceMap() {
    const raw = (this.getSettings() || {}).device_map || '';
    const { ok, map, errors } = hal.validateMap(raw);
    if (!ok) {
      this.log(`device_map validation errors — using empty map: ${errors.join('; ')}`);
    }
    this._deviceMap = map;
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('device_map')) {
      this._loadDeviceMap();
    }
    await this.recompute();
  }

  // ---------------------------------------------------------------------------
  // Flow action handlers
  // ---------------------------------------------------------------------------

  async onReportGrid(w) {
    if (Number.isFinite(w)) {
      this.gridW = w;
      await this.recompute();
    }
    return true;
  }

  async onSetAnchor(w) {
    if (Number.isFinite(w) && w > 0) await this.setSettings({ anchor: Math.round(w) });
    await this.recompute();
    return true;
  }

  async onRunNow() {
    this.log('Run all now requested');
    // Future: apply a temporary "use everything" profile in the device layer.
    return true;
  }

  // ---------------------------------------------------------------------------
  // Main compute loop
  // ---------------------------------------------------------------------------

  async recompute() {
    const s = this.getSettings();
    const anchor = Number(s.anchor) || 4500;
    const floor  = Number(s.anchor_min) || 1000;

    // The settings `house_meter_present` checkbox is authoritative.
    // map.control.house_meter_present is only used if the setting is absent.
    const settingMeter = s.house_meter_present;
    const mapMeter     = this._deviceMap.control.house_meter_present === true;
    const houseMeter   = settingMeter === true || (settingMeter === undefined && mapMeter);
    const mode         = houseMeter ? 'control' : 'advisory';

    // --- Build HAL snapshot if the API is available and map has inputs ---
    let halSignals = {};
    if (this._api != null && this._deviceMap.inputs.length > 0) {
      try {
        const devicesObj = await this._api.devices.getDevices();
        // Build snapshot: { [deviceId]: { [capabilityId]: capabilityValue } }
        const snapshot = {};
        for (const [id, dev] of Object.entries(devicesObj)) {
          if (dev && dev.capabilitiesObj) {
            snapshot[id] = {};
            for (const [capId, capObj] of Object.entries(dev.capabilitiesObj)) {
              snapshot[id][capId] = capObj != null ? capObj.value : undefined;
            }
          }
        }
        const { signals, warnings } = hal.resolveSignals(this._deviceMap, snapshot);
        halSignals = signals;
        if (warnings.length) this.log(`HAL warnings: ${warnings.join('; ')}`);
      } catch (err) {
        this.log(`HAL snapshot fetch failed (${err.message}) — falling back to flow values`);
      }
    }

    // --- Determine consumption source ---
    // Mapped home_consumption_w takes precedence over flow-action gridW.
    // If neither is mapped, use gridW (must be >= 0, export reads as 0).
    const consumptionW = Number.isFinite(halSignals.consumptionW)
      ? Math.max(0, halSignals.consumptionW)
      : Math.max(0, this.gridW);

    // Push through rolling average.
    const r = engine.rollingAverage(this.buffer, consumptionW, 3);
    this.buffer = r.buffer;

    const Teff   = engine.effectiveAnchor(anchor, floor, {});
    const defcon = engine.defconFromNet(r.average, Teff);

    // Update capabilities.
    await this.setCapabilityValue('measure_power', r.average).catch(this.error);
    await this.setCapabilityValue('yahems_mode',   mode).catch(this.error);
    await this.setCapabilityValue('yahems_defcon', defcon).catch(this.error);

    // Build the full decideDevices() input: HAL signals spread in, then
    // consumption, defcon and localHour are always set explicitly.
    const decideInput = {
      ...halSignals,
      defcon,
      consumptionW: Math.max(0, r.average),
      localHour: new Date().getHours(),
    };
    // Unwrap nested ev spread if halSignals brought ev.* fields; spread
    // already preserves the nested shape because resolveSignals uses _setPath.

    this._decisions = matrix.decideDevices(decideInput);

    this.log(
      `[${mode}] D${defcon} | ev=${this._decisions.ev.amp}A `
      + `batt=${this._decisions.battery.mode}/${this._decisions.battery.power_w}W `
      + `nibe=vv${this._decisions.nibe.vv} spa=${this._decisions.spa.temp}C `
      + `appl=${this._decisions.appliances.action}`,
    );

    // Apply decisions through the single gated chokepoint (compute-only for now).
    await this._applyDecisions(this._decisions, mode);

    // Fire DEFCON-change triggers.
    if (defcon !== this._lastDefcon) {
      await this._trigChanged.trigger(this, { defcon, mode }).catch(this.error);
      if (defcon === 1) await this._trigRed.trigger(this, {}).catch(this.error);
      this._lastDefcon = defcon;
    }
  }

  // ---------------------------------------------------------------------------
  // Actuation chokepoint — COMPUTE ONLY
  // ---------------------------------------------------------------------------
  /**
   * THE SOLE PLACE where future real device writes belong.
   *
   * Currently this method performs ZERO writes to any downstream device.
   * When actuation is wired:
   *   - Only proceed when mode === 'control'.
   *   - Import simgate and wrap every real write:
   *       simgate.guardActuation(() => someDevice.setCapabilityValue(...))
   *   - Thread sim_mode from onSettings() into simgate.setMode().
   *
   * @param {object} decisions  result of matrix.decideDevices()
   * @param {string} mode       'advisory' | 'control'
   */
  // eslint-disable-next-line no-unused-vars
  async _applyDecisions(decisions, mode) {
    // COMPUTE ONLY — no device writes here yet.
    // Future writes MUST be wrapped in simgate.guardActuation() and gated on
    // mode === 'control' before this method can actuate anything.
    if (mode !== 'control') return;
    // (future actuation code goes here)
  }

  async onDeleted() {
    if (this._interval) this.homey.clearInterval(this._interval);
  }

};
