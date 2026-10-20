# Open Questions and Environmental Notes

This document logs design decisions, hardware/OS constraints, and items requiring operational attention.

## 1. System Settings and Administrator Permissions
- As mandated by Ground Rule 6, the software never modifies system firewall or network adapters directly. PowerShell scripts (`scripts/windows/open-firewall.ps1` and `close-firewall.ps1`) are provided for the operator to run with elevated privileges.
- Mobile hotspot address discovery relies on detecting interface aliases and standard IP ranges (such as `192.168.137.1`). If the Wi-Fi adapter does not support Hosted Network / Mobile Hotspot, the system falls back seamlessly to the Wi-Fi LAN IP or localhost loopback mode.

## 2. Windows Timer Resolution
- The application gateway shaper uses a 20 ms nominal scheduling tick. To mitigate Windows `setTimeout` timer jitter (which typically defaults to ~15.6 ms resolution), the shaper calculates the actual elapsed interval $\Delta t$ on each iteration using high-resolution monotonic timestamps (`process.hrtime.bigint()`). This preserves byte-accurate token bucket refilling and policing regardless of scheduling fluctuations.

## 3. Node.js 24 Realpath Resolution on Sandboxed Windows
- In Node.js 24 running under restricted Windows tokens or sandboxed execution, `fs.realpathSync.native` may encounter `EPERM`. A clean preload patch (`scripts/patch-realpath.cjs`) safely bridges `realpathSync.native` to `realpathSync`, ensuring Vitest and build tooling function without error.

## 4. Single Executable Application (Node SEA)
- Node SEA binary creation is supported via `npm run build:agent:exe`. The automated `postject` injection succeeded and generated `dist/slice-agent.exe`. In environments where executable creation is restricted, `npx tsx apps/agent/src/index.ts` is available as a drop-in fallback.

## 5. WSL Availability and Linux Kernel TC (Phase 8 Optional)
- As noted in the system environment, Windows Subsystem for Linux (WSL) is installed and available.
- WSL2 runs Linux in a virtual machine behind its own NAT, so `tc` inside WSL **cannot** shape traffic from devices on the Windows hotspot. Kernel (L3) enforcement with `tc-htb` needs the laptop to boot Linux, or a Linux device such as a Raspberry Pi acting as the access point. Not built.

## 6. Known gaps (not built yet)
- **Proxy mode does not shape traffic.** `:8888` forwards joined devices' traffic unshaped (see LIMITATIONS §2.3), so TC9 cannot pass yet.
- **Upload load** is not implemented; load sessions are download only.
- **Operator control** has no opt-out switch: every device follows demand set from the dashboard. That is what makes the scenario buttons work.
