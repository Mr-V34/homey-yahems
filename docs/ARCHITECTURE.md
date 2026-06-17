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
| [`lib/signals.js`](../lib/signals.js) | ✅ | Canonical signal catalogue (labels, kinds, capability hints). Single source of truth shared by `hal.js` and the settings page; a parity self-test keeps `SIGNAL_MAP` in sync. |
| [`lib/hal.js`](../lib/hal.js) | ✅ | Hardware abstraction layer. Validates the JSON device map; resolves mapped Homey device capability values into the canonical signal object that `decideDevices()` consumes. |
| [`lib/matrix.js`](../lib/matrix.js) | ✅ | DEFCON + house state → one decision per device. Setpoints are data in `DEFAULT_MATRIX`; safety / price / load-balance rules layered on top. |
| [`lib/simfeeder.js`](../lib/simfeeder.js) | ✅ | Synthetic 24-hour dry-run data (solar/load/price/SOC) fed through engine + matrix. See [SIMULATION.md](SIMULATION.md). |
| [`lib/simgate.js`](../lib/simgate.js) | ✅ | `sim_mode` kill-switch. Hard-blocks real actuation during dry-run. |
| [`drivers/controller/device.js`](../drivers/controller/device.js) | ❌ | The Homey layer: reads settings, fetches the HomeyAPI snapshot, feeds signals through HAL, runs the engine on a timer, sets capabilities, fires flow triggers. **Compute only — actuates nothing yet.** |
| [`drivers/controller/driver.js`](../drivers/controller/driver.js) | ❌ | Registers flow action/condition cards, pairs the controller device. |
| [`settings/index.html`](../settings/index.html) | ❌ | App Settings page — the device-map builder (device + capability dropdowns, estimate switch). Writes the map to app settings. |
| [`api.js`](../api.js) | ❌ | Read-only Web API behind the settings page: `getDevices`, `getSignals`. |
| [`app.js`](../app.js) | ❌ | App entry point; hosts the settings-page data helpers (`apiGetDevices`, `apiGetSignals`). |

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

2. **Net-power source precedence.** `device.js` picks the first available of:
   `grid_power_w` (signed CT, clamp ≥ 0) → `home_consumption_w` → the **Report grid
   power** flow action → an **advisory estimate** (`simfeeder.estimateConsumptionW`,
   when nothing real is mapped and the estimate switch is on). The chosen source is
   published to the `yahems_source` capability (`grid_ct`/`measured`/`flow`/
   `estimated`). A fake zero is never reported as surplus. Fault detection
   (staleness/implausibility) is suppressed for the `estimated` source, which is
   intentionally steady. The device map is read from **app-level settings** and
   re-loaded live when the settings page saves.

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

The `op_mode` app setting (settings page: Simulation / Advisory / Full operation) is
the single **control gate**, read via `device.js _opMode()`:
- `simulation` / `advisory` → `mode = 'advisory'` — computes, never actuates.
- `full` → `mode = 'control'` — (future) allows `_applyDecisions()` to actuate.

The resulting mode is also readable via the `yahems_mode` device capability. There is
no per-device meter checkbox; selecting Full operation is the gate.

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
