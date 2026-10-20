# Slice gateway (`@cn/gateway`)

The gateway is the **network** in this testbed. Every byte of slice traffic passes through it. It
does three jobs:

1. **Enforces limits.** Each slice gets its own speed limit, and all slices share one 1 Mbps link.
2. **Measures.** Every 2 seconds it records each slice's demand, throughput, drops, queueing
   delay, latency, jitter, loss and availability.
3. **Takes orders.** The controller reads those measurements and sends new limits back over a
   private API.

The controller decides; the gateway enforces and measures. Neither does the other's job.

## How traffic flows through it

```
 device asks for X kbps          per-slice limit             shared 1 Mbps link
 ───────────────────────►  [ slice queue ]──(token bucket)──►[ root queue ]──(950 kbps)──► device
                            0.5 s buffer      limit_i          0.5 s buffer      offered capacity
                            full → dropped                     full → dropped
```

- **Arrivals.** A device's load session puts bytes into its slice's queue at the rate the device
  asked for. That rate is the slice's **demand**.
- **Police.** Each slice's token bucket lets bytes out at no more than the slice's **limit**.
- **Transmit.** All slices share one root queue that drains at the **offered capacity**: 1,000
  kbps total minus 50 kbps reserved. With the default `fifo` setting this is a plain shared link.
- **Probes.** Each device sends a tiny probe every 0.5–1 s. Probes wait in the same queues as the
  data, so their round-trip time is the slice's real queueing delay.

Why this shows the problem: the slices' **baselines add up to 1,480 kbps** but the link carries
**950 kbps**. Without arbitration the root queue fills, and *every* slice gets delay and drops,
including the clinic. After the controller cuts the right slices, the traffic the limits let
through fits the link again. The root queue then drains, and only the slices that were cut still
queue.

## Code map

| Folder | What's in it |
|---|---|
| `src/shaper/` | `tokenBucket.ts`, `queue.ts`, and `scheduler.ts` (the 20 ms loop: arrivals → police → transmit) |
| `src/meter/sliceMeter.ts` | Per-slice counters, closed into a stats window every 2 s |
| `src/probes/probeManager.ts` | Probe round-trip times → latency p50/p95, jitter, loss, availability |
| `src/sessions/` | Load sessions (`/load/down`) and the device registry (join codes, offline after 15 s) |
| `src/southbound/southboundServer.ts` | The controller's API on `127.0.0.1:9090` |
| `src/portal-api/portalServer.ts` | The devices' API on `:8080`: join, load, probes, WebSocket; also serves the built portal |
| `src/proxy/forwardProxy.ts` | Optional HTTP proxy on `:8888` (see limitations) |

## APIs

**Southbound** (`127.0.0.1:9090`, header `Authorization: Bearer $GATEWAY_TOKEN`):

| Call | Meaning |
|---|---|
| `GET /v1/health` | Is the gateway up |
| `GET /v1/capacity` | Total / reserved / offered kbps |
| `PUT /v1/slices` | The slice catalogue: codes, baselines, floors, SLA targets, join codes |
| `GET /v1/stats` | The **last completed** 2 s window for every slice. Read-only: any number of readers see the same numbers |
| `PUT /v1/slices/:code/limit` | Set a slice's limit. Idempotent; takes effect on the next 20 ms tick |
| `GET /v1/devices` | Devices that have joined |
| `POST /v1/slices/:code/demand` | Operator remote control of a slice's devices |

**Devices** (`:8080`):
- `POST /portal-api/join`
- `GET /portal-api/slices`
- `GET /portal-api/snapshot?device=`
- `GET /load/down?device=&rate=&mode=`
- `GET /probe?device=&seq=`
- `POST /portal-api/probe-results`
- `/ws?device=`, which pushes a live snapshot every second

Full examples are in [`docs/API.md`](../../docs/API.md).

## Settings (`.env` at the repository root)

| Variable | Default | Meaning |
|---|---|---|
| `NETWORK_TOTAL_CAPACITY_MBPS` | `1000` | Link size in **kbps** for this testbed (1000 = 1 Mbps) |
| `NETWORK_RESERVED_CAPACITY_MBPS` | `50` | Kept back; not offered to slices |
| `GATEWAY_LAN_PORT` | `8080` | Port for devices |
| `GATEWAY_SOUTHBOUND_PORT` | `9090` | Controller API, loopback only |
| `GATEWAY_TOKEN` | — | Shared secret with the controller (`npm run setup` generates one) |
| `GATEWAY_TICK_MS` | `20` | Scheduler tick. Rates use real elapsed time, so Windows timer jitter doesn't change them |
| `GATEWAY_QUEUE_SECONDS` | `0.5` | Buffer size of each queue, in seconds of traffic |
| `GATEWAY_STATS_WINDOW_MS` | `2000` | Length of one measurement window |
| `GATEWAY_ROOT_DISCIPLINE` | `fifo` | `fifo` = plain shared link; `drr` = weighted fair queueing (an experiment option) |
| `GATEWAY_PROXY_ENABLED` | `false` | Start the proxy on `GATEWAY_PROXY_PORT` (`8888`) |
| `INTERNET_SOURCE_URL` | Cloudflare speed-test URL | Where `mode=internet` sessions fetch their bytes from |

## Run and test

From the repository root, run `npm run dev` (everything) or `npm run dev -w @cn/gateway` (the
gateway alone). Gateway tests:

```bash
npm test -w @cn/gateway
```

The tests use a virtual clock and cover:
- rate accuracy within ±3 % from 20 to 950 kbps;
- the root never exceeding capacity;
- shared-FIFO congestion hurting every slice;
- DRR sharing;
- tail-drop accounting;
- limit changes within one tick;
- device timeouts;
- southbound authentication and validation.

## Limitations

- **Proxy mode does not shape traffic yet.** `:8888` checks that the device has joined, then
  passes its traffic straight through. Phone apps using the proxy are not held to the slice limit.
- **Only download load is generated.** Upload is not implemented.
- This is application-layer enforcement in Node.js, not kernel or 3GPP radio slicing. See
  [`docs/LIMITATIONS.md`](../../docs/LIMITATIONS.md).
