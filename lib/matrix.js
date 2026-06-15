'use strict';

/**
 * YAHEMS device-decision matrix — pure logic, no Homey imports.
 * Author: Peter Persson. Co-author: B.Frank.
 *
 * Given a DEFCON level (computed elsewhere, see lib/engine.js) plus the
 * currently-known house state, resolve a concrete decision per device.
 * Setpoints live as DATA in DEFAULT_MATRIX (dry-run seed values, easy to
 * retune). decideDevices() layers the safety/price/load-balance rules on
 * top of the raw matrix lookup. This module NEVER actuates anything —
 * Homey wiring lives only in drivers/controller/device.js.
 *
 * DEFCON: 5 = calm/surplus ... 1 = critical peak.
 * priceLevel: 1 = most expensive ... 5 = cheapest.
 */

// Band keys 5..1 mapped to setpoints. One entry per device, data-driven.
const DEFAULT_MATRIX = {
  // 1. Nibe heat pump — frost protection ALWAYS on, even at D1.
  nibe: {
    kind: 'thermal',
    bands: {
      5: { vv: 53, offset: 1, frost: true },
      4: { vv: 50, offset: 0, frost: true },
      3: { vv: 50, offset: 0, frost: true },
      2: { vv: 45, offset: -2, frost: true },
      1: { vv: 40, offset: -5, frost: true }, // legionella/frost floor: vv stays >= 40
    },
  },

  // 2. Spa (Balboa) — D1 frost guard: circulation pump ON, electric heat OFF.
  spa: {
    kind: 'thermal',
    bands: {
      5: { temp: 38, heat: true },
      4: { temp: 38, heat: true },
      3: { temp: 36, heat: true },
      2: { temp: 36, heat: true },
      1: { temp: 10, heat: false, frostGuard: true }, // never stop the pump
    },
  },

  // 3. EV charger (Zaptec). gateOre = device-level price gate (ore/kWh).
  ev: {
    kind: 'ev',
    gateOre: 300,
    bands: {
      5: { amp: 32 },
      4: { amp: 32 },
      3: { amp: 16 },
      2: { amp: 10 },
      1: { amp: 0 },
    },
  },

  // 4. Battery (Dyness TP7, 7.68 kWh). Gates carried on the entry.
  battery: {
    kind: 'battery',
    soc_reserve: 15,
    soc_safety: 5,
    soc_ceil: 97,
    rated_charge_w: 7680,
    charge_price_gate: 0,
    bands: {
      5: { mode: 'charge', pct: 100, power_w: 7680, charge_mode: 'headroom' },
      4: { mode: 'charge', pct: 50, power_w: 3840, charge_mode: 'fixed' },
      3: { mode: 'discharge', power_w: 0 }, // 0 = auto/max
      2: { mode: 'discharge', power_w: 0 },
      1: { mode: 'discharge', power_w: 0 },
    },
  },

  // 5. Home Connect appliances (dishwasher/washer/dryer). NEVER heating elements.
  appliances: {
    kind: 'appliance',
    highPowerW: 1500,
    bands: {
      5: { action: 'run' },
      4: { action: 'run' },
      3: { action: 'run' },
      2: { action: 'pause' },
      1: { action: 'pause' },
    },
  },

  // 6. Comfort loads (microwave/coffee). Always allowed, even D1.
  comfort: {
    kind: 'comfort',
    bands: {
      5: { action: 'allow' },
      4: { action: 'allow' },
      3: { action: 'allow' },
      2: { action: 'allow' },
      1: { action: 'allow' },
    },
  },
};

