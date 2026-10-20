# API Reference — CN Real Network Arbitration Testbed

This document details all network application programming interfaces across the **Slice Gateway Southbound API**, the **Portal & Data API**, the **HTTP Forward Proxy**, and the **Controller Testbed REST Endpoints**.

---

## 1. Gateway Southbound REST API (`127.0.0.1:9090`)

The Southbound API is bound strictly to `127.0.0.1` and requires the `Authorization: Bearer <GATEWAY_TOKEN>` header.

### 1.1 `GET /v1/health`
Returns the operational health and uptime of the slice gateway.

**Response (200 OK):**
```json
{
  "ok": true,
  "uptimeS": 3482,
  "version": "1.0.0"
}
```

---

### 1.2 `GET /v1/capacity`
Returns the link capacity configuration and units.

**Response (200 OK):**
```json
{
  "totalKbps": 1000,
  "reservedKbps": 50,
  "offeredKbps": 950,
  "unit": "kbps",
  "source": "configuration"
}
```

---

### 1.3 `PUT /v1/slices`
Registers or updates the full slice catalogue on the gateway.

**Request Body:**
```json
[
  {
    "code": "patient-telemetry",
    "name": "Patient Telemetry",
    "department": "Clinic",
    "sNssai": { "sst": 2, "sd": "000101" },
    "profile": "URLLC",
    "baselineKbps": 60,
    "floorKbps": 40,
    "burstKbps": 90,
    "currentLimitKbps": 60,
    "slaTargets": {
      "latencyMs": 150,
      "jitterMs": 25,
      "lossPct": 0.1,
      "minThroughputKbps": 40,
      "availabilityPct": 99.999
    },
    "joinCode": "CLN101"
  }
]
```

**Response (200 OK):**
```json
{
  "accepted": true,
  "sliceCount": 7
}
```

---

### 1.4 `GET /v1/stats`
Returns each slice's traffic and probe metrics for the **last completed** measurement window. The gateway closes a window every `GATEWAY_STATS_WINDOW_MS` (default 2 s) on its own clock, and rates are averaged over the real elapsed time. This call is read-only: any number of readers (controller, experiment recorder, curl) get the same numbers. `null` means unknown, because no probe was answered in the window.

**Response (200 OK):**
```json
[
  {
    "code": "patient-telemetry",
    "atMs": 1792506300000,
    "demandKbps": 33,
    "limitKbps": 60,
    "usedKbps": 33,
    "droppedKbps": 0,
    "queueMs": 0,
    "latencyP50Ms": 24,
    "latencyP95Ms": 35,
    "jitterMs": 4.2,
    "lossPct": 0.0,
    "availabilityPct": 100.0,
    "activeDevices": 1,
    "activeSessions": 1,
    "saturated": false
  }
]
```

---

### 1.5 `PUT /v1/slices/:code/limit`
Enforces a new rate limit on live traffic for the specified slice. This endpoint is idempotent.

**Request Body:**
```json
{
  "limitKbps": 28,
  "decisionId": "ARB-0MVGRZOOC-ETSCSE",
  "reason": "Limit lowered from 140 to 28 kbps to protect critical patient telemetry"
}
```

**Response (200 OK):**
```json
{
  "applied": true,
  "effectiveKbps": 28
}
```

---

### 1.6 `GET /v1/devices`
Lists all devices currently bound to slices.

**Response (200 OK):**
```json
[
  {
    "deviceId": "dev-0MVGRW6RM",
    "nickname": "Clinic-Phone",
    "ip": "192.168.137.42",
    "sliceCode": "patient-telemetry",
    "lastSeenMs": 1792506300000,
    "allowOperatorControl": true
  }
]
```

---

### 1.6b `DELETE /v1/devices/:id`
Removes a device: ends its load sessions, sends `{ "type": "unbound" }` to its open pages and forgets it. `404` if unknown.

---

### 1.7 `POST /v1/slices/:code/demand`
Operator remote control. Every device joined to the slice switches to this demand: its load
stream changes rate, and its page or agent is told over the WebSocket (`{ "type": "operator-demand", "rateKbps": … }`).

