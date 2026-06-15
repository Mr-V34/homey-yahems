# Setup, pairing & device mapping

YAHEMS runs locally on **Homey Pro** (SDK 3, `platforms: ["local"]`). This page
covers installing it, pairing the controller, the hardware-agnostic device-mapping
model, and the settings and flow cards you use day to day.

---

## Install

```
npm install
homey app run         # live-reload on a paired Homey Pro
homey app validate --level publish   # gate before publishing
```

`homey app run` sideloads the app onto your Homey for development. For a permanent
install, build and install with the Homey CLI, or install from the App Store once
published.

## Pair the controller

Add a new device and pick **YAHEMS Controller**. There is a single controller
device — it holds the whole-home DEFCON status and exposes the settings and flow
cards below. After pairing you will see three capabilities:

| Capability | Meaning |
|------------|---------|
| `yahems_defcon` | The current DEFCON level (1–5), shown as a sensor. |
| `yahems_mode` | `advisory` (read-only) or `control` (acting on the house). |
| `measure_power` | The smoothed net grid power the level is computed from. |

---

## Hardware-agnostic device mapping (placeholders)

YAHEMS does not require any specific brand. It works against **canonical signals**
(net grid power, battery SOC, EV state, price, per-device power) and you map your
own hardware onto them:

- **Devices you own are used for real.** Map your meter, battery, EV charger, heat
  pump, etc. onto the matching signals.
- **Missing hardware is estimated**, so the decision ladder still produces a
  sensible result with partial information.
- **A single device can back more than one signal** — e.g. one unit can both
  *measure* (its power) and be *controlled* (its setpoint).
- **Nothing is actuated until YAHEMS can see real whole-house consumption** (the
  house-meter gate below). Until then it is purely advisory.

> The settings UI for the full placeholder map is on the roadmap. Today the grid
> reading is supplied via the **Report grid power** flow action (see below) and the
> per-device decisions are computed from it.

---

## Settings

| Setting | Default | Purpose |
|---------|--------:|---------|
| **Power target (anchor)** | 4500 W | Net import at/above which the house is at a full peak. The DEFCON bands are thirds of this value — see [DEFCON.md](DEFCON.md). |
| **Safety floor** | 1000 W | The power target can never effectively drop below this. |
| **Real house meter connected** | off | The **Control gate**. While off, YAHEMS stays in *advisory* (read-only). Turn on only once YAHEMS can see real house consumption. |

## Flow cards

**Triggers**
- **DEFCON changed** — fires on any level change. Tokens: `defcon` (number),
  `mode` (string).
- **Critical peak started** — fires when DEFCON reaches 1.

**Condition**
- **DEFCON is [level] or lower** — gate other flows on the current level.

**Actions**
- **Report grid power [W]** — feed a meter reading (positive = importing). This is
  how the controller currently gets its net-power input.
- **Set power target [W]** — adjust the anchor from a flow.
- **Run all now** — temporarily allow all loads to run.

---

## Safety model in one line

YAHEMS computes continuously but acts conservatively: it stays **advisory** until a
real house meter is present, frost protection and comfort loads are never sacrificed
(see [DEFCON.md](DEFCON.md)), and during development the
[sim-mode kill-switch](SIMULATION.md) hard-blocks any actuation.