// (b)-OVERRIDE "car always drivable" minimum trickle floors, per DEFCON band.
// TUNABLE / needs-Peter-confirm: source numbers ambiguous. D1 deliberately
// absent — the override does NOT apply at critical peak (D1 = safety stop, 0A).
// NOTE: 3A is below the SAE/IEC charger minimum (6A). A charger physically
// cannot deliver < 6A, and the load-balance rule below zeroes anything < 6A.
// So when the override fires we lift to at least EV_MIN_AMP — the documented
// trickle is "the smallest amount the hardware can actually deliver".
const OVERRIDE_FLOOR_A = { 3: 3, 2: 6 };
const EV_MIN_AMP = 6;

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// Fill in safe defaults for every signal the app may not have yet.
function normalize(input) {
  const i = input || {};
  const ev = i.ev || {};
  return {
    defcon: Number.isFinite(i.defcon) ? i.defcon : 3,
    socPct: i.socPct == null ? null : Number(i.socPct),
    priceLevel: Number.isFinite(i.priceLevel) ? i.priceLevel : 3,
    priceOre: i.priceOre == null ? null : Number(i.priceOre),
    consumptionW: Number.isFinite(i.consumptionW) ? i.consumptionW : 0,
    localHour: Number.isFinite(i.localHour) ? i.localHour : 0,
    ev: {
      connected: ev.connected === true,
      mustCharge: ev.mustCharge !== false, // default true
      targetSocPct: Number.isFinite(ev.targetSocPct) ? ev.targetSocPct : 80,
      batterySocPct: ev.batterySocPct == null ? null : Number(ev.batterySocPct),
      deadlineHour: Number.isFinite(ev.deadlineHour) ? ev.deadlineHour : 7,
      expensiveConfirmNeeded: ev.expensiveConfirmNeeded === true,
      expensiveConfirmed: ev.expensiveConfirmed === true,
    },
    mainFuseA: Number.isFinite(i.mainFuseA) ? i.mainFuseA : 25,
    phases: Number.isFinite(i.phases) ? i.phases : 3,
    volts: Number.isFinite(i.volts) ? i.volts : 230,
  };
}

function decideThermalNibe(band) {
  // Always keep frost protection on regardless of band.
  return {
    kind: 'thermal',
    vv: band.vv,
    offset: band.offset,
    frost: true,
  };
}

function decideThermalSpa(band) {
  const d = { kind: 'thermal', temp: band.temp, heat: band.heat === true };
  if (band.frostGuard === true) {
    d.frostGuard = true; // circulation pump stays ON, heat off — never stop the pump
  }
  return d;
}

function decideEv(s, matrix) {
  const entry = matrix.ev;
  const battery = matrix.battery;
  const flags = [];

  // a. raw matrix intent
  let amp = entry.bands[s.defcon].amp;

  // EV's own SoC (the car's battery) decides "below target".
  const carSoc = s.ev.batterySocPct;
  const belowTarget = carSoc == null || carSoc < s.ev.targetSocPct;
  const chargingIntended = s.ev.connected && s.ev.mustCharge && belowTarget;

  // b. (b)-OVERRIDE "car always drivable": guarantee a min trickle even when
  // DEFCON would cut it. D1 is excluded (critical-peak safety stop).
  if (chargingIntended && s.defcon !== 1) {
    const floor = OVERRIDE_FLOOR_A[s.defcon];
    if (floor != null) {
      // Lift to at least the deliverable charger minimum (see EV_MIN_AMP note).
      const target = Math.max(floor, EV_MIN_AMP);
      if (amp < target) {
        amp = target;
        flags.push('override-floor');
      }
    }
  }

  // c. PRICE control-question. Only relevant if we actually intend to charge.
  let expensiveConfirmNeeded = false;
  if (chargingIntended && amp > 0) {
    const expensive = s.priceLevel <= 2
      || (s.priceOre != null && s.priceOre > entry.gateOre);
    if (expensive && !s.ev.expensiveConfirmed) {
      expensiveConfirmNeeded = true;
      amp = 0;
      flags.push('await-price-confirm');
    }
  }

  // d. LOAD BALANCE — hard ceiling over everything, including the override.
  // availableEvAmp = remaining headroom on the main fuse given known consumption.
  const denom = s.volts * s.phases;
  const availableEvAmp = Math.floor(s.mainFuseA - s.consumptionW / denom);
  if (amp > availableEvAmp) {
    amp = availableEvAmp;
    flags.push('load-balance');
  }
  if (amp < 6) {
    amp = 0;
    if (!flags.includes('load-balance')) flags.push('load-balance');
  }

  // e. BATTERY SAFETY VETO — house battery critically low cuts EV.
  if (s.socPct != null && s.socPct < battery.soc_safety) {
    amp = 0;
    flags.push('battery-safety-veto');
  }

  return {
    kind: 'ev',
    amp: Math.max(0, amp),
    chargingIntended,
    expensiveConfirmNeeded,
    availableEvAmp,
    flags,
  };
}

