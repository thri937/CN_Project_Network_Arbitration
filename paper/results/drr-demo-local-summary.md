# demo:local results — 2026-10-20T21:12:25.871Z

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
  - ✓ Canteen held at its 140 kbps limit (used 140 kbps)
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
- **TC6 A/B arbitration OFF vs ON: FAIL**
  - ✓ measured 20 OFF and 20 ON windows
  - ✓ engine decided once switched ON
  - ✗ Clinic, Factory and Lab: lower latency p95 with arbitration ON
  - ✓ Clinic, Factory and Lab: loss no higher with arbitration ON
  - ✓ Clinic, Factory and Lab within their latency SLA with arbitration ON
  - ✓ Clinic not cut

## TC6 — arbitration OFF vs ON

| Slice | Latency p95 OFF (ms) | Latency p95 ON (ms) | Loss OFF (%) | Loss ON (%) | Used OFF (kbps) | Used ON (kbps) | Limit ON (kbps) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Patient Telemetry | 33 | 32 | 0.00 | 0.00 | 34 | 34 | 60 |
| Factory Automation | 32 | 32 | 0.00 | 0.00 | 210 | 210 | 380 |
| Lab Instrumentation | 40 | 31 | 0.00 | 0.00 | 100 | 100 | 180 |
| Warehouse Operations | 666 | 472 | 12.99 | 5.28 | 113 | 123 | 122.42 |
| CCTV | 663 | 470 | 29.96 | 16.46 | 169 | 202 | 201.1 |
| Office Wi-Fi | 685 | 473 | 29.85 | 31.46 | 225 | 220 | 219.98 |
| Canteen Signage | 687 | 578 | 64.95 | 90.33 | 99 | 27 | 28 |

Raw data: `2026-10-20T21-08-36-demo-local.csv`
