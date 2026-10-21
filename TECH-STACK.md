# Tech stack: what we used, and what each piece does here

This file lists every technology in the **real-network testbed** and explains its job in this
project, in plain words. For how the parts fit together, read
[`docs/PROJECT-EXPLAINED.md`](docs/PROJECT-EXPLAINED.md).

## The parts at a glance

```
 Phone / laptop browser                Laptop (Windows)
 ┌──────────────────────┐   Wi-Fi     ┌──────────────────────────────────────────────────────┐
 │ Department page      │  hotspot    │ Slice gateway (:8080 for devices, :9090 private)     │
 │ React + Vite         │◄──────────►│ Node.js: token buckets, shared 1 Mbps link, probes   │
 └──────────────────────┘ HTTP + WS  │            ▲ southbound API (stats in, limits out)   │
                                     │ Controller (:4000)                                   │
 Operator browser                    │ Express + Socket.IO: detection, CBHA engine, audit   │
 ┌──────────────────────┐            │            ▲ REST + live push                        │
 │ Operator dashboard   │◄──────────►│ Dashboard dev server (:5173)                         │
 │ React + Vite         │            └──────────────────────────────────────────────────────┘
 └──────────────────────┘
```

Everything is **TypeScript**, so one language runs in the phone page, the gateway, the
controller and the tests.

---

## 1. Language, runtime and project tooling

| Technology | Version | Where | What it does in this project |
|---|---|---|---|
| **TypeScript** | 5.7 | everywhere | Typed JavaScript. A bandwidth decision cuts real traffic, so the compiler catches missing values and wrong units before they run. Strict mode is on |
| **Node.js** | 20.11 or newer (tested on 24) | gateway, controller, agent, scripts | Runs the server programs. The gateway uses only Node's built-in networking, so it needs no extra network software |
| **npm workspaces** | npm 10 | repository root | Holds the six packages (`@cn/shared`, `controller`, `gateway`, `dashboard`, `portal`, `agent`) in one repository with one install |
| **tsx** | 4.19 | development, scripts | Runs TypeScript files directly, without a build step, in `npm run dev` and every `scripts/*.ts` |
| **concurrently** | 9.1 | `npm run dev`, `npm start` | Starts the controller, gateway, dashboard and department page together in one terminal, each with a coloured prefix |
| **dotenv** | 16.4 | gateway, controller, agent | Reads settings from the `.env` file: link size, ports, the shared secret token. `npm run setup` writes this file |
| **cross-env** | 7.0 | scripts | Sets environment variables the same way on Windows and Linux |

## 2. Shared code (`packages/shared`)

| Technology | Version | What it does in this project |
|---|---|---|
| **Zod** | 3.24 | One schema describes each message (a slice, a stats window, a join request). It checks incoming data at run time **and** gives the TypeScript type, so the gateway, controller, phone page and agent always agree on the format |

## 3. Slice gateway (`apps/gateway`): the network

This is the part that makes the project "real": every byte a phone downloads passes through it.

| Technology | Version | What it does in this project |
|---|---|---|
| **`node:http`** (built in) | Node | Two HTTP servers: the **devices' API on port 8080** (join, download stream, probes; it also serves the built department page) and the **southbound API on 127.0.0.1:9090** that only the controller can reach |
| **`ws`** | 8.18 | WebSocket server on `/ws`: pushes each phone a live snapshot of its slice (limit, demand, latency, loss) every second, and tells it when the operator changes its demand or removes it |
| **`node:net`** (built in) | Node | The optional forward proxy on port 8888 (off by default) |
| **Zod** | 3.24 | Validates every request to both APIs; bad input gets a 400, never a crash |
| **Pino** | 9.6 | Structured logs (slice limit changes, devices joining and leaving) |
| **Our token bucket** (`src/shaper/tokenBucket.ts`) | own code | Holds each slice to its limit. Tokens refill at the limit's rate; a chunk leaves only if there are tokens for it. Measured within 0.25 % of the limit from 20 to 950 kbps |
| **Our queues and scheduler** (`src/shaper/`) | own code | Every 20 ms: new bytes go into the slice's queue (0.5 s of traffic; full = dropped), the bucket lets them out, and the shared 950 kbps link sends them. Rates use real elapsed time, so uneven Windows timers don't change them |
| **FIFO or DRR link** | own code | `fifo` (default): one shared queue, like a plain switch port. `drr`: weighted deficit round robin, sharing the link in proportion to the slices' limits. Chosen with `GATEWAY_ROOT_DISCIPLINE` |
| **Probe meter** (`src/meter/`, `src/probes/`) | own code | Probes wait in the **same queues as the data**, so their round trip is the latency the slice's traffic really sees. Every 2 s the gateway closes a window per slice: demand, carried, dropped, queue delay, latency p50/p95, jitter, loss and availability |

