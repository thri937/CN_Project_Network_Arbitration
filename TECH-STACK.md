# Tech stack, explained

Every technology in the **real-network testbed**, explained in the same three steps:

- **What it is**: the technology in plain words, for someone who has never used it.
- **Why we use it**: the problem it solves for this project.
- **Where it is used**: the exact folders and files, so you can open them and point at them.

For how the parts work together, read [`docs/PROJECT-EXPLAINED.md`](docs/PROJECT-EXPLAINED.md).

## The project in one picture

```
 Phone / laptop browser                Laptop (Windows)
 ┌──────────────────────┐   Wi-Fi     ┌──────────────────────────────────────────────────────┐
 │ Department page      │  hotspot    │ Slice gateway (:8080 for devices, :9090 private)     │
 │ (apps/portal)        │◄──────────►│ (apps/gateway) every byte passes through it          │
 └──────────────────────┘ HTTP + WS  │            ▲ southbound API: stats in, limits out    │
                                     │ Controller (:4000)  (apps/controller)                │
 Operator browser                    │ detects contention, decides with CBHA, keeps audit   │
 ┌──────────────────────┐            │            ▲ REST API + live push                    │
 │ Operator dashboard   │◄──────────►│ Dashboard (:5173)  (apps/dashboard)                  │
 └──────────────────────┘            └──────────────────────────────────────────────────────┘
```

## Contents

