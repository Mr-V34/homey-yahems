# Architecture & modules

YAHEMS is deliberately split into **pure logic** (plain JavaScript, no Homey
imports, fully unit-tested) and a **thin Homey layer** (the driver/device that
wires the logic to flow cards, capabilities and settings). This keeps the
decision engine portable, testable, and safe to reason about.

```
 devices ──▶ HomeyAPI snapshot ──▶ hal.resolveSignals ──┐
                                                         ▼
 flow action ──▶ gridW fallback ──────────────────▶ engine (DEFCON) ──▶ matrix (per-device decision) ──▶ [actuation gate] ──▶ devices
                                                                           │                                 │
                                                                      lib/matrix.js                   drivers/controller/device.js
                                                                                                      (COMPUTE ONLY today)
```

## Module map

| File | Pure? | Responsibility |
|------|:-----:|----------------|
| [`lib/engine.js`](../lib/engine.js) | ✅ | Net power → DEFCON level. Rolling average, effective anchor, band thresholds. |
| [`lib/hal.js`](../lib/hal.js) | ✅ | Hardware abstraction layer. Validates the JSON device map; resolves mapped Homey device capability values into the canonical signal object that `decideDevices()` consumes. |
| [`lib/matrix.js`](../lib/matrix.js) | ✅ | DEFCON + house state → one decision per device. Setpoints are data in `DEFAULT_MATRIX`; safety / price / load-balance rules layered on top. |
| [`lib/simfeeder.js`](../lib/simfeeder.js) | ✅ | Synthetic 24-hour dry-run data (solar/load/price/SOC) fed through engine + matrix. See [SIMULATION.md](SIMULATION.md). |
| [`lib/simgate.js`](../lib/simgate.js) | ✅ | `sim_mode` kill-switch. Hard-blocks real actuation during dry-run. |
| [`drivers/controller/device.js`](../drivers/controller/device.js) | ❌ | The Homey layer: reads settings, fetches the HomeyAPI snapshot, feeds signals through HAL, runs the engine on a timer, sets capabilities, fires flow triggers. **Compute only — actuates nothing yet.** |
| [`drivers/controller/driver.js`](../drivers/controller/driver.js) | ❌ | Registers flow action/condition cards, pairs the controller device. |
| [`app.js`](../app.js) | ❌ | App entry point. |

The `lib/*` modules import nothing from `homey`, which is why they can be
exercised directly by [`test/selftest.js`](../test/selftest.js).

## Data flow

1. **Settings map → HomeyAPI snapshot → HAL signals.**
   On every `recompute()` cycle, `device.js` calls `this._api.devices.getDevices()`
   to get the current capability values for all devices, builds a snapshot object
   `{ [deviceId]: { [capabilityId]: value } }`, and passes it with the validated
   `_deviceMap` into `hal.resolveSignals()`. The result is a partial signal object
   (`consumptionW`, `socPct`, `priceLevel`, `priceOre`, `ev.*`, `appliancePowerW`)
   ready to spread into `decideDevices()`.

2. **Consumption source precedence.**
   If `home_consumption_w` is mapped in the device map and the HomeyAPI returns a
   value for it, that value is used as `consumptionW` (after clamping to ≥ 0). If
   the signal is absent or unmapped, `device.js` falls back to the last value
   reported via the **Report grid power** flow action.

3. **Rolling average.** Either consumption value is pushed through
   `engine.rollingAverage` (3-sample window, 5-minute cadence) to smooth
   transient spikes before `engine.defconFromNet` computes the DEFCON level.

4. **`matrix.decideDevices()`.** The spread HAL signals plus `defcon`,
   `consumptionW` (averaged), and `localHour` are passed in together. Missing
   signals fall back to safe defaults inside `matrix.normalize()`. Nothing is
   injected as zero to fake a known reading.

5. On a DEFCON change the **DEFCON changed** trigger fires (and **Critical peak
   started** at D1).

## The actuation gate

Today `device.js` is **compute only**: it decides, logs and exposes the result,
but it does not write to any downstream device. The single gated chokepoint is the
private `_applyDecisions(decisions, mode)` method. It currently returns
immediately. Future writes must live here, gated on `mode === 'control'` and
wrapped in `simgate.guardActuation()`.

The `house_meter_present` device setting is the **control gate**:
- `false` (default) → `mode = 'advisory'` — computes, never actuates.
- `true` → `mode = 'control'` — (future) allows `_applyDecisions()` to actuate.

The advisory/control mode is also readable via the `yahems_mode` device capability
and from `map.control.house_meter_present` (the settings checkbox takes priority).

## Testing

All pure modules expose a `selfTest()` that returns `{ pass, fails }`.
`test/selftest.js` auto-discovers every `lib/*.js` with a `selfTest` export and
runs it:

```
npm test
```

A green run is the contract for "the logic still behaves." See the per-module test
suites in `engine.js`, `hal.js`, `matrix.js`, `simfeeder.js` and `simgate.js` for
the exact invariants each one guarantees.
