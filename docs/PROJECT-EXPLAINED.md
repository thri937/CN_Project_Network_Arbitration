# The project, explained from zero

This document explains the whole project for someone who has never seen it. It covers the
problem, the idea, every part of the system, the technology used in each part and how it is
built, the algorithm, and the networking behind it. The last section has questions an examiner
is likely to ask, with answers.

---

## 1. The problem

**Problem statement:** *Runtime Arbitration for Contended, SLA-Critical Enterprise Network Slices —
a department-aware, auditable alternative to generic priority-based degradation.*

**Network slicing** splits one physical network into several logical networks, called
**slices**. Each slice gets a share of the capacity and its own targets: latency, jitter, loss,
throughput and availability. In 5G a slice is identified by an **S-NSSAI** (a slice type, SST,
plus a differentiator, SD). Common slice types are:

- **URLLC**: low latency, high reliability;
- **eMBB**: high bandwidth;
- **mMTC**: many small devices.

An enterprise gives each **department** its own slice. Together, these are the **contracts**:

| Department | Slice | What it carries |
|---|---|---|
| Clinic | Patient Telemetry | patient monitors |
| Factory | Factory Automation | robots and machine vision |
| Quality lab | Lab Instrumentation | regulated measurement data |
| Warehouse | Warehouse Operations | AGVs and sensors |
| Security | CCTV | camera feeds |
| Office IT | Office Wi-Fi | staff laptops |
| Canteen | Canteen Signage | menu screens |

Each slice has:

- a **baseline**: its normal limit;
- a **floor**: a guaranteed minimum it is never cut below;
- **SLA targets**.

To use capacity efficiently the baselines are **oversubscribed**: they add up to more than the
link can carry, because departments rarely all peak at once.

**Contention** is the moment they do peak together. Demand exceeds capacity, so something has
to be slowed down.

**What usually happens.** Networks decide using the **QoS label**. URLLC traffic is kept and the
rest is cut first. But labels describe how traffic *behaves*, not how much the business
*cares*. In our company the canteen screens are labelled **URLLC** (an outage costs £15 a
minute), while the regulated Quality lab is labelled **eMBB** (£1,600 a minute). A label-based
network protects the menu screens and slows the lab, which is the opposite of what a manager
would choose.

**What this project does instead.** It decides from business facts:

- criticality;
- downtime cost;
- compliance (life-safety, regulated, contractual);
- customer impact;
- operational importance;
- how long the department can tolerate being slowed (recovery tolerance).

It never crosses a compliance ceiling or a contractual floor. It **explains and audits every
decision**.

---

## 2. What we built

The arbitration runs on a **real network**: one Windows laptop and the phones connected to its
Wi-Fi hotspot.

```
                    Internet (home Wi-Fi)
                            │
     ┌──────────────────────┴───────────────────────────────────────────┐
     │ LAPTOP (Windows Mobile Hotspot, 192.168.137.1)                    │
     │                                                                   │
     │  CONTROLLER :4000  ◄── measurements every 2 s ──  GATEWAY :9090   │
     │  (the brain)        ── new limits ──────────────►  (the network)  │
     │   contention → CBHA → apply → recover → audit       7 slice queues │
     │                                                     one 1 Mbps link│
     │  DASHBOARD :5173 (operator, in the laptop's browser)  PORTAL :8080 │
     └────────────────────────────────────────────────────────────┬──────┘
                                       real Wi-Fi                  │
        Clinic phone · Factory phone · Lab laptop · … · Canteen phone (each opens the portal)
```

The link carries **1 Mbps**: 1,000 kbps, of which 50 kbps is reserved and **950 kbps** is
offered to slices. Every bandwidth figure is the 10 Gbps company's value divided by 10,000, so
the business rules stay exactly the same. The slice baselines add up to **1,480 kbps, 156 % of
the link**, so contention is easy to cause.

