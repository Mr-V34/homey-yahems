# The DEFCON decision ladder

DEFCON is the single number that drives everything in YAHEMS: **5 = calm /
surplus**, **1 = critical peak**. This page walks the full decision in the order
the app actually runs it, from a raw meter reading to a concrete instruction for
every device.

The pure logic lives in [`lib/engine.js`](../lib/engine.js) (the DEFCON number)
and [`lib/matrix.js`](../lib/matrix.js) (per-device decisions). Neither file
touches Homey — they are plain functions you can read and test in isolation.

---

## Step 1 — Read the net grid power

The only input the engine needs is the **net power at the grid connection**, in
watts, where **positive = importing from the grid** and **negative = exporting**.
Solar is already baked into this figure: if your panels cover the house and feed
the grid, the net number is negative.

## Step 2 — Smooth it (rolling average)

A single reading is noisy — a kettle switching on should not flip the whole house
to a critical peak. Each new sample is pushed into a small rolling buffer and the
**average of the last 3 samples** is what the ladder actually judges. This short
average is published as the controller's `measure_power` ("Now").

```js
const r = engine.rollingAverage(buffer, sample, 3); // { buffer, average }
```

### The 7.5-minute average (`yahems_avg`)

Separately, YAHEMS tracks a **7.5-minute rolling average** of net house power —
half the grid's quarter-hour (15-min) billing window. This keeps the system *awake*:
it tracks a building load quickly and reacts roughly twice as fast as a full 15-min
window would, while still smoothing the 60-second instantaneous spikes that would
otherwise make the level flap. It is built from timestamped samples (not a fixed
buffer), so it stays correct whatever the recompute cadence is.

```js
samples = engine.pushSample(samples, watts, Date.now()); // prunes > 7.5 min old
const avg = engine.windowAverage(samples, Date.now());   // rolling 7.5-min mean (or null while cold)
```

`yahems_avg` has its **own YAHEMS insight** (graph) and the value appears on the
overview/status page. **The DEFCON ladder judges this 7.5-min average** — responsive
but not jittery. The short `measure_power` average is the live "Now" reading shown
alongside it. (Before the window has data, the 7.5-min average already equals the
first sample, so there is no warm-up gap.)

> **Hysteresis:** there is deliberately **no deadband** on the level today — the
> 7.5-min window is the only smoothing. If a load proves to start/stop too often in
> practice, a band-edge deadband (e.g. ~10 %) is a planned follow-up (see the
> roadmap).

### Status indicators on the controller

