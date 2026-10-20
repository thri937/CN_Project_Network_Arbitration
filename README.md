# Real-Network Slice Arbitration Testbed

**Who should slow down when the network is full?** This project answers that question on a
**real network** built from one laptop and the phones connected to it.

A company network is split into **slices**, one per department. When everyone wants more
bandwidth than the link can carry, something has to give. A normal network decides using the
**QoS label** someone attached years ago. This project decides using **business value**: what an
outage costs per minute, compliance (life-safety, regulated), how critical the department is, and
how long it can tolerate being slowed. It enforces that decision on live traffic and explains
every decision in plain English.

It is the real-network version of the simulated project in `D:\CN project\CN project\CN`. **The
business rules and the arbitration engine are copied unchanged.** Only the network is new: the
simulator is replaced by a real traffic gateway.

---

## The picture

```
                     Home Wi-Fi / ISP
                            │
   ┌────────────────────────┴───────────────────────────────────────────┐
   │ MAIN LAPTOP  (Windows Mobile Hotspot, usually 192.168.137.1)        │
   │                                                                     │
   │   CONTROLLER :4000  ── reads stats / sets limits ──►  SLICE GATEWAY │
   │   the "brain": detects        127.0.0.1:9090          the "network":│
   │   contention, decides                                 per-slice     │
   │   who is cut, audits                                  limits + one  │
   │                                                       1 Mbps link   │
   │   DASHBOARD :5173 (operator)                          :8080 portal  │
   └──────────────────────────────────────────────────────────┬──────────┘
                                         real hotspot Wi-Fi    │
     Clinic   Factory   Quality lab   Warehouse   Security   Office IT   Canteen
     phone    phone     laptop        phone       phone      laptop      phone
      └── each device opens the portal, joins its department's slice, and creates real load
```

- **Gateway** (`apps/gateway`): carries the traffic. Each slice gets its own speed limit, and all
  slices share one **1 Mbps** link (950 kbps offered, 50 kbps reserved). It measures throughput,
  delay, loss and availability every 2 s.
- **Controller** (`apps/controller`): reads those measurements. When demand exceeds the link, it
  decides how much traffic must be shed and from whom, then sets new limits on the gateway.
- **Portal** (`apps/portal`): the website on each department's phone. You pick how much traffic
  to send and watch your slice live.
- **Dashboard** (`apps/dashboard`): the operator's view, with topology, QR join codes, every
  decision with its reasons, the arbitration on/off switch and an experiment recorder.

---

## The 7 departments and slices

Bandwidth is the simulated project's value divided by 10,000 (10 Gbps becomes 1 Mbps). Every
business rule is the same.

| Department | Slice | QoS label | Cost of outage | Max cut | Baseline | Floor | Join code |
|---|---|---|---:|---:|---:|---:|---|
| Clinic | Patient Telemetry | URLLC | £25,000/min | **0 %** (life-safety) | 60 kbps | 40 kbps | `CLN101` |
| Factory | Factory Automation | URLLC | £8,400/min | 15 % | 380 kbps | 170 kbps | `FAC201` |
| Quality lab | Lab Instrumentation | eMBB | £1,600/min | 20 % (regulated) | 180 kbps | 50 kbps | `LAB401` |
| Warehouse | Warehouse Operations | URLLC | £2,100/min | 35 % | 160 kbps | 55 kbps | `WHS301` |
| Security | CCTV | eMBB | £700/min | 40 % | 240 kbps | 60 kbps | `SEC601` |
| Office IT | Office Wi-Fi | eMBB | £900/min | 45 % | 320 kbps | 70 kbps | `OFF501` |
| Canteen | Canteen Signage | **URLLC** | **£15/min** | 80 % | 140 kbps | 28 kbps | `CAN701` |
| | **Total** | | | | **1,480 kbps** | 473 kbps | |

The baselines add up to **156 %** of the link on purpose, so at busy times there isn't enough for
everyone. Look at the Canteen: its label says top priority (URLLC), but an outage costs £15 a
minute. The Quality lab's label is ordinary (eMBB), but it is regulated. A label-based network
would protect the canteen screens over the lab; this one does the opposite.

---

## How one decision happens

