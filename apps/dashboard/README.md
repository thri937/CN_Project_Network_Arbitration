# Dashboard (`@cn/dashboard`)

The **operator's** web app. It is the frontend of the original simulated project, plus a
**Testbed** page for the real network. Open <http://localhost:5173> while `npm run dev` is running
and sign in with the **Admin** or **Manager** button.

## The Testbed page

- **Topology:** the laptop gateway in the middle and the 7 slices around it. Each slice shows its
  live health colour, connected devices, and used vs limit in kbps.
- **Join codes and QR codes:** one per slice, linking to `http://<laptop-ip>:8080/join?code=…`.
  The address picker lists the laptop's networks: hotspot first, then Wi-Fi, with virtual adapters
  (VirtualBox, Hyper-V) marked as unusable by phones.
- **Devices:** every joined device with its IP, slice, rate and last-seen time; unbind a device.
- **Operator control:** set a slice's demand remotely; its devices follow. Scenario buttons
  TC1–TC5 set the standard demand patterns.
- **Automatic arbitration ON/OFF:** the switch for the A/B test (TC6). Each change is audited.
- **Experiment recorder:** Start/Stop, then download the CSV. It records the gateway's own
  measurements every 2 s. Unknown values stay blank.

All the original pages still work: Dashboard, Runtime Monitoring, Contention Events, Arbitration
Decisions (with the full "why" for each decision), Slices, Departments, Business Policies,
Reports, Analytics, Audit Logs and Users. Bandwidth is shown in kbps.

## Develop

```bash
npm run dev -w @cn/dashboard
```

```bash
npm run build -w @cn/dashboard
```

The QR codes use the standard `qrcode` npm package.
