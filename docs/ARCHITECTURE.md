# System Architecture — CN Real Network Arbitration Testbed

This document details the architectural design, control plane sequencing, data plane shaping pipeline, telemetry subsystem, and operational protocols of the **5G CBHA Real-Network Arbitration Platform**.

---

## 1. High-Level Component Topology

The system separates concerns across six modular packages organized in an npm monorepo:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              CONTROL PLANE (apps/controller)                           │
│                                                                                        │
│  ┌─────────────────────────┐  sample (2s)   ┌───────────────────────────────────────┐  │
│  │ GatewayTelemetryAdapter │ ◀───────────── │ Southbound Client (:9090)             │  │
│  └───────────┬─────────────┘                └───────────────────────────────────────┘  │
│              │                                                  ▲                      │
│              ▼                                                  │ apply limit          │
│  ┌─────────────────────────┐                ┌───────────────────┴───────────────────┐  │
│  │ Contention Detector     │ ──▶ CBHA ──▶   │ Allocation Manager (Two-Phase Apply)  │  │
│  │ (ratio > 1.02, 2 ticks) │     Solver     │ (Audit Log + Event Dispatch)          │  │
│  └─────────────────────────┘                └───────────────────────────────────────┘  │
└────────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │ Southbound REST (127.0.0.1:9090, Bearer Auth)
                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               DATA PLANE (apps/gateway)                                │
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Rate Limiter & Shaper Pipeline (20 ms tick, hrtime dt compensation)              │  │
│  │                                                                                  │  │
│  │  Slice 1 Queue (Clinic)   ──▶ Token Bucket ──┐                                   │  │
│  │  Slice 2 Queue (Factory)  ──▶ Token Bucket ──┤                                   │  │
│  │  Slice 3 Queue (Lab)      ──▶ Token Bucket ──┼──▶ [Root Bottleneck FIFO] ──▶ Rx  │  │
│  │  ...                                         │    (Offered Cap: 950 kbps)        │  │
│  │  Slice 7 Queue (Canteen)  ──▶ Token Bucket ──┘                                   │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│                                         ▲                                              │
│                     ┌───────────────────┴───────────────────┐                          │
│                     │ Load Sessions (:8080) & Probes (:8080)│                          │
│                     └───────────────────────────────────────┘                          │
└────────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │ Wi-Fi Hotspot (192.168.137.1) / Local LAN
                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT PLANE (apps/portal & apps/agent)                   │
│                                                                                        │
│  📱 Phone 1 (Clinic)     💻 Laptop (Quality Lab)      📱 Phone 7 (Canteen)             │
│     Slice Portal :8080       Headless Agent (CLI)         Slice Portal :8080           │
│     Active Prober (1s)       Active Prober (1s)           Active Prober (1s)           │
│     Demand Generator         Demand Generator             Demand Generator             │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Monorepo Structure

| Package / Application | Directory | Purpose | Technology Stack |
|---|---|---|---|
| `@cn/controller` | `apps/controller` | Control plane: policy engine, contention detection, CBHA arbitration, two-phase apply, audit trail, OpenAPI. | Node.js 24, TypeScript, Express, Zod, Pino |
| `@cn/gateway` | `apps/gateway` | Data plane: per-slice token bucket shaping, load streaming, active probe queuing, HTTP forward proxy, southbound server. | Node.js 24, TypeScript, `node:http`, `ws`, Zod |
| `@cn/portal` | `apps/portal` | Department user interface: join code authentication, demand slider/presets, live charts, SLA chips, degradation alerts. | React 18, Vite 5, TypeScript, Tailwind CSS, Recharts |
| `@cn/dashboard` | `apps/dashboard` | Operator console: interactive SVG topology map, QR code drawer, device manager, scenario runner, CSV recorder. | React 18, Vite 5, TypeScript, Tailwind CSS, Recharts |
| `@cn/agent` | `apps/agent` | Headless slice client: CLI and standalone `.exe` for automated testbed generation and multi-machine testing. | Node.js 24, TypeScript, Node Single Executable Application |
| `@cn/shared` | `packages/shared` | Shared contracts: Zod schemas, TypeScript interfaces, error types, bandwidth formatters (`formatBandwidth`). | TypeScript, Zod |

---

## 3. Port Map and Network Security