| Department | Slice | QoS label | Outage cost | Max cut | Baseline | Floor | Latency target | Join code |
|---|---|---|---:|---:|---:|---:|---:|---|
| Clinic | Patient Telemetry | URLLC | £25,000/min | 0 % (life-safety) | 60 kbps | 40 | 150 ms | CLN101 |
| Factory | Factory Automation | URLLC | £8,400/min | 15 % | 380 | 170 | 180 ms | FAC201 |
| Quality lab | Lab Instrumentation | eMBB | £1,600/min | 20 % (regulated) | 180 | 50 | 500 ms | LAB401 |
| Warehouse | Warehouse Operations | URLLC | £2,100/min | 35 % | 160 | 55 | 250 ms | WHS301 |
| Security | CCTV | eMBB | £700/min | 40 % | 240 | 60 | 900 ms | SEC601 |
| Office IT | Office Wi-Fi | eMBB | £900/min | 45 % | 320 | 70 | 600 ms | OFF501 |
| Canteen | Canteen Signage | **URLLC** | **£15/min** | 80 % | 140 | 28 | 350 ms | CAN701 |

---

## 3. One decision, start to finish (TC3, the lunch-hour rush)

1. **Load.** The phones ask for: Canteen 280 kbps (twice its limit), Office 320, CCTV 240,
   Warehouse 128, and the rest at 55 %. That is about **1,309 kbps of demand on a 950 kbps
   link**.
2. **The gateway measures.** The Canteen's own token bucket holds it at 140 kbps, so about
   1,169 kbps reaches the shared link. The link can send only 950. Its shared queue fills, and
   *every* slice sees about half a second of delay and some loss, the Clinic included.
3. **Detect.** Every 2 s the controller reads the measurements. Demand is above 102 % of 950 kbps
   for two samples (4 s), so a **contention event** opens.
4. **Decide.** The engine computes the shortage. Carried traffic, the smaller of each slice's
   demand and limit, is about 1,169 kbps. The target is 97 % of the link, 921.5 kbps, so about
   **247 kbps** must go. It hands that out in small steps, each to the slice where one more kbps
   costs the least business harm. The Canteen goes down towards its 28 kbps floor first, then
   Office, CCTV and Warehouse lose a little. Clinic, Factory and Lab are never touched.
5. **Apply.** The decision is saved first, then the new limits are sent to the gateway, which
   enforces them within 20 ms. The controller then reads back what the gateway enforced.
6. **Effect.** About 921 kbps now reaches the link, below the 950 it can send, so the shared
   queue drains in 15–20 s. In our measurement the Clinic's latency fell from 510 ms to 26 ms
   and its loss from 3.9 % to 0 %. The Canteen asks for ten times its new limit and loses most of
   its traffic, as intended.
7. **Explain.** The decision page shows the reasons, the per-slice factors, and four
   alternative plans priced on the same scale, with why each was rejected. The Canteen phone
   shows *"Limit lowered from 140 to 28 kbps…"*.
8. **Recover.** When demand falls, contention closes after three normal samples. Each slice is
   restored when its recovery window ends (Canteen 30 min, Office/CCTV 10 min). An admin can
   restore everything at once with **Override**.

---

## 4. The parts, the technology in each, and how each is built

All code is **TypeScript** in one repository (an npm workspaces monorepo). Node.js runs the
back end; React runs the two websites.

### 4.1 Slice gateway (`apps/gateway`): the network

**Technology:**
- Node.js built-in `node:http` and `node:net`;
- `ws` (WebSocket);
- Zod (validates every API message);
- no web framework, no native modules.

**How it works:**

- **Shaper** (`src/shaper/`). A scheduler loop runs every 20 ms. It computes the real elapsed
  time with `process.hrtime.bigint()`, so Windows' coarse timers don't change the rates. Each
  tick does three things:
  1. **Arrivals:** each device's session adds bytes to its slice queue at the rate the device
     asked for. That rate is the slice's demand.
  2. **Police:** each slice's **token bucket** lets bytes out at no more than the slice's limit.
     The bucket refills at the limit rate and holds 0.1 s of tokens, but never less than one 1 KB
     chunk.
  3. **Transmit:** all slices feed **one shared FIFO queue** that drains at 950 kbps: the
     bottleneck link. Both queues hold 0.5 s of traffic and **tail-drop** when full.

  A `drr` option replaces the shared FIFO with weighted fair queueing.
