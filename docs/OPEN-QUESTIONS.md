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
- Node SEA binary creation is supported via `npm run build:agent:exe`. If `postject` or Windows binary manipulation is restricted, the headless agent can be run directly via `npx tsx apps/agent/src/index.ts`.