| Port | Bind Address | Exposure | Protocol / Role |
|---|---|---|---|
| **4000** | `0.0.0.0` | Local Subnet | **Controller API & Dashboard:** REST endpoints, Socket.IO updates, OpenAPI spec, production static asset server. |
| **5173** | `127.0.0.1` | Localhost | **Dashboard Dev Server:** Vite development server with hot-module reloading. |
| **8080** | `0.0.0.0` | Local Subnet | **Slice Gateway:** Portal static files, `/portal-api/*`, `/load/down`, `/probe`, and WebSocket `/ws`. |
| **8888** | `0.0.0.0` | Local Subnet | **HTTP Forward Proxy (optional, off by default):** forwards joined devices' HTTP and `CONNECT` traffic. Not shaped yet; see LIMITATIONS §2.3. |
| **9090** | **`127.0.0.1` only** | **Loopback Only** | **Southbound API:** Secure control interface between controller and gateway. Protected by Bearer token. |

> **Security Guardrail:** Port 9090 is strictly bound to `127.0.0.1`. Client devices on the Wi-Fi hotspot or local subnet cannot reach or tamper with the southbound control API.

---

## 4. The Closed-Loop Arbitration Lifecycle

Every 2 seconds, the platform executes an end-to-end feedback loop:

```mermaid
sequenceDiagram
    autonumber
    participant GW as Slice Gateway (:9090)
    participant ADP as GatewayTelemetryAdapter
    participant DET as ContentionDetector
    participant CBHA as PolicyEngine (CBHA)
    participant MGR as AllocationManager
    participant AUD as AuditService
    participant DB as Dashboard / Portal

    loop Every 2000 ms
        ADP->>GW: GET /v1/stats (Bearer Token)
        GW-->>ADP: Per-slice metrics (demand, used, latency, jitter, loss)
        ADP->>DET: Evaluate aggregate demand vs offered capacity (950 kbps)
        alt Ratio > 1.02 for 2 consecutive samples
            DET->>CBHA: Trigger Contention (shortage = carried traffic - 97% of capacity)
            CBHA->>CBHA: Water-fill on convex business harm (per-kbps marginal harm)
            CBHA-->>MGR: Feasible Plan (Degradation Allocations)
            MGR->>AUD: Record decision and rationales (Decision ID)
            MGR->>GW: PUT /v1/slices/:code/limit (Idempotent)
            GW-->>MGR: Limit applied (effectiveKbps)
            MGR->>DB: Broadcast new limits & degradation banners
        else Ratio <= 1.02 for 3 consecutive samples
            DET->>DET: Close the contention event
            MGR->>GW: Restore each cut slice when its recovery window ends (2-30 min) or on admin override
        end
    end
```

### 1. Sampling (`GatewayTelemetryAdapter`)
- Calls `GET /v1/stats` on the gateway Southbound API.
- Passes the gateway's kbps values straight into the engine's `...Mbps` fields: in this testbed **1 unit = 1 kbps**, and no conversion is needed because the engine does not depend on units.
- If the gateway is unreachable or missing data for a slice, marks health as `UNKNOWN`, preventing dangerous arbitration on stale metrics.

### 2. Contention Detection (`ContentionDetector`)
- Calculates aggregate demand ratio:
  $\text{Ratio} = \frac{\sum \text{Demand}}{\text{Offered Capacity} = 950\text{ kbps}}$
- Contention opens if $\text{Ratio} > 1.02$ for **2 consecutive samples** and closes after **3 clear samples** (hysteresis prevents flapping on transient spikes).
- The engine then sizes the cut on **carried** traffic, $\sum \min(\text{demand}_i, \text{limit}_i)$: demand that a slice's own limit already holds back is not counted twice. If current limits already fit the link (TC2), nothing is cut.

### 3. CBHA Optimization (`PolicyEngine`)
- Runs the immutable Convex Business-Harm Arbitration solver copied from SOURCE.
- Solves for the minimal business harm vector across the 7 departments subject to:
  1. Carried traffic after the cuts, $\sum \min(\text{demand}_i, \text{limit}_i) \le \text{Offered Capacity} \times (1 - 0.03) \approx 921.5\text{ kbps}$ (3 % headroom target).
  2. $\text{Allocated}_i \ge \text{Floor}_i$ (Contractual minimum guaranteed rate).
  3. $\text{Degradation}_i \le \text{Ceiling}_i$ (Max allowed degradation percentage).
  4. Clinic effective degradation ceiling is **0%** (Life-Safety exemption).

### 4. Two-Phase Apply & Audit
- Saves decision record in the immutable audit log with full explanation text.
- Sends idempotent `PUT /v1/slices/:code/limit` to the gateway.
- Southbound updates take effect within a single 20 ms scheduler tick.

### 5. Recovery
- The contention event closes after **3 clear samples** (demand ratio back at or below 1.02).
- Each cut slice is restored to its baseline when its **recovery window** ends. The window comes from the department's recovery tolerance: 2 min (low), 10 min (moderate) or 30 min (high). A recovery sweep checks every 5 s.
- An administrator can restore everything at once with **Override** on the decision page. The reason is recorded in the audit log.

