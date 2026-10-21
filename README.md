# Slice Arbitration Testbed

**Who should slow down when the network is full?** This Computer Networks project answers that
question on a **real network**: one Windows laptop and the phones connected to its Wi-Fi
hotspot.

*Problem statement: Runtime Arbitration for Contended, SLA-Critical Enterprise Network Slices —
a department-aware, auditable alternative to generic priority-based degradation.*

A company network is split into **slices**, one per department. When everyone wants more
bandwidth than the link can carry, something has to give. A normal network decides by the
**QoS label** someone attached years ago. This testbed decides by **business value**:
- the cost of an outage per minute;
- compliance (life-safety, regulated);
- how critical the department is;
- how long it can tolerate being slowed.

It enforces the decision on live traffic and explains every decision in plain English.

New to the project? Read **[docs/PROJECT-EXPLAINED.md](docs/PROJECT-EXPLAINED.md)**. It covers
the whole system from zero, with the technology used in each part and likely viva questions.
Every library and tool, and what it does here, is listed in **[TECH-STACK.md](TECH-STACK.md)**.

---

## The picture

```
                     Home Wi-Fi / ISP
                            │
   ┌────────────────────────┴───────────────────────────────────────────┐
   │ LAPTOP  (Windows Mobile Hotspot, usually 192.168.137.1)             │
   │                                                                     │
   │   CONTROLLER :4000  ── reads stats / sets limits ──►  SLICE GATEWAY │
   │   the "brain": detects        127.0.0.1:9090          the "network":│
   │   contention, decides                                 7 slice limits│
   │   who is cut, audits                                  + one 1 Mbps  │
   │                                                       shared link   │
   │   DASHBOARD :5173 (operator)                          :8080 phones  │
   └──────────────────────────────────────────────────────────┬──────────┘
                                         real hotspot Wi-Fi    │
     Clinic   Factory   Quality lab   Warehouse   Security   Office IT   Canteen
     phone    phone     laptop        phone       phone      laptop      phone
```

| Part | Folder | Technology | Job |
|---|---|---|---|
| **Gateway** | `apps/gateway` | Node.js `http`/`net`, `ws`, Zod | Carries all slice traffic: per-slice token buckets feeding one shared 1 Mbps link (950 kbps offered). Measures demand, throughput, latency, jitter, loss every 2 s |
| **Controller** | `apps/controller` | Node.js, Express, Zod, Socket.IO, Pino, JWT | Detects contention, runs the CBHA engine, applies new limits, recovers, audits |
| **Dashboard** | `apps/dashboard` | React 18, Vite, TanStack Query, Tailwind, Recharts | The operator's site: slices, devices, QR codes, scenarios, decisions, rules |
| **Department page** | `apps/portal` | React 18, Vite, Tailwind, Recharts | Opens on each phone: join a slice, choose how much traffic to send, watch it live |
| **Agent** | `apps/agent` | Node.js CLI, Windows `.exe` | A command-line "device" for laptops and the automated demo |

---

## The 7 departments and slices

| Department | Slice | QoS label | Outage cost | Max cut | Baseline | Floor | Join code |
|---|---|---|---:|---:|---:|---:|---|
| Clinic | Patient Telemetry | URLLC | £25,000/min | **0 %** (life-safety) | 60 kbps | 40 kbps | `CLN101` |
| Factory | Factory Automation | URLLC | £8,400/min | 15 % | 380 kbps | 170 kbps | `FAC201` |
| Quality lab | Lab Instrumentation | eMBB | £1,600/min | 20 % (regulated) | 180 kbps | 50 kbps | `LAB401` |
| Warehouse | Warehouse Operations | URLLC | £2,100/min | 35 % | 160 kbps | 55 kbps | `WHS301` |
| Security | CCTV | eMBB | £700/min | 40 % | 240 kbps | 60 kbps | `SEC601` |
| Office IT | Office Wi-Fi | eMBB | £900/min | 45 % | 320 kbps | 70 kbps | `OFF501` |
| Canteen | Canteen Signage | **URLLC** | **£15/min** | 80 % | 140 kbps | 28 kbps | `CAN701` |
| | **Total** | | | | **1,480 kbps** | 473 kbps | |

The baselines add up to **156 %** of the 950 kbps link on purpose, so at busy times there isn't
enough for everyone.

Look at the Canteen: its label says top priority (URLLC), but an outage costs £15 a minute. The
Quality lab's label is ordinary (eMBB), but it is regulated. A label-based network would protect
the canteen screens over the lab; this one does the opposite.

