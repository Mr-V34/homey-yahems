'use strict';

const Homey = require('homey');
const engine = require('../../lib/engine');
const matrix = require('../../lib/matrix');
const hal = require('../../lib/hal');
const simgate = require('../../lib/simgate');
const simfeeder = require('../../lib/simfeeder');
const catalog = require('../../lib/catalog');

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
// FAULT CONDITIONS (yahems_fault = true → DEFCON forced to D3, fail safe):
//   STALENESS: consumptionW unchanged for STALE_WINDOW_MS (60 min) — meter
//   offline or integration crash. signal_stale trigger fires on transition in.
//   IMPLAUSIBLE: consumptionW > MAX_PLAUSIBLE_W — spoofed/broken meter reading.
//   signal_stale trigger fires on transition in (with "implausibly high" label).
//   Both conditions are edge-fired (trigger once on first detection, not every cycle).
// =============================================================================

// Real net-power always jitters slightly; 60 minutes of byte-identical readings
// reliably indicates a dead feed (meter offline, Homey integration crash, etc.).
const STALE_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

// Generous ceiling for net house power on a Swedish 3×25 A (or 3×35 A) service:
//   3 × 35 A × 230 V ≈ 24 150 W. Round up to 30 kW for margin.
// Any reading above this almost certainly indicates a spoofed or broken meter.
// CONFIGURABLE-LATER: promote to a driver setting when real hardware is connected.
// FLAG to owner for confirmation (default 30000 W).
const MAX_PLAUSIBLE_W = 30000;