---

## 5. Shaper Data Plane Architecture

The data plane in `apps/gateway` models a carrier-grade edge gateway / slice-aware User Plane Function (UPF):

```
Client Traffic In ──▶ [Slice Ingress Filter]
                             │
                             ├──▶ Slice Queue 1 (0.5 s × current limit)    ──▶ Token Bucket 1 ──┐
                             ├──▶ Slice Queue 2 (0.5 s × current limit)    ──▶ Token Bucket 2 ──┤
                             │    ...                                                            ├──▶ [Root Shared Queue] ──▶ Sockets Out
                             └──▶ Slice Queue 7 (0.5 s × current limit)    ──▶ Token Bucket 7 ──┘    (950 kbps Cap)
                                  (Over-rate → Slice Tail Drop)                                       (Over-rate → Root Tail Drop)
```

### High-Resolution Tick Scheduling
Windows default timer resolution (~15.6 ms) introduces scheduling jitter. The shaper overcomes this by computing actual elapsed high-resolution time on every tick:

```typescript
const nowNs = process.hrtime.bigint();
const dtSeconds = Number(nowNs - this.lastTickNs) / 1e9;
this.lastTickNs = nowNs;
```

### Token Bucket Logic
On each tick ($dt$ seconds):
Each bucket holds 0.1 s of its rate, but never less than one 1 KB chunk; otherwise a slice cut to 28 kbps (350 bytes of tokens) could never send its head chunk. Each slice queue holds 0.5 s of traffic at the slice's **current** limit, so a slice cut to its floor queues about 0.5 s, not several seconds.

1. **Refill Slice Buckets:**
   $$\text{Tokens}_i = \min\left(\text{Tokens}_i + \text{LimitBps}_i \times \frac{dt}{8}, \text{BurstBytes}_i\right)$$
2. **Refill Root Bucket:**
   $$\text{RootTokens} = \min\left(\text{RootTokens} + \text{OfferedBps} \times \frac{dt}{8}, \text{RootBurstBytes}\right)$$
3. **Police (Round-Robin):** Move up to 1 KB chunks from `sliceQueue_i` to `rootQueue` while $\text{Tokens}_i$ allow. If `rootQueue` is full, tail-drop occurs and increments `rootDropped_i`.
4. **Transmit:** Drain `rootQueue` in FIFO order while `RootTokens` allow. Write chunks to client sockets. If `socket.write()` returns `false`, pause session until `'drain'`.

---

## 6. Active Probe & SLA Engine

Probe measurements represent the ground-truth experience of each slice:

1. **In-Band Measurement:** Clients send `GET /probe?device=<id>&seq=<n>` every second (the portal and the agent default; `demo:local` uses 500 ms). The gateway injects a 64-byte probe payload directly into **that slice's FIFO queue**. If the slice is congested, the probe sits behind data packets, experiencing true queueing delay.
2. **Jitter:** the mean absolute difference between consecutive probe round-trip times in the last 4 s, $J = \frac{1}{n-1}\sum_{k=2}^{n} |RTT_k - RTT_{k-1}|$. This is in the spirit of RFC 3550 interarrival jitter, without its 1/16 smoothing.
3. **Loss Accounting:**
   $$\text{Loss } \% = \max\left(\frac{\text{Dropped Bytes}}{\text{Offered Bytes}}, \frac{\text{Lost Probes}}{\text{Sent Probes}}\right) \times 100$$
4. **Availability:** Rolling 5-minute ratio of answered probes to dispatched probes.
5. **No Made-Up Numbers:** If a slice has no active devices sending probes, metrics report `null` / `UNKNOWN`. The dashboard displays `—`.

---

## 7. Zero-Dependency & Sandboxed Windows Adaptations

To comply with strict environment constraints (Windows 11, Node 24, zero native add-ons, sandbox execution):
- **QR codes:** generated with the standard `qrcode` npm package (pure JavaScript, no native bindings), for both the dashboard and `npm run lan:info`. An earlier hand-written encoder produced codes that phones could not scan and was removed.
- **Node 24 Sandboxed Realpath Preload (`scripts/patch-realpath.cjs`):** Transparently patches `fs.realpathSync.native` to `fs.realpathSync`, circumventing Windows security sandbox `EPERM` limitations.
- **Dynamic Adapter Introspection:** Dynamically probes `os.networkInterfaces()` for hosted networks, Mobile Hotspot aliases, and local LAN adapters at runtime, eliminating hard-coded IP dependencies.
