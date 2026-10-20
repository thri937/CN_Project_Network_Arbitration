# Build prompt — CN_Real_Network_arbitration

You are building a complete, working project in this folder:
`D:\CN project\CN project\CN_Real_Network_arbitration`

Read this whole file before writing any code. Everything you need is here. Your only job is to
build the project described below, completely and correctly, with tests and docs.

---

## 0. Ground rules

1. **Reuse the existing project. Do not rewrite the algorithm.** A finished, tested simulator
   already exists at `D:\CN project\CN project\CN` (call it **SOURCE**). Copy what this prompt
   tells you to copy. **Never modify anything inside SOURCE.**
2. **Do not change the business rules.** The rule files you copy must stay identical:
   `domain/policyEngine.ts`, `domain/arbitration/*`, `constants/tunables.ts`, `constants/enums.ts`
   and the policy model. That covers the weights, ceilings, harm curve, solver, contention
   thresholds, cooldown, quantum and headroom. If you think one of them must change, stop and write
   the reason in `docs/OPEN-QUESTIONS.md` instead.
3. **Every number shown in gateway mode must be measured from real traffic.** If something is
   unknown, show `—` or `UNKNOWN`. Never fill a gap with a made-up number.
4. **No cloud and no paid services.** That means no Firebase, no hosted database and no external
   APIs, apart from the optional internet traffic source in §8.6.
5. **No native npm modules.** Installation must work on Windows 11 with Node.js 24 and npm only.
6. **Do not change system settings yourself.** That includes the firewall, the hotspot and
   adapters. Write PowerShell scripts and docs for the user to run as administrator.
7. **Don't hard-code an IP address.** Find the laptop's LAN/hotspot IP at runtime.
8. Use `git init` in this folder and commit after each phase. Don't add a remote and don't push.
9. If you get stuck on something outside your control (hardware, permissions), record it in
   `docs/OPEN-QUESTIONS.md` and continue with the rest.

**Machine:** Windows 11 laptop, Node.js v24.11.1, PowerShell 5.1, Git Bash available.

---

## 1. What we are building

SOURCE is a **runtime arbitration platform for contended enterprise network slices**. Each
department of a company gets a network slice. When the network is overloaded, the engine decides
which slices to slow down, and by how much, using **business value**: criticality, cost of
downtime, compliance, recovery tolerance. It does not just follow the network QoS label. It
explains and audits every decision. In SOURCE the network is **simulated**.

This project moves it onto a **real network**:

- **The main laptop is the network.** It runs a Windows Mobile Hotspot (shared from the user's
  Wi-Fi ISP connection). It also runs a **slice gateway** that carries real traffic and enforces a
  real bandwidth limit for each slice.
- **There are 7 departments, so 7 slices and 7 client devices.** These are phones or laptops
  joined to the hotspot. Browser tabs or agents on the main laptop also work.
- **Each device opens a website (the "slice portal")** served by the gateway. It joins its
  department's slice there and **generates real load** (demand) on that slice.
- **The total link is 1 Mbps instead of 10 Gbps.** Every bandwidth number from SOURCE is scaled
  down by the same factor. All business rules stay the same.
- The **controller** is SOURCE's backend. It reads real measurements from the gateway, detects
  contention, runs the same arbitration engine and pushes new per-slice limits back to the gateway.
  The gateway enforces them on live traffic straight away.

```
                    ISP Wi-Fi (internet)
                           │
            ┌──────────────┴───────────────────────────────────────────────┐
            │ MAIN LAPTOP (Windows 11, Mobile Hotspot 192.168.137.1)       │
            │                                                              │
            │  ┌────────────────────┐ southbound REST ┌──────────────────┐ │
            │  │ CONTROLLER :4000   │ 127.0.0.1:9090  │ SLICE GATEWAY    │ │
            │  │ (SOURCE backend)   │ ──────────────▶ │  :8080 portal +  │ │
            │  │ contention → CBHA  │  limits, stats  │        load +    │ │
            │  │ → 2-phase apply    │ ◀────────────── │        probes    │ │
            │  │ audit, Socket.IO   │                 │  :8888 HTTP proxy│ │
            │  └─────────┬──────────┘                 │  HTB shaper: 7   │ │
            │            │                            │  slice queues +  │ │
            │   DASHBOARD (SOURCE frontend)           │  1 Mbps root cap │ │
            │   operator view :5173 / :4000           └────────┬─────────┘ │
            └──────────────────────────────────────────────────┼───────────┘
                                         hotspot Wi-Fi (real)  │
          ┌───────────┬───────────┬───────────┬────────────────┼───────┬───────────┐
       Clinic      Factory    Quality lab  Warehouse      Security  Office IT    Canteen
       phone       phone       laptop       phone          phone     laptop       phone
     (portal)    (portal)    (portal/agent) (portal)       (portal)  (portal)     (portal)
```

---

## 2. What "real" means here (put this honestly in the docs)

- **Real:** the Wi-Fi, the devices, the TCP connections and the bytes on the wire. The gateway
  really enforces each slice's rate and the total 1 Mbps link capacity. Throughput, queueing delay,
  latency, jitter, loss and availability are all measured. Limits change live after arbitration.
- **Emulated:** "slicing" is enforced at an **application-layer gateway**, which plays the role of a
  slice-aware UPF or SD-WAN edge. It is not 3GPP radio slicing, and the shared Wi-Fi medium itself
  is not partitioned. The 1 Mbps link is a cap enforced by the gateway. The ISP is normally faster;
  the docs must say so, and the gateway must warn if the measured ISP speed is lower than the cap
  (see §8.6).
- 3GPP identifiers (S-NSSAI = SST + SD) are kept as slice metadata, exactly as in SOURCE.