The controller's single on-screen DEFCON tile is `yahems_defcon_label`, a colour-cued
label using the **official DEFCON colours** —
🔵 D5 · Producing, 🟢 D4 · Low, 🟡 D3 · Medium, 🔴 D2 · High, ⚪ D1 · Critical.
(Homey does not expose custom tile colours per value, so the colour is carried by the
label's emoji, which renders consistently across the app and mobile card.)

The numeric `yahems_defcon` (1–5) is kept too — but hidden from the device tiles
(`uiComponent: null`) so there is only one indicator — purely to feed its **insight
graph** (an enum label cannot be graphed). Both update every cycle.

## Step 3 — The anchor

The **anchor** (called *power target* in the UI) is the import level that counts
as a full-blown peak. The anchor is the single source of truth — it is used
directly. There is no separate floor or night-tariff multiplier; those were second
sources of truth and have been removed.

## Step 4 — Map net power to a DEFCON level

The bands are fixed **thirds of the anchor**. A boundary value always belongs to
the *calmer* level. Export or near-zero net is always DEFCON 5.

| Level | Condition (averaged net import) | Meaning |
|------:|---------------------------------|---------|
| **5** | `net ≤ 5 W` (export / near zero) | Producing — own surplus; burn energy (charge EV, heat spa) |
| **4** | `net ≤ anchor / 3` | Low — green light for scheduled heavy loads |
| **3** | `net ≤ 2 × anchor / 3` | Medium — normal; devices run without restriction |
| **2** | `net ≤ anchor` | High — throttle or pause flexible loads |
| **1** | `net > anchor` | Critical — shed everything but essential operation |

Worked example with the default anchor of **4500 W** (bands at 1500 / 3000 / 4500):

| Averaged net | DEFCON |
|-------------:|:------:|
| −800 W (exporting) | 5 |
| 1 200 W | 4 |
| 2 900 W | 3 |
| 4 400 W | 2 |
| 5 000 W | 1 |

---

## Step 5 — Turn the level into per-device decisions

`matrix.decideDevices()` takes the DEFCON level plus whatever house state is known
(battery SOC, price, EV status, current consumption) and resolves one decision per
device. Setpoints are **data** in `DEFAULT_MATRIX`, so they are easy to retune
without touching logic. Missing signals fall back to safe defaults.

### Device matrix at a glance

| Device | D5 | D4 | D3 | D2 | D1 |
|--------|----|----|----|----|----|
| **Nibe heat pump** | vv 53, +1 | vv 50, 0 | vv 50, 0 | vv 45, −2 | vv 40, −5 *(frost floor)* |
| **Spa (Balboa)** | 38 °C heat | 38 °C heat | 36 °C heat | 36 °C heat | pump on, **heat off** |
| **EV (Zaptec)** | 32 A | 32 A | 16 A | 10 A | 0 A |
| **Battery (Dyness TP7)** | charge 100 % | charge 50 % | discharge | discharge | discharge |
| **Dishwasher** | run | run | run | run | pause |
| **Washing machine** | run | run | run | pause | pause |
| **Tumble dryer** | run | run | pause | pause | pause |
| **Comfort loads** | allow | allow | allow | allow | allow |

White goods are three independent devices (dryer pauses earliest), each with its own
high-power threshold. These are the built-in defaults — every cell is editable on the
App Settings page. The status colours follow the official DEFCON scale: **5 blue, 4
green, 3 yellow, 2 red, 1 white.**

Two invariants hold in **every** band, including D1:
- **Frost protection never turns off.** The heat pump's `vv` stays ≥ 40 °C and its
  frost flag is always on; the spa's circulation pump keeps running even when its
  electric heat is cut.
- **Comfort loads (microwave, coffee) are always allowed.** YAHEMS never makes the
  house feel broken to save a few öre — high WAF by design.

---

## Step 6 — Layer the safety / price / balance rules

On top of the raw matrix lookup, a few rules can override the band — applied in
this order for the EV, which is the most contended load:

1. **Matrix intent** — the amperage for the current band.
2. **"Car always drivable" floor** — if the car is connected, wants charge and is
   below its target SOC, a minimum trickle is guaranteed at D3/D2 (lifted to the
   6 A charger minimum). **D1 is deliberately excluded** — a critical peak is a
   hard stop at 0 A.
3. **Price control-question** — if charging would happen at an expensive hour
   (`priceLevel ≤ 2` or `priceOre` over the gate) and the user hasn't confirmed,
   the EV is held at 0 A and a confirmation is requested rather than silently
   spending money.
4. **Load balance** — a hard ceiling. The EV is clamped to the headroom left on
   the main fuse given known consumption; anything below 6 A becomes 0 A. This
   overrides even the "always drivable" floor — physics wins.
5. **Battery safety veto** — if the house battery is critically low
   (`SOC < 5 %`), the EV is cut to protect the home supply.

### Battery SOC gates

The battery has three SOC guard rails, checked against the band's intent:

| Guard | Value | Effect |
|-------|------:|--------|
| Ceiling | 97 % | On a charge band, stop charging (idle) |
| Reserve | 15 % | On a discharge band, stop supporting the house (protect reserve) |
| Safety | 5 % | Idle, and veto EV charging |

### "Storförbrukare" (big-load) price hold

Any controlled device the user ticks as a **big load** follows the price slider.
When a live electricity price is mapped and exceeds the slider threshold
(`matrix.ev.gateOre`), that device is evaluated at its **critical (D1) band** —
its most conservative, frost-safe setpoint — regardless of the house DEFCON:
the heat pump drops to its hot-water/frost floor, the spa's electric heat goes off
(circulation pump stays on), white goods pause, and the EV holds (its existing
confirm flow). A **boost always wins** — issuing a boost means "I'll pay to run it
now." The home battery is never a big load; it keeps its own SoC/price logic.

### Appliance high-power pause

At D2/D1, if a high-power appliance measurement is present and exceeds the
threshold (1500 W), it is paused regardless of band — but heating elements are
never touched.

---

## Advisory vs Control

YAHEMS computes the full ladder at all times, but it will not actuate anything
unless the **operating mode** (`op_mode`) on the App Settings page is set to **Full
operation**. In Simulation and Advisory the controller reports `mode = advisory`
(read-only); Full reports `mode = control`. Selecting Full is the single gate —
there is no separate per-device meter checkbox. See [SETUP.md](SETUP.md) and
[SIMULATION.md](SIMULATION.md) for how this gate and the sim-mode kill-switch keep
the system safe before any actuation is wired.
