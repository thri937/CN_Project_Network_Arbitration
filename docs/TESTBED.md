# Testbed Specification and Experimental Results — CN Real Network Arbitration

This document specifies the physical Wi-Fi environment, scaling formulas, SLA targets, calibration benchmarks, test case execution procedures (TC1–TC9), and empirical A/B experimental results.

---

## 1. Physical Testbed Environment

The testbed uses a Windows 11 laptop acting as a mobile network edge gateway:

1. **Primary Deployment — Windows Mobile Hotspot:**
   - Laptop connects to ISP uplink via home Wi-Fi or Ethernet.
   - Laptop enables **Windows Mobile Hotspot** (`Settings → Network & internet → Mobile hotspot`).
   - Shared interface typically assigns the gateway IP `192.168.137.1` with a DHCP range for up to 8 client devices.
   - Client devices (smartphones, tablets, secondary laptops) connect to this SSID.
2. **Alternative Deployment — Shared Local Subnet (LAN):**
   - If the laptop Wi-Fi NIC does not support Wi-Fi Hosted Networks, both laptop and client devices join the same local Wi-Fi router.
   - The testbed binds dynamically to the laptop's assigned LAN IPv4 address (e.g. `192.168.1.X`).
3. **Single-Laptop Loopback Mode:**
   - Runs all 7 slice clients locally via 7 browser tabs or automated CLI agents (`npm run demo:local`).
   - Traffic traverses the local IP stack (`127.0.0.1`), where it is shaped and measured identically by the gateway token bucket pipeline.

---

## 2. Bandwidth Scaling and Offered Capacity

SOURCE was calibrated for a 10 Gbps core network link. The testbed scales all bandwidth figures down to a **1 Mbps physical bottleneck** to allow visible queueing delay, tail drop, and contention dynamics over standard Wi-Fi:

$$\text{Scale Factor } s = \frac{\text{NETWORK\_TOTAL\_CAPACITY\_MBPS}}{10,000} = \frac{1,000\text{ kbps}}{10,000\text{ Mbps}} = 0.1$$

- **Total Link Capacity:** $1,000\text{ kbps}$ (1 Mbps).
- **Reserved Capacity:** $50\text{ kbps}$, never offered to slices. Management traffic (portal HTML/JS, WebSocket updates, API calls) is not shaped at all and is counted separately, like out-of-band OAM.
- **Offered Slice Capacity:** $950\text{ kbps}$.
- **Sum of Baseline Allocations:** $1,480\text{ kbps}$ ($156\%$ oversubscription of offered capacity).
- **Sum of Guaranteed Floors:** $473\text{ kbps}$ ($50\%$ of offered capacity).
- **Contention Trigger:** total **demand** above $969\text{ kbps}$ ($1.02 \times 950\text{ kbps}$) for 2 samples (4 s); it closes after 3 clear samples.
- **How much is cut:** the engine sizes the cut on **carried** traffic, $\sum \min(\text{demand}_i, \text{limit}_i)$, so demand a slice's own limit already holds back isn't counted. The target is the link minus a $3\%$ headroom: $\approx 921.5\text{ kbps}$.

---

## 3. Department and Slice Re-Baselined SLA Targets

At 1 Mbps over shared 802.11 Wi-Fi, transmission delay and medium access contention prevent meeting 10 Gbps sub-10 ms latency targets. Bandwidth scales with $s = 0.1$, while latency, jitter, and loss are calibrated to realistic Wi-Fi bounds:

$$\text{Latency Target} = 100\text{ ms} + 10 \times \text{SOURCE Latency}$$
$$\text{Jitter Target} = 20\text{ ms} + 5 \times \text{SOURCE Jitter}$$
$$\text{Loss Target} = \operatorname{clamp}(10 \times \text{SOURCE Loss}, 0.1\%, 10\%)$$

| Slice | Department | Baseline | Floor | Max Burst | Max Latency | Max Jitter | Max Loss | Min Tput | Availability |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Patient Telemetry** | Clinic | 60 kbps | 40 kbps | 90 kbps | **150 ms** | 25 ms | **0.1%** | 40 kbps | 99.999% |
| **Factory Automation**| Factory | 380 kbps | 170 kbps | 580 kbps | **180 ms** | 30 ms | **0.1%** | 150 kbps | 99.99% |
| **Lab Instrumentation**| Quality lab| 180 kbps | 50 kbps | 260 kbps | **500 ms** | 70 ms | **3.0%** | 45 kbps | 99.9% |
| **Warehouse Operations**| Warehouse | 160 kbps | 55 kbps | 250 kbps | **250 ms** | 40 ms | **0.5%** | 45 kbps | 99.95% |
| **CCTV** | Security | 240 kbps | 60 kbps | 360 kbps | **900 ms** | 145 ms | **8.0%** | 50 kbps | 99.0% |
| **Office Wi-Fi** | Office IT | 320 kbps | 70 kbps | 500 kbps | **600 ms** | 95 ms | **5.0%** | 60 kbps | 99.5% |
| **Canteen Signage** | Canteen | 140 kbps | 28 kbps | 200 kbps | **350 ms** | 60 ms | **10.0%** | 8 kbps | 98.0% |

---

## 4. Calibration (`npm run calibrate`)

Join one device to each slice, leave them idle (no load), then run `npm run calibrate`. For 30 s it
reads each slice's probe round-trip times from the gateway and compares the idle p95 with 60 % of
the slice's latency target. A slice with no device shows "no measurement" rather than 0.

Fill this in from your hotspot session (phones on Wi-Fi):

