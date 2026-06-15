# Architecture & modules

YAHEMS is deliberately split into **pure logic** (plain JavaScript, no Homey
imports, fully unit-tested) and a **thin Homey layer** (the driver/device that
wires the logic to flow cards, capabilities and settings). This keeps the
decision engine portable, testable, and safe to reason about.

```
 signals ──▶ engine (DEFCON) ──▶ matrix (per-device decision) ──▶ [actuation gate] ──▶ devices
              │                    │                                 │
         lib/engine.js        lib/matrix.js                    drivers/controller/device.js
                                                               (COMPUTE ONLY today)
```

## Module map

| File | Pure? | Responsibility |
|------|:-----:|----------------|
| [`lib/engine.js`](../lib/engine.js) | ✅ | Net power → DEFCON level. Rolling average, effective anchor, band thresholds. |
| [`lib/matrix.js`](../lib/matrix.js) | ✅ | DEFCON + house state → one decision per device. Setpoints are data in `DEFAULT_MATRIX`; safety / price / load-balance rules layered on top. |
| [`lib/simfeeder.js`](../lib/simfeeder.js) | ✅ | Synthetic 24-hour dry-run data (solar/load/price/SOC) fed through engine + matrix. See [SIMULATION.md](SIMULATION.md). |
| [`lib/simgate.js`](../lib/simgate.js) | ✅ | `sim_mode` kill-switch. Hard-blocks real actuation during dry-run. |
| [`drivers/controller/device.js`](../drivers/controller/device.js) | ❌ | The Homey layer: reads settings, runs the engine on a timer, sets capabilities, fires flow triggers. **Compute only — actuates nothing yet.** |
| [`drivers/controller/driver.js`](../drivers/controller/driver.js) | ❌ | Registers flow action/condition cards, pairs the controller device. |
| [`app.js`](../app.js) | ❌ | App entry point. |

The two `lib/*` decision modules import nothing from `homey`, which is why they
can be exercised directly by [`test/selftest.js`](../test/selftest.js).

## Data flow

1. A grid-power reading arrives — today via the **Report grid power** flow action
   (`device.onReportGrid`). In a future version it will come from a paired meter.
2. `device.recompute()` runs every 60 s (and on each new reading): it pushes the
   sample through `engine.rollingAverage`, computes the effective anchor and the
   DEFCON level, and writes the `measure_power`, `yahems_mode` and `yahems_defcon`
   capabilities.
3. It then calls `matrix.decideDevices()` to resolve per-device intent. The grid
   average currently stands in for whole-house consumption; SOC/price/EV signals
   default inside the matrix until those sources are wired.
4. On a DEFCON change it fires the **DEFCON changed** trigger (and **Critical peak
   started** at D1).

## The actuation gate

Today `device.js` is **compute only**: it decides, logs and exposes the result,
but it does not write to any downstream device. This is intentional — nothing is
controlled until YAHEMS can see real house consumption (the *house meter* gate)
**and** the actuation path is wrapped by the sim-mode kill-switch.

When actuation is wired, every capability write to a physical device **must** be
wrapped in `simgate.guardActuation(...)`, and the `sim_mode` device setting must
be threaded into the gate via `onSettings()`. The contract is documented inline at
the top of `device.js` and covered in [SIMULATION.md](SIMULATION.md). Until then,
no `sim_mode` UI setting is added (it would introduce locale keys with no backing
setting definition).

## Testing

All pure modules expose a `selfTest()` that returns `{ pass, fails }`.
`test/selftest.js` auto-discovers every `lib/*.js` with a `selfTest` export and
runs it:

```
npm test
```

A green run is the contract for "the logic still behaves." See the per-module test
suites in `engine.js`, `matrix.js`, `simfeeder.js` and `simgate.js` for the exact
invariants each one guarantees.
