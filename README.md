# 5G CBHA Runtime Arbitration — Real-Network Testbed

A production-grade real-network testbed that ports the **Context-Based Harm Arbitration (CBHA)** enterprise network slicing engine onto a physical Windows 11 Wi-Fi hotspot environment with real traffic shaping, live client devices, active telemetry probes, and dynamic business-harm arbitration.

---

## 1. Overview

In multi-department enterprises, physical network infrastructure is sliced into logical sub-networks (slices). When unexpected traffic spikes saturate the bottleneck link, traditional network devices drop packets arbitrarily or rely solely on static QoS class identifiers (5QI / DSCP). 

**CBHA (Context-Based Harm Arbitration)** replaces static QoS with **business value arbitration**:
- Decisions are driven by **business criticality**, **cost of downtime (£/min)**, **recovery tolerance**, **regulatory compliance**, and **customer impact**.
- When congestion occurs, non-critical slices (e.g. Canteen Signage) are throttled down towards their contractual floors, preserving low latency and zero packet loss for life-critical services (e.g. Patient Telemetry) and mission-critical manufacturing (e.g. Factory Automation).
- **Every decision is audited and explained in plain English** on operator dashboards and department client portals.

```
                    ISP Wi-Fi (Internet)
                           │
            ┌──────────────┴──────────────────────────────────────────────┐
            │ MAIN LAPTOP (Windows 11, Mobile Hotspot 192.168.137.1)      │
            │                                                             │
            │  ┌────────────────────┐ southbound REST ┌─────────────────┐ │
            │  │ CONTROLLER :4000   │ 127.0.0.1:9090  │ SLICE GATEWAY   │ │
            │  │ (CBHA Engine)      │ ──────────────▶ │  :8080 portal + │ │
            │  │ contention → CBHA  │  limits, stats  │        load +   │ │
            │  │ → 2-phase apply    │ ◀────────────── │        probes   │ │
            │  │ audit, Socket.IO   │                 │  :8888 proxy    │ │
            │  └─────────┬──────────┘                 │  Token Bucket   │ │
            │            │                            │  Rate Limiter   │ │
            │   DASHBOARD :5173 / :4000               │  Root: 950 kbps │ │
            │   Interactive Topology Map              └────────┬────────┘ │
            └──────────────────────────────────────────────────┼──────────┘
                                         hotspot Wi-Fi (real)  │
          ┌───────────┬───────────┬───────────┬────────────────┼───────┬───────────┐
       Clinic      Factory    Quality lab  Warehouse      Security  Office IT    Canteen
       phone       phone       laptop       phone          phone     laptop       phone
      (portal)    (portal)    (portal/agent)(portal)      (portal)  (portal)     (portal)
```

---

## 2. The 7 Departments and Slices

All bandwidth numbers are scaled for a **1 Mbps total bottleneck link** (950 kbps offered capacity, 50 kbps reserved for out-of-band management) with a scaling factor of $s = 0.1$:

| # | Department | Slice Name | Criticality | Importance | Downtime Cost | Recovery Tol. | Max Degr. | Baseline | Floor | Max Burst | Profile | S-NSSAI |
|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---|---|
| 1 | **Clinic** | Patient Telemetry | `MISSION_CRITICAL` | 100 | £25,000 / min | `ZERO` | **0% (Exempt)** | 60 kbps | 40 kbps | 90 kbps | URLLC | 2 / 000101 |
| 2 | **Factory** | Factory Automation | `MISSION_CRITICAL` | 94 | £8,400 / min | `LOW` | 15% | 380 kbps | 170 kbps | 580 kbps | URLLC | 2 / 000201 |
| 3 | **Quality lab** | Lab Instrumentation | `BUSINESS_CRITICAL` | 68 | £1,600 / min | `LOW` | 20% | 180 kbps | 50 kbps | 260 kbps | eMBB | 1 / 000401 |
| 4 | **Warehouse** | Warehouse Operations | `BUSINESS_CRITICAL` | 72 | £2,100 / min | `MODERATE` | 35% | 160 kbps | 55 kbps | 250 kbps | URLLC | 2 / 000301 |
| 5 | **Security** | CCTV | `BUSINESS_OPERATIONAL` | 58 | £700 / min | `MODERATE` | 40% | 240 kbps | 60 kbps | 360 kbps | eMBB | 1 / 000601 |
| 6 | **Office IT** | Office Wi-Fi | `BUSINESS_OPERATIONAL` | 52 | £900 / min | `MODERATE` | 45% | 320 kbps | 70 kbps | 500 kbps | eMBB | 1 / 000501 |
| 7 | **Canteen** | Canteen Signage | `BEST_EFFORT` | 8 | £15 / min | `HIGH` | 80% | 140 kbps | 28 kbps | 200 kbps | URLLC | 2 / 000701 |
|   | **Total** | | | | | | | **1,480 kbps** | **473 kbps** | 2,240 kbps | | |