---

## 3. Physical setup (put this in `docs/TESTBED.md`)

1. The main laptop connects to the home Wi-Fi (the ISP).
2. Turn on **Settings → Network & internet → Mobile hotspot** and share the Wi-Fi connection.
   Windows allows up to **8 devices**: 7 slice devices plus 1 spare. The laptop's hotspot address is
   usually `192.168.137.1`; detect it at runtime.
3. **Fallback:** if the Wi-Fi adapter can't host a hotspot, put all devices and the laptop on the
   same home router. Everything still works using the laptop's LAN IP.
4. The user runs `scripts/windows/open-firewall.ps1` as administrator. It opens inbound TCP 8080
   and 8888, plus 4000 if they choose, for `LocalSubnet` only. `close-firewall.ps1` removes the rules.
5. Each device opens `http://<laptop-ip>:8080/join`, or scans the QR code on the dashboard, and
   enters its department's join code.
6. **Single-laptop mode:** 7 browser tabs, or `npm run demo:local`, on the main laptop. Traffic then
   uses loopback instead of Wi-Fi, but it is still fully shaped and measured. Say so in the UI.

---

## 4. Units and scaling

- **Testbed unit: 1 unit = 1 kbps.** The engine doesn't care about units. Feed it kbps values in
  the fields named `*Mbps`. **Do not rename fields in the copied code.** Show "kbps" in all UIs
  through one formatter (see §9.3).
- `NETWORK_TOTAL_CAPACITY_MBPS=1000` (that is, 1000 kbps = 1 Mbps) and
  `NETWORK_RESERVED_CAPACITY_MBPS=50`. **Offered capacity is 950 kbps.**
- **Scale factor:** `s = NETWORK_TOTAL_CAPACITY_MBPS / 10000`. Each slice's bandwidth value is the
  SOURCE value in Mbps × `s`. With 1 Mbps, `s = 0.1`, so SOURCE's 600 Mbps becomes 60 kbps.
- The seed must **compute** slice values from `s`, not hard-code them. That way the user can set
  `NETWORK_TOTAL_CAPACITY_MBPS=8000` if they meant 1 MB/s (= 8 Mbps), and everything scales.
- Leave the ratios alone: total baselines are 156 % of offered capacity, and floors are about 50 %.
  This is the oversubscription that creates contention.
- **The reserved 50 kbps is not offered to slices.** Management traffic (portal HTML/JS, API calls,
  WebSockets) is **exempt from shaping** and counted separately, like out-of-band OAM. Slice data
  and slice probes are shaped.

---

## 5. The 7 departments and 7 slices

### 5.1 Departments (copied unchanged from SOURCE `backend/src/scripts/seed.ts`)

| Department  | Criticality          | Importance | Downtime £/min | Recovery tol. | Max degr. % | Compliance  | Customer impact | Op. importance |
|-------------|----------------------|-----------:|---------------:|---------------|------------:|-------------|-----------------|---------------:|
| Clinic      | MISSION_CRITICAL     | 100        | 25,000         | ZERO          | 0           | LIFE_SAFETY | SEVERE_EXTERNAL | 100            |
| Factory     | MISSION_CRITICAL     | 94         | 8,400          | LOW           | 15          | CONTRACTUAL | DIRECT          | 96             |
| Quality lab | BUSINESS_CRITICAL    | 68         | 1,600          | LOW           | 20          | REGULATED   | DIRECT          | 70             |
| Warehouse   | BUSINESS_CRITICAL    | 72         | 2,100          | MODERATE      | 35          | INTERNAL    | INDIRECT        | 78             |
| Security    | BUSINESS_OPERATIONAL | 58         | 700            | MODERATE      | 40          | CONTRACTUAL | INTERNAL_ONLY   | 66             |
| Office IT   | BUSINESS_OPERATIONAL | 52         | 900            | MODERATE      | 45          | INTERNAL    | INTERNAL_ONLY   | 55             |
| Canteen     | BEST_EFFORT          | 8          | 15             | HIGH          | 80          | NONE        | NONE            | 10             |

Copy the remaining department fields (owner email, site, tags) from SOURCE's seed.

### 5.2 Slices: one per department (values at 1 Mbps, s = 0.1)

SOURCE has 9 slices. Factory and Warehouse have two each. **Merge each department's slices into
one** by adding up baseline, floor and burst. Keep the S-NSSAI and profile of the more critical
original slice. This keeps the total baseline (1,480) and total floor (473) the same as SOURCE × s.

| # | Department  | Slice name            | Merged from                    | S-NSSAI (SST/SD) | Profile | Baseline | Floor | Max burst |
|---|-------------|-----------------------|--------------------------------|------------------|---------|---------:|------:|----------:|
| 1 | Clinic      | Patient Telemetry     | Patient Telemetry              | 2 / 000101       | URLLC   | 60       | 40    | 90        |
| 2 | Factory     | Factory Automation    | Motion Control + Machine Vision| 2 / 000201       | URLLC   | 380      | 170   | 580       |
| 3 | Quality lab | Lab Instrumentation   | Lab Instrumentation            | 1 / 000401       | eMBB    | 180      | 50    | 260       |
| 4 | Warehouse   | Warehouse Operations  | AGV Fleet + Warehouse IoT      | 2 / 000301       | URLLC   | 160      | 55    | 250       |
| 5 | Security    | CCTV                  | CCTV                           | 1 / 000601       | eMBB    | 240      | 60    | 360       |
| 6 | Office IT   | Office Wi-Fi          | Office Wi-Fi                   | 1 / 000501       | eMBB    | 320      | 70    | 500       |
| 7 | Canteen     | Canteen Signage       | Canteen Signage                | 2 / 000701       | URLLC   | 140      | 28    | 200       |
|   | **Total**   |                       |                                |                  |         | **1,480**| **473**| 2,240    |

