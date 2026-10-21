# Tech stack

Only what the real-network testbed actually uses.

## Language and tools

| Tech | What it is | Why we use it | Where |
|---|---|---|---|
| **TypeScript** | JavaScript with types, checked before it runs | Catches mistakes early; one language for every part | All code in `apps/` and `packages/` |
| **Node.js** | Runs JavaScript on the laptop as a server | Runs the gateway, controller and agent | `apps/gateway`, `apps/controller`, `apps/agent`, `scripts/` |
| **npm workspaces** | Several packages in one repository | One install for all six packages | Root `package.json` |
| **tsx** | Runs TypeScript directly | No build step in development and scripts | `npm run dev`, `scripts/*.ts` |
| **concurrently** | Starts several programs in one terminal | One command starts the whole testbed | `npm run dev`, `npm start` |
| **dotenv** | Reads settings from `.env` | Link size, ports and the secret token without code changes | Gateway, controller, agent |
| **Zod** | Describes and checks the shape of data | Every message between the parts is checked | `packages/shared`, all APIs |

## Slice gateway (the network): `apps/gateway`

| Tech | What it is | Why we use it | Where |
|---|---|---|---|
| **node:http** | Node's built-in web server | Phones connect over HTTP; we control when each byte is sent | `portal-api/portalServer.ts` (:8080), `southbound/southboundServer.ts` (:9090) |
| **WebSocket (`ws`)** | A connection that stays open both ways | Pushes each phone its live slice data every second | `/ws` in `portalServer.ts` |
| **Token bucket** (own code) | Standard network speed limiter | Holds each slice to its limit (within 0.25 %) | `shaper/tokenBucket.ts` |
| **Queues + 20 ms scheduler** (own code) | Waiting lines moved every 20 ms | Creates real congestion: delay and drops on a 950 kbps link | `shaper/queue.ts`, `shaper/scheduler.ts` |
| **FIFO / DRR** (own code) | One shared queue, or fair turns per slice | FIFO shows the problem; DRR shows why fair sharing alone isn't enough | `shaper/scheduler.ts` |
| **Probes + meter** (own code) | Tiny timed messages, and per-slice counters | Latency, loss and throughput measured every 2 s | `probes/probeManager.ts`, `meter/sliceMeter.ts` |
| **Pino** | Structured logging | See joins, limit changes and restarts | Gateway and controller |

## Controller (the brain): `apps/controller`

| Tech | What it is | Why we use it | Where |
|---|---|---|---|
| **Express** | Web framework for APIs | The REST API the dashboard calls | `src/app.ts`, `src/routes/`, `src/controllers/` |
| **Socket.IO** | Live push to the browser | Dashboard updates the moment a decision is made | `src/realtime/gateway.ts` |
| **JWT** | Signed sign-in token | Roles: Viewer, Manager, Admin | `src/services/token.service.ts`, `src/middleware/authenticate.ts` |
| **helmet, cors, rate limit** | Standard API protection | Security headers, only the dashboard may call, no flooding | `src/app.ts`, `src/middleware/rateLimiter.ts` |
| **File-backed store** (own code) | Data in memory, saved to disk | No database server needed | `src/repositories/memory/`, data in `.data/` |
| **CBHA engine** (own code) | Our arbitration algorithm | Decides who is cut by business value, never breaks safety rules, explains why | `src/domain/`, `src/services/arbitration.service.ts` |
| **Gateway adapter** (own code) | The controller's link to the network | Reads stats, sends new limits | `src/telemetry/adapters/gateway.telemetry.adapter.ts` |

## Dashboard and phone page: `apps/dashboard`, `apps/portal`

| Tech | What it is | Why we use it | Where |
|---|---|---|---|
| **React** | Builds pages from components | Live pages that update with the data | Both apps, `src/` |
| **Vite** | Dev server and build tool | Fast reload; builds the phone page the gateway serves | `vite.config.ts` in both |
| **Tailwind CSS** | Styling with short classes | Consistent look, phone-sized page | Both apps |
| **Recharts** | Charts for React | Live latency and throughput charts | `MonitoringPage.tsx`, `SlicePage.tsx` |
| **TanStack Query** | Fetches and refreshes server data | Dashboard numbers refresh every 2 s | Dashboard pages |
| **Axios** | HTTP client | Calls the API with the sign-in token; downloads the CSV | `dashboard/src/api/` |
| **React Router** | Pages inside one web app | Dashboard menu and links | `dashboard/src/App.tsx` |
| **qrcode** | Draws QR codes | Phones scan to join their department | `TestbedPage.tsx`, `scripts/lan-info.ts` |
| **fetch stream, WebSocket, sessionStorage** (browser) | Built into every browser | The phone's download is the slice traffic; live updates; one device per tab | `portal/src/components/SlicePage.tsx`, `portal/src/App.tsx` |