module.exports = class ControllerDevice extends Homey.Device {

  async onInit() {
    this.buffer   = [];       // short rolling buffer for the responsive measure_power
    this._samples = [];       // timestamped samples for the 15-min (3×5-min) average
    this.gridW    = 0;        // fallback grid reading from flow action
    this._gridWReported = false; // true once a Report-grid-power flow value arrives
    this._lastDefcon = null;
    this._decisions  = null;
    this._api        = null;  // HomeyAPI instance (null if unavailable)
    this._deviceMap  = hal.validateMap('').map; // safe empty default
    this._matrix     = matrix.DEFAULT_MATRIX;   // effective matrix; replaced by _loadMatrix()

    // Per-device boost state: { [kind]: untilTimestampMs }.
    // Non-persistent — lost on app restart, which fails safe (returns to normal DEFCON).
    // Boostable kinds: nibe, spa, ev, battery, appliances. comfort is excluded (always 'allow').
    this._boosts = {};

    // Signal-staleness tracking. Tracks the value and when it last changed.
    // Extend this object to track socPct / priceOre when needed later.
    this._sig = {
      consumptionW: { value: null, lastChangedAt: null },
    };

    // Ensure required capabilities exist (including yahems_source + yahems_fault).
    for (const c of ['yahems_defcon', 'yahems_defcon_label', 'yahems_mode', 'yahems_source', 'measure_power', 'yahems_avg15', 'yahems_fault']) {
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

    // Load device_map and matrix_override settings.
    this._loadDeviceMap();
    this._loadMatrix();

    // The App Settings page edits the device_map at app level. React to changes
    // immediately so the map takes effect without an app restart.
    this._onAppSettingsSet = (key) => {
      const watched = ['device_map', 'op_mode', 'anchor', 'matrix_override', 'main_fuse_a', 'phases', 'price_gate_ore'];
      if (watched.includes(key)) {
        if (key === 'device_map') this._loadDeviceMap();
        if (key === 'matrix_override' || key === 'price_gate_ore') this._loadMatrix();
        this.recompute().catch(this.error);
      }
    };
    try {
      this.homey.settings.on('set', this._onAppSettingsSet);
    } catch (err) {
      this.log(`could not subscribe to app settings changes: ${err.message}`);
    }

    // Periodic recompute (every 60 s) plus an immediate run.
    this._interval = this.homey.setInterval(() => this.recompute().catch(this.error), 60000);
    await this.recompute();
    this.log('YAHEMS Controller device initialized');
  }

  // ---------------------------------------------------------------------------
  // Settings helpers
  // ---------------------------------------------------------------------------

  /**
   * (Re)load and validate the device_map. Logs validation errors.
   *
   * The map is owned by the App Settings page and stored in app-level
   * ManagerSettings (key `device_map`). For backward compatibility a non-empty
   * device-level `device_map` setting (the legacy textarea) is still honoured as
   * a fallback when no app-level map exists.
   */
  _loadDeviceMap() {
    let raw = '';
    try {
      raw = this.homey.settings.get('device_map') || '';
    } catch (_) {
      raw = '';
    }
    if (!raw) {
      // Legacy fallback: device-level textarea (pre-settings-page installs).
      raw = (this.getSettings() || {}).device_map || '';
    }
    const { ok, map, errors } = hal.validateMap(raw);
    if (!ok) {
      this.log(`device_map validation errors — using empty map: ${errors.join('; ')}`);
    }
    this._deviceMap = map;
  }

  /**
   * Operating mode (the single top-level switch on the settings page):
   *   - 'simulation' — try things you don't own; never actuates; synthetic feed.
   *   - 'advisory'   — installed devices; reads Homey Energy total; never actuates.
   *   - 'full'       — installed devices; real meter; actuation gate OPEN.
   * Back-compat: the legacy `house_meter_present` device checkbox = 'full'.
   * @returns {'simulation'|'advisory'|'full'}
   */
  _opMode() {
    try {
      const v = this.homey.settings.get('op_mode');
      if (v === 'simulation' || v === 'advisory' || v === 'full') return v;
    } catch (_) { /* fall through */ }
    try {
      if ((this.getSettings() || {}).house_meter_present === true) return 'full';
    } catch (_) { /* fall through */ }
    return 'advisory';
  }

  /**
   * Which fallback source to use when no real meter/flow signal is mapped.
   * Derived from the operating mode:
   *   - simulation → 'estimate' (synthetic season-aware model)
   *   - advisory / full → 'homey_energy' (real aggregated total; auto-falls back
   *     to the estimate inside the precedence if the report is unavailable).
   * @returns {'homey_energy'|'estimate'}
   */
  _noMeterSource() {
    return this._opMode() === 'simulation' ? 'estimate' : 'homey_energy';
  }

  /**
   * Build the big-load ("Storförbrukare") set for the matrix, mapping each
   * controlled subgroup the user flagged onto its matrix key (heatpump→nibe …).
   * @returns {object} e.g. { ev: true, spa: true }
   */
  _bigLoads() {
    const out = {};
    const controls = (this._deviceMap && this._deviceMap.controls) || {};
    for (const sg of catalog.subgroups()) {
      if (!sg.matrixKey) continue;
      const c = controls[sg.key];
      if (c && c.bigLoad === true) out[sg.matrixKey] = true;
    }
    return out;
  }

  /**
   * Show one status tile per CONFIGURED consumer on the device page, by adding a
   * `yahems_allow_<matrixKey>` boolean capability for each installed/simulated
   * controlled device and removing it when the device is "Not installed". The
   * capability value is the allowed/paused state from the latest decisions.
   * Capabilities are only added/removed on change (hasCapability guards churn).
   */
  async _syncStatusCapabilities() {
    const controls = (this._deviceMap && this._deviceMap.controls) || {};
    const d = this._decisions || {};
    for (const sg of catalog.subgroups()) {
      if (!sg.matrixKey) continue;
      const cap = `yahems_allow_${sg.matrixKey}`;
      const c = controls[sg.key];
      const configured = c && c.presence !== 'absent';
      if (configured) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
        const st = this._decisionStatus(sg.matrixKey, d[sg.matrixKey]);
        await this.setCapabilityValue(cap, st.allowed).catch(this.error);
      } else if (this.hasCapability(cap)) {
        await this.removeCapability(cap).catch(this.error);
      }
    }
  }

  /**
   * Live per-consumer overview for the settings page. Maps the latest decisions
   * (this._decisions) onto allowed/paused + a compact detail per configured device,
   * plus custom consumers. Pure read of cached state — no API calls, no writes.
   */
  getStatusSnapshot() {
    const d = this._decisions || {};
    const controls = (this._deviceMap && this._deviceMap.controls) || {};
    const out = {
      mode: this.getCapabilityValue('yahems_mode'),
      defcon: this.getCapabilityValue('yahems_defcon'),
      source: this.getCapabilityValue('yahems_source'),
      power: this.getCapabilityValue('measure_power'),
      // 15-min average + its three 5-minute sub-averages (newest first), so the
      // overview can show both the value and how it is built up.
      avg15: Number.isFinite(this._avg15) ? this._avg15 : null,
      windows: Array.isArray(this._windows) ? this._windows : [null, null, null],
      devices: [],
      custom: [],
    };
    const defcon = Number.isFinite(out.defcon) ? out.defcon : 3;
    for (const sg of catalog.subgroups()) {
      if (!sg.matrixKey) continue;
      const c = controls[sg.key];
      if (!c || c.presence === 'absent') continue;
      const st = this._decisionStatus(sg.matrixKey, d[sg.matrixKey]);
      out.devices.push({
        labelEn: sg.labelEn,
        labelSv: sg.labelSv,
        presence: c.presence,
        bigLoad: c.bigLoad === true,
        allowed: st.allowed,
        detail: st.detail,
      });
    }
    for (const cu of (this._deviceMap.custom || [])) {
      const pausable = cu.mode === 'pausable';
      // Pausable customs are held back at a peak (DEFCON 2/1); monitor-only are
      // just watched. (No per-custom threshold yet — sensible default.)
      const allowed = pausable ? defcon >= 3 : true;
      out.custom.push({
        name: cu.name || 'Consumer',
        mode: cu.mode || 'monitor',
        allowed,
        detail: pausable ? (allowed ? 'run' : 'pause') : 'monitor',
      });
    }
    return out;
  }

  /**
   * Map one device's decision to { allowed, detail }. `detail` is compact and
   * mostly numeric/unit; flag tags (price/boost) are appended when present.
   */
  _decisionStatus(key, dec) {
    if (!dec) return { allowed: true, detail: '—' };
    const flags = dec.flags || [];
    const tags = [];
    if (dec.priceHold || flags.includes('price-hold')) tags.push('price');
    if (dec.boosted || flags.includes('boosted')) tags.push('boost');
    const suffix = tags.length ? ` [${tags.join(',')}]` : '';
    switch (key) {
      case 'ev': return { allowed: dec.amp > 0, detail: `${dec.amp} A${suffix}` };
      case 'spa': return { allowed: dec.heat === true, detail: `${dec.temp}°C${suffix}` };
      case 'nibe': return { allowed: true, detail: `vv ${dec.vv}°C${suffix}` };
      case 'battery': return { allowed: dec.mode !== 'idle', detail: `${dec.mode}${suffix}` };
      case 'dishwasher':
      case 'washer':
      case 'dryer': return { allowed: dec.action === 'run', detail: `${dec.action}${suffix}` };
      default: return { allowed: true, detail: '—' };
    }
  }

  /**
   * Read Homey Energy's aggregated whole-home live total as net house watts.
   * Homey already sums every device's measure_power, so this is real data, not a
   * guess. Returns null if the API is unavailable or the report has no usable
   * figure, so the caller can fall through to the synthetic estimate.
   * @returns {Promise<number|null>}
   */
  async _readHomeyEnergyW() {
    if (this._api == null || this._api.energy == null) return null;
    try {
      const report = await this._api.energy.getLiveReport({});
      if (!this._loggedLiveReport) {
        // One-time shape confirmation on the real Homey (field names vary by fw).
        this.log(`Homey Energy live report sample: ${JSON.stringify(report).slice(0, 300)}`);
        this._loggedLiveReport = true;
      }
      const gross = simfeeder.houseNetFromLiveReport(report);
      if (!Number.isFinite(gross)) return null;
      // Homey Energy counts THIS controller's own measure_power in the total
      // (it appears as a load like any other device). Subtract our own current
      // contribution so we never feed our reading back into itself — otherwise
      // the value would compound every cycle. This settles at the real house draw.
      const own = Number(this.getCapabilityValue('measure_power')) || 0;
      return Math.max(0, gross - own);
    } catch (err) {
      this.log(`Homey Energy live report read failed: ${err.message}`);
      return null;
    }
  }

  /**
   * (Re)load, validate, merge, and monotonicity-check the matrix_override setting.
   *
   * Validate-then-adopt-or-keep-last-good pattern:
   *   1. validateMatrixOverride(raw) — parse + shape guard.
   *   2. mergeMatrix(DEFAULT_MATRIX, override) — deep merge + clamp.
   *   3. validateMatrix(merged) — monotonicity check.
   *   On any failure, this._matrix is left unchanged (kept at last good value).
   *   On success, this._matrix is updated to the merged+clamped matrix.
   */
  _loadMatrix() {
    // matrix_override is owned by the settings page (app settings). Fall back to a
    // legacy device-level value, then to {} (built-in defaults).
    let raw;
    try { raw = this.homey.settings.get('matrix_override'); } catch (_) { raw = null; }
    if (!raw) raw = (this.getSettings() || {}).matrix_override || '{}';

    // Step 1: validate override shape + parse.
    const { ok: parseOk, override, errors: parseErrors } = matrix.validateMatrixOverride(raw);
    if (!parseOk) {
      this.log(`matrix_override invalid — keeping last good matrix: ${parseErrors.join('; ')}`);
      return; // keep this._matrix as-is
    }
    if (parseErrors.length) {
      // Warnings (e.g. unknown keys stripped) — log but continue.
      this.log(`matrix_override warnings: ${parseErrors.join('; ')}`);
    }

    // Step 2: deep-merge onto DEFAULT_MATRIX with safe clamps.
    const merged = matrix.mergeMatrix(matrix.DEFAULT_MATRIX, override);

    // Step 3: monotonicity check.
    const { ok: monoOk, errors: monoErrors } = matrix.validateMatrix(merged);
    if (!monoOk) {
      this.log(
        `matrix_override rejected (monotonicity violation) — keeping last good matrix: ${monoErrors.join('; ')}`
      );
      return; // keep this._matrix as-is
    }

    // Apply the user's price-gate slider: the öre/kWh threshold above which
    // expensive loads (EV charging) are held pending confirmation. This is a
    // single instrument, independent of the per-band level table. `merged` is a
    // deep clone (mergeMatrix uses JSON round-trip), so mutating it is safe.
    let gate;
    try { gate = Number(this.homey.settings.get('price_gate_ore')); } catch (_) { gate = NaN; }
    if (Number.isFinite(gate) && merged.ev) {
      merged.ev.gateOre = Math.max(0, Math.min(10000, Math.round(gate)));
    }

    // All checks passed: adopt the merged matrix.
    this._matrix = merged;
    this.log('matrix_override applied successfully');
  }

  async onSettings() {
    // The only remaining device-level setting is house_meter_present (the control
    // gate). Everything else (device_map, matrix_override, anchor, fuse, estimate)
    // lives in app settings and is handled by the listener in onInit. Just recompute
    // so a meter-gate change takes effect immediately.
    await this.recompute();
  }

  // ---------------------------------------------------------------------------
  // Flow action handlers
  // ---------------------------------------------------------------------------

  async onReportGrid(w) {
    if (Number.isFinite(w)) {
      this.gridW = w;
      this._gridWReported = true; // a real flow value has arrived; outranks estimate
      await this.recompute();
    }
    return true;
  }

  async onSetAnchor(w) {
    // Anchor (the user's max power target) is an app-level setting owned by the
    // settings page; writing it here fires the settings listener → recompute.
    if (Number.isFinite(w) && w > 0) this.homey.settings.set('anchor', Math.round(w));
    await this.recompute();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Boost helpers
  // ---------------------------------------------------------------------------

  // Kinds that can be boosted. comfort is excluded — it is always 'allow'.
  static get BOOSTABLE_KINDS() {
    return new Set(['nibe', 'spa', 'ev', 'battery', 'appliances']);
  }

  /**
   * Return a { [kind]: true } map of currently active boosts, pruning expired entries.
   * Call at the top of recompute() so expired boosts are automatically cleaned up.
   */
  _activeBoosts() {
    const now = Date.now();
    const active = {};
    for (const [kind, untilTs] of Object.entries(this._boosts)) {
      if (untilTs > now) {
        active[kind] = true;
      } else {
        delete this._boosts[kind]; // prune expired
      }
    }
    return active;
  }

  /**
   * Set a boost for a given kind until the specified timestamp.
   * Unknown or non-boostable kinds are silently ignored.
   * After setting, recompute() is called so the effect is immediate.
   */
  async _setBoost(kind, untilTs) {
    if (!ControllerDevice.BOOSTABLE_KINDS.has(kind)) {
      this.log(`_setBoost: ignored unknown/non-boostable kind '${kind}'`);
      return;
    }
    this._boosts[kind] = untilTs;
    const until = new Date(untilTs).toISOString();
    this.log(`Boost SET: ${kind} until ${until}`);
    await this.recompute();
  }

  /**
   * Cancel an active boost for a given kind.
   * After cancelling, recompute() is called so the effect is immediate.
   */
  async _cancelBoost(kind) {
    if (!ControllerDevice.BOOSTABLE_KINDS.has(kind)) {
      this.log(`_cancelBoost: ignored unknown/non-boostable kind '${kind}'`);
      return;
    }
    delete this._boosts[kind];
    this.log(`Boost CANCELLED: ${kind}`);
    await this.recompute();
  }

  // ---------------------------------------------------------------------------
  // Flow action handlers — boost cards
  // ---------------------------------------------------------------------------

  async onBoostForHours(kind, hours) {
    const untilTs = Date.now() + Math.max(0, hours) * 3_600_000;
    await this._setBoost(kind, untilTs);
    return true;
  }

  async onBoostUntil(kind, timeStr) {
    // timeStr is "HH:MM" (Homey 'time' type, local time).
    const [hh, mm] = timeStr.split(':').map(Number);
    const now = new Date();
    const candidate = new Date(now);
    candidate.setHours(hh, mm, 0, 0);
    // If the target time has already passed today, roll forward to tomorrow.
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    await this._setBoost(kind, candidate.getTime());
    return true;
  }

  async onCancelBoost(kind) {
    await this._cancelBoost(kind);
    return true;
  }

  async onRunNow() {
    // GLOBAL boost: set every boostable kind for 1 hour.
    const untilTs = Date.now() + 3_600_000;
    for (const kind of ControllerDevice.BOOSTABLE_KINDS) {
      this._boosts[kind] = untilTs;
    }
    this.log('Run-all-now: all boostable kinds boosted for 1 hour');
    await this.recompute();
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
    // Max power target: app setting (owned by the settings page) is authoritative;
    // fall back to any legacy device-level setting, then the 4500 W default.
    const anchor = Number(this.homey.settings.get('anchor')) || Number(s.anchor) || 4500;

    // Operating mode drives advisory vs control. Only 'full' actuates.
    const mode = this._opMode() === 'full' ? 'control' : 'advisory';

    // --- Build HAL snapshot if the API is available and map has inputs ---
    // DATA MINIMISATION: read ONLY the devices the user explicitly mapped, by id,
    // rather than fetching every device on the Homey. This keeps the broad
    // homey:manager:api permission scoped to what YAHEMS actually needs.
    let halSignals = {};
    if (this._api != null && this._deviceMap.inputs.length > 0) {
      try {
        const mappedIds = [...new Set(this._deviceMap.inputs.map((e) => e.deviceId))];
        // Build snapshot: { [deviceId]: { [capabilityId]: capabilityValue } }
        const snapshot = {};
        for (const id of mappedIds) {
          let dev;
          try {
            dev = await this._api.devices.getDevice({ id });
          } catch (e) {
            // Mapped device removed/unavailable — omit it (HAL treats as absent,
            // never substitutes zero). Do not abort the whole snapshot.
            continue;
          }
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

    // --- Determine net-power source (precedence) ---
    // The engine wants net grid import in watts (export reads as 0). Precedence:
    //   1. grid_power_w  — signed inverter/Shelly CT reading (preferred meter).
    //   2. home_consumption_w — mapped house-draw meter (P1/HAN, PbtH).
    //   3. flow-action gridW — "Report grid power" flow input.
    //   4. no-meter fallback — per the `no_meter_source` setting:
    //        'homey_energy' → Homey Energy's aggregated whole-home live total
    //                         (real summed device power; great for apartments),
    //        'estimate'     → synthetic season-aware model (lib/simfeeder),
    //        'off'          → hold neutral.
    // Each real source clamps to >= 0. Only when NOTHING real is available do we
    // fall back, so a fake zero is never reported as surplus.
    let consumptionW;
    let sourceTag;
    if (Number.isFinite(halSignals.gridPowerW)) {
      consumptionW = Math.max(0, halSignals.gridPowerW);
      sourceTag = 'grid_ct';
    } else if (Number.isFinite(halSignals.consumptionW)) {
      consumptionW = Math.max(0, halSignals.consumptionW);
      sourceTag = 'measured';
    } else if (this._gridWReported === true) {
      consumptionW = Math.max(0, this.gridW);
      sourceTag = 'flow';
    } else {
      const noMeterSource = this._noMeterSource();
      const energyW = noMeterSource === 'homey_energy'
        ? await this._readHomeyEnergyW()
        : null;
      if (Number.isFinite(energyW)) {
        // Homey Energy whole-home total — real summed data. Stays advisory;
        // unlocking control still requires a dedicated meter (house_meter_present).
        consumptionW = Math.max(0, energyW);
        sourceTag = 'homey_energy';
      } else if (noMeterSource === 'off') {
        // No source and fallback disabled: hold neutral (use 0 but tag honestly).
        consumptionW = 0;
        sourceTag = 'estimated';
      } else {
        // 'estimate', or 'homey_energy' chosen but unavailable this cycle.
        consumptionW = simfeeder.estimateConsumptionW({});
        sourceTag = 'estimated';
      }
    }

    // Fault detection only applies to REAL dedicated sensor sources. The advisory
    // estimate is intentionally steady, and the Homey Energy aggregate can briefly
    // read low before devices report — neither can go stale or read implausibly
    // high in a meaningful way, so skip both checks for them.
    const isRealSource = ['grid_ct', 'measured', 'flow'].includes(sourceTag);

    // --- Implausible-reading check ---
    // Values above MAX_PLAUSIBLE_W indicate a spoofed or broken meter.
    // Treat as a fault: clamp the value fed to the buffer so it can recover
    // quickly once real values return, but force DEFCON 3 regardless.
    const isImplausible = isRealSource && consumptionW > MAX_PLAUSIBLE_W;
    const consumptionWClamped = isImplausible ? MAX_PLAUSIBLE_W : consumptionW;

    // --- Staleness detection on consumptionW ---
    // Run staleness check on the (possibly clamped) value so a stuck-at-implausible
    // feed does not prevent stale detection from also firing later.
    // Was this signal in fault BEFORE checking this cycle (to detect transitions)?
    const wasFault = this.getCapabilityValue('yahems_fault') === true;
    const isStaleNow = isRealSource
      ? this._checkStaleness('consumptionW', consumptionWClamped)
      : false;

    // Combined fault condition: stale OR implausible.
    const isFault = isStaleNow || isImplausible;

    // Edge-trigger: signal just BECAME stale this cycle.
    if (isStaleNow && !wasFault) {
      const label = this.homey.__('signals.consumptionW') || 'House power';
      const msg = `${label} sensor looks stuck (unchanged for over an hour). `
        + 'Holding at DEFCON 3 until it updates again.';
      this.log(`[FAULT] ${msg}`);
      await this._trigStale.trigger(this, { signal: label }).catch(this.error);
      // Best-effort Homey notification (WAF: explain the why clearly).
      if (this.homey.notifications && this.homey.notifications.createNotification) {
        await this.homey.notifications.createNotification({ excerpt: `YAHEMS: ${msg}` })
          .catch(() => {}); // non-fatal
      }
    }

    // Edge-trigger: reading just BECAME implausible this cycle (and was not already
    // in fault — avoid double-firing if both conditions arrive simultaneously).
    if (isImplausible && !wasFault) {
      const label = this.homey.__('signals.consumptionW') || 'House power';
      const msg = `${label} reading implausibly high (${consumptionW} W > ${MAX_PLAUSIBLE_W} W limit). `
        + 'Holding at DEFCON 3 until meter recovers.';
      this.log(`[FAULT] ${msg}`);
      await this._trigStale.trigger(this, { signal: label }).catch(this.error);
      // Best-effort Homey notification.
      if (this.homey.notifications && this.homey.notifications.createNotification) {
        await this.homey.notifications.createNotification({ excerpt: `YAHEMS: ${msg}` })
          .catch(() => {}); // non-fatal
      }
    }

    // Push clamped value through rolling average.
    // If implausible, consumptionWClamped = MAX_PLAUSIBLE_W so the buffer can
    // recover quickly once real values return (DEFCON is force-3 regardless).
    const r = engine.rollingAverage(this.buffer, consumptionWClamped, 3);
    this.buffer = r.buffer;

    // 15-minute average (three consecutive 5-minute sub-averages) — the figure a
    // grid power tariff actually bills. Computed from timestamped samples so it is
    // correct regardless of the 60 s recompute cadence. Kept separate from
    // measure_power (the short, responsive value) for its own YAHEMS insight.
    const now = Date.now();
    this._samples = engine.pushSample(this._samples, consumptionWClamped, now);
    this._windows = engine.windowAverages(this._samples, now);
    this._avg15 = engine.fifteenMinAverage(this._windows);

    // DEFCON judges the 15-min average — the same window a grid power tariff bills.
    // This is deliberately stable: a brief appliance spike no longer flips the
    // ladder. (Before the first sub-window has data, _avg15 already equals the
    // first sample, so there is no warm-up gap; r.average is only a safety
    // fallback.) If stale OR implausible: force DEFCON 3 (fail safe).
    const judgedW = Number.isFinite(this._avg15) ? this._avg15 : r.average;
    const defcon = isFault ? 3 : engine.defconFromNet(judgedW, anchor);

    // Update capabilities (own-capability writes — not actuation).
    await this.setCapabilityValue('measure_power', r.average).catch(this.error);
    await this.setCapabilityValue('yahems_mode',   mode).catch(this.error);
    await this.setCapabilityValue('yahems_source', sourceTag).catch(this.error);
    await this.setCapabilityValue('yahems_defcon', defcon).catch(this.error);
    await this.setCapabilityValue('yahems_defcon_label', `d${defcon}`).catch(this.error);
    await this.setCapabilityValue('yahems_fault',  isFault).catch(this.error);
    // Only publish the 15-min average once a sub-window has data (avoid a fake 0).
    if (Number.isFinite(this._avg15)) {
      await this.setCapabilityValue('yahems_avg15', this._avg15).catch(this.error);
    }

    // House main fuse + phases (app settings) feed EV load-balancing / clamps.
    const fuseA = Number(this.homey.settings.get('main_fuse_a'));
    const phases = Number(this.homey.settings.get('phases'));

    // Build the full decideDevices() input: HAL signals spread in, then
    // consumption, defcon and localHour are always set explicitly.
    const decideInput = {
      ...halSignals,
      defcon,
      consumptionW: Math.max(0, r.average),
      localHour: new Date().getHours(),
      bigLoads: this._bigLoads(),
      ...(Number.isFinite(fuseA) ? { mainFuseA: fuseA } : {}),
      ...(Number.isFinite(phases) ? { phases } : {}),
    };
    // Unwrap nested ev spread if halSignals brought ev.* fields; spread
    // already preserves the nested shape because resolveSignals uses _setPath.

    // Resolve active boosts (prunes expired entries as a side effect).
    const activeBoosts = this._activeBoosts();
    const activeBoostKinds = Object.keys(activeBoosts);

    this._decisions = matrix.decideDevices(decideInput, this._matrix, activeBoosts);

    const boostTag = activeBoostKinds.length > 0
      ? ` boost=[${activeBoostKinds.join(',')}]`
      : '';
    const faultTag = isFault
      ? (isStaleNow && isImplausible ? ' FAULT:stale+implausible'
        : isImplausible ? ' FAULT:implausible'
        : ' FAULT:stale')
      : '';
    this.log(
      `[${mode}] D${defcon} src=${sourceTag}${faultTag}${boostTag} | ev=${this._decisions.ev.amp}A `
      + `batt=${this._decisions.battery.mode}/${this._decisions.battery.power_w}W `
      + `nibe=vv${this._decisions.nibe.vv} spa=${this._decisions.spa.temp}C `
      + `appl=${this._decisions.dishwasher.action[0]}${this._decisions.washer.action[0]}${this._decisions.dryer.action[0]}`,
    );

    // Reflect per-consumer allowed/paused state on the device page as status tiles.
    await this._syncStatusCapabilities();

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
    // Only 'full' operating mode may actuate.
    if (this._opMode() !== 'full') {
      throw new Error(
        `_write: refused outside full mode (deviceId=${deviceId} cap=${capability}). `
        + 'Switch the operating mode to Full to actuate.',
      );
    }
    await simgate.guardActuation(() =>
      this._api.devices.setCapabilityValue({ deviceId, capabilityId: capability, value })
    );
  }

  async onDeleted() {
    if (this._interval) this.homey.clearInterval(this._interval);
    if (this._onAppSettingsSet) {
      try { this.homey.settings.removeListener('set', this._onAppSettingsSet); } catch (_) { /* noop */ }
    }
  }

};