> **Key Architectural Insight:**
> Notice that **Canteen Signage** is tagged with the 3GPP profile `URLLC`, but carries near-zero financial loss (£15/min), while **Lab Instrumentation** is tagged `eMBB` but is legally regulated (£1,600/min). Traditional QoS would prioritize Canteen over Lab because of the URLLC label; **CBHA prioritizes by business impact**, ensuring the right service survives.

---

## 3. Quick Start (10-Minute Setup)

### Prerequisites
- Windows 11 Laptop with Wi-Fi adapter.
- Node.js 20+ or 24+ installed.
- PowerShell 5.1+ or 7+.

### Step 1: Install & Setup
```powershell
# Clone or open the repository
cd 'D:\CN project\CN project\CN_Real_Network_arbitration'

# Initialize environment configuration
npm run setup

# Seed the 7-department testbed
npm run seed
```

### Step 2: Configure Windows Firewall
Run PowerShell as Administrator and execute:
```powershell
.\scripts\windows\open-firewall.ps1
```
*(This safely opens ports 8080, 8888, and 4000 exclusively for the `LocalSubnet`)*.

### Step 3: Turn On Windows Mobile Hotspot
1. Open **Windows Settings → Network & internet → Mobile hotspot**.
2. Toggle Mobile Hotspot to **On** (sharing Wi-Fi over 2.4 GHz or 5 GHz).
3. Connect client phones or laptops to this hotspot.
4. Run `npm run lan:info` to see the hotspot IP (`192.168.137.1`) and QR code.

### Step 4: Start the Full Testbed
```powershell
npm run dev
```
This launches concurrently:
- **Controller** at `http://localhost:4000` (API & Telemetry engine)
- **Dashboard** at `http://localhost:5173` (Operator UI & SVG Topology Map)
- **Slice Gateway** at `http://0.0.0.0:8080` (Shaper, Portal, & Active Prober)
- **Southbound Loopback** at `http://127.0.0.1:9090` (Internal Control Plane)

### Step 5: Join From Phones & Run Arbitration
1. Open `http://<laptop-ip>:8080/join` on any connected phone (or scan the QR code from `npm run lan:info` or the dashboard).
2. Enter a join code (e.g. `CLN101` for Clinic, `CAN701` for Canteen).
3. Increase demand to **Flood (200%)** on Canteen.
4. Observe the **Dashboard Testbed Topology**: CBHA triggers within 4 seconds, restricts Canteen to its floor (28 kbps), and leaves Clinic 100% un-degraded.

---

## 4. Single-Laptop Headless Demo (`demo:local`)

You can run the entire 6-scenario demonstration suite without any external phones:

```powershell
npm run demo:local
```

This runs all 6 test cases sequentially against in-process agents:
- **TC1 (All Normal 55%):** Contention-free operation (814 kbps < 921.5 kbps; 0 drops).
- **TC2 (Canteen Flood 280 kbps):** Shaper token bucket tail-drop contains rogue slice at 140 kbps baseline without triggering arbitration.
- **TC3 (Lunch Rush Contention):** 1,309 kbps demand triggers CBHA within 4s. Canteen degraded to floor 28 kbps; Clinic 100% protected at 60 kbps.
- **TC4 (Everyone at Peak 1,480 kbps):** Extreme overload. Slices cut strictly in order of business harm; floors and ceilings respected; Clinic untouched.
- **TC5 (Step-down Recovery):** Demand drops back to 55%; contention clears after 3 clean samples; baselines restored.
- **TC6 (A/B Comparative Proof):** Real-time empirical comparison:
  - *Arbitration OFF:* Unmitigated bottleneck saturates root FIFO, causing severe queueing delay (p95 latency > 500 ms) and drops across Clinic and Factory.
  - *Arbitration ON:* CBHA sheds non-critical load, bringing Clinic latency back to baseline (~128 ms) with 0% loss.
