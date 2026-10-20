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
Returns aggregated real-time traffic and probe metrics per slice for the last 2-second window.

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

### 1.7 `POST /v1/slices/:code/demand`
Allows the operator to remotely override the demand rate of connected devices on that slice over WebSockets.

**Request Body:**
```json
{
  "rateKbps": 280,
  "mode": "local"
}
```

**Response (200 OK):**
```json
{
  "broadcasted": true,
  "targetSlice": "canteen-signage",
  "rateKbps": 280
}
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

Transparent HTTP/HTTPS forward proxy for routing real mobile application traffic through slice rate limiters:
- **HTTP Requests:** Standard proxy requests (`GET http://example.com/`).
- **HTTPS Tunnels:** HTTP `CONNECT example.com:443` tunnels with bidirectional TCP backpressure pacing.
- **Access Control:** Client IP must match an actively bound device in `deviceRegistry`; unknown IPs receive an HTTP 403 join prompt.

---

## 4. Controller Testbed REST API (`0.0.0.0:4000/api/v1/testbed/*`)

### 4.1 `GET /api/v1/testbed/status` (VIEWER+)
Returns overall testbed operational health, detected LAN/hotspot IPs, ISP speed test status, and connected device counts.

---

### 4.2 `GET /api/v1/testbed/devices` & `DELETE /api/v1/testbed/devices/:id` (MANAGER+)
Inspects connected testbed devices or forces unbinding of an inactive device.

---

### 4.3 `POST /api/v1/testbed/slices/:id/join-code/rotate` (MANAGER+)
Rotates a slice's 6-character join code and updates the QR code.

---

### 4.4 `POST /api/v1/testbed/scenarios/:name/run` (MANAGER+)
Automates running test cases `TC1` through `TC6` by broadcasting operator demand presets across all slices.

---

### 4.5 `PUT /api/v1/testbed/arbitration` (MANAGER+)
Enables or disables automatic CBHA runtime arbitration (for A/B testing).

**Request Body:**
```json
{ "enabled": false }
```

---

### 4.6 Experiment Recorder Endpoints
- `POST /api/v1/testbed/experiments` `{ "name": "ab-comparison-run" }` — Starts logging telemetry ticks to CSV.
- `POST /api/v1/testbed/experiments/:id/stop` — Halts active recording.
- `GET /api/v1/testbed/experiments/:id/download` — Downloads the generated CSV file.
