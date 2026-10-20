# Live Demonstration Runbook — CN Real Network Arbitration Testbed

This runbook provides step-by-step instructions for demonstrating the **5G CBHA Real-Network Arbitration Platform** to instructors, judges, and evaluators using real mobile devices over Windows 11 Wi-Fi.

---

## 1. Pre-Flight Preparation Checklist (5 Minutes Before Demo)

1. **Verify Laptop Wi-Fi & Hotspot:**
   - Ensure the Windows 11 laptop is connected to an upstream Wi-Fi network (or Ethernet).
   - Open **Windows Settings → Network & internet → Mobile hotspot**.
   - Set Network Band to **2.4 GHz or 5 GHz** (2.4 GHz has wider phone compatibility).
   - Toggle Mobile Hotspot to **On**.
2. **Open Firewall Rules (Administrator):**
   ```powershell
   # Run in an elevated PowerShell session:
   cd 'D:\CN project\CN project\CN_Real_Network_arbitration'
   .\scripts\windows\open-firewall.ps1
   ```
3. **Verify Environment Configuration:**
   ```powershell
   npm run setup
   npm run seed
   ```
4. **Display Join Information & QR Codes:**
   ```powershell
   npm run lan:info
   ```
   *(This prints the detected hotspot IP `192.168.137.1` and a terminal QR code for the portal)*.

---

## 2. Launching the Platform

Start all four components in labeled development mode:
```powershell
npm run dev
```

Verify that all subsystems report online:
- `[gate]` Slice Gateway listening on `0.0.0.0:8080` (Portal) and `127.0.0.1:9090` (Southbound).
- `[ctrl]` Controller listening on `0.0.0.0:4000`.
- `[dash]` Dashboard available at `http://localhost:5173/testbed`.

Open your browser to the operator console:
👉 **`http://localhost:5173/testbed`**

---

## 3. Connecting Mobile Devices to Slices

Have participants or helpers connect their smartphones to the laptop's Mobile Hotspot:

1. **Join Hotspot Wi-Fi:**
   - Scan for the laptop's hotspot SSID on the phone and enter the hotspot password.
2. **Open Slice Portal:**
   - Scan the QR code shown on the **Testbed Dashboard** (or navigate to `http://192.168.137.1:8080/join`).
3. **Bind Devices to Departments:**
   - Enter a Join Code for each device:
     - Phone 1: **`CLN101`** (Clinic — Patient Telemetry)
     - Phone 2: **`FAC201`** (Factory — Factory Automation)
     - Phone 3: **`QAL301`** (Quality lab — Lab Instrumentation)
     - Phone 4: **`WRH401`** (Warehouse — Warehouse Operations)
     - Phone 5: **`SEC501`** (Security — CCTV)
     - Phone 6: **`OFF601`** (Office IT — Office Wi-Fi)
     - Phone 7: **`CAN701`** (Canteen — Canteen Signage)
4. **Confirm Device Connection:**
   - On the **Testbed Dashboard**, observe the interactive SVG topology map: nodes transition from gray to green with active device badges.

---

## 4. Live Demonstration Script

### Act 1: Baseline Normal Operation (TC1)
1. On each phone, tap **Normal (55%)**.
2. **Observe Dashboard:**
   - Total carried throughput is $\approx 814\text{ kbps}$ (under the 950 kbps offered capacity).
   - Animated packet particles flow steadily towards all 7 slices.
   - All SLA status chips are green (RTT $\approx 25\text{--}40\text{ ms}$, loss $0\%$).
   - Contention state displays **`NORMAL`**.

### Act 2: The Rogue Best-Effort Slice (TC2)
1. On the **Canteen Phone**, tap **Flood (200%)** (requesting 280 kbps).
2. **Observe Gateway Shaper:**
   - Canteen's live throughput climbs to its **140 kbps** baseline limit and flatlines.
   - The token bucket tail-drops the excess 140 kbps locally in Canteen's queue.
   - **Explain to Evaluator:** "The shaper enforces slice limits at the gateway without needing arbitration because the total carried load ($\approx 877\text{ kbps}$) still fits within our 950 kbps link."

