# Runbook: the live demo with phones on the hotspot

A step-by-step script for showing the testbed with real phones (or laptops, or browser tabs).
It takes about 15 minutes.

---

## 1. Before the demo (do this once, 10 minutes)

1. **Install and build** (in the project folder):
   ```bash
   npm install
   ```
   ```bash
   npm run setup
   ```
   ```bash
   npm run build
   ```
   ```bash
   npm run seed
   ```
   `npm run build` matters: phones load the *built* department page from the gateway.
2. **Open the firewall** for phones. Open PowerShell with **Run as administrator**, go to the
   project folder, and run:
   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\windows\open-firewall.ps1
   ```
   It opens TCP 8080 for the local network only, and removes any Windows rule that blocks
   Node.js.
3. **Turn on the hotspot:** Settings → Network & internet → **Mobile hotspot** → On. Share your
   Wi-Fi connection. In *Properties*, choose the 2.4 GHz band if a phone can't see the network.
   Windows allows up to **8 devices**.
4. **Connect the phones** to the hotspot. Turn off mobile data on each phone, so it uses the
   hotspot, and set its screen to stay on for 10 minutes.

**Want a clean start?** Stop the servers, delete `apps/controller/.data`, and run
`npm run seed` again.

---

## 2. Start

```bash
npm run dev
```

Wait until the terminal shows the gateway's `Online` lines and the controller is listening
(about 10 s).

On the laptop, open <http://localhost:5173> and press **Sign in as Admin**. The home page is
**Slices and devices**. The **Gateway** box should say *Running*.

---

## 3. Join the seven departments

- **QR code:** on **Slices and devices**, click a slice row. The panel on the right shows its
  QR code for `http://192.168.137.1:8080/join?code=…`. Check that **Address phones use** says
  *hotspot*. Scan it with that department's phone and press **Join**.
- **Or type it:** on the phone open `http://192.168.137.1:8080/join` and enter the code:

  | Code | Department |
  |---|---|
  | `CLN101` | Clinic |
  | `FAC201` | Factory |
  | `LAB401` | Quality lab |
  | `WHS301` | Warehouse |
  | `SEC601` | Security |
  | `OFF501` | Office IT |
  | `CAN701` | Canteen |

- **Fewer than 7 phones?** Fill the other departments with browser tabs on the laptop
  (`http://localhost:8080/join`, one tab per department), or with the agent:
  ```bash
  npx tsx apps/agent/src/index.ts --code FAC201 --rate 209 --name factory-laptop
  ```

Each phone starts sending at 55 % of its limit. The **Devices** list on the dashboard shows
every device; the **Slices** table shows its demand, carried rate and measured latency.

---

## 4. The demo, act by act

### Act 1: a normal day (TC1)
Press **Run** on *TC1 Normal day*. Every slice sends 55 % of its limit, about 814 kbps on the
950 kbps link.

> "Everything fits. Every slice is at its full limit and within its latency target. Nothing is
> cut."

### Act 2: one department floods (TC2)
Press **Run** on *TC2 Canteen flood*. The Canteen asks for 280 kbps, twice its limit.

> "The Canteen's own limit holds it at 140 kbps. The rest still fits the link (about 877 kbps),
> so nobody else is affected and the engine doesn't need to cut anything. The slice's own limit
> already isolates it."

### Act 3: the lunch-hour rush (TC3)
Press **Run** on *TC3 Lunch-hour rush*: Canteen 200 %, Office and CCTV 100 %, Warehouse 80 %.

> "Now demand is about 1,300 kbps on a 950 kbps link. Within about 4 seconds a contention opens,
> and the engine decides who gives up bandwidth."

Point at the **State** column:
- the Canteen is cut towards its 28 kbps floor;
- Office, CCTV and Warehouse are cut a little;
- Clinic, Factory and Lab are not touched.

Open **Decisions** and the newest decision. Read one sentence of the explanation and show the
*Alternatives considered*. The "Priority Sort" plan had more harm.

> "The Canteen is labelled URLLC, top priority in a normal network, but an outage costs £15 a
> minute. The Quality lab is eMBB but regulated. We protect the lab."

Show the Canteen phone: it explains its own cut.

### Act 4: more than can be fixed (TC4)
Press **Run** on *TC4 Everyone at peak*.

> "1,480 kbps on 950. Even the deepest cuts the rules allow are not enough. The engine does not
> break a rule to make it fit: the decision is PARTIAL and the operator is alerted. The Clinic is
> still never cut."

### Act 5: the proof (TC6, about 3 minutes)
1. Press **Run** on *TC3*. Then turn **Automatic arbitration off**.
2. Wait about a minute. On the Clinic phone, latency rises to around half a second and loss
   appears, while its own limit hasn't changed.

   > "Without arbitration the shared link overflows and everybody suffers, even the Clinic."
3. Turn **Automatic arbitration on**. Within a few seconds the engine cuts the cheap slices.
   After about 25 s the shared queue has drained and the Clinic's latency is back to tens of
   milliseconds, with no loss.
4. In the **Recording** box, press **Download CSV**. Every 2-second window of the demo is in it,
   labelled with the scenario.

On one laptop (`npm run demo:local`), this comparison measured:
- Clinic p95 latency 503 ms → 23 ms, loss 5.6 % → 0 %;
- Factory 509 ms → 22 ms;
- Lab 505 ms → 22 ms.

### Act 6: back to normal (TC5)
Press **Run** on *TC5 Back to normal*. The contention closes after about 6 seconds. The cut
slices return when their recovery window ends: 10 min for Office/CCTV, 30 min for the Canteen.
To restore them at once, open the decision and press **Override** (admin), giving a reason. The
override is in the **Audit log**.

---

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| Phone can't open the page | Check the phone is on the laptop's hotspot (not mobile data), and that you used the hotspot address (`npm run lan:info`). Re-run `open-firewall.ps1` as administrator. Turn off any VPN on the laptop |
| Phone says "no internet" for the hotspot | Choose "stay connected"; the page works anyway |
| QR code points at 10.x or 192.168.56.x | In the slice panel, pick the address marked *hotspot* |
| A scenario button does nothing on a slice | That slice has no device joined. Only joined devices send traffic |
| A phone stopped updating | The screen locked; mobile browsers pause pages. Unlock it; it rejoins by itself |
| Gateway shows *Not reachable* | `npm run dev` isn't running, or failed. Look at the terminal. Port in use: close the old window, or end Node processes in Task Manager |
| Numbers look ten times too big | `.env` has the wrong link size. It must be `NETWORK_TOTAL_CAPACITY_MBPS=1000`. Delete `apps/controller/.data` and run `npm run seed` |
| Old decisions from yesterday | Normal: everything is kept. For a clean start, delete `apps/controller/.data` and run `npm run seed` |
| More than 8 devices | Windows hotspot limit. Use browser tabs on the laptop for the extra departments |