- **Measurement** (`src/meter/`, `src/probes/`). Every 2 s each slice's window closes, giving:
  - demand, carried and dropped rate;
  - queueing delay;
  - **latency** (p50 and p95 of probe round trips);
  - **jitter** (mean change between consecutive round trips);
  - **loss** (dropped ÷ offered bytes, or lost probes, whichever is larger);
  - **availability** (answered probes over 5 minutes).

  Probes travel through the slice's own queues, so they measure the real queueing delay. When
  nothing was measured, the value is *unknown* (null), never 0.
- **Device API on :8080** (`src/portal-api/`). Join with a code, a load stream
  (`GET /load/down?rate=`), probes, and a WebSocket that pushes a live snapshot every second.
  It also serves the built portal.
- **Control API on 127.0.0.1:9090** (`src/southbound/`). Used by the controller only, with a
  bearer token:
  - read stats;
  - set a slice's limit;
  - push the slice catalogue;
  - list or remove devices;
  - send operator demand.

### 4.2 Controller (`apps/controller`): the brain

**Technology:**
- Node.js with Express 4 (REST API);
- Zod (input validation);
- Socket.IO (live updates to the dashboard);
- Pino (logs);
- JSON Web Tokens (sessions);
- OpenAPI 3.1 (API docs at `/api/docs`);
- an in-memory datastore saved to disk (`apps/controller/.data`).

**How it works:**
- **Ports and adapters.** Everything talks to the network through one interface,
  `INetworkTelemetryPort` (`sample`, `applyAllocation`, `describeCapacity`, `ping`). The
  `gateway` adapter implements it over the gateway's control API. That's why the same engine runs
  on a simulator or on this real network without changes.
- **Jobs** (`src/jobs/scheduler.ts`). These run every 2 s: telemetry sampling, capacity
  monitoring, contention scan and arbitration. A recovery sweep runs every 5 s.
- **Business Policy Engine** (`src/domain/policyEngine.ts`). Turns department facts into a
  0–100 priority score (§5.1).
- **CBHA engine** (`src/domain/arbitration/`). Pure functions with no I/O:
  - `harm.ts`: the harm curve;
  - `solver.ts`: water-filling;
  - `alternatives.ts`: four rival strategies priced on the same scale;
  - `engine.ts`: assembles the plan and writes the explanation.
- **Allocation** (`src/services/allocation.service.ts`). Two-phase apply: save, send to the
  gateway, reconcile, retry on failure.
- **Audit and notifications.** Every decision, override and setting change goes into an
  append-only log.
- **Testbed** (`src/testbed/`, `src/controllers/testbed.controller.ts`):
  - the 7-slice definition;
  - scenarios;
  - the arbitration on/off switch;
  - device management;
  - continuous CSV recording of every gateway window.

### 4.3 Dashboard (`apps/dashboard`): the operator's website

**Technology:**
- React 18 with Vite 5;
- TanStack Query (server data, polling and caching);
- React Router;
- Tailwind CSS;
- Recharts (charts);
- `qrcode` (join QR codes);
- Socket.IO client.

**Pages:**
- **Slices and devices:** live table, QR codes, demand presets, scenarios, arbitration switch,
  device list and CSV download.
- **Contention.**
- **Decisions**, each with its full explanation.
- **Live charts.**
- The rules: **slice contracts**, **departments**, **business policy** and the **audit log**.

### 4.4 Department page (`apps/portal`): the website on each phone

**Technology:** React 18, Vite 5, Tailwind CSS, Recharts. It uses the browser's `fetch`
streaming to receive load and a `WebSocket` for live updates.

**How it works:**
- **Join.** You join with a code. The device identity is kept in `sessionStorage`, so each
  browser tab is a separate device.
- **Load.** One download stream at the chosen rate, using bytes the laptop generates or, if
  chosen, real internet bytes.
- **Probes.** One probe a second.
- **Display.** It shows the limit, what gets through, latency and loss against the targets,
  and the controller's reason when the slice is cut.
- **Follows the operator.** Demand set from the dashboard is applied straight away.
- **Recovers.** It rejoins by itself if the gateway restarts.

