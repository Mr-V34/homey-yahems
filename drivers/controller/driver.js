'use strict';

const Homey = require('homey');

module.exports = class ControllerDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('report_grid_power')
      .registerRunListener(async (args) => args.device.onReportGrid(Number(args.power)));
    this.homey.flow.getActionCard('set_anchor')
      .registerRunListener(async (args) => args.device.onSetAnchor(Number(args.watts)));
    this.homey.flow.getActionCard('run_now')
      .registerRunListener(async (args) => args.device.onRunNow());
    this.homey.flow.getActionCard('boost_for_hours')
      .registerRunListener(async (args) => args.device.onBoostForHours(args.load, Number(args.hours)));
    this.homey.flow.getActionCard('boost_until')
      .registerRunListener(async (args) => args.device.onBoostUntil(args.load, args.time));
    this.homey.flow.getActionCard('cancel_boost')
      .registerRunListener(async (args) => args.device.onCancelBoost(args.load));
    this.homey.flow.getConditionCard('defcon_lte')
      .registerRunListener(async (args) => (args.device.getCapabilityValue('yahems_defcon') || 5) <= Number(args.level));
    this.log('YAHEMS Controller driver ready');
  }

  async onPairListDevices() {
    return [
      { name: 'YAHEMS Controller', data: { id: 'yahems-controller' } },
    ];
  }

};