## 4. Controller (`apps/controller`): the brain

| Technology | Version | What it does in this project |
|---|---|---|
| **Express** | 4.21 | The REST API (`/api/v1/...`) the dashboard uses: slices, departments, policy, contention, decisions, audit log, and the testbed endpoints (scenarios, arbitration on/off, devices, recording download) |
| **Socket.IO** | 4.8 | Pushes live changes to the dashboard (new decision, contention opened or closed) without the page polling |
| **Zod** | 3.24 | Validates every request body and query, and the `.env` settings at start-up |
| **jsonwebtoken (JWT)** | 9.0 | Sign-in sessions for the dashboard. Roles (Viewer, Manager, Admin) decide who may run scenarios, turn arbitration off or override a decision |
| **helmet** | 8.0 | Sets HTTP security headers on every response |
| **cors** | 2.8 | Allows only the dashboard's own address to call the API from a browser |
| **express-rate-limit** | 7.5 | Limits how fast one client can call the API and the sign-in endpoint |
| **compression** | 1.7 | Gzips API responses |
| **Pino + pino-http** | 9.6 / 10.4 | Structured logs, one line per request with a correlation id |
| **swagger-ui-express** | 5.0 | Serves the API documentation (OpenAPI 3.1) at `/api/docs` |
| **File-backed in-memory store** | own code | Keeps slices, departments, decisions and the audit log in memory and saves them to `apps/controller/.data`, so nothing needs a database server. `npm run seed` fills it with the seven departments |
| **CBHA engine** (`src/domain/arbitration/`) | own code | Convex Business-Harm Arbitration: scores each department, then frees bandwidth step by step from the slice where the next cut does the least business harm. Pure functions, no solver library, a decision in milliseconds |
| **Gateway adapter** (`src/telemetry/adapters/gateway.telemetry.adapter.ts`) | own code | The controller's only link to the network: reads `GET /v1/stats` and sends `PUT /v1/slices/:code/limit` with the secret token |
| **firebase-admin** | 13.0 | Optional and **not used by the testbed**: only loaded if `AUTH_DRIVER=firebase` or a Firestore datastore is chosen. The testbed runs with `DATASTORE_DRIVER=memory` and `AUTH_DRIVER=dev` |

## 5. Operator dashboard (`apps/dashboard`)

| Technology | Version | What it does in this project |
|---|---|---|
| **React** | 18.3 | The user interface: Slices and devices, Contention, Decisions, Live charts, Slice contracts, Departments, Business policy, Audit log |
| **Vite** | 5.4 | Development server on port 5173 with instant reload, and the production build |
| **TanStack Query** | 5.62 | Fetches and caches server data, and refreshes the testbed page every 2 s (one gateway window) so the measured values stay live |
| **Axios** | 1.7 | HTTP client for the REST API, including downloading the recording CSV |
| **socket.io-client** | 4.8 | Receives the controller's live pushes |
| **React Router** | 6.28 | Page navigation inside the dashboard |
| **Tailwind CSS** (+ PostCSS, Autoprefixer) | 3.4 | Styling with utility classes; light and dark theme |
| **clsx + tailwind-merge** | 2.1 / 2.6 | Combine CSS class names cleanly in components |
| **Recharts** | 2.15 | The live latency and throughput charts |
| **qrcode** | 1.5 | Draws each department's join QR code (`http://<hotspot address>:8080/join?code=…`) for phones to scan |

## 6. Department page on each phone (`apps/portal`)

