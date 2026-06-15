'use strict';

const Homey = require('homey');
const engine = require('../../lib/engine');

module.exports = class ControllerDevice extends Homey.Device {

  async onInit() {
    this.buffer = [];
    this.gridW = 0;
    this._lastDefcon = null;

    for (const c of ['yahems_defcon', 'yahems_mode', 'measure_power']) {
      if (!this.hasCapability(c)) await this.addCapability(c).catch(this.error);
    }

    this._trigChanged = this.homey.flow.getDeviceTriggerCard('defcon_changed');
    this._trigRed = this.homey.flow.getDeviceTriggerCard('red_alert');

    this._interval = this.homey.setInterval(() => this.recompute().catch(this.error), 60000);
    await this.recompute();
    this.log('YAHEMS Controller device initialized');
  }

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

  async recompute() {
    const s = this.getSettings();
    const anchor = Number(s.anchor) || 4500;
    const floor = Number(s.anchor_min) || 1000;
    const houseMeter = s.house_meter_present === true;

    const r = engine.rollingAverage(this.buffer, this.gridW, 3);
    this.buffer = r.buffer;

    const Teff = engine.effectiveAnchor(anchor, floor, {});
    const defcon = engine.defconFromNet(r.average, Teff);
    const mode = houseMeter ? 'control' : 'advisory';

    await this.setCapabilityValue('measure_power', r.average).catch(this.error);
    await this.setCapabilityValue('yahems_mode', mode).catch(this.error);
    await this.setCapabilityValue('yahems_defcon', defcon).catch(this.error);

    if (defcon !== this._lastDefcon) {
      await this._trigChanged.trigger(this, { defcon, mode }).catch(this.error);
      if (defcon === 1) await this._trigRed.trigger(this, {}).catch(this.error);
      this._lastDefcon = defcon;
    }
  }

  async onDeleted() {
    if (this._interval) this.homey.clearInterval(this._interval);
  }

};
