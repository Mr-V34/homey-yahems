'use strict';

const Homey = require('homey');
const engine = require('../../lib/engine');
const matrix = require('../../lib/matrix');
const hal = require('../../lib/hal');
const simgate = require('../../lib/simgate');

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
//   1. Call this._write(deviceId, capability, value) — the single chokepoint.
//   2. Never call this._api.devices.setCapabilityValue() directly anywhere else
//      (the build-time guard in test/selftest.js asserts this structurally).
//   3. Thread sim_mode from onSettings() into simgate.setMode().
// Do NOT add a sim_mode UI setting until that step — it would introduce
// locale keys with no backing setting definition.
//
// STALENESS: if consumptionW has not changed for STALE_WINDOW_MS (60 min),
// DEFCON is forced to D3 (fail safe) and yahems_fault is set true.
// A signal_stale flow trigger fires on the transition into stale (edge only).
// =============================================================================

// Real net-power always jitters slightly; 60 minutes of byte-identical readings
// reliably indicates a dead feed (meter offline, Homey integration crash, etc.).
const STALE_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

module.exports = class ControllerDevice extends Homey.Device {

  async onInit() {
    this.buffer   = [];
    this.gridW    = 0;        // fallback grid reading from flow action
    this._lastDefcon = null;
    this._decisions  = null;
    this._api        = null;  // HomeyAPI instance (null if unavailable)
    this._deviceMap  = hal.validateMap('').map; // safe empty default

    // Signal-staleness tracking. Tracks the value and when it last changed.
    // Extend this object to track socPct / priceOre when needed later.
    this._sig = {
      consumptionW: { value: null, lastChangedAt: null },
    };

    // Ensure required capabilities exist (including the new yahems_fault).
    for (const c of ['yahems_defcon', 'yahems_mode', 'measure_power', 'yahems_fault']) {
      if (!this.hasCapability(c)) await this.addCapability(c).catch(this.error);
    }

    // Guard: DEFAULT_MATRIX must always be monotone. Log if it ever isn't
    // (this would indicate a broken edit to lib/matrix.js — never fires on
    // a correct matrix; exists so any future author edit is caught at startup).
    const mv = matrix.validateMatrix(matrix.DEFAULT_MATRIX);
    if (!mv.ok) this.error(`Matrix invariant violation: ${mv.errors.join('; ')}`);

    // Set up flow trigger cards.
    this._trigChanged = this.homey.flow.getDeviceTriggerCard('defcon_changed');
    this._trigRed     = this.homey.flow.getDeviceTriggerCard('red_alert');
    this._trigStale   = this.homey.flow.getDeviceTriggerCard('signal_stale');

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
  // Staleness tracking helper
  // ---------------------------------------------------------------------------

  /**
   * Update the staleness tracker for a named signal and return whether it is
   * currently stale. Edge-detects the stale transition and fires the
   * signal_stale trigger + a Homey notification the first time it goes stale.
   *
   * @param {string} signalName  key in this._sig (e.g. 'consumptionW')
   * @param {*}      currValue   the value observed this cycle
   * @returns {boolean} true if the signal is stale this cycle
   */
  _checkStaleness(signalName, currValue) {
    const now = Date.now();
    const sig = this._sig[signalName];
    if (!sig) return false; // unknown signal key — not tracked

    // First observation: record and not stale.
    if (sig.lastChangedAt === null) {
      sig.value = currValue;
      sig.lastChangedAt = now;
      return false;
    }

    // Value changed: reset tracker, not stale.
    if (currValue !== sig.value) {
      sig.value = currValue;
      sig.lastChangedAt = now;
      return false;
    }

    // Value unchanged: check age.
    const ageMs = now - sig.lastChangedAt;
    const stale = hal.isStale(sig.value, currValue, ageMs, STALE_WINDOW_MS);
    return stale;
  }

  // ---------------------------------------------------------------------------
  // Main compute loop
  // ---------------------------------------------------------------------------

  async recompute() {
    const s = this.getSettings();
    const anchor = Number(s.anchor) || 4500;

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

    // --- Staleness detection on consumptionW ---
    // Was this signal stale BEFORE checking this cycle (to detect the transition)?
    const wasStale = this.getCapabilityValue('yahems_fault') === true;
    const isStaleNow = this._checkStaleness('consumptionW', consumptionW);

    // Edge-trigger: signal just BECAME stale this cycle.
    if (isStaleNow && !wasStale) {
      const msg = 'consumptionW signal is stale (unchanged ≥60 min). '
        + 'Holding DEFCON 3 until the signal recovers.';
      this.log(`[FAULT] ${msg}`);
      await this._trigStale.trigger(this, { signal: 'consumptionW' }).catch(this.error);
      // Best-effort Homey notification (WAF: explain the why clearly).
      if (this.homey.notifications && this.homey.notifications.createNotification) {
        await this.homey.notifications.createNotification({ excerpt: `YAHEMS: ${msg}` })
          .catch(() => {}); // non-fatal
      }
    }

    // Push through rolling average.
    const r = engine.rollingAverage(this.buffer, consumptionW, 3);
    this.buffer = r.buffer;

    // If stale: force DEFCON 3 (fail safe — frost + comfort preserved).
    // Do not trust the rolling average from a frozen feed.
    const defcon = isStaleNow ? 3 : engine.defconFromNet(r.average, anchor);

    // Update capabilities (own-capability writes — not actuation).
    await this.setCapabilityValue('measure_power', r.average).catch(this.error);
    await this.setCapabilityValue('yahems_mode',   mode).catch(this.error);
    await this.setCapabilityValue('yahems_defcon', defcon).catch(this.error);
    await this.setCapabilityValue('yahems_fault',  isStaleNow).catch(this.error);

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
      `[${mode}] D${defcon}${isStaleNow ? ' FAULT:stale' : ''} | ev=${this._decisions.ev.amp}A `
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
   * When actuation is wired, it MUST call this._write(deviceId, capability, value)
   * — never the HomeyAPI form directly. The build-time guard in test/selftest.js
   * asserts this structurally.
   *
   * @param {object} decisions  result of matrix.decideDevices()
   * @param {string} mode       'advisory' | 'control'
   */
  // eslint-disable-next-line no-unused-vars
  async _applyDecisions(decisions, mode) {
    // COMPUTE ONLY — no device writes here yet.
    // Future writes MUST use this._write(deviceId, capability, value).
    // this.setCapabilityValue(...) is allowed here for OWN capabilities (not actuation).
    if (mode !== 'control') return;
    // (future actuation calls go here, via this._write(...))
  }

  // ---------------------------------------------------------------------------
  // Single write chokepoint — THE ONLY method permitted to call
  // this._api.devices.setCapabilityValue (HomeyAPI write form) to actuate
  // downstream devices. Own-capability writes (this.setCapabilityValue) are
  // NOT actuation and must stay outside this method.
  // ---------------------------------------------------------------------------
  /**
   * Write a capability value to a downstream (non-controller) device.
   *
   * Safety invariants enforced here:
   *  1. this._api must be initialised — throw clearly if not.
   *  2. Current mode must be 'control' — advisory mode writes fail LOUD
   *     (a silent advisory-mode actuate is a safety bug, not a warning).
   *  3. Wrapped in simgate.guardActuation() — a sim_mode ON hard-blocks the
   *     real API call, so stray calls during dry-run are impossible.
   *
   * @param {string} deviceId    Homey device UUID (not the controller's own id)
   * @param {string} capability  Capability id on the target device
   * @param {*}      value       Value to write
   */
  async _write(deviceId, capability, value) {
    if (!this._api) {
      throw new Error('_write: HomeyAPI is not initialised — cannot actuate');
    }
    // Determine current mode at call time (not cached, always fresh).
    const s = this.getSettings();
    const settingMeter = s.house_meter_present;
    const mapMeter = this._deviceMap.control.house_meter_present === true;
    const houseMeter = settingMeter === true || (settingMeter === undefined && mapMeter);
    const mode = houseMeter ? 'control' : 'advisory';
    if (mode !== 'control') {
      throw new Error(
        `_write: refused in advisory mode (deviceId=${deviceId} cap=${capability}). `
        + 'Enable house_meter_present before actuating.',
      );
    }
    await simgate.guardActuation(() =>
      this._api.devices.setCapabilityValue({ deviceId, capabilityId: capability, value })
    );
  }

  async onDeleted() {
    if (this._interval) this.homey.clearInterval(this._interval);
  }

};