| Technology | Version | What it does in this project |
|---|---|---|
| **React + Vite** | 18.3 / 5.4 | The page a phone opens: join with a code, choose how much to download, watch its slice live. Built once (`npm run build`) and served by the gateway on port 8080, so phones need only a browser |
| **Tailwind CSS** | 3.4 | Styling, sized for phone screens |
| **Recharts** | 2.15 | The phone's own latency and throughput charts |
| **Browser `fetch` streams** (built in) | browser | The download that creates the slice's real traffic: the page reads the stream at the rate it asked for |
| **Browser `WebSocket`** (built in) | browser | Receives the live snapshot, operator demand changes and "removed" messages from the gateway |
| **`sessionStorage`** (built in) | browser | Remembers the device per tab, so several tabs on one laptop can each be a different department, and the page rejoins by itself after a gateway restart |

## 7. Agent (`apps/agent`): a software phone

| Technology | Version | What it does in this project |
|---|---|---|
| **Node built-in `fetch` and `WebSocket`** | Node 22+ | Joins a slice, downloads at a set rate and sends probes, exactly like the phone page. Used to fill departments when there are fewer than seven phones, and by `npm run demo:local` |
| **Node single executable (SEA)** | Node | `npm run build:agent:exe` packs the agent into one `.exe` for a laptop without Node |

## 8. Testing and measurement

| Technology | Version | What it does in this project |
|---|---|---|
| **Vitest** | 2.1 | Test runner: 443 controller tests and 17 gateway tests (`npm test`) |
| **Supertest** | 7.0 | Calls the controller's HTTP API inside tests without opening a port |
| **@vitest/coverage-v8** | 2.1 | Code-coverage reports |
| **`npm run demo:local`** | own script | Starts the gateway, controller and 7 agents on one laptop, runs test cases TC1–TC6 on real traffic and checks every pass condition from the measurements |
| **`npm run experiment:summary`** | own script | Turns a recording CSV into a table of means per scenario and slice |
| **`npm run calibrate`** | own script | Measures the idle probe latency of joined devices (the latency floor before any load) |
| **`npm run isp:check`** | own script | Measures how fast the laptop's internet connection can deliver internet-mode downloads, compared with the link size |
| **`npm run lan:info`** | own script (qrcode) | Prints the laptop's addresses, marks the hotspot one, and shows the join QR code in the terminal |

## 9. Network and operating system

| Technology | What it does in this project |
|---|---|
| **Windows Mobile Hotspot** | The Wi-Fi network the phones join. The laptop is `192.168.137.1`; up to 8 devices |
| **Windows Defender Firewall + PowerShell** (`scripts/windows/open-firewall.ps1`) | Opens TCP 8080 to the local network only, and removes rules that block Node.js. `close-firewall.ps1` undoes it |
| **Ports** | 8080 devices (gateway) · 127.0.0.1:9090 controller-to-gateway, private · 4000 controller API · 5173 dashboard · 5174 department page in development · 8888 optional proxy |
| **3GPP S-NSSAI** | Each slice carries a real slice identity (SST + SD, e.g. SST 2, SD 000101) and a URLLC/eMBB label, which the engine deliberately ignores |

## 10. Paper, slides and video

| Technology | What it does in this project |
|---|---|
| **LaTeX (IEEEtran) + pgfplots/TikZ** | The 6-page paper in `paper/`; every chart is drawn from the CSVs in `paper/results/` |
| **Slides (HTML deck)** | The 39-slide deck in `presentation/deck/`, also as `Real-Network-Testbed-Slides.pptx` (built with **python-pptx** and headless Chrome) |
| **Python 3 (numpy, Pillow, imageio-ffmpeg)** | Draws every frame of the explainer video and mixes the audio (`presentation/video/build/`) |
| **Windows speech (Microsoft Zira, System.Speech)** | The video's offline narration voice, with word timings for the subtitles |
| **FFmpeg** | Encodes the final MP4 |

## 11. What we deliberately did not use

| Not used | Why |
|---|---|
| **Linux `tc` / kernel shaping** | The demo laptop runs Windows, which has no `tc`. Our own shaper runs anywhere and measures itself; kernel shaping is listed as future work |
| **A real 5G core (Open5GS, free5GC) or Kubernetes** | Not needed to show arbitration on real traffic. The controller still contains adapters for them from the platform it grew out of, but this project runs with `TELEMETRY_PROVIDER=gateway` |
| **A database server** | The file-backed store is enough for one laptop, and the demo needs no setup |
| **Redux, an ORM, a solver library** | TanStack Query already holds the server data; the store is simple; the CBHA water-filling is small, fast and explains every step |