1. [Language and project tooling](#1-language-and-project-tooling): TypeScript, Node.js, npm workspaces, tsx, concurrently, dotenv, cross-env
2. [Shared code](#2-shared-code): Zod
3. [Slice gateway (the network)](#3-slice-gateway-the-network): node:http, WebSocket (ws), node:net, Pino, token bucket, queues and scheduler, FIFO and DRR, probes and the meter, the southbound API
4. [Controller (the brain)](#4-controller-the-brain): Express, REST API, Socket.IO, JWT, helmet, CORS, rate limiting, compression, OpenAPI/Swagger, the data store, the CBHA engine, the gateway adapter, firebase-admin
5. [Operator dashboard](#5-operator-dashboard): React, Vite, TanStack Query, Axios, socket.io-client, React Router, Tailwind CSS, clsx and tailwind-merge, Recharts, qrcode
6. [Department page on the phone](#6-department-page-on-the-phone): fetch streams, browser WebSocket, sessionStorage
7. [Agent (a software phone)](#7-agent-a-software-phone): Node fetch and WebSocket, Node single executable
8. [Testing and measurement](#8-testing-and-measurement): Vitest, Supertest, coverage, demo:local, helper scripts
9. [Networking and the operating system](#9-networking-and-the-operating-system): HTTP, TCP and ports, Wi-Fi hotspot, firewall, 3GPP slice identity
10. [Paper, slides and video](#10-paper-slides-and-video): LaTeX, pgfplots, python-pptx, Python, Windows speech, FFmpeg
11. [What we did not use, and why](#11-what-we-did-not-use-and-why)

---

## 1. Language and project tooling

### TypeScript (5.7)
- **What it is:** JavaScript with **types**. You write which kind of value each variable holds
  (a number, a text, a slice). A compiler checks the whole program before it runs and turns it
  into plain JavaScript.
- **Why we use it:**
  - Mistakes are caught while typing, not during the demo. A wrong field name, a missing value,
    or a number passed where text is expected are all errors before the program runs.
  - That matters here because a decision cuts real traffic.
  - One language serves every part: phone page, dashboard, gateway, controller and tests.
  - Strict mode is on, so even reading an array item that might not exist must be handled.
- **Where it is used:** every `.ts` / `.tsx` file in `apps/` and `packages/`. The compiler
  settings are in each package's own `tsconfig.json`.

### Node.js (20.11 or newer; tested on 24)
- **What it is:** a program that runs JavaScript outside the browser, on the laptop itself. It
  can open network ports, read files and run servers.
- **Why we use it:**
  - The gateway must be a real network server: accept phone connections, hold data in queues,
    send bytes at a controlled speed. Node does this with its built-in networking, so nothing
    else needs to be installed.
  - The controller and the agent run on it too.
- **Where it is used:** `apps/gateway`, `apps/controller` and `apps/agent` run on Node, and so
  does every script in `scripts/`. The minimum version is set in the root `package.json`
  (`engines`).

### npm and npm workspaces (npm 10)
- **What it is:** npm is Node's package manager: it downloads libraries listed in
  `package.json`. **Workspaces** let one repository hold several packages that can use each
  other.
- **Why we use it:**
  - The project has six packages: `@cn/shared`, `@cn/controller`, `@cn/gateway`,
    `@cn/dashboard`, `@cn/portal` and `@cn/agent`.
  - Workspaces let them all install with one `npm install`.
  - Every program can import the shared message definitions directly.
- **Where it is used:**
  - The root `package.json` (`workspaces` list, and all the `npm run …` commands).
  - One `package.json` per package.
  - `package-lock.json`, which pins exact versions.

### tsx (4.19)
- **What it is:** a tool that runs a TypeScript file directly, compiling it on the fly.
- **Why we use it:**
  - In development there is no separate build step: change a file and the program restarts.
  - Our helper scripts run with one command.
- **Where it is used:**
  - `npm run dev` for the controller and gateway (`tsx watch`).
  - `npm run demo:local`, `npm run setup`, `npm run seed` and every script in `scripts/`.

### concurrently (9.1)
- **What it is:** a tool that starts several programs at once in one terminal, with a coloured
  name in front of each line.
- **Why we use it:** the testbed is four programs (controller, gateway, dashboard, department
  page). One command starts them all, and you can still see which program printed what.
- **Where it is used:** the `dev` and `start` commands in the root `package.json`.

### dotenv (16.4)
- **What it is:** a library that reads settings from a `.env` text file into the program's
  environment variables.
- **Why we use it:**
  - Settings change between laptops without changing code: link size, ports, and the secret
    token shared by the controller and gateway.
  - The secret stays out of GitHub (`.env` is in `.gitignore`).
- **Where it is used:**
  - Loaded in `apps/gateway/src/index.ts`, `apps/controller/src/config/env.ts` and
    `apps/agent/src/index.ts`.
  - `npm run setup` (`scripts/setup.ts`) creates `.env` from `.env.example` and generates the
    token.

### cross-env (7.0)
- **What it is:** a small tool that sets an environment variable in a way that works the same on
  Windows and on Linux/macOS.
- **Why we use it:** Windows and Linux set variables differently on the command line; this makes
  such a command work on both.
- **Where it is used:** only the optional `test:firestore` command in
  `apps/controller/package.json`. The testbed itself never needs it.

---

## 2. Shared code

### Zod (3.24)
- **What it is:** a library for describing the **shape of data** ("a slice has a code, a name, a
  baseline in kbps…") and checking real data against that description while the program runs.
- **Why we use it:**
  - Four programs send each other messages: phone ↔ gateway ↔ controller ↔ dashboard.
  - One Zod schema gives two things at once. The program rejects a malformed message with a
    clear error instead of crashing. TypeScript gets the type from the same schema, so the
    check and the type can never disagree.
- **Where it is used:**
  - `packages/shared/src/index.ts` (the shared message formats).
  - Request checks in `apps/gateway/src/southbound/southboundServer.ts` and
    `apps/gateway/src/portal-api/portalServer.ts`.
  - The controller's `apps/controller/src/middleware/validate.ts`, `src/validators/` and
    `src/config/env.ts` (the `.env` settings are checked at start-up).

---

## 3. Slice gateway (the network)

The gateway is what makes this project **real**: every byte a phone downloads passes through it,
at the speed the controller allows.

### node:http (built into Node)
- **What it is:** Node's built-in web server. It listens on a port and answers HTTP requests.
- **Why we use it:**
  - The phones talk HTTP, because a browser is all they need.
  - Using the built-in server gives us full control over **when** each byte is written, which
    is exactly what a traffic shaper needs. A web framework would hide that.
- **Where it is used:**
  - `apps/gateway/src/portal-api/portalServer.ts`: the **devices' server on port 8080**. It
    handles join, the download stream, latency probes and the live WebSocket, and also serves
    the built phone page.
  - `apps/gateway/src/southbound/southboundServer.ts`: the **private API on 127.0.0.1:9090**
    for the controller.

### WebSocket, using the `ws` library (8.18)
- **What it is:** a connection between browser and server that **stays open**, so either side
  can send a message at any moment. Plain HTTP is one question, one answer.
- **Why we use it:**
  - The gateway pushes each phone a live snapshot every second: its limit, demand, latency and
    loss.
  - It tells the phone immediately when the operator changes its demand or removes it.
  - Without it, the phone would have to keep asking.
- **Where it is used:** the `/ws` endpoint in `apps/gateway/src/portal-api/portalServer.ts`.

### node:net (built into Node)
- **What it is:** Node's low-level TCP networking (raw connections, below HTTP).
- **Why we use it:** for the optional forward proxy, which relays a phone's own app traffic.
- **Where it is used:** `apps/gateway/src/proxy/forwardProxy.ts`. It is off by default
  (`GATEWAY_PROXY_ENABLED=false`) and does not shape traffic yet; see
  `docs/LIMITATIONS.md`.

### Pino (9.6)
- **What it is:** a fast logging library. Each log line is structured data (time, level,
  fields), not just text.
- **Why we use it:**
  - We can see exactly what happened and when: a device joined, a limit changed, the gateway
    restarted.
  - It is fast enough not to slow the 20 ms scheduler.
- **Where it is used:** the gateway (`apps/gateway/src/index.ts` and its servers) and the
  controller (`apps/controller/src/utils/logger.ts`).

### Token bucket (our own code)
- **What it is:** the classic way networks enforce a speed limit.
  - Picture a bucket that fills with tokens at a fixed rate, the slice's **limit**.
  - Sending 1 byte costs 1 token.
  - If the bucket is empty, the data waits.
  - The bucket's size allows a small burst.
- **Why we use it:**
  - It is the standard rate limiter in real routers, so our slice limits behave like real
    ones.
  - We measured it within **0.25 %** of the limit from 20 to 950 kbps.
  - The bucket always holds at least one full 1 KB chunk, so even a slice cut to 28 kbps keeps
    moving.
- **Where it is used:** `apps/gateway/src/shaper/tokenBucket.ts`. Every slice has one bucket.

### Queues and the 20 ms scheduler (our own code)
- **What it is:** a queue is a waiting line for data; the scheduler is a loop that runs every
  20 ms and moves data along.
- **Why we use it:** this is how real congestion appears. Every 20 ms:
  1. New bytes a phone asked for join its slice's queue. The queue holds 0.5 s of traffic; when
     it is full, new bytes are **dropped** (that is packet loss).
  2. The token bucket lets bytes out no faster than the limit.
  3. The shared link sends them at 950 kbps.

  When demand is bigger than the link, queues fill up, and data waits (latency) or is dropped
  (loss). Rates use the real clock, so uneven Windows timers don't change them.
- **Where it is used:**
  - `apps/gateway/src/shaper/queue.ts` and `apps/gateway/src/shaper/scheduler.ts`.
  - Download sessions in `apps/gateway/src/sessions/loadSession.ts`.

### FIFO and DRR: two ways to share the link (our own code)
- **What it is:**
  - **FIFO** (first in, first out): one shared waiting line for all slices, like a single
    supermarket checkout. If it fills up, *everyone* waits behind it.
  - **DRR** (deficit round robin): every slice has its own line, and the link serves them in
    turn, each getting a share proportional to its limit. This is a well-known form of
    **fair queueing**.
- **Why we use it:**
  - FIFO (the default) behaves like a plain switch port. That is exactly the problem we
    demonstrate: without arbitration even the clinic waits half a second.
  - DRR is there to answer the obvious question, "why not just share fairly?" Our measurements
    show it protects light slices, but at full peak it gives the clinic only 37.5 kbps, below
    its 40 kbps minimum, because fairness doesn't know business value.
- **Where it is used:** `apps/gateway/src/shaper/scheduler.ts` (`policeFifo` /
  `transmitRootQueue` and `transmitDrr`). Chosen with `GATEWAY_ROOT_DISCIPLINE` in `.env`.

### Probes and the meter (our own code)
- **What it is:**
  - A **probe** is a tiny message a phone sends every second to measure round-trip time
    (latency).
  - The **meter** counts each slice's traffic and turns it into numbers every 2 seconds.
- **Why we use it:**
  - Probes wait in the **same queue as the slice's data**, so the latency we report is what that
    slice's traffic really experiences.
  - Every 2 s the meter closes a "window" per slice: demand, carried, dropped, queue delay,
    latency p50 and p95, jitter, loss and availability.
  - The controller decides from these real measurements, not from a model.
- **Where it is used:** `apps/gateway/src/probes/probeManager.ts` and
  `apps/gateway/src/meter/sliceMeter.ts`.

### The southbound API (our own design)
- **What it is:** the small private API between the controller (the brain) and the gateway (the
  network). "Southbound" is the networking term for the direction from a controller down to the
  network.
- **Why we use it:**
  - It keeps the jobs separate: the controller only *decides*, and the gateway only *enforces
    and measures*.
  - It listens on `127.0.0.1` (the laptop itself) and needs a secret token, so a phone on the
    hotspot cannot change any limit.
- **Where it is used:**
  - Server: `apps/gateway/src/southbound/southboundServer.ts`.
  - Calls: `GET /v1/stats`, `PUT /v1/slices/:code/limit`, `PUT /v1/slices`, `GET` and `DELETE`
    on `/v1/devices`, `POST /v1/slices/:code/demand`.
  - Documented in `docs/API.md`.

---

## 4. Controller (the brain)

### Express (4.21)
- **What it is:** the most widely used web framework for Node. You declare "for this URL, run
  this function", and add shared steps (security, logging, checking input) in between.
- **Why we use it:**
  - The dashboard needs an API with many endpoints, user roles and input checks. Express makes
    that short and readable.
  - It is very well known, which makes it easy to explain and review.
- **Where it is used:**
  - `apps/controller/src/app.ts` builds the app.
  - `src/routes/*.routes.ts` hold the URLs.
  - `src/controllers/*.controller.ts` hold the handlers.
  - `src/middleware/` holds the shared steps.

### REST API
- **What it is:** a common style of web API. Each kind of thing has a URL (`/api/v1/slices`,
  `/api/v1/decisions/:id`), and HTTP verbs say what to do: GET reads, POST creates, PUT changes,
  DELETE removes.
- **Why we use it:** it is simple, standard, and easy to test with a browser or a script.
- **Where it is used:**
  - All controller routes under `/api/v1/…`.
  - The testbed controls are in `apps/controller/src/routes/testbed.routes.ts`: scenarios,
    arbitration on/off, devices and the recording download.

### Socket.IO (4.8)
- **What it is:** a library built on WebSockets that adds automatic reconnection and named
  events.
- **Why we use it:** when the engine makes a decision or a contention opens, the dashboard
  updates at once, without reloading or polling.
- **Where it is used:**
  - Server: `apps/controller/src/realtime/gateway.ts`. (Here "gateway" means the realtime
    gateway, not the slice gateway.)
  - Client: `apps/dashboard/src/realtime/RealtimeProvider.tsx`.

### JWT, using `jsonwebtoken` (9.0)
- **What it is:** a JSON Web Token is a signed piece of text that proves who you are. The server
  signs it at sign-in; on each request it checks the signature, so nobody can fake or edit the
  token.
- **Why we use it:**
  - The operator signs in once, and every later request carries the token.
  - The token holds the role: **Viewer** can look; **Manager** can run scenarios and turn
    arbitration off; **Admin** can also override decisions and read the audit log.
- **Where it is used:**
  - Tokens are made and checked in `apps/controller/src/services/token.service.ts`.
  - The sign-in is in `src/auth/dev.auth.adapter.ts` (local, role-based sign-in).
  - Requests are checked in `src/middleware/authenticate.ts` and `src/middleware/authorize.ts`.
  - The dashboard's sign-in page is `apps/dashboard/src/pages/LoginPage.tsx`.

### helmet (8.0)
- **What it is:** a small library that adds standard **security headers** to every HTTP
  response. They tell browsers to block common attacks such as clickjacking and content
  sniffing.
- **Why we use it:** one line protects every endpoint.
- **Where it is used:** `apps/controller/src/app.ts`.

### CORS, using `cors` (2.8)
- **What it is:** browsers block a page from calling an API on a different address unless the
  API allows it. CORS is that permission.
- **Why we use it:** the dashboard (port 5173) calls the controller (port 4000). Only the
  addresses we list are allowed; any other website is refused.
- **Where it is used:** `apps/controller/src/app.ts`. The allowed addresses are set in
  `CORS_ORIGINS` in `.env` (the dashboard, by default).

### Rate limiting, using `express-rate-limit` (7.5)
- **What it is:** a limit on how many requests one client may send per minute.
- **Why we use it:** it stops a buggy script or a password-guessing attempt from flooding the
  controller.
- **Where it is used:** `apps/controller/src/middleware/rateLimiter.ts`, with one limiter for
  the API and a stricter one for sign-in.

### compression (1.7)
- **What it is:** gzip-compresses API responses before sending them.
- **Why we use it:** smaller responses, so the dashboard loads faster.
- **Where it is used:** `apps/controller/src/app.ts`.

### OpenAPI and Swagger UI, using `swagger-ui-express` (5.0)
- **What it is:**
  - **OpenAPI** is a standard format for describing an API: every URL, input and output.
  - **Swagger UI** turns that description into an interactive web page where you can try each
    call.
- **Why we use it:** living documentation of the controller's API that anyone can test from a
  browser.
- **Where it is used:**
  - The description is in `apps/controller/src/docs/openapi.ts`.
  - It is served at `http://localhost:4000/api/docs`, set up in
    `apps/controller/src/bootstrap.ts`.

### The data store (our own code)
- **What it is:** the controller keeps its data in memory and saves it to files on disk. The
  data is slices, departments, the business policy, contention events, decisions and the audit
  log.
- **Why we use it:**
  - The demo needs no database server to install or start.
  - The data survives a restart.
  - `npm run seed` fills it with the seven departments.
  - To start fresh, delete `apps/controller/.data`.
- **Where it is used:**
  - `apps/controller/src/repositories/memory/`: `memory.datastore.ts` and
    `persistence.ts`.
  - The repositories in `src/repositories/*.repository.ts` are the only code that touches
    data.
  - The data files are in `apps/controller/.data/`.

### The CBHA engine (our own code)
- **What it is:** **Convex Business-Harm Arbitration**, the algorithm at the heart of the
  project.
  - Each department gets a business score from seven facts: criticality, downtime cost,
    importance, compliance, customer impact, operations and recovery tolerance.
  - When the link is short, the engine frees bandwidth in small steps. Each step goes to the
    slice where cutting a little more causes the least business harm (this is called
    "water-filling").
  - Harm grows faster than the cut, so the engine prefers several small cuts over one deep
    cut.
  - Hard rules are never broken: life-safety slices are never cut, no slice goes below its
    minimum, and no department is cut past its ceiling.
- **Why we use it:**
  - This is our problem statement: decide by **department and business value**, not by
    technical labels such as URLLC or eMBB, and explain why.
  - It needs no maths library and decides in milliseconds.
  - Every decision is written to the audit log with reasons and the alternatives it rejected.
- **Where it is used:**
  - The engine and scoring: `apps/controller/src/domain/` (`policyEngine.ts` and the
    `arbitration/` folder).
  - Detection: `src/services/contention.service.ts`.
  - Decide and apply: `src/services/arbitration.service.ts` and
    `src/services/allocation.service.ts`.
  - The seven departments and their facts: `apps/controller/src/testbed/catalogue.ts`.

### The gateway adapter (our own code)
- **What it is:** the controller's single connection to the network.
- **Why we use it:**
  - The rest of the controller never talks to the network directly. It calls the adapter,
    which reads the gateway's stats and sends new limits.
  - That keeps the brain independent of the network, which also makes it testable.
- **Where it is used:**
  - `apps/controller/src/telemetry/adapters/gateway.telemetry.adapter.ts`, chosen by
    `TELEMETRY_PROVIDER=gateway` in `.env`.
  - The recorder that saves every 2 s window to `experiments/<time>-session.csv` is
    `apps/controller/src/testbed/experimentRecorder.ts`.

### firebase-admin (13.0): optional, not used by the testbed
- **What it is:** Google's library for Firebase sign-in and the Firestore cloud database.
- **Why it is there:** the controller grew out of a platform that could run in the cloud. The
  testbed does **not** use it: it runs with `DATASTORE_DRIVER=memory` and `AUTH_DRIVER=dev`.
  It is loaded only if someone switches those settings.
- **Where it is used:** `apps/controller/src/firebase/admin.ts` and
  `src/auth/firebase.auth.adapter.ts`.

---

## 5. Operator dashboard

### React (18.3)
- **What it is:** a library for building web pages out of **components**: reusable pieces such
  as a table row, a card or a chart. When the data changes, React updates only the parts of the
  page that changed.
- **Why we use it:**
  - The dashboard shows live data that changes every 2 seconds. React keeps the page in step
    with the data without manual updates.
  - The same knowledge carries over to the phone page.
- **Where it is used:**
  - Everything in `apps/dashboard/src/`.
  - The pages are in `src/pages/`. The main page is `TestbedPage.tsx` (Slices and devices);
    the others are `ContentionPage.tsx`, `ArbitrationPage.tsx`, `DecisionDetailPage.tsx`,
    `MonitoringPage.tsx` (Live charts), `SlicesPage.tsx`, `DepartmentsPage.tsx`,
    `PoliciesPage.tsx` and `AuditPage.tsx`.
  - Shared pieces are in `src/components/`.

### Vite (5.4)
- **What it is:** the build tool for the web pages. In development it serves the page with
  instant reload on every save. For production it bundles everything into small optimised
  files.
- **Why we use it:**
  - It is very fast to start and reload.
  - The production build of the phone page is what the gateway serves to phones.
- **Where it is used:**
  - `apps/dashboard/vite.config.ts` (development server on port **5173**).
  - `apps/portal/vite.config.ts` (port 5174 in development).
  - `npm run build` creates each `dist/` folder.

### TanStack Query (5.62)
- **What it is:** a library that fetches data from a server, keeps a copy (a cache), and
  refreshes it on a timer or when it becomes stale.
- **Why we use it:**
  - The dashboard is almost entirely server data. TanStack Query handles loading states,
    errors and refreshing for us.
  - The testbed page refreshes every **2 s**, one gateway window, so the measured numbers stay
    live.
- **Where it is used:**
  - Set up in `apps/dashboard/src/main.tsx`.
  - Used in every page (`useQuery`).
  - Cache keys are in `src/lib/queryKeys.ts`.

### Axios (1.7)
- **What it is:** a library for making HTTP requests from the browser.
- **Why we use it:**
  - One place attaches the sign-in token to every request and turns errors into readable
    messages.
  - It also downloads the recording CSV as a file.
- **Where it is used:** `apps/dashboard/src/api/client.ts` and `src/api/resources.ts`.

### socket.io-client (4.8)
- **What it is:** the browser side of Socket.IO.
- **Why we use it:** it receives the controller's live pushes (new decision, contention opened
  or closed) and tells TanStack Query to refresh.
- **Where it is used:** `apps/dashboard/src/realtime/RealtimeProvider.tsx` and
  `src/hooks/useLiveData.ts`.

### React Router (6.28)
- **What it is:** a library for moving between pages inside a single-page web app without a
  full reload. Each page has its own URL.
- **Why we use it:** the dashboard has about ten pages, and each one should have a link you can
  share and a working Back button.
- **Where it is used:** `apps/dashboard/src/App.tsx` (the routes) and
  `src/components/layout/AppShell.tsx` (the menu).

### Tailwind CSS (3.4), with PostCSS and Autoprefixer
- **What it is:** a styling system where you style elements with short ready-made classes (for
  example `p-4` for padding, `text-sm` for small text) instead of writing separate CSS files.
  PostCSS processes the CSS, and Autoprefixer adds browser-specific variants.
- **Why we use it:**
  - The look stays consistent everywhere.
  - Light and dark themes come from one set of colour tokens.
  - The phone page is easy to size for small screens.
- **Where it is used:**
  - `tailwind.config.js` and `postcss.config.js` in `apps/dashboard` and `apps/portal`.
  - The theme switch is `apps/dashboard/src/lib/theme.tsx`.

### clsx and tailwind-merge (2.1 / 2.6)
- **What it is:** two tiny helpers. `clsx` joins CSS class names conditionally; `tailwind-merge`
  removes Tailwind classes that conflict.
- **Why we use it:** a component can take extra classes from its parent without the styles
  fighting.
- **Where it is used:** `apps/dashboard/src/lib/cn.ts`, used by the UI components in
  `src/components/ui/`.

### Recharts (2.15)
- **What it is:** a charting library for React: line charts, bar charts and so on.
- **Why we use it:** to draw the live latency and throughput charts from the gateway's
  measurements.
- **Where it is used:** `apps/dashboard/src/pages/MonitoringPage.tsx` (Live charts) and the
  phone page `apps/portal/src/components/SlicePage.tsx`.

### qrcode (1.5)
- **What it is:** a library that draws QR codes.
- **Why we use it:**
  - Each department's phone scans a QR code to open its join page:
    `http://192.168.137.1:8080/join?code=CLN101`. That is faster and less error-prone than
    typing an address.
  - The dashboard lets you pick which laptop address the QR code points to, and marks the
    hotspot address.
- **Where it is used:** `apps/dashboard/src/pages/TestbedPage.tsx` (the panel for the selected
  slice), and in the terminal by `npm run lan:info` (`scripts/lan-info.ts`).

---

## 6. Department page on the phone

This page uses **React, Vite, Tailwind CSS and Recharts**, explained above. It is built once
with `npm run build` and then **served by the gateway** on port 8080, so a phone needs nothing
but its browser. Its code is in `apps/portal/src/`:

- `App.tsx` (joining, and remembering the device).
- `components/JoinPage.tsx` (enter a code).
- `components/SlicePage.tsx` (the live slice page).

It also uses three things built into every browser:

### fetch streams (built into the browser)
- **What it is:** `fetch` downloads from a URL. Reading its **stream** gives you the bytes as
  they arrive, instead of waiting for the whole file.
- **Why we use it:**
  - This download *is* the slice's traffic. The phone asks the gateway for, say, 120 kbps, and
    reads the stream for as long as it runs.
  - The gateway decides how fast the bytes really come: that is the slice limit at work.
- **Where it is used:** `apps/portal/src/components/SlicePage.tsx`.

### WebSocket (built into the browser)
- **What it is:** the browser's own WebSocket, the client side of the gateway's `ws` server.
- **Why we use it:** to receive the live snapshot every second, demand changes from the
  operator, and the "you were removed" message.
- **Where it is used:** `apps/portal/src/components/SlicePage.tsx`.

### sessionStorage (built into the browser)
- **What it is:** a small key-value store that belongs to **one browser tab** and is cleared
  when the tab closes.
- **Why we use it:**
  - Each tab remembers its own device and join code. Several tabs on one laptop can therefore
    each be a different department, which is useful when there are fewer than seven phones.
  - If the gateway restarts, the page rejoins the same slice by itself.
- **Where it is used:** `apps/portal/src/App.tsx`.

---

## 7. Agent (a software phone)

### Node's built-in fetch and WebSocket
- **What it is:** Node 22 and newer include the same `fetch` and `WebSocket` as browsers.
- **Why we use it:**
  - The agent behaves exactly like the phone page: join, download at a set rate, send probes.
    Because it needs no browser, it fills departments when there aren't enough phones.
  - `npm run demo:local` uses seven agents to run every test case on one laptop.
- **Where it is used:**
  - `apps/agent/src/index.ts`.
  - Run one with `npx tsx apps/agent/src/index.ts --code FAC201 --rate 209`.

### Node single executable application (SEA)
- **What it is:** a Node feature that packs a program and Node itself into one `.exe` file.
- **Why we use it:** to run an agent on a laptop that doesn't have Node installed.
- **Where it is used:** `npm run build:agent:exe` (`scripts/build-agent-exe.ts`).

---

## 8. Testing and measurement

### Vitest (2.1)
- **What it is:** a test runner. You write small programs that check your code ("given this
  input, expect that output"), and Vitest runs them all and reports pass or fail.
- **Why we use it:**
  - 460 tests (443 for the controller, 17 for the gateway) prove the important rules on every
    change:
    - the clinic can never be cut;
    - the shaper holds its rate;
    - the shared link is never exceeded;
    - fair sharing really isolates and weights slices;
    - the private API needs its token.
  - It is fast and understands TypeScript directly.
- **Where it is used:**
  - `apps/controller/tests/` and `apps/gateway/tests/`.
  - Run everything with `npm test`.

### Supertest (7.0)
- **What it is:** a library for calling an HTTP API inside a test, without starting a real
  server on a port.
- **Why we use it:** to test the controller's endpoints, including sign-in, roles and input
  checks, quickly and reliably.
- **Where it is used:** the API tests in `apps/controller/tests/`.

### @vitest/coverage-v8 (2.1)
- **What it is:** measures which lines of code the tests actually ran.
- **Why we use it:** to find important code that no test touches.
- **Where it is used:** `npm run test:coverage -w @cn/controller`.

### `npm run demo:local` (our own script)
- **What it is:** an automatic end-to-end test on real traffic. It starts the gateway, the
  controller and seven agents on one laptop, then runs the six test cases:
  1. normal day;
  2. canteen flood;
  3. lunch-hour rush;
  4. everyone at peak;
  5. recovery;
  6. arbitration off vs on.

  It checks every pass condition from the measurements.
- **Why we use it:** it proves the whole system works together, and it produced the numbers in
  the paper (for example clinic latency 503 → 23 ms).
- **Where it is used:**
  - The script is `scripts/demo-local.ts`.
  - Results go to `experiments/`; the copies used in the paper are in `paper/results/`.

### Helper scripts
| Command | What it does | File |
|---|---|---|
| `npm run setup` | Creates `.env` and the secret token | `scripts/setup.ts` |
| `npm run lan:info` | Lists the laptop's addresses (hotspot first) and prints the join QR code | `scripts/lan-info.ts` |
| `npm run experiment:summary -- <csv>` | Turns a recording into a table of means per scenario and slice | `scripts/experiment-summary.ts` |
| `npm run calibrate` | Measures the idle probe latency of joined devices (the latency floor) | `scripts/calibrate.ts` |
| `npm run isp:check` | Measures how fast the laptop's internet delivers internet-mode downloads | `scripts/isp-check.ts` |

---

## 9. Networking and the operating system

### HTTP, TCP and ports
- **What it is:**
  - **TCP** is the protocol that delivers a reliable stream of bytes between two computers.
  - **HTTP** runs on top of TCP and carries web requests.
  - A **port** is a numbered door on a computer, so several servers can run side by side.
- **Why it matters here:** every part of the testbed talks over TCP. Our shaper decides how
  fast bytes are written into each phone's TCP connection, and that is what the phone measures
  as its speed.
- **Where it is used:**

  | Port | Who listens | Who connects |
  |---|---|---|
  | 8080 | Gateway: devices' API and the phone page | Phones and laptop tabs on the hotspot |
  | 127.0.0.1:9090 | Gateway: southbound API (private) | Controller only |
  | 4000 | Controller: REST API, Socket.IO, `/api/docs` | Dashboard |
  | 5173 | Dashboard (development server) | Operator's browser |
  | 5174 | Department page (development only) | Developer |
  | 8888 | Optional proxy (off by default) | Phones' own apps |

### Windows Mobile Hotspot (Wi-Fi)
- **What it is:** a Windows feature that turns the laptop into a Wi-Fi access point.
- **Why we use it:** phones join the laptop directly, with no router or extra hardware. The
  laptop is always `192.168.137.1`, and up to **8 devices** can join.
- **Where it is used:** Settings → Network & internet → Mobile hotspot. Step by step in
  `docs/RUNBOOK.md`.

### Windows Defender Firewall, with PowerShell scripts
- **What it is:** the firewall decides which network connections may reach the laptop.
  PowerShell is Windows' scripting language.
- **Why we use it:**
  - By default Windows blocks phones from reaching port 8080.
  - Our script opens port 8080 **only to the local network**, and removes any rule that blocks
    Node.js. A second script undoes it.
- **Where it is used:** `scripts/windows/open-firewall.ps1` and
  `scripts/windows/close-firewall.ps1`. Run them as administrator.

### 3GPP slice identity (S-NSSAI) and slice types (URLLC, eMBB)
- **What it is:**
  - In 5G, a slice is identified by an **S-NSSAI**: a slice type (SST) plus a differentiator
    (SD).
  - Common types are **URLLC** (ultra-reliable low latency) and **eMBB** (high bandwidth).
- **Why we use it:**
  - Each slice carries a real 5G identity (for example SST 2, SD 000101), so the testbed speaks
    the same language as real slicing.
  - The engine deliberately **ignores** the type label. In our company the canteen is URLLC and
    the regulated lab is eMBB, which shows why labels make bad decisions.
- **Where it is used:** the slice catalogue in `apps/controller/src/testbed/catalogue.ts` and
  `apps/gateway/src/defaultCatalogue.ts`.

---

## 10. Paper, slides and video

### LaTeX (IEEEtran class), with pgfplots and TikZ
- **What it is:**
  - **LaTeX** is the standard typesetting system for scientific papers; IEEEtran is IEEE's
    conference layout.
  - **pgfplots** and **TikZ** draw charts and diagrams from numbers inside the document.
- **Why we use it:** conferences expect this format, and every chart is drawn directly from our
  measured CSV files, so the figures always match the data.
- **Where it is used:**
  - `paper/main.tex` and `paper/references.bib`.
  - The data is in `paper/results/`.
  - Compile on Overleaf (see `paper/README.md`).

### The slide deck, and python-pptx
- **What it is:**
  - The deck is written as one HTML file per slide.
  - **python-pptx** is a Python library that writes PowerPoint files.
  - **Headless Chrome** is Chrome running without a window, used to render each slide to an
    image.
- **Why we use it:** to have the same deck online and as a `.pptx` with speaker notes.
- **Where it is used:** `presentation/deck/` and `Real-Network-Testbed-Slides.pptx` in the
  repository root.

### Python (numpy, Pillow, imageio-ffmpeg), Windows speech and FFmpeg
- **What it is:**
  - **Python** draws every frame of the explainer video: **Pillow** draws pictures, and
    **numpy** handles the audio maths.
  - **Windows speech (Microsoft Zira)** is the built-in offline voice that reads the script and
    reports when each word is spoken.
  - **FFmpeg** (via imageio-ffmpeg) encodes the frames and sound into an MP4.
- **Why we use it:**
  - The video is generated from a script file, so changing a sentence regenerates the voice,
    the subtitles and the timing.
  - It needs no internet, no paid voice and no video editor.
- **Where it is used:** `presentation/video/build/`. The narration is in `script_data.py`, the
  drawing in `render.py`, and the voice in `tts.ps1`. The output is
  `presentation/video/explainer.mp4`.

---

## 11. What we did not use, and why

| Not used | Why not |
|---|---|
| **Linux `tc` (kernel traffic control)** | The demo laptop runs Windows, which has no `tc`. Our own shaper runs on any laptop and measures itself; kernel shaping is future work |
| **A real 5G core (Open5GS, free5GC) or Kubernetes** | Not needed to show arbitration on real traffic. The controller still has adapters for them from the platform it grew out of, but this project runs with `TELEMETRY_PROVIDER=gateway` |
| **A database server (PostgreSQL, MongoDB…)** | The file-backed store is enough for one laptop, and the demo needs no setup |
| **Redux** | TanStack Query already holds all server data; a second store would duplicate it |
| **An ORM** | The data access is simple and lives in a few repository files |
| **A maths or solver library** | The CBHA water-filling is short, fast (milliseconds) and can explain every step it takes |
| **Docker** | Everything runs with `npm install` on the demo laptop; containers would add setup without helping the demo |