1. **Measure.** Every 2 s the gateway reports each slice's demand, throughput, latency (p95 of
   probe round trips), jitter and loss.
2. **Detect.** Contention opens when total demand is above 102 % of the 950 kbps link for two
   samples in a row (4 s).
3. **Decide.** The shortage is the traffic actually carried, the smaller of each slice's demand
   and limit, minus 97 % of the link. The CBHA engine (Convex Business-Harm Arbitration) takes that
   shortage in small steps from whichever slice loses the **least business value per kbps**. Small
   cuts to several cheap slices beat one deep cut. Nothing goes below a contractual floor or past
   a compliance ceiling, and the Clinic is never cut.
4. **Apply.** The decision is saved, the gateway enforces the new limits on the next 20 ms tick,
   and the controller checks what was enforced.
5. **Explain.** The decision page and the cut department's phone show why, with the real numbers.
6. **Recover.** When demand falls, contention closes after 3 normal samples. Each cut slice is
   restored when its recovery window ends: 2 min for low tolerance, 10 min for moderate, 30 min
   for high. An admin can restore everything at once with **Override**.

The full algorithm is in [`docs/source/ALGORITHM.md`](docs/source/ALGORITHM.md).

---

## Quick start

**Needs:** Windows 11 laptop, Node.js 22 or newer, and phones or laptops for the departments
(any number from 0 to 7).

```bash
npm install
```

```bash
npm run setup
```

```bash
npm run build
```

```bash
npm run seed
```

- `npm run setup` creates `.env` and a private gateway token.
- `npm run build` is needed because phones load the **built** portal.
- `npm run seed` creates the 7 departments, the 7 slices and the demo users.

1. **Open the firewall** for the hotspot. Run PowerShell **as administrator**, once:
   `scripts\windows\open-firewall.ps1` (and `close-firewall.ps1` to undo).
2. **Turn on Mobile hotspot** (Settings → Network & internet → Mobile hotspot) and connect the
   phones to it. Windows allows up to 8 devices.
3. **Start everything:**
   ```bash
   npm run dev
   ```
4. **Get the join address and QR code:**
   ```bash
   npm run lan:info
   ```