### 4.5 Slice agent (`apps/agent`)

A command-line "device" that behaves exactly like the portal. It is used by `npm run demo:local`
and can be built into a Windows `.exe` (Node single executable application).

### 4.6 Shared (`packages/shared`) and tests

- **Shared:** the Zod schemas and types of every message between the gateway, portal, dashboard
  and agent, plus formatting helpers.
- **Tests:** Vitest and Supertest, over 450 tests in all. They include:
  - the engine's correctness against an exact optimum;
  - life-safety never being cut;
  - shaper accuracy within ±3 % from 20 to 950 kbps;
  - a closed-loop test that runs the real gateway and controller together.
- **`npm run demo:local`:** runs TC1–TC6 automatically on one laptop and checks the measured
  results.

---

## 5. The algorithm (CBHA, Convex Business-Harm Arbitration)

### 5.1 Business priority score (0–100)

`BPS` is a weighted sum of seven business facts, each scaled to 0–100.

| Fact | Weight |
|---|---:|
| Criticality | 0.26 |
| Downtime cost (log-scaled; £1,000/min scores 50) | 0.20 |
| Business importance | 0.16 |
| Compliance | 0.14 |
| Customer impact | 0.12 |
| Operational importance | 0.07 |
| Recovery intolerance | 0.05 |

Scores in this testbed:

| Department | Score |
|---|---:|
| Clinic | 96.0 |
| Factory | 81.7 |
| Lab | 70.9 |
| Warehouse | 59.1 |
| CCTV | 48.8 |
| Office | 43.4 |
| Canteen | 8.0 |

### 5.2 Harm of a cut

Cutting slice *i* by a fraction *dᵢ* of its baseline costs

  **Hᵢ(dᵢ) = BPSᵢ · (dᵢ / maxᵢ)^γᵢ · SLA-stress · fairness · urgency · intolerance**

- **γ (gamma)** depends on recovery tolerance:

  | Tolerance | γ |
  |---|---:|
  | zero | 3.0 |
  | low | 2.2 |
  | moderate | 1.6 |
  | high | 1.15 |

  Because γ > 1, harm grows faster than the cut. The tenth percent costs much more than the
  first, so **spreading small cuts costs less than one deep cut**.
- **maxᵢ** is the slice's ceiling: the department's own limit, tightened by compliance
  (life-safety 0 %, regulated 20 %, contractual 60 %).

### 5.3 How much to cut

  **shortage = Σ min(demandᵢ, limitᵢ) − 0.97 × 950 kbps**

Only traffic the slice actually carries can be shed. Demand that a slice's own limit already
holds back isn't counted twice. So in TC2 (Canteen flood) nothing needs cutting.

### 5.4 Who loses it: water-filling

Repeat in steps of 0.5 % of total demand: give the next step to the slice with the **lowest
marginal harm per kbps**. A slice drops out when it reaches its ceiling or floor. This greedy
method is **optimal** for this kind of problem: a separable convex objective with one linear
budget. At the end, every slice that was cut has equal marginal harm per kbps; that is the KKT
condition. Against an exact solver the gap is about 1.5 % at the default step.

### 5.5 Rules that are never broken

- No slice goes below its floor or past its ceiling.
- Life-safety slices (the Clinic) are never cut.
- If even the maximum allowed cuts aren't enough, the decision is **PARTIAL** and the operator
  is told (TC4). The engine never breaks a rule to fit the link.

### 5.6 Detection and recovery

- **Contention opens** when demand is above 102 % of capacity for 2 samples (4 s), and **closes**
  after 3 normal samples.
- There is a **20 s cooldown** between passes.
- Recovery windows depend on tolerance:

  | Tolerance | Recovery window |
  |---|---:|
  | zero | 30 s |
  | low | 2 min |
  | moderate | 10 min |
  | high | 30 min |

---

## 6. The networking behind it