---

## How one decision happens

1. **Measure.** Every 2 s the gateway reports each slice's demand, throughput, latency (p95 of
   probe round trips), jitter and loss.
2. **Detect.** Contention opens when total demand is above 102 % of the link for two samples in
   a row (4 s).
3. **Decide.**
   - The shortage is the traffic actually carried (each slice's demand, capped at its limit)
     minus 97 % of the link.
   - The CBHA engine (Convex Business-Harm Arbitration) takes that shortage in small steps from
     whichever slice loses the **least business value per kbps**. Several small cuts beat one
     deep cut.
   - Nothing goes below a contractual floor or past a compliance ceiling, and the Clinic is never
     cut.
4. **Apply.** The decision is saved, the gateway enforces the new limits within 20 ms, and the
   controller checks what was enforced.
5. **Explain.** The decision page and the phones of the departments that were cut show why, with
   the real numbers.
6. **Recover.** When demand falls, contention closes after 3 normal samples. Each cut slice is
   restored when its recovery window ends: 2 min for low tolerance, 10 min for moderate, 30 min
   for high. An admin can restore everything at once with **Override**.

---

## Quick start

**Needs:** Windows 11, Node.js 22 or newer, and 0–7 phones or laptops.

Run these once, in this order:

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

- `npm run setup` creates `.env`, the single settings file for every part.
- `npm run build` is needed because phones load the **built** department page.
- `npm run seed` creates the 7 departments, the 7 slices and the demo users.

Then, for each session:

1. **Open the firewall once.** In PowerShell opened with *Run as administrator*:
   `powershell -ExecutionPolicy Bypass -File scripts\windows\open-firewall.ps1`
2. **Turn on Mobile hotspot** (Settings → Network & internet → Mobile hotspot) and connect the
   phones to it. Windows allows up to 8 devices.
3. **Start everything:**
   ```bash
   npm run dev
   ```
4. **On the laptop**, open <http://localhost:5173> and press **Sign in as Admin**.
5. **On each phone**, scan the QR code shown for that department on the **Slices and devices**
   page, or open `http://192.168.137.1:8080/join` and type the join code. `npm run lan:info`
   prints the address and a QR code in the terminal.

No phones? Open the join address in several browser tabs on the laptop, one per department.
Each tab is its own device. Or run the automated demo below.

---

## Things to try

Use the **Test scenarios** buttons on the dashboard. They set the demand of every joined device.
You can also use the buttons on each phone.

| Test | What to do | What should happen |
|---|---|---|
| **TC1 Normal day** | Run TC1 | About 814 kbps on 950: no contention, all within target |
| **TC2 Canteen flood** | Run TC2 | The Canteen's own 140 kbps limit holds it; nothing is cut |
| **TC3 Lunch-hour rush** | Run TC3 | Contention in ~4 s. Canteen cut towards its 28 kbps floor; Office, CCTV and Warehouse cut a little; Clinic, Factory and Lab untouched. Every cut phone shows why |
| **TC4 Everyone at peak** | Run TC4 | Even maximum cuts can't fit 1,480 into 950: a PARTIAL decision and an alert. No floor or ceiling is crossed |
| **TC5 Back to normal** | Run TC5 | Contention closes. Slices return after their recovery window, or at once with Override |
| **TC6 On/off proof** | Run TC3, turn **Automatic arbitration off** for a minute, then **on** for a minute | Off: the shared queue fills and every slice suffers, Clinic included. On: the protected slices recover. Wait ~25 s after each switch before reading numbers. Download the CSV from the **Recording** box |

Every 2-second window of every session is recorded to `experiments/<time>-session.csv`,
labelled with the last scenario run.

### Automated demo on one laptop

```bash
npm run demo:local
```

This runs TC1–TC6 with 7 built-in agents in about 6 minutes, checks each test case, and writes a
CSV and a summary to `experiments/`. The traffic stays inside the laptop (no Wi-Fi), so it
tests the gateway and the decision loop.

**Measured result** (20 October 2026; TC6 lunch-hour rush; mean of 20 two-second windows per
phase; all 6 test cases passed):

| Slice | Latency p95, arbitration off | Latency p95, on | Loss off | Loss on | Limit on |
|---|---:|---:|---:|---:|---:|
| Patient Telemetry (Clinic) | 503 ms | **23 ms** | 5.6 % | **0 %** | 60 kbps (never cut) |
| Factory Automation | 509 ms | **22 ms** | 21.5 % | **0 %** | 380 kbps (not cut) |
| Lab Instrumentation | 505 ms | **22 ms** | 15.0 % | **0 %** | 180 kbps (not cut) |
| Warehouse Operations | 507 ms | 475 ms | 18.3 % | 5.2 % | 122 kbps (cut 24 %) |
| CCTV | 626 ms | 479 ms | 17.5 % | 14.9 % | 204 kbps (cut 15 %) |
| Office Wi-Fi | 573 ms | 476 ms | 19.8 % | 31.2 % | 221 kbps (cut 31 %) |
| Canteen Signage | 949 ms | 415 ms | 65.2 % | 90.0 % | 28 kbps (cut 80 %, its floor) |

With arbitration off, all slices share one overflowing queue. With it on, the engine cuts the
four cheapest slices, carried traffic fits the link again, and the Clinic, Factory and Lab get
their latency and loss back. The cut slices take the loss instead.

**Fair queueing alone?** The gateway can also share the link by weighted deficit round robin
(`GATEWAY_ROOT_DISCIPLINE=drr`). With no controller it keeps Clinic, Factory and Lab fast in the
lunch rush (they stay inside their share), but at full peak it gives the Clinic 37.5 kbps, below
its 40 kbps floor. Fair sharing isolates slices; the engine decides what the shares should be.
Details: [`paper/README.md`](paper/README.md).

---

## Project map

| Folder | What it is | Read |
|---|---|---|
| `apps/controller` | The brain | [README](apps/controller/README.md) |
| `apps/gateway` | The network | [README](apps/gateway/README.md) |
| `apps/portal` | The department page on each phone | [README](apps/portal/README.md) |
| `apps/dashboard` | The operator's site | [README](apps/dashboard/README.md) |
| `apps/agent` | Command-line device and `.exe` | [README](apps/agent/README.md) |
| `packages/shared` | Message types shared by all parts | [README](packages/shared/README.md) |
| `scripts/` | `demo-local`, `calibrate`, `isp-check`, `lan-info`, `experiment-summary`, firewall scripts | |
| `experiments/` | Recorded measurements | [README](experiments/README.md) |
| `paper/` | Conference paper (LaTeX) and its data | [README](paper/README.md) |
| `presentation/` | Slides and the explainer video | [README](presentation/README.md) |
| `docs/` | Explanation, architecture, testbed, runbook, API, limitations | below |

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start controller, gateway, dashboard and department page together |
| `npm run build` / `npm start` | Production build / run of the controller and gateway (phones use the built department page on :8080). For the dashboard, also run `npm run preview -w @cn/dashboard`, or use `npm run dev` |
| `npm test` | All tests (controller and gateway) |
| `npm run demo:local` | TC1–TC6 automatically on one laptop (`-- --quick` for a shorter run) |
| `npm run lan:info` | Show the laptop's addresses and a QR code for phones |
| `npm run calibrate` | Measure each joined device's idle latency for 30 s against its SLA target |
| `npm run isp:check` | Check the ISP is faster than the 1 Mbps link |
| `npm run experiment:summary -- <csv>` | Summarise a recording by scenario and slice |
| `npm run build:agent:exe` | Build `dist/slice-agent.exe` |

### Documents

- [`docs/PROJECT-EXPLAINED.md`](docs/PROJECT-EXPLAINED.md): the whole project from zero, the
  tech stack per part, viva questions.
- [`TECH-STACK.md`](TECH-STACK.md): every technology, its version, and what it does in this project.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): components, ports, control loop, shaper.
- [`docs/TESTBED.md`](docs/TESTBED.md): setup, scaling, SLA targets, test cases, results.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md): the live demo, step by step, with troubleshooting.
- [`docs/API.md`](docs/API.md): every endpoint.
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md): what is real and what is not.
- [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md): environment notes and known gaps.

---

## What is real, and what isn't

- **Real:** the Wi-Fi, the devices, the TCP traffic, and the limits enforced on it. Every number
  shown is measured; values that weren't measured show as —.
- **Not real 5G:** slicing happens in an application gateway on the laptop (like a slice-aware
  UPF or SD-WAN edge), not in a 5G radio network. The 1 Mbps link is a cap the gateway enforces.
- **Not built yet:**
  - the optional phone proxy (`:8888`) passes traffic through without limits, so leave the
    phone's proxy setting off;
  - upload load;
  - an opt-out from operator control.
- **Sign-in is for your own network only:** there are no passwords.

Details: [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).