function decideBattery(s, matrix) {
  const e = matrix.battery;
  const band = e.bands[s.defcon];
  const soc = s.socPct;
  const flags = [];

  if (band.mode === 'charge') {
    // Charge only if SoC unknown or below ceiling.
    if (soc != null && soc >= e.soc_ceil) {
      flags.push('soc-ceil');
      return { kind: 'battery', mode: 'idle', power_w: 0, flags };
    }
    let power;
    if (band.charge_mode === 'headroom') {
      // Headroom mode = charge with available grid surplus. We don't have a
      // surplus signal yet, so approximate as rated power. DOCUMENTED limitation.
      power = e.rated_charge_w;
    } else {
      power = band.power_w;
    }
    power = clamp(power, 0, e.rated_charge_w); // cap at rated
    return {
      kind: 'battery',
      mode: 'charge',
      power_w: power,
      charge_mode: band.charge_mode,
      flags,
    };
  }

  // discharge band
  if (soc != null && soc <= e.soc_safety) {
    flags.push('soc-safety');
    return { kind: 'battery', mode: 'idle', power_w: 0, flags };
  }
  if (soc != null && soc <= e.soc_reserve) {
    flags.push('soc-reserve'); // stop supporting the house, protect reserve
    return { kind: 'battery', mode: 'idle', power_w: 0, flags };
  }
  // power 0 in band => auto/max
  const power = band.power_w === 0 ? e.rated_charge_w : band.power_w;
  return { kind: 'battery', mode: 'discharge', power_w: power, flags };
}

function decideAppliances(s, matrix) {
  const e = matrix.appliances;
  let action = e.bands[s.defcon].action;
  const flags = [];
  // If a high-power measurement is present and exceeds the threshold at D2/D1,
  // force pause regardless of band. Never touches heating elements.
  if ((s.defcon === 2 || s.defcon === 1)
    && Number.isFinite(s.appliancePowerW)
    && s.appliancePowerW > e.highPowerW) {
    action = 'pause';
    flags.push('high-power-pause');
  }
  return { kind: 'appliance', action, flags };
}

function decideComfort(s, matrix) {
  // Always 'allow', even at D1.
  return { kind: 'comfort', action: matrix.comfort.bands[s.defcon].action, flags: [] };
}

/**
 * Resolve a decision for every device given the current state.
 * @param {object} input  partial state (missing signals default sensibly)
 * @param {object} matrix data-driven setpoint matrix (default DEFAULT_MATRIX)
 * @returns {object} keyed by device name with the resolved decision + flags
 */
function decideDevices(input, matrix = DEFAULT_MATRIX) {
  const s = normalize(input);
  return {
    defcon: s.defcon,
    nibe: decideThermalNibe(matrix.nibe.bands[s.defcon]),
    spa: decideThermalSpa(matrix.spa.bands[s.defcon]),
    ev: decideEv(s, matrix),
    battery: decideBattery(s, matrix),
    appliances: decideAppliances(s, matrix),
    comfort: decideComfort(s, matrix),
  };
}

