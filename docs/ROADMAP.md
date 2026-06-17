# YAHEMS roadmap

This roadmap captures the path from today's **advisory, compute-only** controller to
an **active home-orchestration** system. It folds in the findings of the June 2026
technical analysis of the sampling method, DEFCON logic and quarter-hour-tariff
optimisation.

Guiding principle, unchanged: YAHEMS is built to **hold down whole-house consumption**
and protect the main fuse / shave power peaks — not merely to chase the cheapest öre.
We polish the advisory math first, then open actuation deliberately.

---

## Done

### ✅ 7.5-minute measurement (replaces the 3×5 / 15-min average)
DEFCON now judges a plain **rolling 7.5-minute average** of net house power — half the
grid's quarter-hour billing window. This is a deliberate move from a "cautious",
smoothed 15-minute model to a **responsive, awake** one: it reacts to a building load
roughly twice as fast while still averaging out 60-second instantaneous spikes.

- `lib/engine.js`: `windowAverage()` + `MEASURE_WINDOW_MS` (7.5 min); the old
  `windowAverages()`/`fifteenMinAverage()` 3×5 model is removed.
- Capability `yahems_avg15` → `yahems_avg` (own insight + status read-out); the retired
  capability and its stale insight series are removed from already-paired devices on init.
- Docs: `docs/DEFCON.md`, `docs/SETUP.md`.

---

## Planned

### 1. Selectable billing type (15 min / hour / fixed)
Today the measurement window is fixed. Add a setting so the averaging window follows
the user's actual grid contract:

- **15 min** — match a quarter-hour effekttariff exactly (judge on the full 15-min mean).
- **Hour** — match an hourly peak tariff.
- **Fixed** — no power tariff; judge on a short responsive window only.

The 7.5-min window stays the default "responsive" choice. Implementation: a `tariff`
app setting feeding `MEASURE_WINDOW_MS` (or an explicit window) into the recompute,
with the engine staying pure and cadence-agnostic.

### 2. Hysteresis / deadband on the DEFCON ladder
There is **deliberately no deadband today** — the 7.5-min window is the only smoothing,
so we collect honest data on how the house actually behaves. If a load proves to
start/stop too often, add a band-edge deadband (target ~10 %) in `engine.defconFromNet`
so the level only changes once net power clears a band edge by the margin. Opt-in /
tunable; off by default until field data justifies it.

### 3. Battery: charge cheap, sell expensive (price-aware in calm modes)
The matrix already charges in D5/D4 and discharges in D3/D2/D1, but it has **no
spot-price axis when the house is calm**. Add a decision axis that weighs the
`lib/elpris.js` price (and/or a mapped price device) even in **D5**, so the battery
can discharge/sell into an expensive window and recharge in a cheap one — independent
of the peak-shaving ladder. The battery stays excluded from the generic
"Storförbrukare" price-hold (it keeps its own SoC + price logic).

### 4. Actuation engine — from compute-only to control
`_applyDecisions()` is intentionally empty ("compute-only"); the `_write()` chokepoint,
selftest guard and sim-mode kill-switch are all in place. Selecting **Full operation**
already opens the gate. Remaining work: write the computed decisions to real devices
(heat pump curve/hot-water offset, EV charge current, white-goods pause, battery
charge/discharge), each behind the existing gate and per-device mapping. Heat-pump
control is model-specific — the user picks the device → capability → value to steer.

### 5. Higher-resolution decision logging
DEFCON changes are logged to the Homey log today. For real-time tuning, add an opt-in
higher-resolution log (a dedicated insight series and/or an external push) so level
transitions and the inputs behind them can be analysed after the fact.

---

Author: Peter Persson · Co-author: B.Frank