| Slice | Device | Idle p50 (ms) | Idle p95 (ms) | Target (ms) | Within 60 % of target? |
|---|---|---:|---:|---:|---|
| patient-telemetry | | | | 150 | |
| factory-automation | | | | 180 | |
| lab-instrumentation | | | | 500 | |
| warehouse-operations | | | | 250 | |
| cctv | | | | 900 | |
| office-wi-fi | | | | 600 | |
| canteen-signage | | | | 350 | |

If an idle p95 is above 60 % of its target, Wi-Fi alone uses most of that slice's latency budget.
Note it here rather than changing the targets.

---

## 5. Test cases (TC1–TC9)

| ID | Name | Load | Expected outcome | Checked by `demo:local` |
|---|---|---|---|---|
| **TC1** | Normal day | All 7 at 55 % of baseline (≈814 kbps) | Demand ratio ≈ 0.86: no contention, no decision | No contention; every slice carries its demand (±10 %); loss < 1 % |
| **TC2** | Canteen flood | Canteen 280 kbps (200 %), others 55 % | Demand ratio ≈ 1.07, so contention may open. But the Canteen's own 140 kbps limit holds it, and carried traffic (≈877 kbps) fits the link, so **nothing is cut** | Canteen ≤ 147 kbps; no limit changed; others carry their demand |
| **TC3** | Lunch-hour rush | Canteen 200 %, Office and CCTV 100 %, Warehouse 80 %, rest 55 % (≈1,309 kbps, ratio ≈ 1.38) | Contention opens in ~4 s. The engine cuts the cheapest slices (Canteen to its 28 kbps floor, then Office, CCTV, Warehouse). Clinic, Factory and Lab are untouched | Contention opened; limits enforced; Clinic not cut; no floor or ceiling crossed; cut slices run at their new limits (±10 %); Clinic, Factory and Lab p95 within SLA |
| **TC4** | Everyone at peak | All 7 at 100 % (1,480 kbps, ratio ≈ 1.56) | Even maximum cuts can't fit the link: verdict **PARTIAL**, escalated to the operator | PARTIAL decision; Clinic not cut; no floor or ceiling crossed |
| **TC5** | Recovery | Back to 55 % | Contention closes after 3 clear samples. Each cut slice is restored when its recovery window ends (2 min low, 10 min moderate, 30 min high tolerance). Override restores at once | Contention closed; recovery scheduled; Override returns every slice to baseline |
| **TC6** | A/B proof | TC3 load, automatic arbitration OFF, then ON | OFF: the shared queue overflows and every slice gets delay and loss, Clinic included. ON: the protected slices recover; the cut slices take the loss | 25 s warm-up + 40 s measured per phase. Protected slices: lower p95 and no more loss with ON, and within SLA |
| **TC7** | Device leaves | Turn off a phone's Wi-Fi | Device offline after 15 s; that slice's demand drops; availability falls; health UNKNOWN if no device is left | Manual (hotspot) |
| **TC8** | Gateway down | Stop the gateway for 20 s | Controller marks telemetry UNKNOWN and does not arbitrate on it; recovers by itself | Manual |
| **TC9** | Phone proxy | Phone uses proxy `:8888` | **Cannot pass yet**: the proxy forwards traffic without shaping it (LIMITATIONS §2.3) | Not built |

---

## 6. Results

### 6.1 `demo:local`: one laptop, loopback (no Wi-Fi), 20 October 2026

All 6 automated test cases passed. The data and every check are in
`paper/results/fifo-demo-local.csv` and `paper/results/fifo-demo-local-summary.md`.

TC6 used the lunch-hour-rush load: 25 s warm-up, then 40 s measured per phase (20 two-second
windows), arbitration off then on. The table gives means over the measured windows.

| Slice | Latency p95 off | Latency p95 on | Loss off | Loss on | Carried on | Limit on |
|---|---:|---:|---:|---:|---:|---:|
| Patient Telemetry (Clinic) | 503 ms | **23 ms** | 5.62 % | **0 %** | 34 kbps | 60 kbps (never cut) |
| Factory Automation | 509 ms | **22 ms** | 21.47 % | **0 %** | 210 kbps | 380 kbps (not cut) |
| Lab Instrumentation | 505 ms | **22 ms** | 14.99 % | **0 %** | 100 kbps | 180 kbps (not cut) |
| Warehouse Operations | 507 ms | 475 ms | 18.29 % | 5.23 % | 122 kbps | 122 kbps (−24 %) |
| CCTV | 626 ms | 479 ms | 17.53 % | 14.88 % | 205 kbps | 204 kbps (−15 %) |
| Office Wi-Fi | 573 ms | 476 ms | 19.81 % | 31.19 % | 221 kbps | 221 kbps (−31 %) |
| Canteen Signage | 949 ms | 415 ms | 65.15 % | 90.03 % | 28 kbps | 28 kbps (−80 %, floor) |

**What it shows:**
- **Arbitration off.** All slices share one overflowing queue: every slice waits about half a
  second, and even the Clinic loses 5.6 % of its traffic.
- **Arbitration on.** The engine cuts the four cheapest slices, so carried traffic fits the link
  again. Clinic, Factory and Lab drop to about 22 ms with no loss.
- **The cut slices take the loss.** The Canteen asks for ten times its 28 kbps floor, so 90 % of
  its traffic is dropped.
- **Scope.** This is loopback, so it measures the gateway and the control loop, not Wi-Fi.

### 6.2 Hotspot run (to do with real phones)

Join the seven departments from phones, then run TC3 with automatic arbitration off for a minute
and on for a minute (see RUNBOOK Act 5). Download the CSV from the dashboard's **Recording** box
and run:

```bash
npm run experiment:summary -- experiments/<file>-session.csv
```

Put the table here.