/** Self-test of the device-decision invariants. */
function selfTest() {
  const fails = [];
  const chk = (cond, msg) => { if (!cond) fails.push(msg); };

  // --- D1 invariants ---
  const d1 = decideDevices({ defcon: 1, ev: { connected: true, mustCharge: true } });
  chk(d1.nibe.frost === true && d1.nibe.vv >= 40, `D1 nibe frost/vv: ${JSON.stringify(d1.nibe)}`);
  chk(d1.spa.frostGuard === true && d1.spa.heat === false, `D1 spa frostGuard/heat: ${JSON.stringify(d1.spa)}`);
  chk(d1.ev.amp === 0, `D1 ev amp should be 0, got ${d1.ev.amp}`);
  chk(d1.battery.mode === 'discharge' || d1.battery.mode === 'idle', `D1 battery mode: ${d1.battery.mode}`);
  chk(d1.battery.mode === 'discharge', `D1 battery should discharge (socPct null), got ${d1.battery.mode}`);
  chk(d1.comfort.action === 'allow', `D1 comfort should be allow, got ${d1.comfort.action}`);

  // --- D5 invariants ---
  const d5 = decideDevices({ defcon: 5 });
  chk(d5.battery.mode === 'charge' && d5.battery.power_w === 7680, `D5 battery charge 7680: ${JSON.stringify(d5.battery)}`);
  chk(d5.appliances.action === 'run', `D5 appliances run, got ${d5.appliances.action}`);
  chk(d5.comfort.action === 'allow', `D5 comfort allow, got ${d5.comfort.action}`);

  // --- Load balance: high consumption forces EV amp down to fuse headroom ---
  // 25A fuse, 3x230 = 15870 W per amp-step base. consumption ~ 17A worth.
  const lbHigh = decideDevices({
    defcon: 5, consumptionW: 17 * 230 * 3, ev: { connected: true, mustCharge: true },
  });
  // headroom = 25 - 17 = 8A, band wants 32 => clamped to 8
  chk(lbHigh.ev.amp === 8, `load-balance clamp to 8A, got ${lbHigh.ev.amp}`);
  chk(lbHigh.ev.flags.includes('load-balance'), 'load-balance flag missing on clamp');

  // headroom < 6A => amp 0
  const lbZero = decideDevices({
    defcon: 5, consumptionW: 20 * 230 * 3, ev: { connected: true, mustCharge: true },
  });
  chk(lbZero.ev.amp === 0, `load-balance headroom<6 => 0, got ${lbZero.ev.amp}`);

  // --- (b)-override: D2 with mustCharge & connected & headroom => amp>=6 ---
  // No consumption => plenty headroom; band D2 amp=10, override floor=6 (no effect
  // since 10>6), so verify >=6 and not exceeding headroom.
  const ovr = decideDevices({
    defcon: 2, consumptionW: 0,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
    priceLevel: 5,
  });
  chk(ovr.ev.amp >= 6, `(b)-override D2 amp>=6, got ${ovr.ev.amp}`);
  // override actually lifts a cut band: simulate by retuning would be data; instead
  // confirm override floor lifts D3 below-floor case. Use a matrix clone w/ D3 amp 1.
  const m2 = JSON.parse(JSON.stringify(DEFAULT_MATRIX));
  m2.ev.bands[3].amp = 1;
  const ovrLift = decideDevices({
    defcon: 3, consumptionW: 0,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
    priceLevel: 5,
  }, m2);
  chk(ovrLift.ev.amp >= OVERRIDE_FLOOR_A[3] && ovrLift.ev.flags.includes('override-floor'),
    `(b)-override D3 lift to floor, got ${ovrLift.ev.amp}`);

  // override must never exceed load-balance headroom
  const ovrCap = decideDevices({
    defcon: 2, consumptionW: 22 * 230 * 3,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
    priceLevel: 5,
  });
  // headroom 3A < 6 => 0
  chk(ovrCap.ev.amp === 0, `(b)-override capped by load-balance, got ${ovrCap.ev.amp}`);

  // --- Price control-question ---
  const priceQ = decideDevices({
    defcon: 5, consumptionW: 0, priceLevel: 2,
    ev: { connected: true, mustCharge: true },
  });
  chk(priceQ.ev.expensiveConfirmNeeded === true && priceQ.ev.amp === 0,
    `price unconfirmed => need confirm & amp 0, got ${JSON.stringify(priceQ.ev)}`);
  const priceOK = decideDevices({
    defcon: 5, consumptionW: 0, priceLevel: 2,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
  });
  chk(priceOK.ev.amp > 0 && priceOK.ev.expensiveConfirmNeeded === false,
    `price confirmed => amp>0, got ${JSON.stringify(priceOK.ev)}`);

  // --- SoC gates ---
  // socPct < 5 => battery idle & ev amp 0
  const socCrit = decideDevices({
    defcon: 3, socPct: 4, consumptionW: 0,
    ev: { connected: true, mustCharge: true, expensiveConfirmed: true },
  });
  chk(socCrit.battery.mode === 'idle', `socPct<5 battery idle, got ${socCrit.battery.mode}`);
  chk(socCrit.ev.amp === 0, `socPct<5 ev amp 0, got ${socCrit.ev.amp}`);

  // 5..15 => battery idle on discharge bands (D3 is discharge)
  const socLow = decideDevices({ defcon: 3, socPct: 12 });
  chk(socLow.battery.mode === 'idle', `socPct 12 discharge band => idle, got ${socLow.battery.mode}`);

  // socPct >= 97 => no charge on charge bands (D5 is charge)
  const socFull = decideDevices({ defcon: 5, socPct: 98 });
  chk(socFull.battery.mode === 'idle', `socPct>=97 charge band => idle, got ${socFull.battery.mode}`);

  return { pass: fails.length === 0, fails };
}

module.exports = { DEFAULT_MATRIX, OVERRIDE_FLOOR_A, decideDevices, selfTest };
