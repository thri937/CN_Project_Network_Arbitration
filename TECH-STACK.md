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