## Testing

| Tech | What it is | Why we use it | Where |
|---|---|---|---|
| **Vitest** | Test runner | 460 tests (`npm test`) | `apps/controller/tests`, `apps/gateway/tests` |
| **Supertest** | Calls the API inside tests | Tests endpoints, roles and input checks | `apps/controller/tests` |
| **demo:local** (own script) | Runs 7 software phones on one laptop | Test cases TC1–TC6 on real traffic | `scripts/demo-local.ts` |
| **Agent** (own code) | A phone without a browser | Fills departments when phones are short | `apps/agent` |

## Network

| Tech | What it is | Why we use it | Where |
|---|---|---|---|
| **Windows Mobile Hotspot** | Laptop as a Wi-Fi access point | Phones join at `192.168.137.1`, no router needed | Windows settings, `docs/RUNBOOK.md` |
| **Firewall script** (PowerShell) | Opens a port in Windows Firewall | Lets phones reach port 8080, local network only | `scripts/windows/open-firewall.ps1` |
| **HTTP over TCP, ports** | How the parts talk | 8080 phones · 9090 private · 4000 controller · 5173 dashboard | All servers |
| **5G slice identity (S-NSSAI)** | Slice type + ID, e.g. URLLC, SST 2 | Real slice labels, which the engine deliberately ignores | `apps/controller/src/testbed/catalogue.ts` |

## Paper, slides, video

| Tech | Why | Where |
|---|---|---|
| **LaTeX + pgfplots** | Conference paper; charts drawn from our data | `paper/` |
| **python-pptx + Chrome** | PowerPoint copy of the deck | `Real-Network-Testbed-Slides.pptx` |
| **Python + Windows voice + FFmpeg** | Narrated explainer video | `presentation/video/` |

## Project folders and files

