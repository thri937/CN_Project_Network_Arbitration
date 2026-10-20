# Experiments

Measured results land here.

| File | Written by |
|---|---|
| `<timestamp>-demo-local.csv` and `-summary.md` | `npm run demo:local`: TC1–TC6 on one laptop, with every check and the TC6 table |
| `<timestamp>-<name>.csv` | The dashboard's **experiment recorder** (Testbed page → Start/Stop) |
| `<file>-summary.md` | `npm run experiment:summary -- <csv>`: means per scenario and slice |

CSV files are git-ignored. Summaries can be committed.

## Columns (one row per slice per 2 s gateway window)

| Column | Meaning |
|---|---|
| `t_ms` | Milliseconds since the recording started |
| `scenario` | Test-case phase or recording name |
| `arbitration_on` | Was automatic arbitration on |
| `slice` | Slice code |
| `demand_kbps` | What the slice's devices asked for |
| `limit_kbps` | The slice's enforced limit |
| `used_kbps` | What actually got through |
| `dropped_kbps` | Tail-dropped at the slice queue or the shared link |
| `queue_ms` | Mean queueing delay of probes in the gateway |
| `latency_p50_ms`, `latency_p95_ms` | Probe round trip, median and 95th percentile |
| `jitter_ms` | Mean absolute change between consecutive round trips |
| `loss_pct` | max(dropped ÷ offered bytes, lost ÷ sent probes) × 100 |
| `availability_pct` | Answered ÷ sent probes over the last 5 minutes |
| `devices` | Devices joined to the slice |
| `contention_state` | NONE, DETECTED, MITIGATED, … |
| `decision_id` | Latest decision for the open contention |

**Blank means unknown** (no probe answered in that window). It is never written as 0.
