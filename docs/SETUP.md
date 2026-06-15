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

---

## Device map JSON format

The **Device map** setting holds a JSON string that tells YAHEMS which Homey device
and capability backs each canonical signal. The shape is:

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
  ],
  "control": {
    "house_meter_present": false
  }
}
```

### Canonical signal keys

| Signal key | Matrix field | Notes |
|------------|-------------|-------|
| `home_consumption_w` | `consumptionW` | Net whole-house draw from your grid meter (W) |
| `battery_soc_pct` | `socPct` | House battery state-of-charge 0–100 |
| `price_level` | `priceLevel` | Tibber price level 1 (expensive) – 5 (cheap) |
| `price_ore` | `priceOre` | Spot price in öre/kWh |
| `ev_connected` | `ev.connected` | Boolean — car plugged in |
| `ev_battery_soc_pct` | `ev.batterySocPct` | Car battery SoC 0–100 |
| `appliance_power_w` | `appliancePowerW` | Current draw of high-power appliance (W) |

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

## Settings

| Setting | Default | Purpose |
|---------|--------:|---------|
| **Power target (anchor)** | 4500 W | Net import at/above which the house is at a full peak. The DEFCON bands are thirds of this value — see [DEFCON.md](DEFCON.md). |
| **Safety floor** | 1000 W | The power target can never effectively drop below this. |
| **Real house meter connected** | off | The **Control gate**. While off, YAHEMS stays in *advisory* (read-only). Turn on only once `home_consumption_w` (or the flow action) is reliably delivering live house consumption. |
| **Device map (JSON)** | `{"inputs":[],"control":{"house_meter_present":false}}` | Maps your Homey device IDs and capabilities to the YAHEMS canonical signals above. |

### Advisory → Control gate

| `house_meter_present` setting | Mode | Behaviour |
|-------------------------------|------|-----------|
| `false` (default) | **advisory** | Computes decisions and logs them. No writes to any downstream device. |
| `true` | **control** | (Future) Allows `_applyDecisions()` to actuate mapped devices. |

The setting checkbox takes priority over `control.house_meter_present` in the JSON
map. Keep the checkbox off until your `home_consumption_w` signal (or the flow
action) is producing reliable real-time data.

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
