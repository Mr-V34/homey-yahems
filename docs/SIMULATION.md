# Simulation, dry-run & the sim-mode kill-switch

YAHEMS is designed to be fully exercised **before any real hardware exists**. A
synthetic-data feeder runs a whole day through the decision engine, and a
fail-safe kill-switch guarantees that simulation can never reach a physical
device. Two modules cooperate:

- [`lib/simfeeder.js`](../lib/simfeeder.js) — generates a 24-hour profile and runs
  it through engine + matrix.
- [`lib/simgate.js`](../lib/simgate.js) — the `sim_mode` kill-switch.

---

## The kill-switch contract (`simgate`)

`sim_mode` is **OFF by default** and must be explicitly enabled for a dry-run.
The contract is deliberately strict and fail-safe:

| Behaviour | Guarantee |
|-----------|-----------|
| Default state | OFF — uninitialised/unknown is treated as OFF (safe). |
| `setMode(flag)` | Only **strict `=== true`** enables it. `null`, `0`, `''`, `'true'` (string) all stay OFF. |
| `guardActuation(fn)` | When sim is **ON**, throws `SimBlockedError` and **never calls `fn`**. When OFF, calls `fn()` and returns its result. |
| Production rule | `sim_mode` **must** be OFF in live operation. |

Every real capability write (once actuation is wired) is required to go through
the gate:

```js
const simgate = require('../../lib/simgate');
// real device write — blocked hard while a simulation is running:
simgate.guardActuation(() => zaptec.setChargeAmp(amp));
```

This is why a stray simulation call from live code cannot move a physical device:
the write would throw before it reached the hardware.

---

## Running a dry-run

`generateProfile()` is pure data and safe to call any time. `runDay()` is the one
that drives the engine, and it **refuses to run unless `sim_mode` is ON** — so it
can never execute by accident in production:

```js
const { runDay } = require('./lib/simfeeder');
const simgate = require('./lib/simgate');

simgate.enable();                       // dry-run only
const rows = runDay({
  month: 7,                             // 1–12
  outdoor_temp: 22,                     // °C
  battery_soc_start: 40,                // %
  cloud_pct: 20,                        // 0–100
});
simgate.disable();                      // always restore OFF
```

`runDay()` returns 24 rows, one per hour. Each row carries the generated profile
plus the resolved DEFCON level and the per-device decisions:

```js
{
  hour: 13, solar_w: 9870, load_w: 650, grid_net_w: -9220,
  battery_soc_pct: 78, price_ore: 50, price_level: 4,
  defcon: 5,
  decisions: { nibe: {...}, spa: {...}, ev: {...}, battery: {...}, ... }
}
```

## What the synthetic day contains

The feeder models a realistic Swedish day for the target site:

| Signal | Model |
|--------|-------|
| **Solar** | 15.5 kWp array, 58°N latitude factor, sunrise/sunset per month, cloud cover knob. Zero at night, peaks at midday. |
| **House load** | 350 W base + heat-pump load that scales with how cold it is, plus dishwasher (10–12) and washer (14–16) windows. |
| **Price** | Swedish SE3/SE4-style öre/kWh curves (separate winter and summer shapes), mapped to `priceLevel` 5 (cheap) → 1 (expensive). |
| **Battery SOC** | Simple 1-hour physics: solar surplus charges, deficit discharges, clamped 0–100 %. |

All inputs are overridable through `cfg` (including `cloud`, `dishwasher` and
`washer` functions), so you can script specific scenarios — a clear solar day, a
cold-snap winter peak, an EV plugged in at an expensive hour, and so on.

## Verifying it

The feeder and the kill-switch both ship with self-tests that the standard runner
executes:

```
npm test
```

The suite asserts, among other things, that the profile has 24 valid rows, that
solar is zero at night and high at noon, that the frost-protection invariants
hold across the whole day, that `runDay()` **throws when `sim_mode` is OFF**, and
that `simgate` is left OFF after the tests complete.

---

> **Production reminder:** `sim_mode` is a dry-run tool only. It must be OFF in
> live operation, and the kill-switch exists precisely so that a forgotten sim
> session cannot actuate real devices. See the actuation gate in
> [ARCHITECTURE.md](ARCHITECTURE.md).