**Request Body:**
```json
{ "kbps": 280, "mode": "local" }
```
`mode` is optional (`local` or `internet`).

**Response (200 OK):**
```json
{ "success": true, "sliceCode": "canteen-signage", "demand": { "kbps": 280, "mode": "local" } }
```

---

## 2. Portal & Load API (`0.0.0.0:8080`)

Public endpoints used by client devices on the Wi-Fi hotspot.

### 2.1 `POST /portal-api/join`
Binds a client device to a department slice using its 6-character join code.

**Request Body:**
```json
{
  "code": "CLN101",
  "nickname": "Pixel-8"
}
```

**Response (200 OK):**
```json
{
  "deviceId": "dev-1792506300123",
  "nickname": "Pixel-8",
  "sliceCode": "patient-telemetry",
  "slice": {
    "name": "Patient Telemetry",
    "department": "Clinic",
    "baselineKbps": 60,
    "floorKbps": 40
  }
}
```

---

### 2.2 `GET /load/down?device=<id>&rate=<kbps>&mode=local|internet`
Initiates a continuous `application/octet-stream` download session. The gateway shapes this stream through the slice's token bucket and root link.

- `rate`: Offered arrival rate in kbps.
- `mode`: `local` (generated test bytes) or `internet` (piped from Cloudflare upstream).

---

### 2.3 `GET /probe?device=<id>&seq=<n>`
Dispatches a 64-byte latency probe. The gateway enqueues the probe behind that slice's active data chunks, measuring real queueing delay.

---

### 2.4 `POST /portal-api/probe-results`
Submits a batch of client-measured RTTs to the gateway. Exempt from rate limiting.

**Request Body:**
```json
{
  "deviceId": "dev-1792506300123",
  "results": [
    { "seq": 101, "rttMs": 28 },
    { "seq": 102, "rttMs": 31 }
  ]
}
```

---

### 2.5 `WebSocket /ws?device=<deviceId>`
Real-time bidirectional channel:
- Pushes `slice-snapshot` every 1,000 ms (limit, demand, used, latency, SLA statuses, decision reason).
- Receives remote operator demand overrides.

---

## 3. Forward Proxy Server (`0.0.0.0:8888`)

Optional HTTP/HTTPS forward proxy, off by default (`GATEWAY_PROXY_ENABLED=false`). **It does not shape traffic yet**: see `docs/LIMITATIONS.md` §2.3.
- **HTTP requests:** standard proxy requests (`GET http://example.com/`), forwarded unshaped.
- **HTTPS tunnels:** `CONNECT example.com:443`, piped through unshaped.
- **Access control:** the client IP must belong to a device that has joined a slice. Unknown IPs get HTTP 403 with a link to the join page on the address they reached.

---

## 4. Controller testbed API (`:4000/api/v1/testbed`)

Every call needs a signed-in session (`Authorization: Bearer <token>`; the dashboard sends it).
Bandwidth is in kbps.

| Call | Role | What it does |
|---|---|---|
| `GET /status` | Viewer | Gateway reachable?, capacity, the gateway's latest per-slice stats, laptop addresses (hotspot first, virtual adapters marked), department-page port, arbitration on/off, current recording file and row count |
| `GET /devices` | Viewer | Devices joined to slices (name, address, slice, demand, last seen) |
| `GET /recording.csv` | Viewer | This session's recording: every 2 s gateway window, labelled with the last scenario run |
| `DELETE /devices/:id` | Manager | Remove a device from its slice; its load stops and its page returns to the join screen. Audited |
| `POST /slices/:id/join-code/rotate` | Manager | New join code for a slice; devices already joined stay joined |
| `POST /slices/:id/demand` | Manager | `{ "kbps": 140 }`: the slice's devices switch to this demand (operator remote control) |
| `POST /scenarios/:name/run` | Manager | `IDLE`, `TC1`…`TC5`: set every joined device's demand to that pattern (fractions of baseline) |
| `PUT /arbitration` | Manager | `{ "enabled": false }`: automatic arbitration off or on, for the TC6 comparison. Audited |

The gateway also has `DELETE /v1/devices/:id` on the southbound API, which the controller uses
for the device removal above.
