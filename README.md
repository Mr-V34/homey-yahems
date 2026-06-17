# YAHEMS — DEFCON Energy Controller

A local-first Home Energy Management app for Homey Pro. YAHEMS computes a single
whole-home **DEFCON** status (5 = calm/surplus → 1 = critical peak) from the net
power at the grid connection, measured against an adjustable **power target
(anchor)**, and guides the home's loads accordingly — heat pump, hot tub, EV
charger, appliances and home battery.

It is hardware-agnostic: devices you own are used for real, the rest is estimated,
and nothing is actively controlled until YAHEMS can see your real house
consumption. The result is a lower bill with high WAF — it just works in the
background.

Brand: V34 (https://www.v34.com) · App id: `com.v34.yahems` · SDK 3 · local

## How it works in one minute

1. Read the **net grid power** (positive = importing, solar already included).
2. Smooth it with a rolling average so a kettle can't trip a false peak.
3. Compare it to the **anchor**; the bands are fixed thirds of that value.
4. That gives a **DEFCON level**, 5 → 1.
5. The **device matrix** turns the level into a concrete decision per device,
   then layers safety, price and load-balance rules on top.

Full walkthrough with tables and worked examples: **[docs/DEFCON.md](docs/DEFCON.md)**.

## Documentation

| Doc | What's inside |
|-----|---------------|
| [docs/DEFCON.md](docs/DEFCON.md) | The decision ladder, band thresholds, the device matrix, and the safety / price / load-balance rules. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map (pure logic vs Homey layer), data flow, the actuation gate, testing. |
| [docs/SIMULATION.md](docs/SIMULATION.md) | The sim-feeder dry-run and the `sim_mode` kill-switch contract. |
| [docs/SETUP.md](docs/SETUP.md) | Install, pairing, device mapping, settings and flow cards. |

## Design principles

- **Local-first** — no cloud dependency.
- **Safety first** — frost protection and comfort loads are never sacrificed;
  the app stays *advisory* (read-only) until a real house meter is present.
- **Hardware abstraction (placeholders)** — any meter/device can feed YAHEMS;
  missing hardware is estimated. See [docs/SETUP.md](docs/SETUP.md).
- **High WAF** — works seamlessly in the background.

## Run locally

```
npm install
npm test              # run the pure-logic self-tests
homey app run         # live-reload on a paired Homey Pro
homey app validate --level publish   # gate before publishing
```

## Project layout

```
lib/engine.js      net power → DEFCON level (pure, tested)
lib/matrix.js      DEFCON + state → per-device decisions (pure, tested)
lib/simfeeder.js   synthetic 24-hour dry-run data (pure, tested)
lib/simgate.js     sim_mode kill-switch (pure, tested)
drivers/controller the YAHEMS Controller device + flow cards
test/selftest.js   auto-discovers and runs every lib/*.js selfTest()
```

## Roadmap

Direct device reads via homey-api ✓, a friendly App Settings device-map builder ✓
(with a no-meter advisory estimate so it runs without a P1/energy dongle), and a
responsive **7.5-minute** measurement driving DEFCON ✓. Next: selectable billing type
(15 min / hour / fixed), optional DEFCON hysteresis, price-aware battery (charge cheap
/ sell expensive), and wiring the actuation gate so the matrix actually drives devices.
See **[docs/ROADMAP.md](docs/ROADMAP.md)** for the full plan. Final app icon and store
imagery still to be designed to App Store spec.

Author: Peter Persson · Co-author: B.Frank