### Act 3: Lunch-Hour Contention & CBHA Arbitration (TC3)
1. Increase load across non-critical slices:
   - Canteen: **Flood (200%)** ($280\text{ kbps}$)
   - Office IT: **Peak (100%)** ($320\text{ kbps}$)
   - Security CCTV: **Peak (100%)** ($240\text{ kbps}$)
   - Warehouse: **Busy (80%)** ($128\text{ kbps}$)
2. **Observe Contention Trigger (within ~4 seconds):**
   - Demand reaches $\approx 1,309\text{ kbps}$ ($138\%$ of link capacity).
   - Dashboard flashes **`CONTENTION DETECTED: SEVERE`**.
   - CBHA solver executes marginal-harm water-filling optimization.
3. **Observe Arbitration Outcome:**
   - **Clinic (Patient Telemetry):** Zero degradation. Limit remains strictly at **60 kbps** (exempt from cuts).
   - **Canteen:** Throttled down to its contractual floor (**28 kbps**, $-80\%$ degradation).
   - **Office IT, CCTV, Warehouse:** Proportionally degraded based on downtime cost and compliance ceilings.
   - **Factory:** Preserved at baseline because cheaper slices absorb the needed cut.
4. **Observe Phone Screen (Canteen):**
   - The Canteen portal displays an amber degradation banner:
     *`⚠️ Degraded by CBHA — Limit lowered from 140 to 28 kbps to protect critical enterprise operations (Decision ARB-XXXX)`*.

### Act 4: The Slicing Isolation Invariant (TC4 & TC5)
1. Highlight to the evaluator that once CBHA arbitration takes effect, **Clinic packet loss returns to 0%** and latency falls well within its SLA target (< 150 ms).
2. Tap **Step-Down Recovery (TC5)** on the dashboard (returning demand to 55%).
3. Observe contention close after 3 consecutive clear samples. Automatic recovery is scheduled per department policy (2–30 min), or tap **Override** on the dashboard to instantly restore all slices to their baseline limits.

### Act 5: Empirical A/B Proof (TC6)
1. On the dashboard, toggle **Automatic Arbitration to OFF**.
2. Trigger the lunch-hour rush. Start an experiment recording named `TC6-OFF`.
3. Show the live chart: without arbitration, the shared root queue overflows, **causing Clinic and Factory latency to breach SLA limits (> 500 ms)** with measurable packet loss.
4. Stop `TC6-OFF`. Toggle **Automatic Arbitration back to ON**. Start recording named `TC6-ON`.
5. **Wait ~25 s** for the root queue to drain and reach steady-state.
6. Show how CBHA instantly de-congests the bottleneck, restoring mission-critical latency (~29 ms) and 0% loss.

---

## 5. Troubleshooting Guide

### Issue 1: Phone Cannot Open `http://192.168.137.1:8080`
- **Cause:** Windows Firewall blocking inbound traffic or wrong subnet.
- **Fix:** Re-run `.\scripts\windows\open-firewall.ps1` as Administrator. Ensure the phone is connected to the laptop's Mobile Hotspot, not a cellular data network or separate Wi-Fi.

### Issue 2: Phone Shows "Wi-Fi Has No Internet Access" Warning
- **Cause:** Android and iOS perform captive-portal checks.
- **Fix:** Select **"Keep Wi-Fi connection"** or **"Use as-is"**. The slice portal operates locally over the hotspot even if external internet routing is restricted.

### Issue 3: Windows Mobile Hotspot Limit Exceeded
- **Cause:** Windows 11 Mobile Hotspot limits connections to **8 simultaneous devices**.
- **Fix:** If more than 7 client devices attempt to join, disconnect spare devices. You can also run secondary slices on the main laptop via browser tabs or `slice-agent.exe`.

### Issue 4: Phone Screen Sleep Causing Slice Inactivity
- **Cause:** Mobile operating systems throttle background WebSockets and timers when the screen locks.
- **Fix:** Set screen lock timeout to 5–10 minutes during the demo, or keep the portal tab open in foreground.

### Issue 5: Port Conflict on Port 4000, 8080, or 9090
- **Fix:** Check running Node processes:
  ```powershell
  Get-Process node | Stop-Process -Force
  ```
