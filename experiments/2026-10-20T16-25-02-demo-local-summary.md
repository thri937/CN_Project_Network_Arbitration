# demo:local results — 2026-10-20T16:28:53.410Z

Loopback run (one laptop, no Wi-Fi). 1 Mbps link (950 kbps offered), 2 s measurement windows,
seeded 7-slice testbed. TC6: 25 s warm-up, then 40 s measured, arbitration OFF then ON,
same lunch-hour-rush load.

## Test cases

- **TC1 Normal day: PASS**
  - ✓ no contention opened
  - ✓ no arbitration decision
  - ✓ every slice carries its demand (±10 %)
  - ✓ loss under 1 % on every slice
- **TC2 Canteen flood contained: PASS**
  - ✓ Canteen held at its 140 kbps limit (used 138 kbps)
  - ✓ no slice limit changed (current limits already fit the link)
  - ✓ other slices carry their demand (±10 %)
- **TC3 Lunch-hour rush: PASS**
  - ✓ contention opened
  - ✓ engine decided and the gateway enforced new limits
  - ✓ Clinic not cut
  - ✓ no slice below its floor or past its ceiling
  - ✓ degraded slices (Warehouse, CCTV, Office, Canteen) run at their new limits (±10 %)
  - ✓ Clinic, Factory and Lab latency p95 within their SLA targets
- **TC4 Everyone at peak: PASS**
  - ✓ engine reports PARTIAL (the ceilings leave a shortfall) and escalates
  - ✓ Clinic not cut
  - ✓ no slice below its floor or past its ceiling
- **TC5 Recovery: PASS**
  - ✓ contention closed after demand fell
  - ✓ automatic recovery is scheduled for every degraded slice
  - ✓ administrator override restores every slice to baseline
- **TC6 A/B arbitration OFF vs ON: PASS**
  - ✓ measured 20 OFF and 20 ON windows
  - ✓ engine decided once switched ON
  - ✓ Clinic, Factory and Lab: lower latency p95 with arbitration ON
  - ✓ Clinic, Factory and Lab: loss no higher with arbitration ON
  - ✓ Clinic, Factory and Lab within their latency SLA with arbitration ON
  - ✓ Clinic not cut

## TC6 — arbitration OFF vs ON

| Slice | Latency p95 OFF (ms) | Latency p95 ON (ms) | Loss OFF (%) | Loss ON (%) | Used OFF (kbps) | Used ON (kbps) | Limit ON (kbps) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Patient Telemetry | 512 | 29 | 4.68 | 0.00 | 33 | 34 | 60 |
| Factory Automation | 511 | 29 | 15.93 | 0.00 | 177 | 210 | 380 |
| Lab Instrumentation | 508 | 31 | 10.24 | 0.00 | 90 | 100 | 180 |
| Warehouse Operations | 509 | 452 | 13.89 | 4.50 | 112 | 123 | 123.36 |
| CCTV | 630 | 473 | 15.52 | 15.96 | 210 | 203 | 202.74 |
| Office Wi-Fi | 575 | 477 | 35.55 | 31.35 | 215 | 220 | 220.4 |
| Canteen Signage | 947 | 577 | 59.55 | 90.26 | 113 | 27 | 28 |

Raw data: `2026-10-20T16-25-02-demo-local.csv`
