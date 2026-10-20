# Experiments

Measured results are written here. CSV files are not committed; the results used in the paper
are copied to `paper/results/`.

| File | Written by |
|---|---|
| `<time>-session.csv` | The controller, all the time: every 2 s gateway window of a session, labelled with the last scenario run from the dashboard. Download it from the dashboard's **Recording** box |
| `<time>-demo-local.csv` and `-summary.md` | `npm run demo:local`: TC1–TC6 on one laptop, with every check and the TC6 table |
| `<file>-summary.md` | `npm run experiment:summary -- <csv>`: means per scenario and slice |

## Columns (one row per slice per 2 s window)

| Column | Meaning |
|---|---|
| `t_ms` | Milliseconds since the recording started |
| `scenario` | The test-case phase or the last scenario run (`live` before any) |
| `arbitration_on` | Was automatic arbitration on |
| `slice` | Slice code |
| `demand_kbps` | What the slice's devices asked for |
| `limit_kbps` | The slice's enforced limit |
| `used_kbps` | What actually got through |
| `dropped_kbps` | Tail-dropped at the slice queue or the shared link |
| `queue_ms` | Mean queueing delay of probes inside the gateway |
| `latency_p50_ms`, `latency_p95_ms` | Probe round trip: median and 95th percentile |
| `jitter_ms` | Mean change between consecutive round trips |
| `loss_pct` | max(dropped ÷ offered bytes, lost ÷ sent probes) × 100 |
| `availability_pct` | Answered ÷ sent probes over the last 5 minutes |
| `devices` | Devices joined to the slice |
| `contention_state` | NONE, DETECTED, MITIGATED, … |
| `decision_id` | Latest decision for the open contention |

**A blank cell means unknown** (no probe was answered in that window). It is never written as 0.
