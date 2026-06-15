'use strict';

const Homey = require('homey');
const engine = require('./lib/engine');

module.exports = class YahemsApp extends Homey.App {

  async onInit() {
    const st = engine.selfTest();
    this.log(`YAHEMS initialized. DEFCON engine self-test: ${st.pass ? 'PASS' : `FAIL ${st.fails.join('; ')}`}`);
  }

};