- **Scorecard:** Prints formatted execution table and writes CSV to `experiments/<timestamp>-tc-demo.csv`.

---

## 5. Headless Slice Agent (`slice-agent.exe`)

For automated testing or connecting secondary laptops to the testbed:

```powershell
# Using the pre-built single-file executable:
.\dist\slice-agent.exe --gateway http://192.168.137.1:8080 --code CLN101 --name clinic-agent --rate 60

# Or using TypeScript runtime:
npx tsx apps/agent/src/index.ts --gateway http://192.168.137.1:8080 --code CAN701 --name canteen-agent --rate 280
```

To compile the standalone Windows binary using Node Single Executable Application (SEA):
```powershell
npm run build:agent:exe
```

---

## 6. Available CLI Scripts

| Command | Purpose |
|---|---|
| `npm run setup` | Copies `.env.example` to `.env` and generates secure gateway bearer token. |
| `npm run seed` | Seeds the 7 departments and 7 slices with computed baseline/floor values. |
| `npm run dev` | Runs controller, gateway, dashboard, and portal watch concurrently. |
| `npm run build` | Builds production artifacts for all packages and applications. |
| `npm start` | Production startup serving dashboard on :4000 and portal on :8080. |
| `npm test` | Runs all 489 controller tests and 14 gateway unit tests. |
| `npm run lan:info` | Displays dynamically detected LAN/Hotspot IPs and prints terminal QR code. |
| `npm run demo:local` | Runs automated headless 6-scenario demonstration (TC1–TC6). |
| `npm run calibrate` | Measures idle probe latency over 30s and verifies SLA target thresholds. |
| `npm run isp:check` | Measures upstream ISP throughput to ensure testbed shaper is the true bottleneck. |
| `npm run experiment:summary` | Generates statistical Markdown summary of the latest experiment CSV. |
| `npm run build:agent:exe` | Compiles standalone `dist/slice-agent.exe` via Node SEA. |

---

## 7. Testbed Invariants & Guarantees

1. **Patient Telemetry Protection:** Clinic (SST 2 / SD 000101) is strictly exempt from degradation under all operating conditions. Its effective degradation ceiling is 0%.
2. **Measurement Integrity:** Every metric displayed in the portal, dashboard, or agent CLI is measured from live network packets and active HTTP RTT probes.
3. **Deterministic Token Buckets:** Shaper accuracy remains within $\pm 3\%$ of configured rates with $dt$ computed from `process.hrtime.bigint()`.
4. **Idempotent Control Plane:** Limit allocations can be re-applied repeatedly without state drift.
5. **Full Auditability:** Every arbitration decision generates an unalterable audit log with plain-English rationales.

---

## 8. Documentation Index

- [Architecture Guide](docs/ARCHITECTURE.md) — Comprehensive design of the shaper, control loop, and telemetry pipeline.
- [Testbed Guide](docs/TESTBED.md) — Physical Wi-Fi setup, SLA targets, calibration, test procedures, and A/B experiment data.
- [Demonstration Runbook](docs/RUNBOOK.md) — Step-by-step evaluator walkthrough and troubleshooting guide.
- [API Reference](docs/API.md) — Southbound, Portal, Proxy, and Controller Testbed REST endpoint documentation.
- [Limitations & Emulation](docs/LIMITATIONS.md) — Honest evaluation of application-layer slicing vs 3GPP radio slicing.
- [Open Questions & Notes](docs/OPEN-QUESTIONS.md) — Hardware notes, Windows timer granularity, and permission boundaries.