```
CN_Real_Network_arbitration/
├── package.json                  # npm workspaces + every command (dev, build, start, test, seed, demo:local)
├── .env.example                  # settings template; `npm run setup` copies it to .env with a secret token
├── README.md                     # start here: what it is, how to run it, results
├── TECH-STACK.md                 # this file
├── Real-Network-Testbed-Slides.pptx   # the presentation as PowerPoint
│
├── packages/shared/
│   └── src/index.ts              # message formats (Zod) shared by every app: slice, stats window, join, probe
│
├── apps/gateway/                 # THE NETWORK: every byte to a phone passes through here
│   ├── src/index.ts              # starts the gateway: loads settings and the slice list, opens both servers
│   ├── src/defaultCatalogue.ts   # the 7 slices it starts with (limits, join codes)
│   ├── src/portal-api/portalServer.ts   # port 8080 for phones: join, download stream, probes, WebSocket, phone page
│   ├── src/southbound/southboundServer.ts  # port 9090, private: controller reads stats, sets limits
│   ├── src/shaper/tokenBucket.ts # speed limit per slice
│   ├── src/shaper/queue.ts       # waiting line per slice (0.5 s); full = dropped
│   ├── src/shaper/scheduler.ts   # every 20 ms: queue → token bucket → shared 950 kbps link (FIFO or DRR)
│   ├── src/meter/sliceMeter.ts   # counts traffic; closes a 2 s measurement window per slice
│   ├── src/probes/probeManager.ts# latency probes → p50/p95, jitter, loss, availability
│   ├── src/sessions/deviceRegistry.ts  # joined devices; offline after 15 s silence
│   ├── src/sessions/loadSession.ts     # one phone's download stream at its chosen rate
│   ├── src/proxy/forwardProxy.ts # optional proxy on 8888 (off; does not shape)
│   └── tests/gateway.test.ts     # 17 tests: shaper accuracy, congestion, DRR, API token
│
├── apps/controller/              # THE BRAIN: detects shortage, decides, records
│   ├── src/server.ts             # starts the controller on port 4000
│   ├── src/bootstrap.ts          # wires everything; keeps the gateway in sync; API docs page
│   ├── src/container.ts          # picks the data store, sign-in and network adapter from .env
│   ├── src/app.ts                # Express app: security headers, CORS, rate limit, routes
│   ├── src/config/env.ts         # reads and checks .env
│   ├── src/routes/               # API URLs (slices, departments, policy, decisions, testbed…)
│   ├── src/controllers/          # what each URL does; testbed.controller.ts = scenarios, devices, recording
│   ├── src/services/             # the logic: contention.service (detect), arbitration.service (decide),
│   │                             #   allocation.service (apply limits, restore after recovery), audit, token
│   ├── src/domain/policyEngine.ts       # business score 0–100 per department
│   ├── src/domain/arbitration/   # CBHA: harm.ts (harm curve), solver.ts (water-filling),
│   │                             #   alternatives.ts (other plans compared), engine.ts (decision + explanation)
│   ├── src/telemetry/adapters/gateway.telemetry.adapter.ts  # talks to the gateway's southbound API
│   ├── src/testbed/catalogue.ts  # the 7 departments and slices with their business facts
│   ├── src/testbed/experimentRecorder.ts  # saves every 2 s window to experiments/<time>-session.csv
│   ├── src/realtime/gateway.ts   # Socket.IO live push to the dashboard
│   ├── src/jobs/scheduler.ts     # runs background jobs: telemetry tick (measure → detect → decide),
│   │                             #   recovery sweep, old-data cleanup
│   ├── src/repositories/         # data access; memory/ = in-memory store saved to .data/
│   ├── src/middleware/           # sign-in check, roles, input checks, logging, errors
│   ├── src/models/, constants/, types/, utils/, validators/, interfaces/   # data shapes and helpers
│   ├── src/scripts/seed.ts       # `npm run seed`: creates the 7 departments, slices and policy
│   ├── src/auth/dev.auth.adapter.ts      # role-based local sign-in (Viewer, Manager, Admin)
│   ├── src/docs/openapi.ts       # API description shown at /api/docs
│   ├── src/telemetry/synthetic/, adapters/prometheus…, adapters/kubernetes…,
│   │   auth/firebase…, firebase/ # from the earlier platform; not used by the testbed
│   └── tests/                    # 443 tests: unit/ (engine, scores, adapter) and integration/ (API, closed loop)
│
├── apps/dashboard/               # OPERATOR WEBSITE (port 5173)
│   ├── src/main.tsx, App.tsx     # starts the app; page routes
│   ├── src/pages/TestbedPage.tsx # home: slices, devices, QR codes, scenarios, arbitration on/off, recording
│   ├── src/pages/ContentionPage.tsx      # when the link was short, and how badly
│   ├── src/pages/ArbitrationPage.tsx     # list of decisions
│   ├── src/pages/DecisionDetailPage.tsx  # one decision: who was cut, why, alternatives, override
│   ├── src/pages/MonitoringPage.tsx      # live charts
│   ├── src/pages/SlicesPage.tsx, DepartmentsPage.tsx, PoliciesPage.tsx, AuditPage.tsx  # the rules and the audit log
│   ├── src/pages/LoginPage.tsx   # sign in as Viewer, Manager or Admin
│   ├── src/api/client.ts, resources.ts   # calls the controller's API
│   ├── src/realtime/RealtimeProvider.tsx # receives live pushes
│   ├── src/components/           # page layout, menu, buttons, tables
│   └── src/lib/                  # number formatting (kbps, ms), theme
│
├── apps/portal/                  # PHONE PAGE (served by the gateway on 8080)
│   ├── src/App.tsx               # remembers this tab's device; rejoins after a gateway restart
│   ├── src/components/JoinPage.tsx   # enter a join code or open a QR link
│   └── src/components/SlicePage.tsx  # runs the download, sends probes, shows limit/latency/loss live
│
├── apps/agent/
│   └── src/index.ts              # a software phone for the command line (fills missing departments)
│
├── scripts/
│   ├── setup.ts                  # creates .env with a secret token
│   ├── demo-local.ts             # runs test cases TC1–TC6 with 7 agents on one laptop
│   ├── lan-info.ts               # shows the laptop's addresses and the join QR code
│   ├── experiment-summary.ts     # turns a recording CSV into a results table
│   ├── calibrate.ts, isp-check.ts    # measure idle latency / internet speed
│   ├── build-agent-exe.ts        # packs the agent into one .exe
│   ├── patch-realpath.cjs        # works around a Windows file-permission quirk in Node 24
│   └── windows/open-firewall.ps1, close-firewall.ps1, lan-info.ps1   # firewall for phones; addresses
│
├── docs/
│   ├── PROJECT-EXPLAINED.md      # the whole project from zero, with viva questions
│   ├── RUNBOOK.md                # step-by-step demo with phones on the hotspot
│   ├── ARCHITECTURE.md           # parts, ports, control loop
│   ├── API.md                    # every API call
│   ├── TESTBED.md                # setup, test cases, measured results
│   ├── LIMITATIONS.md            # what is real and what is scaled down
│   ├── OPEN-QUESTIONS.md         # Windows notes and open design points
│   └── source/ALGORITHM.md, TECHNICAL.md   # the CBHA algorithm and the original design, in full
│
├── experiments/                  # recordings land here (CSV files are not committed)
├── paper/                        # main.tex (paper), references.bib, results/ (measured data), scripts/
└── presentation/                 # deck/ (slides), video/ (explainer.mp4, subtitles, build scripts)
```