The **effective degradation ceiling** is the tighter of the department's own limit and its
compliance ceiling. The engine computes it; don't re-implement it. The results are: Clinic 0 %
(exempt), Factory 15 %, Quality lab 20 %, Warehouse 35 %, Security 40 %, Office IT 45 %,
Canteen 80 %.

Canteen Signage is labelled **URLLC** but has the lowest business value. Lab Instrumentation is
labelled **eMBB** but is regulated. Keep this mismatch: it is the project's main point.

### 5.3 SLA targets, re-baselined for a 1 Mbps Wi-Fi testbed

SOURCE's latency targets (5–150 ms) assume a 10 Gbps link. At 1 Mbps, plus Wi-Fi, plus an
application gateway, they can't be met. Bandwidth targets scale by `s`. Time targets use these
fixed rules, documented in TESTBED.md. For merged slices, use the tighter of the two originals.

- latency target = 100 ms + 10 × SOURCE latency
- jitter target = 20 ms + 5 × SOURCE jitter
- loss target = clamp(10 × SOURCE loss, 0.1 %, 10 %)
- minimum throughput = s × SOURCE throughput (summed for merged slices)
- availability is unchanged

| Slice                | Latency ms | Jitter ms | Loss % | Min throughput kbps | Availability % |
|----------------------|-----------:|----------:|-------:|--------------------:|---------------:|
| Patient Telemetry    | 150        | 25        | 0.1    | 40                  | 99.999         |
| Factory Automation   | 180        | 30        | 0.1    | 150                 | 99.99          |
| Lab Instrumentation  | 500        | 70        | 3      | 45                  | 99.9           |
| Warehouse Operations | 250        | 40        | 0.5    | 45                  | 99.95          |
| CCTV                 | 900        | 145       | 8      | 50                  | 99.0           |
| Office Wi-Fi         | 600        | 95        | 5      | 60                  | 99.5           |
| Canteen Signage      | 350        | 60        | 10     | 8                   | 98.0           |

**Calibration step** (`npm run calibrate`, and also on the dashboard): measure each connected
device's idle probe RTT for 30 s. If an idle p95 exceeds 60 % of a slice's latency target, print a
warning. Record measured idle RTTs in `docs/TESTBED.md`. Don't silently change targets.

---

## 6. Architecture

### 6.1 Components

| Component | Folder | Built from | Role |
|---|---|---|---|
| **Controller** | `apps/controller` | copy of SOURCE `backend/` | Control plane: policy engine, contention detection, CBHA arbitration, two-phase apply, recovery, audit, REST + Socket.IO, OpenAPI |
| **Dashboard** | `apps/dashboard` | copy of SOURCE `frontend/` | Operator UI, plus a new Testbed page (§11) |
| **Slice gateway** | `apps/gateway` | new | Data plane: per-slice shaping, load sessions, probes, measurement, HTTP proxy, southbound API, serves the portal |
| **Slice portal** | `apps/portal` | new | The website each department device opens: join, set demand, see live slice health |
| **Slice agent** | `apps/agent` | new | Headless CLI and `.exe` that acts as a slice device (for laptops and `demo:local`) |
| **Shared** | `packages/shared` | new | Zod schemas and TS types for the southbound and portal APIs, unit formatter |

### 6.2 Ports

| Port | Bind | Who uses it |
|---|---|---|
| 4000 | 0.0.0.0 | Controller API + Socket.IO; also serves the built dashboard in `npm start` |
| 5173 | localhost | Dashboard dev server (`npm run dev`) |
| 8080 | 0.0.0.0 | Gateway: portal, `/portal-api/*`, `/load/*`, `/probe`, `/ws` (devices only need this one) |
| 8888 | 0.0.0.0 | Gateway HTTP/HTTPS forward proxy (optional "real apps" mode) |
| 9090 | **127.0.0.1 only** | Gateway southbound API for the controller, protected by a bearer token |

### 6.3 Control loop (unchanged from SOURCE, now on real data)

Every 2 s the controller samples the gateway. Contention **opens** when total demand ÷ offered
capacity is above 1.02 for 2 samples, and **closes** after 3 clear samples. When it opens, the
CBHA engine runs on **carried traffic** (min(demand, limit)), with a 3 % headroom target and a
20 s cooldown. The plan goes through two phases: save the decision, then send a PUT to the gateway,
then reconcile with what the gateway reports it enforced. When contention clears, recovery restores
limits towards baseline. All of this already exists in SOURCE; you are only connecting it to the
gateway.

---

## 7. Reuse plan (Phase 0)

Copy from SOURCE into this folder, **excluding** `node_modules`, `dist`, `coverage`, `.data`,
`backend/.data`, `paper/`, `video/`, `*.pptx`, `progress/` and `.git`:

- `SOURCE/backend/` → `apps/controller/`
- `SOURCE/frontend/` → `apps/dashboard/`
- `SOURCE/docs/ALGORITHM.md` and `SOURCE/docs/TECHNICAL.md` → `docs/source/` (reference)

Set up npm **workspaces** at the root: `apps/*` and `packages/*`. After copying,
`npm install && npm test -w apps/controller` must pass **all copied tests unchanged** before you
continue. The copied tests use their own scenario numbers, so leave the defaults in `env.ts` as they
are. Testbed values go only in `.env`.

Keep SOURCE's synthetic provider working. `TELEMETRY_PROVIDER=synthetic` must still run the whole
app without a gateway, for offline development.

---

