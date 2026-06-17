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

### The 15-minute average (`yahems_avg15`)

Separately, YAHEMS tracks the figure a Swedish **effekttariff** actually bills: the
average power over the last **15 minutes**, computed the same way the grid does — as
**three consecutive 5-minute sub-averages**, then the mean of those. It is built
from timestamped samples (not a fixed buffer), so it stays correct whatever the
recompute cadence is, and each 5-minute sub-window is reported on its own.

```js
samples = engine.pushSample(samples, watts, Date.now()); // prunes > 15 min old
const windows = engine.windowAverages(samples, Date.now()); // [recent, mid, oldest]
const avg15 = engine.fifteenMinAverage(windows);            // mean of the available sub-averages
```

`yahems_avg15` has its **own YAHEMS insight** (graph), and both the value and its
3×5-minute breakdown appear on the overview/status page. It is informational — the
DEFCON ladder itself still judges the responsive short average above, so a sustained
peak shows up immediately rather than 15 minutes late.

### Status indicators on the controller

The controller device shows DEFCON two ways: `yahems_defcon` (the number 1–5, with an
insight) and `yahems_defcon_label`, a colour-cued label —
🟢 D5 · Calm, 🟢 D4 · Comfortable, 🟡 D3 · Caution, 🟠 D2 · High, 🔴 D1 · Critical.
(Homey does not expose custom tile colours per value, so the colour is carried by the
label's emoji, which renders consistently across the app and mobile card.)

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
| **5** | `net ≤ 5 W` (export / near zero) | Surplus — use and store everything |
| **4** | `net ≤ anchor / 3` | Comfortable |
| **3** | `net ≤ 2 × anchor / 3` | Watchful |
| **2** | `net ≤ anchor` | Backing off |
| **1** | `net > anchor` | Critical peak — shed load |

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
until it can see real whole-house consumption. Until the **house meter** setting
is enabled, the controller reports `mode = advisory` (read-only). See
[SETUP.md](SETUP.md) and [SIMULATION.md](SIMULATION.md) for how this gate and the
sim-mode kill-switch keep the system safe before the real house exists.