5. **On each phone**, open `http://192.168.137.1:8080/join` (or your laptop's address from step 4),
   or scan the QR code on the dashboard's **Testbed** page. Enter that department's join code.
6. **On the laptop**, open the dashboard at <http://localhost:5173>. Sign in with the **Admin** or
   **Manager** button (local sign-in, no passwords) and open **Testbed**.

No phones? Open several browser tabs on the laptop, each joined with a different code. Each tab
is its own device. Or run the automated demo below.

---

## Things to try

Use the demand buttons on each phone, or the scenario buttons on the dashboard:

| Test | What to do | What should happen |
|---|---|---|
| **TC1 Normal day** | Everyone at **Normal** (55 %) | About 814 kbps on a 950 kbps link: no contention, all green |
| **TC2 Canteen flood** | Canteen at **Flood** (200 %) | The Canteen's own 140 kbps limit holds it; nobody else is affected and nothing is cut |
| **TC3 Lunch-hour rush** | Canteen Flood, Office and CCTV **Peak**, Warehouse **Busy** | Contention in ~4 s. The Canteen is cut first (towards its 28 kbps floor), then Office, CCTV and Warehouse a little. Clinic, Factory and Lab are protected, and every cut phone shows why |
| **TC4 Everyone at peak** | Everyone at **Peak** | Even maximum cuts can't fit 1,480 kbps into 950: the decision is PARTIAL and the operator is told. No floor or ceiling is crossed |
| **TC5 Recovery** | Everyone back to **Normal** | Contention closes. Slices come back after their recovery windows, or at once with Override |
| **TC6 On/off proof** | TC3 load with **Automatic arbitration OFF**, then **ON** | With it off, the shared queue fills and *everyone* suffers, Clinic included. With it on, the protected slices recover. Wait ~25 s after switching before reading numbers. Record with the **experiment recorder** |

### Automated demo on one laptop

```bash
npm run demo:local
```

This runs TC1–TC6 with 7 built-in agents on the laptop in about 6 minutes, checks each test case,
and saves a CSV and a summary in `experiments/`. The traffic stays inside the laptop (no Wi-Fi),
so it tests the gateway and the decision loop. Use real phones for Wi-Fi results.

**Measured result (`demo:local`, one laptop, TC6 lunch-hour rush, mean of 20 two-second windows
each):**

| Slice | Latency p95 OFF | Latency p95 ON | Loss OFF | Loss ON | Limit ON |
|---|---:|---:|---:|---:|---:|
| Patient Telemetry (Clinic) | 512 ms | **29 ms** | 4.68 % | **0 %** | 60 kbps (never cut) |
| Factory Automation | 511 ms | **29 ms** | 15.93 % | **0 %** | 380 kbps (not cut) |
| Lab Instrumentation | 508 ms | **31 ms** | 10.24 % | **0 %** | 180 kbps (not cut) |
| Warehouse Operations | 509 ms | 452 ms | 13.89 % | 4.50 % | 123 kbps (−23 %) |
| CCTV | 630 ms | 473 ms | 15.52 % | 15.96 % | 203 kbps (−15 %) |
| Office Wi-Fi | 575 ms | 477 ms | 35.55 % | 31.35 % | 220 kbps (−31 %) |
| Canteen Signage | 947 ms | 577 ms | 59.55 % | 90.26 % | 28 kbps (−80 %, its floor) |

Raw data and every check: `experiments/2026-10-20T16-25-02-demo-local-summary.md`.

With arbitration off, every slice shares one overflowing queue. With it on, the engine cuts the
low-value slices, and the Clinic, Factory and Lab get their latency and loss back. The cut slices
(above all the Canteen) absorb the loss instead.

---

## Project map

| Folder | What it is | Read |
|---|---|---|
| `apps/controller` | The brain: the simulated project's backend plus the gateway adapter | [README](apps/controller/README.md) |
| `apps/gateway` | The network: shaping, measuring, device API | [README](apps/gateway/README.md) |
| `apps/portal` | The website on each department's device | [README](apps/portal/README.md) |
| `apps/dashboard` | The operator's web app | [README](apps/dashboard/README.md) |
| `apps/agent` | A command-line "device" and Windows `.exe` | [README](apps/agent/README.md) |
| `packages/shared` | Types shared by all of the above | [README](packages/shared/README.md) |
| `scripts/` | `demo-local`, `calibrate`, `isp-check`, `lan-info`, `experiment-summary`, and the firewall scripts in `windows/` | |
| `experiments/` | CSV results (git-ignored) and summaries | [README](experiments/README.md) |
| `docs/` | Architecture, testbed, runbook, API, limitations | below |

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start controller, gateway, dashboard and portal together |
| `npm run build` / `npm start` | Production build / run |
| `npm test` | All tests: controller (the original engine tests plus testbed tests) and gateway |
| `npm run demo:local` | TC1–TC6 automatically on one laptop (`-- --quick` for a shorter run) |
| `npm run calibrate` | Measure each joined device's idle latency for 30 s and compare it with its SLA target |
| `npm run isp:check` | Check the ISP is faster than the 1 Mbps link, so the gateway is the real bottleneck |
| `npm run experiment:summary -- <csv>` | Summarise an experiment CSV by scenario and slice |
| `npm run build:agent:exe` | Build `dist/slice-agent.exe` |

### Documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, ports, control loop, shaper.
- [`docs/TESTBED.md`](docs/TESTBED.md): setup, scaling, SLA targets, test cases, results.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md): step-by-step live demo.
- [`docs/API.md`](docs/API.md): every endpoint.
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md): what is real and what is not.
- [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md): environment notes and known gaps.

---

## What is real, and what isn't

- **Real:** the Wi-Fi, the devices, the TCP traffic, and the limits enforced on it. Every number
  shown is measured; unknown values show as —.
- **Not real 5G:** slicing happens in an application gateway on the laptop (like a slice-aware
  UPF or SD-WAN edge), not in a 5G radio network. The 1 Mbps link is a cap the gateway enforces.
- **Not built yet:**
  - phone **proxy mode** (`:8888`) passes traffic through without limits, so leave the phone's
    proxy setting off;
  - upload load;
  - an opt-out from operator control.
- **Sign-in is for your own network only.** There are no passwords, so don't expose it to the
  internet.

Details: [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).