## 8. Slice gateway (`apps/gateway`): the data plane

Node.js + TypeScript, using `node:http`, `node:net`, `ws`, `pino` and `zod`. No Express is needed
here, but it's allowed. Structure it as modules: `shaper/`, `sessions/`, `probes/`, `meter/`,
`proxy/`, `southbound/`, `portal-api/`, `static/`.

### 8.1 Slice catalogue

On startup (and whenever slices change), the controller sends the slice catalogue with
`PUT /v1/slices`. It contains: code, name, department, S-NSSAI, profile, baseline, floor, burst,
current limit, SLA targets and join code. Until the catalogue arrives, the gateway serves a portal
page that says "waiting for controller".

### 8.2 The shaper: per-slice limits feeding one shared 1 Mbps link

Model a real edge: **each slice has its own queue and token bucket (its limit)**, and they all feed
**one shared bottleneck link** (the root) at the offered capacity. Run one scheduler loop. Use a
20 ms tick, but work out `dt` from `process.hrtime.bigint()` so that Windows timer jitter doesn't
change the rate.

```
per slice i:  limitBps_i (from controller), tokens_i, burstBytes_i = limitBps_i × 0.1 s / 8
              sliceQueue_i (FIFO of ≤1 KB chunks + probe entries), capacity 0.5 s × baselineBps_i / 8
root link:    offeredBps = (TOTAL − RESERVED) × 1000, rootTokens, burst = offeredBps × 0.1 s / 8
              rootQueue (ONE shared FIFO, entries tagged with their slice), capacity 0.5 s × offeredBps / 8

each tick (dt seconds):
  1. ARRIVALS  for every active load session s in slice i: add s.offeredBps × dt / 8 bytes to sliceQueue_i
               (local mode: generated bytes; internet mode: bytes read from upstream)
               overflow → tail-drop; sliceDropped_i += excess
  2. REFILL    tokens_i = min(tokens_i + limitBps_i × dt/8, burstBytes_i); same for rootTokens at offeredBps
  3. POLICE    round-robin over slices: move chunks from sliceQueue_i into rootQueue while tokens_i allow
               (this enforces each slice's limit); rootQueue full → tail-drop; rootDropped_i += bytes
  4. TRANSMIT  drain rootQueue in FIFO order while rootTokens allow; write each chunk to its session's socket
               (socket.write() false → hold that session until 'drain'); sent_i += bytes
  5. METER     arrivals, sent, both drop counters, both queue depths, and queueing delay of every probe
```

Add `GATEWAY_ROOT_DISCIPLINE=fifo|drr`. The default `fifo` is a plain shared link. `drr` is a
weighted fair-queueing link (DRR, quantum proportional to the limit). It is an experiment option:
fair queueing already shields lightly loaded slices, so the A/B effect in TC6 is smaller. Report
both if time allows.

Required behaviour:

- **Before arbitration** the limits add up to 1,480 kbps, which is more than the 950 kbps link. The
  shared root queue fills, so **every** slice gets queueing delay and drops, including Clinic. This is
  the "generic network" behaviour the project improves on.
- **After arbitration** the traffic the limits let through (Σ min(demand, limit)) is about 921 kbps,
  which is under the link rate. The root queue drains, protected slices see low latency again, and
  only the degraded slices queue and drop, in their own slice queues.
- A limit change through the southbound PUT takes effect **within one tick**. PUT is **idempotent**.
- **Accuracy:** for a saturated slice on an uncongested link, the measured sent rate must be within
  ±3 % of its limit over any 10 s window, at limits from 20 to 950 kbps (unit-tested). The root
  must never send faster than the offered capacity.
- Write chunks of at most 1 KB, so a probe never waits behind a large chunk.

### 8.3 Load sessions (how a device creates demand)

- `GET /load/down?device=<id>&rate=<kbps>&mode=local|internet` returns a streaming
  `application/octet-stream` response. The session's **offered rate** is `rate`. Data enters the
  slice queue at that rate, and the shaper decides what gets through.
- `PATCH /portal-api/sessions/<id> {rate}` changes the rate live without reconnecting.
- One download session per device is enough. A device may have up to 2.
- Upload is **optional (phase 6+)**. If you build it, use a WebSocket binary stream with
  backpressure. Fetch streaming uploads don't work over plain HTTP/1.1 in browsers.
- **A slice's demand** is the arrival rate into its queue. For generated load, that is the sum of
  its sessions' offered rates. For proxy traffic, see §8.7. This matches SOURCE's definition: demand
  is what the slice tries to send, and it does not fall when the slice is limited.

### 8.4 Probes: real latency, jitter, loss, availability

- Each portal or agent sends `GET /probe?device=<id>&seq=<n>` every 500 ms. The gateway puts a
  64-byte response **into that slice's queue**, so it waits behind that slice's data. Latency
  therefore goes up when the slice is congested, which is real queueing delay.
- The client measures the RTT and sends a batch to the gateway every 2 s through
  `POST /portal-api/probe-results`. This is management traffic and is exempt from shaping. A probe
  with no answer within 2 s counts as **lost**.
- For each 2 s window and slice, the gateway computes:
  - latency = p95 client RTT (also keep p50);
  - jitter = mean absolute difference between consecutive RTTs (as in RFC 3550);
  - loss % = max((slice + root dropped bytes) ÷ offered bytes, lost probes ÷ sent probes) × 100;
  - availability % = answered probes ÷ sent probes over a rolling 5 minutes.
- If no device in a slice reports probes, report latency, jitter and availability as **unknown**.
  The controller then marks the slice's health `UNKNOWN`. Do not report 0.

### 8.5 Device binding and join codes