| Concept | Where it appears |
|---|---|
| **Token bucket** | Each slice's limit. Tokens arrive at the limit rate; sending spends them; no tokens, no sending |
| **FIFO queue and tail drop** | The shared 1 Mbps link and each slice's buffer. A full queue drops new arrivals, which is the loss you see |
| **Queueing delay / bufferbloat** | When the shared queue is full, every packet waits about 0.5 s. This is why the Clinic suffers without arbitration |
| **Weighted fair queueing (DRR)** | Optional link discipline (`GATEWAY_ROOT_DISCIPLINE=drr`) for comparison |
| **RTT, p95, jitter, loss, availability** | Measured with probes through each slice's queues |
| **TCP backpressure** | A shaped stream simply isn't read or written faster than the limit, so TCP slows the sender |
| **Wi-Fi hotspot, NAT, LAN subnet** | Phones get 192.168.137.x addresses from the laptop's hotspot; the firewall opens port 8080 for the local subnet only |
| **Ports and loopback** | 8080 on the network for devices; 9090 on 127.0.0.1 only, so phones can never change limits |
| **WebSocket** | One-second live updates and operator commands to phones |
| **S-NSSAI (SST/SD)** | Kept on every slice as in 5G (SST 1 eMBB, SST 2 URLLC) |

---

## 7. Real or simulated?

- **Real:**
  - the Wi-Fi;
  - the phones;
  - the TCP connections and the bytes;
  - the limits enforced on them;
  - every measurement.

  Turn arbitration off and you can see the clinic's real latency go up.
- **Emulated:**
  - **The 1 Mbps link.** It is a cap the gateway enforces; the ISP is faster.
  - **Where slicing happens.** In an application gateway on the laptop, acting like a
    slice-aware UPF or SD-WAN edge, not in 5G radio. The shared Wi-Fi airtime itself is not
    partitioned.
- **Not built yet:**
  - shaping for the optional phone proxy (`:8888`);
  - upload traffic;
  - more than one controller.

See [LIMITATIONS.md](LIMITATIONS.md).

---

## 8. Questions you may be asked

**Is the network real or a simulation?**
The traffic and the limits are real: phones send real TCP traffic over the laptop's Wi-Fi
hotspot, and the gateway really holds each slice to its limit. You can measure it. What is
emulated is the size of the link (a 1 Mbps cap in software) and where slicing happens (in an
application gateway rather than a 5G radio network).

**Why 1 Mbps?**
So that a handful of phones can overload it and contention is easy to show. Every number is
scaled by the same factor (1/10,000), so the business rules are unchanged.

**If I run a speed test on a phone, will I see the slice limit?**
Only for traffic that goes through the gateway: the department page's own load. A normal
speed-test app goes straight to the internet through the hotspot and isn't shaped. (Proxy
shaping for other apps is future work.)

**Why not just protect the URLLC slices?**
Because labels don't reflect business value. Here the canteen screens are URLLC and the
regulated lab is eMBB. A label rule would protect the menu screens and hurt the lab.

**Why many small cuts instead of cutting the cheapest slice fully?**
Harm grows faster than the cut (γ > 1), so the last percents of a deep cut cost more than the
first percents taken from several slices. In the TC3 decision the priority-sort alternative
had about 18 % more harm.

**How do you know the split is the best one?**
The problem is a separable convex minimisation with one linear constraint. Equalising marginal
harm per kbps is exactly its optimality (KKT) condition, and the greedy steps converge to it.
Tests compare the result with an exact solver.

**What happens when there is not enough room even after cutting everything allowed?**
The engine stops at the ceilings and floors, marks the decision PARTIAL and alerts the
operator. It never breaks a rule (TC4).

**Can a department be cut forever?**
No. Each cut has a recovery window from the department's recovery tolerance. After contention
ends, the slice is restored when that window ends, or at once with an admin override. The
fairness term also makes repeatedly cut slices more expensive to cut again.

**What is "auditable" here?**
Every decision stores its inputs, the policy version, the per-slice reasons, the alternatives
and the outcome. Every action goes into an append-only audit log.

**What proves it helps?**
TC6. Run the same overload with arbitration off, then on, and compare the measurements. On one
laptop the Clinic's p95 latency went from 510 ms to 26 ms and its loss from 3.9 % to 0 %.
