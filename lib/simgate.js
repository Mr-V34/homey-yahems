'use strict';

/**
 * YAHEMS sim-mode kill-switch (simgate).
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * sim_mode is OFF by default and must be explicitly enabled for dry-run
 * sessions. When ON, any call to guardActuation() throws — real Homey
 * capability writes MUST be wrapped with guardActuation() so they are
 * hard-blocked during simulation. Fail-safe: unknown/uninitialised state
 * is treated as OFF (safe).
 *
 * Usage in device.js (once device actuation is wired):
 *
 *   const simgate = require('../../lib/simgate');
 *   // before writing a capability to a physical device:
 *   simgate.guardActuation(() => zaptec.setChargeAmp(amp));
 *
 * sim_mode is controlled via the controller device setting 'sim_mode'.
 * Default: false (disabled). The device.js onSettings handler must call
 * simgate.setMode(newSettings.sim_mode === true) when the setting changes.
 */

let _simMode = false; // default OFF — fail-safe

/** Enable sim mode (dry-run). Logs a clear warning. */
function enable() {
  _simMode = true;
}

/** Disable sim mode (live operation). */
function disable() {
  _simMode = false;
}

/**
 * Set sim mode from a boolean value.
 * Any non-strict-true value (null, undefined, 0, '') is treated as OFF.
 */
function setMode(flag) {
  _simMode = flag === true;
}

/** Returns true if sim mode is currently active. */
function isEnabled() {
  return _simMode === true;
}

/**
 * Guard a real-device actuation function.
 * Throws SimBlockedError if sim mode is ON — the real function is never called.
 * If sim mode is OFF, calls fn() and returns its result (sync or async).
 *
 * @param {Function} fn  the actuation function to call in live mode
 * @returns result of fn() when live, or throws when sim
 */
function guardActuation(fn) {
  if (_simMode) {
    throw new SimBlockedError(
      'sim_mode is ON — real actuation blocked. Disable sim_mode before live operation.',
    );
  }
  return fn();
}

class SimBlockedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'SimBlockedError';
  }
}

/** Self-test: verifies default-OFF, enable/disable cycle, and the hard block. */
function selfTest() {
  const fails = [];
  const chk = (cond, msg) => { if (!cond) fails.push(msg); };

  // 1. Default must be OFF (fail-safe).
  disable(); // ensure clean state
  chk(isEnabled() === false, 'default state must be OFF');

  // 2. Enable → isEnabled true.
  enable();
  chk(isEnabled() === true, 'enable() should set mode ON');

  // 3. guardActuation must throw when ON.
  let threw = false;
  let threwSimBlocked = false;
  try {
    guardActuation(() => 'real-device-call');
  } catch (e) {
    threw = true;
    threwSimBlocked = e.name === 'SimBlockedError';
  }
  chk(threw, 'guardActuation must throw when sim ON');
  chk(threwSimBlocked, 'thrown error must be SimBlockedError');

  // 4. The real function must NOT have been called.
  let realCalled = false;
  try {
    guardActuation(() => { realCalled = true; });
  } catch (_) { /* expected */ }
  chk(realCalled === false, 'real function must NOT be called when sim ON');

  // 5. Disable → isEnabled false.
  disable();
  chk(isEnabled() === false, 'disable() should set mode OFF');

  // 6. guardActuation must call fn when OFF.
  let liveCalled = false;
  guardActuation(() => { liveCalled = true; });
  chk(liveCalled === true, 'guardActuation must call fn when sim OFF');

  // 7. setMode(true) / setMode(false) — same semantics.
  setMode(true);
  chk(isEnabled() === true, 'setMode(true) must enable');
  setMode(false);
  chk(isEnabled() === false, 'setMode(false) must disable');

  // 8. setMode with falsy non-boolean must stay OFF (fail-safe).
  setMode(null);
  chk(isEnabled() === false, 'setMode(null) must stay OFF');
  setMode(0);
  chk(isEnabled() === false, 'setMode(0) must stay OFF');
  setMode('true'); // string — should NOT enable
  chk(isEnabled() === false, "setMode('true') string must stay OFF");

  // 9. Leave in clean OFF state for other tests.
  disable();

  return { pass: fails.length === 0, fails };
}

module.exports = { enable, disable, setMode, isEnabled, guardActuation, SimBlockedError, selfTest };
