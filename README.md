# YAHEMS — DEFCON Energy Controller

A local-first Home Energy Management app for Homey Pro. YAHEMS computes a single
whole-home **DEFCON** status (5 = calm/surplus → 1 = critical peak) from the net
power at the grid connection, measured against an adjustable **power target
(anchor)**, and guides the home's loads accordingly.

Brand: V34 (https://www.v34.com) · App id: `com.v34.yahems` · SDK 3 · local

## Status
`0.1.0` — initial scaffold. Foundation only:
- `lib/engine.js` — pure net-power DEFCON engine (+ self-test).
- `drivers/controller` — the YAHEMS Controller device. Capabilities:
  `yahems_defcon`, `yahems_mode`, `measure_power`.
- Flow cards: trigger *DEFCON changed* (tokens: defcon, mode) and *Critical peak
  started*; condition *DEFCON is X or lower*; actions *Report grid power*,
  *Set power target*, *Run all now*.
- Settings: power target, safety floor, **house-meter Control gate** (stays in
  Advisory / read-only until a real house meter is present — safety first).

## Design principles
- **Local-first**, no cloud dependency.
- **Hardware-abstraction (placeholders):** any meter/device can feed YAHEMS;
  missing hardware is estimated; nothing is actuated without a real house meter.
- **High WAF** — works seamlessly in the background.

## Run locally
```
npm install
homey app run        # live-reload on a paired Homey Pro
homey app validate    # check before publishing
```

## Roadmap
Port the full device matrix (heat pump / hot tub / EV / appliances / battery),
direct device reads via homey-api, price + solar-forecast prediction, settings UI
for the placeholder map. App images (PNG) and final icon still to be designed to
App Store spec.

Author: Peter Persson · Co-author: B.Frank
