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
| `yahems_source` | Where the power reading comes from: `measured`, `grid_ct`, `flow`, `homey_energy`, or `estimated`. |
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

---

## Mapping devices — the App Settings page

Open **Settings → Apps → YAHEMS → Configure** (the app-level settings page). For each
canonical signal you get a dropdown of *your* Homey devices and a second dropdown of
that device's capabilities — no JSON, no UUIDs. Map what you own, leave the rest
unmapped, and press **Save**. The page writes the validated map into the app's
settings and the controller picks it up immediately (no restart).

The **operating mode** at the top decides whether simulated devices are offered and
whether YAHEMS may actuate; in Advisory/Full it reads Homey Energy's total when no
dedicated meter is mapped (see [Running without a meter](#running-without-a-meter)).

### JSON format (reference / advanced)

Under the hood the page stores the same JSON contract `lib/hal.js` validates. You
rarely need to see it, but the shape is:

```json
{
  "inputs": [
    {
      "signal":     "home_consumption_w",
      "deviceId":   "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "capability": "measure_power"
    },
    {
      "signal":     "battery_soc_pct",
      "deviceId":   "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
      "capability": "measure_battery"
    },
    {
      "signal":     "ev_connected",
      "deviceId":   "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
      "capability": "charging_cable_connected"
    }
  ]
}
```

> Advisory vs control is governed solely by the **operating mode** (`op_mode`) on the
> App Settings page — not by the device map. (A `control` block may still appear in a
> stored map for backward compatibility; it is ignored.)

### Canonical signal keys

| Signal key | Matrix field | Notes |
|------------|-------------|-------|
| `grid_power_w` | `gridPowerW` | **Net grid power, signed** (+ import / − export) from a hybrid-inverter CT or Shelly EM. Preferred grid source — no P1 dongle needed. |
| `home_consumption_w` | `consumptionW` | Net whole-house draw from your grid meter (W) |
| `battery_soc_pct` | `socPct` | House battery state-of-charge 0–100 |
| `price_ore` | `priceOre` | Spot price in öre/kWh (map a Tibber/spot-price device). The **price-sensitivity slider** sets the öre/kWh threshold this is compared against. |
| `ev_connected` | `ev.connected` | Boolean — car plugged in |
| `ev_battery_soc_pct` | `ev.batterySocPct` | Car battery SoC 0–100 |
| `solar_production_w` | `solarProductionW` | PV production (W) |
| `dishwasher_power_w` | `dishwasherPowerW` | Dishwasher draw (W) — per-appliance high-power threshold |
| `washer_power_w` | `washerPowerW` | Washing-machine draw (W) |
| `dryer_power_w` | `dryerPowerW` | Tumble-dryer draw (W) |

### Optional `activeAbove`

Add `"activeAbove": <number>` to any entry to convert a numeric power reading into
a boolean "device is active":

```json
{
  "signal":      "ev_connected",
  "deviceId":    "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
  "capability":  "measure_power",
  "activeAbove": 15
}
```

Here the EV charger's `measure_power` value is treated as `ev_connected = true`
whenever the draw exceeds 15 W.

### Device IDs

Find a device's UUID in Homey's developer tools at `http://<homey-ip>/api/manager/devices/device/`
or through the Homey smartphone app (device page → gear icon → ID).

### What happens when a signal is missing

If a device or capability is absent from the snapshot, that signal is **omitted**
entirely — YAHEMS never substitutes zero. The matrix normaliser then applies its
safe default (see `lib/matrix.js` → `normalize()`). This means partial maps are
safe: add signals gradually as you wire up hardware.

---

## The App Settings page (v2)

The **Configure** page is organised top-down so a non-technical user can set it up:

1. **Operating mode** (`op_mode`) — the single top-level switch:
   - **Simulation** — try YAHEMS with devices you don't own (pick *Simulate* on a
     device); never controls anything; uses a synthetic feed.
   - **Advisory** (default) — your installed devices; reads **Homey Energy's** whole-home
     total as house consumption (ideal without a P1/energy dongle); never actuates.
   - **Full operation** — uses your best available house reading (a real meter/dongle,
     or Homey Energy in an apartment) and *may* control installed devices. Available in
     any home. (Actual device control is the next build; for now it reads and computes.)
2. **Limits** — your **Power limit (max)** in watts (net import at/above this is DEFCON
   1; bands are thirds of it) and your **main fuse (A) + phases** (caps EV charging
   current — a 25 A fuse forbids selecting 32 A).
3. **Inputs (sensors)** — all optional. Grid power and house consumption list only
   whole-home meters (leave empty in an apartment); electricity price (öre/kWh).
4. **Price sensitivity slider** — sets the öre/kWh threshold above which any device
   ticked as a **big load** (*Storförbrukare*) is held back (needs a mapped price device).
5. **Your devices** — grouped by the taxonomy (Climate, Energy, EV, Appliances,
   Cooking). Each device row lets you pick *your* device (the dropdown is filtered to
   the relevant type — a charger row lists only chargers), or **Not installed**, or
   **Simulate** (only in Simulation mode). A **Big load** checkbox (on heat pump, spa,
   EV, white goods) opts the device into the price slider. Picking a device reveals
   capability sub-pickers for that device's functions.
6. **Your own consumers** — add custom loads (pausable or monitor-only).
7. **How YAHEMS controls each level** — an **editable** table (D5→D1) of setpoints per
   device, with a live read-out of how the power limit splits across the DEFCON bands.
   You change the defaults (e.g. spa off on D3–D1); contradictory schedules are
   auto-rejected, keeping the last safe values. "Not installed" devices are hidden here.

## Per-device settings

YAHEMS adds **no device-level settings** of its own — everything (operating mode,
power limit, fuse, device map, level setpoints, price gate) lives on the App Settings
page above. The only entries under the device's *Properties* are Homey's built-ins
(e.g. *Exclude from Energy*).

### Advisory → Control gate

The **operating mode** (`op_mode`) on the App Settings page is the single switch —
there is no separate per-device meter checkbox.

| `op_mode` | `yahems_mode` | Behaviour |
|-----------|---------------|-----------|
| `simulation` | **advisory** | Synthetic feed; computes and logs; never actuates. |
| `advisory` (default) | **advisory** | Real installed devices + Homey Energy total; computes and logs; never actuates. |
| `full` | **control** | (Future) Allows `_applyDecisions()` to actuate mapped devices. Selecting Full **is** the gate — available in any home. |

## Running without a meter

YAHEMS is designed to run on a Homey with **no P1/HAN reader or energy dongle**. The
net-power reading is taken from the first available of, in order:

1. **`grid_power_w`** — a signed grid CT (hybrid inverter / Shelly EM).
2. **`home_consumption_w`** — a mapped whole-house meter.
3. The **Report grid power** flow action.
4. The **no-meter fallback**, derived from the operating mode (`op_mode`):
   - **Advisory / Full → Homey Energy total** (`homey_energy`) — Homey Energy already
     sums every added device's `measure_power` into a whole-home live total. That
     aggregate is real data, so on an apartment with no dedicated meter it is an
     honest stand-in for house consumption (net = consumed − generated, ≥ 0). Read
     via `energy.getLiveReport()`; parsed by `lib/simfeeder.js`
     `houseNetFromLiveReport`. The controller subtracts its own `measure_power` from
     the total so it never counts itself.
   - **Simulation → built-in estimate** (`estimate`) — a season-aware base + heat-pump
     load model (`lib/simfeeder.js` `estimateConsumptionW`).

The active source is shown live in the `yahems_source` capability. While the source
is `homey_energy` or `estimated`, the figure is guidance only — YAHEMS **never
actuates** in these states (it stays advisory until a *dedicated* meter satisfies the
house-meter gate), and staleness/implausibility faults are suppressed because these
sources are advisory by design.

## Flow cards

**Triggers**
- **DEFCON changed** — fires on any level change. Tokens: `defcon` (number),
  `mode` (string).
- **Critical peak started** — fires when DEFCON reaches 1.

**Condition**
- **DEFCON is [level] or lower** — gate other flows on the current level.

**Actions**
- **Report grid power [W]** — feed a meter reading (positive = importing). This is
  the fallback input when no `home_consumption_w` device is mapped.
- **Set power target [W]** — adjust the anchor from a flow.
- **Run all now** — temporarily allow all loads to run.

---

## Safety model in one line

YAHEMS computes continuously but acts conservatively: it stays **advisory** until a
real house meter is present, frost protection and comfort loads are never sacrificed
(see [DEFCON.md](DEFCON.md)), and during development the
[sim-mode kill-switch](SIMULATION.md) hard-blocks any actuation.