- Each slice has a 6-character join code, created by the controller and shown on the dashboard
  with a QR code for `http://<laptop-ip>:8080/join?code=XXXXXX`.
- `POST /portal-api/join {code, nickname}` returns `{deviceId, slice}`. The portal stores
  `deviceId` in **sessionStorage**, which is per tab, so several tabs on one laptop can be different
  slices. It sends `deviceId` with every request.
- The gateway records each device's id, nickname, source IP, slice, user agent and last-seen time.
  A device with no requests for 15 s is marked offline.

### 8.6 Internet mode (uses the real ISP)

- With `mode=internet`, the gateway reads from `INTERNET_SOURCE_URL` at the session's offered rate,
  pausing and resuming the upstream stream to keep that rate. The default is Cloudflare's public
  speed-test endpoint `https://speed.cloudflare.com/__down?bytes=25000000`. The bytes go into the
  slice queue, so the traffic comes through the user's ISP. When the response ends, reopen it.
- The portal must show a data-used counter and a warning, because 1 Mbps for an hour is about
  450 MB.
- At startup, `npm run isp:check` (and also on the dashboard) downloads 2 MB and reports the ISP
  speed. If it is below the configured capacity, warn that the ISP, not the gateway, is the
  bottleneck.
- **Local mode is the default.** It uses no ISP data.

### 8.7 Proxy mode (optional): real apps on a phone go through the slice

- Run an HTTP forward proxy on `:8888` that supports `CONNECT` for HTTPS. On the phone, set the
  Wi-Fi network's proxy to `<laptop-ip>:8888`.
- Map traffic to a slice by **source IP**, which must already be bound to a device (one slice per
  IP in proxy mode). Pace both directions of a tunnel through the slice's bucket, using TCP
  backpressure (pause and resume) instead of dropping.
- Unknown IPs get an HTTP 403 page: "Join a slice first at http://<laptop-ip>:8080/join".
- Proxy demand is an estimate. Use the measured upstream read rate. If the slice's proxy backlog
  stayed above 50 % of its buffer during the window, report demand = max(read rate, 1.1 × limit)
  and set `saturated: true`. Explain this estimate in LIMITATIONS.md.
- A phone speed test through the proxy (for example fast.com) should show about the slice's limit.

### 8.8 Southbound API (`127.0.0.1:9090`, header `Authorization: Bearer $GATEWAY_TOKEN`)

| Method & path | Body / response |
|---|---|
| `GET /v1/health` | `{ok, uptimeS, version}` |
| `GET /v1/capacity` | `{totalKbps, reservedKbps, offeredKbps, unit:'kbps', source:'configuration', ispKbps?}` |
| `PUT /v1/slices` | full catalogue (§8.1) → `{accepted}` |
| `GET /v1/stats` | per slice for the last 2 s window: `{code, atMs, demandKbps, limitKbps, usedKbps, droppedKbps, queueMs, latencyP50Ms, latencyP95Ms, jitterMs, lossPct, availabilityPct, activeDevices, activeSessions, saturated}` |
| `PUT /v1/slices/:code/limit` | `{limitKbps, decisionId, reason}` → `{applied, effectiveKbps}` (idempotent) |
| `GET /v1/devices` | bound devices |
| `POST /v1/slices/:code/demand` | operator remote control `{kbps, mode}`: pushed over `/ws` to that slice's devices that have "allow operator control" switched on |

Validate every body with zod schemas from `packages/shared`.

### 8.9 Portal API and realtime (`:8080`)

`/portal-api/*` covers join, session control, probe results and the slice snapshot. `/ws` is a
WebSocket that pushes, about once a second, the device's slice snapshot: limit, demand, used, SLA
values against targets, health, and the **latest decision reason**. The reason comes from the
`reason` and `decisionId` fields of the controller's limit PUT. Show the original English text from
SOURCE, such as "Limit lowered from 140 to 28 kbps, shedding 112 kbps of the 140 kbps it was
carrying (80% of its baseline)".

---

## 9. Controller changes (`apps/controller`)

Change only these things. Everything else stays as copied.

### 9.1 Gateway telemetry adapter

Add `TelemetryProviderKind.GATEWAY = 'gateway'` and
`src/telemetry/adapters/gateway.telemetry.adapter.ts`, which implements `INetworkTelemetryPort`.
Register it in `src/telemetry/index.ts` and select it with `TELEMETRY_PROVIDER=gateway`.

