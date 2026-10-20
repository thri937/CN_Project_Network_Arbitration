# Dashboard (`@cn/dashboard`)

The **operator's** website. Open <http://localhost:5173> while `npm run dev` is running, then
press **Sign in as Admin** (or Manager, or Viewer).

**Technology:**
- React 18 with Vite 5;
- TanStack Query (server data, polling every 2 s);
- React Router;
- Tailwind CSS;
- Recharts;
- the `qrcode` package;
- Socket.IO client.

## Pages

**Testbed**

- **Slices and devices** (the home page):
  - **Status:** gateway status, link use (carried vs demand vs 950 kbps), devices joined, and
    the **automatic arbitration on/off** switch (the TC6 comparison).
  - **Slices table:** each slice's demand, limit (against baseline), carried rate, latency
    p95 against target, loss and state ("Cut 34 %", "Never cut", "Up to 20 % cut"). These are
    exactly the gateway's measurements; anything not measured shows as —.
  - **Selected slice panel:** its join code and **QR code** for
    `http://<laptop address>:8080/join?code=…`. The address picker puts the hotspot first and
    marks virtual adapters. There are demand presets (Idle, Normal, Peak, Flood) for that
    slice's devices, and a "New join code" button.
  - **Test scenarios:** All idle and TC1–TC5. Each button sets the demand of every joined
    device. There are also written instructions for TC6.
  - **Devices:** name, address, slice, demand and last seen, with **Remove**.
  - **Recording:** every 2 s gateway window of the session is saved to
    `experiments/<time>-session.csv`, labelled with the last scenario. **Download CSV**.
- **Contention:** open and past contention events, and the detector's settings.
- **Decisions:** every arbitration decision. Each one opens a full explanation: the reasons,
  per-slice outcome and factors, the four rejected alternatives priced on the same scale, the
  policy in force and the audit trail. **Arbitrate now** (managers) runs the engine at once on
  an open contention.
- **Live charts:** one slice's demand, limit, carried rate, latency and loss over the last few
  minutes.
- **Department page:** opens the phone page on this laptop.

**Rules**

- **Slice contracts:** baselines, floors and SLA targets.
- **Departments:** the business facts behind every decision.
- **Business policy:** the score weights and engine tuning, versioned.
- **Audit log** (admin): every decision, override and setting change.

All bandwidth is shown in kbps. The theme is light by default; the moon button switches to dark.

## Develop

```bash
npm run dev -w @cn/dashboard
```

```bash
npm run build -w @cn/dashboard
```

The dev server proxies `/api` and `/realtime` to the controller on port 4000.