- `capabilities()` returns `{enforcement:true, computeMetrics:false, capacityDiscovery:true, streaming:false, nominalSampleAgeMs:2000}`.
- `sample()` calls `GET /v1/stats` and maps the result to `SliceTelemetry`:
  - `demandMbps ← demandKbps`
  - `usedMbps ← usedKbps`
  - `allocatedMbps ← limitKbps`
  - `latencyMs ← latencyP95Ms`
  - `jitterMs`
  - `packetLossPercent ← lossPct`
  - `activeSessions`
  - `utilisation = used / limit`
  - `cpuPercent` and `memoryPercent` set to 0 (computeMetrics is false)
  - extras: p50, queueMs, droppedKbps, availabilityPct, activeDevices, saturated

  Compute health with SOURCE's existing `assessHealth`. **It must return one entry per subject.** If
  the gateway is unreachable or a slice is missing, return `health: UNKNOWN` (the port's contract),
  so the platform's stale-telemetry confidence logic stops it from arbitrating on missing data.
- `applyAllocation()` sends one `PUT /v1/slices/:code/limit` per command and returns
  `effectiveKbps` as `effectiveMbps`. It must be idempotent.
- `describeCapacity()` calls `GET /v1/capacity`. `ping()` calls `GET /v1/health`.
- When the controller starts, and whenever a slice changes, push the catalogue (§8.1) to the gateway.

### 9.2 Testbed seed

Replace the seed's department and slice set with §5: 7 departments and 7 slices, values computed
from `s`, SLA targets from §5.3, and a join code per slice. Keep SOURCE's current users and
role-based sign-in (admin / manager / viewer) exactly as they are.

### 9.3 Units in the UI

Add `BANDWIDTH_UNIT=kbps` to the controller env and return it from the capacity endpoint. In the
dashboard, replace every hard-coded Mbps or Gbps label and formatter with one
`formatBandwidth(value, unit)`. It should show "kbps" for this testbed, and "Mbps" when
`TELEMETRY_PROVIDER=synthetic` with the default env.

### 9.4 New testbed endpoints (MANAGER+ unless noted; add them to the OpenAPI docs)

- `GET /api/v1/testbed/status` (VIEWER+): gateway health, LAN IPs, ISP check, capacity, devices per slice.
- `GET /api/v1/testbed/devices` (VIEWER+) and `DELETE /api/v1/testbed/devices/:id` (unbind).
- `POST /api/v1/testbed/slices/:id/join-code/rotate`.
- `POST /api/v1/testbed/slices/:id/demand {kbps, mode}`: operator remote control, through the gateway.
- `POST /api/v1/testbed/scenarios/:name/run`: runs a TC timeline from §12.3 through operator demand control.
- `PUT /api/v1/testbed/arbitration {enabled}`: turns automatic arbitration on or off at runtime (A/B testing).
  Reuse SOURCE's `AUTO_ARBITRATION` behaviour or settings service. Audit every toggle.
- `POST /api/v1/testbed/experiments {name}`, `POST …/:id/stop`, `GET …/:id.csv`: records every tick
  (§13).
- `POST /api/v1/telemetry/load` (synthetic only) must return **409** with a clear message in
  gateway mode.

---

## 10. Slice portal (`apps/portal`): the department website

React 18 + Vite 5 + TypeScript + Tailwind + Recharts, built to static files and served by the
gateway on `:8080`. It must work well on a 360 px wide phone in Chrome and Safari. Add a
`manifest.webmanifest` so users can "Add to Home screen" like an app. HTTPS is not required, so
don't depend on a service worker.

Pages:

1. **`/join`**: a join-code box (prefilled from `?code=`) and a nickname field. It shows the
   department and slice the code belongs to before the user confirms.
2. **`/slice`**: the main page.
   - **Header:** department, slice name, S-NSSAI, profile badge (URLLC/eMBB/mMTC) and a
     connected-devices count.
   - **Big status card:** "Your limit now: **X kbps**", baseline, floor, and a state of NORMAL,
     DEGRADED (−N %) or PROTECTED.
   - **Demand control:** a slider from 0 to 2 × baseline in kbps, plus preset buttons:
     - Idle 0 %
     - Light 30 %
     - Normal 55 %
     - Busy 80 %
     - Peak 100 %
     - Flood 200 % of baseline

     Also: a Local/Internet mode switch with a data-used counter, a Start/Stop button and an
     "Allow operator control" switch.
   - **Live chart** (last 2 minutes, 1 s points): my demand, slice limit, received rate (measured
     in the browser) and latency.
   - **SLA chips:** latency, jitter, loss, throughput and availability, each showing measured
     against target, coloured green, amber or red.
   - **Degradation banner:** when the slice is degraded, show the controller's reason text and
     decision id, and a note that it was a business-priority decision.
   - **Footer:** "This testbed enforces slices at the laptop gateway on real Wi-Fi traffic."
3. **Errors:** a clear screen if the gateway is unreachable, the code is invalid, or the controller
   is waiting. Reconnect automatically.

---

## 11. Dashboard additions (`apps/dashboard`)

Keep every existing SOURCE page. Add a **Testbed** page, and link it in the navigation after
Dashboard:

- **Topology:** the laptop gateway in the centre and 7 slice nodes around it. Each node shows its
  live health colour, the number of connected devices, and used/limit kbps. Draw it as SVG; no
  extra library is needed.
- **Join panel:** for each slice, its join code and a QR code (`qrcode` npm package) for
  `http://<laptop-ip>:8080/join?code=…`, with a Rotate button.
- **Devices table:** nickname, IP, slice, mode, rate, last seen, and an Unbind button.
- **Operator control:** a demand slider per slice, scenario buttons (TC1–TC6 from §12.3) and an
  "Automatic arbitration ON/OFF" switch.
- **Live chart for all slices:** demand vs limit vs used, with a capacity line at 950 kbps.
- **Experiment recorder:** Start/Stop and Download CSV.
- **Testbed health:** gateway up/down, ISP check result, and calibration result.

---

## 12. Agent, demo and test scenarios

### 12.1 Slice agent (`apps/agent`)

A CLI that does exactly what the portal does (join, download session, probes, reporting), headless:

```
slice-agent --gateway http://192.168.137.1:8080 --code K7P2QX --name lab-laptop --rate 180 --mode local
```

It prints a live line every 2 s with limit, received rate, RTT p50/p95 and loss. Build a Windows
single executable with Node SEA: `npm run build:agent:exe` produces `dist/slice-agent.exe`. If the
SEA build fails on this machine, record that in OPEN-QUESTIONS.md and document
`npx tsx apps/agent/src/index.ts` as the fallback.

### 12.2 `npm run demo:local`

This starts the controller, gateway and 7 agents (one per slice) on localhost, then runs the TC
timeline below, printing a readable summary and writing an experiment CSV. It must work with no
phones at all.

### 12.3 Test cases (scenario names used by the dashboard and `demo:local`)

Expected arbitration outcomes must come from **running the engine** on the seeded numbers, in a
golden unit test. Write the computed numbers into `docs/TESTBED.md`; never write them by hand.

| TC | Name | Setup | Pass criteria |
|---|---|---|---|
| TC1 | Normal day | All 7 at Normal (55 %): about 814 kbps, ratio ≈ 0.86 | No contention; all SLAs green; used ≈ demand (±5 %) |
| TC2 | Canteen flood, contained | Canteen at Flood (280), others Normal | Canteen held at its 140 kbps limit; others unaffected. If carried load fits, the engine records "not required"; check the logged decision either way |
| TC3 | Lunch-hour rush | Canteen Flood, Office Peak, CCTV Peak, Warehouse Busy, Lab/Factory/Clinic Normal | Contention opens within ≤ 6 s; plan applied; degraded slices' used rate within ±10 % of new limits within 6 s; Clinic untouched; protected slices' latency p95 back under target within 10 s |
| TC4 | Everyone at peak | All 7 at Peak | Plan is PARTIAL with an escalation; **no** slice cut beyond its ceiling or floor; Clinic never cut; operator notified |
| TC5 | Recovery | After TC3, set Canteen, Office and CCTV back to Normal | Contention closes after 3 clear samples; limits restored towards baseline; audit trail shows restore |
| TC6 | A/B proof | TC3 with arbitration OFF for 60 s, then ON for 60 s | CSV shows Clinic/Factory/Lab latency p95 and loss worse with OFF than with ON; summary table in TESTBED.md |
| TC7 | Device leaves | Turn off Wi-Fi on one phone during TC1 | Device offline within 15 s; that slice's demand drops; availability falls; health becomes UNKNOWN if no device remains |
| TC8 | Gateway down | Stop the gateway for 20 s | Controller marks telemetry stale and does not arbitrate on stale data; apply attempts fail and are retried; recovers by itself when the gateway returns |
| TC9 | Real app via proxy | Phone uses proxy :8888 and runs a speed test | Measured speed ≈ slice limit (±15 %); changing the limit changes the speed test result |

---

## 13. Experiment recording (for the paper)

Each tick appends rows with these columns: `t_ms, scenario, arbitration_on, slice, demand_kbps,
limit_kbps, used_kbps, dropped_kbps, queue_ms, latency_p50_ms, latency_p95_ms, jitter_ms,
loss_pct, availability_pct, devices, contention_state, decision_id`. Save to
`experiments/<timestamp>-<name>.csv` and make it downloadable from the dashboard.

`npm run experiment:summary -- <csv>` prints and saves (as Markdown) the mean and p95 of latency,
loss and used/limit per slice and per arbitration state.

---

## 14. Configuration (`.env.example` at the root, documented line by line)

```
# Controller
NODE_ENV=development
PORT=4000
DATASTORE_DRIVER=memory
AUTH_DRIVER=dev
TELEMETRY_PROVIDER=gateway          # synthetic = offline simulator from SOURCE
NETWORK_TOTAL_CAPACITY_MBPS=1000    # testbed unit is kbps → 1000 = 1 Mbps (set 8000 for 1 MB/s)
NETWORK_RESERVED_CAPACITY_MBPS=50
BANDWIDTH_UNIT=kbps
AUTO_ARBITRATION=true
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
CORS_ORIGINS=http://localhost:5173,http://localhost:4000
GATEWAY_URL=http://127.0.0.1:9090
GATEWAY_TOKEN=change-me-long-random

# Gateway
GATEWAY_LAN_PORT=8080
GATEWAY_PROXY_PORT=8888
GATEWAY_PROXY_ENABLED=false
GATEWAY_SOUTHBOUND_PORT=9090
GATEWAY_TICK_MS=20
GATEWAY_QUEUE_SECONDS=0.5
INTERNET_SOURCE_URL=https://speed.cloudflare.com/__down?bytes=25000000
CONTROLLER_URL=http://127.0.0.1:4000
```

`npm run setup` copies `.env.example` to `.env` if it's missing and generates a random
`GATEWAY_TOKEN`.

---

## 15. Repository layout and scripts

```
CN_Real_Network_arbitration/
├─ AGY_PROMPT.md                 (this file — keep it)
├─ README.md                     (plain-English: what, why, how to run, how to test)
├─ package.json                  (npm workspaces + root scripts)
├─ .env.example  .gitignore  .editorconfig
├─ apps/
│  ├─ controller/                (copied SOURCE backend + §9)
│  ├─ dashboard/                 (copied SOURCE frontend + §11)
│  ├─ gateway/                   (§8)
│  ├─ portal/                    (§10)
│  └─ agent/                     (§12.1)
├─ packages/shared/              (zod schemas, types, formatBandwidth)
├─ scripts/
│  ├─ windows/open-firewall.ps1  close-firewall.ps1  lan-info.ps1
│  ├─ demo-local.ts  calibrate.ts  isp-check.ts  experiment-summary.ts  setup.ts
├─ experiments/                  (CSV output, git-ignored except a README)
└─ docs/
   ├─ ARCHITECTURE.md  TESTBED.md  API.md  RUNBOOK.md  LIMITATIONS.md  OPEN-QUESTIONS.md
   └─ source/ALGORITHM.md  source/TECHNICAL.md
```

Root scripts:

| Script | What it does |
|---|---|
| `npm run setup` | Create `.env` and the token |
| `npm run seed` | Seed the 7-department testbed |
| `npm run dev` | Controller, gateway, dashboard (Vite) and portal (build watch) together via `concurrently`, with labelled output |
| `npm run build` / `npm start` | Production build; the controller serves the dashboard on :4000 and the gateway serves the portal on :8080 |
| `npm test` | All workspaces' tests |
| `npm run lan:info` | Print the laptop's LAN/hotspot IPs and a terminal QR code for the join page |
| `npm run demo:local` | §12.2 |
| `npm run calibrate`, `npm run isp:check`, `npm run experiment:summary` | Run the matching scripts in `scripts/` |
| `npm run build:agent:exe` | §12.1 |

---

## 16. Tests (all must pass; run them after every phase)

- **Controller:** every copied SOURCE test, unchanged and passing. Add:
  - gateway adapter unit tests against a fake gateway, covering mapping, the UNKNOWN-on-missing
    contract, idempotent apply and unreachable handling;
  - a golden engine test for TC2, TC3 and TC4 on the 7-slice seed, which also writes the expected
    cuts for TESTBED.md;
  - a 409 test for `/telemetry/load` in gateway mode.
- **Gateway:**
  - token-bucket accuracy within ±3 % at 20/60/140/380/950 kbps over 10 s (use a fake clock);
  - root cap never exceeded;
  - a congested shared FIFO raises latency and loss for **every** slice, including an idle-ish Clinic;
  - `drr` mode shares the link in proportion to the limits;
  - tail-drop accounting at both the slice queue and the root queue;
  - a limit change takes effect within one tick;
  - probe latency rises when the slice is saturated and stays low when it isn't;
  - southbound auth (401 without the token) and zod validation (400);
  - device timeout after 15 s.
- **Integration** (in process, real sockets on localhost): gateway, controller and 7 simulated
  agents run TC1, TC3, TC4 and TC5 with assertions from §12.3. Time it with a fast tick or fake
  clock so it finishes in under 60 s.
- **Portal and dashboard:** a component test for the demand control and the SLA chips; both
  `vite build`s must succeed.
- **Lint and type check:** `tsc --noEmit` is clean in every workspace.

---

## 17. Documentation to write

- **README.md:** plain English for a non-technical reader. What it is, the picture, the 7 slices
  table, a 10-minute quick start (setup → seed → dev → firewall script → hotspot → join from
  phones → run TC3), and how to run the tests.
- **docs/ARCHITECTURE.md:** components, ports, the control-loop sequence (detect → decide → save →
  apply → reconcile → recover), the shaper algorithm and design decisions.
- **docs/TESTBED.md:** the physical setup, scaling rules, slice and SLA tables, calibration results,
  the TC1–TC9 procedure, and space for measured results. Fill in TC6 from `demo:local`.
- **docs/RUNBOOK.md:** step-by-step real-device session for the class demo, with troubleshooting:
  - a phone can't open the portal → firewall, IP, hotspot band;
  - "no internet" warning on the phone;
  - Windows hotspot limit of 8 devices;
  - antivirus blocking ports;
  - Wi-Fi power saving on phones.
- **docs/API.md:** the southbound, portal and new testbed endpoints, with examples.
- **docs/LIMITATIONS.md:** the honest points from §2, the proxy demand estimate, shared Wi-Fi
  airtime that isn't shaped, Windows timer granularity, single instance, and loopback mode not
  testing Wi-Fi.

---

## 18. Build order (commit after each phase; don't start a phase until the previous one passes)

| Phase | Work | Done when |
|---|---|---|
| P0 | Workspaces, copy SOURCE (§7), shared package | Copied controller tests all pass; dashboard builds |
| P1 | Gateway shaper, sessions, probes, meter, southbound | Gateway unit tests pass; `curl` shows a stream held at its limit |
| P2 | Gateway adapter, 7-slice seed, units, catalogue push | Closed loop works with simulated agents: TC3 integration test passes |
| P3 | Portal: join, slice page, realtime | Phone or browser tab joins and generates load; live chart moves |
| P4 | Dashboard Testbed page, operator control, A/B switch, recorder | TC6 CSV produced from the dashboard |
| P5 | Agent CLI + exe, `demo:local`, calibrate, isp:check | `npm run demo:local` passes TC1–TC6 headless |
| P6 | Internet mode, proxy mode (+ optional upload) | TC9 passes on a real phone (or documented as untested) |
| P7 | All docs, README, final checklist | §19 all ticked |
| P8 *(optional)* | Linux `tc` adapter: when the laptop runs Linux, enforce at L3 with HTB classes per client IP on the hotspot interface (`tc qdisc add dev <wlan> root handle 1: htb`, one class per slice with `rate=ceil=limit`, u32 filters by IP, ifb for ingress) and read `tc -s -j class show` | Behind `GATEWAY_ENFORCER=tc`; documented; not required on Windows |

---

## 19. Final checklist (paste into the last commit message as done or not done)

- [ ] SOURCE folder untouched; business-rule files byte-identical to SOURCE
- [ ] `npm install && npm run setup && npm run seed && npm test` passes from a clean clone
- [ ] `npm run dev` starts everything; dashboard login works with `admin`, `manager` and `viewer`
- [ ] A phone on the hotspot can join a slice by QR code and generate load
- [ ] Gateway holds each slice within ±3 % of its limit and the total within 950 kbps
- [ ] Contention → arbitration → new limits enforced on live traffic → recovery: all visible on the dashboard and audited
- [ ] Clinic (life-safety) is never cut in any test
- [ ] TC1–TC6 pass in `demo:local`; TC7–TC9 procedures documented (results filled where run)
- [ ] TC6 A/B results table in TESTBED.md from a real CSV
- [ ] Every UI shows kbps; nothing shows a made-up number in gateway mode
- [ ] README, ARCHITECTURE, TESTBED, RUNBOOK, API and LIMITATIONS written; OPEN-QUESTIONS lists anything unresolved
