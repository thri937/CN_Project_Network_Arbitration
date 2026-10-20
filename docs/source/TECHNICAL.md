# Runtime Arbitration for Contended, SLA-Critical Enterprise Network Slices

**A department-aware, auditable alternative to generic priority-based degradation.**

---

## The problem

When demand for network capacity exceeds supply, something has to give. Conventional slice
controllers decide using **network** attributes — 5QI, slice/service type, a static priority
integer. That answers a business question with a network answer, and it produces outcomes
like this:

> A hospital's patient-telemetry slice is throttled because it was provisioned as eMBB,
> while the canteen's digital-signage slice is protected because a template happened to tag
> it URLLC.

This platform decides using **business policy** instead: department criticality, measured
downtime cost, compliance obligations, customer impact, recovery tolerance, and historical
fairness. Every decision is explainable, reversible, and permanently recorded.

The difference is not theoretical. Here is a real decision from the seeded scenario:

| Slice | Network profile | Business score | Outcome |
|---|---|---|---|
| Patient Telemetry | URLLC | 96.0 | **EXEMPT** — 0 % |
| Lab Instrumentation | **eMBB** | 70.9 | **PROTECTED** |
| Canteen Signage | **URLLC** | 8.0 | **cut 80 %** |

A QoS-priority controller would have protected Canteen Signage ahead of the Quality lab. This one
inverted that on business grounds, and recorded why.

---

## Quick start

Nothing external is required — no cloud project, no credentials, no 5G core.

```bash
npm install
```

```bash
npm run seed --workspace backend
```

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Open <http://localhost:5173>, sign in with any email address (development auth is active
when Firebase is not configured), and the network will drift into contention on its own
within a minute or two.

| Endpoint | |
|---|---|
| Dashboard | <http://localhost:5173> |
| API | <http://localhost:4000/api/v1> |
| API documentation | <http://localhost:4000/api/docs> |
| Health | <http://localhost:4000/health/ready> |

---

## The algorithm — CBHA

**Convex Business-Harm Arbitration.** It does not sort priorities; it solves a constrained
optimisation.

Given a deficit ΔD, choose a degradation vector **d** minimising total business harm:

```
H_i(d_i) = BPS_i · (d_i / max_i)^γ_i · (1 + g·stress_i) · fairness_i · urgency_i · intolerance_i
```

| Term | Source | Why it is there |
|---|---|---|
| `BPS_i` | Business Policy Engine | business priority, never QoS class |
| `γ_i` | recovery tolerance | **the key term** — see below |
| `stress_i` | live SLA margin | a slice near breach costs more to cut |
| `fairness_i` | degradation history | rotates the burden across departments |
| `urgency_i` | downtime cost × duration | money, not abstraction |
| `intolerance_i` | recovery tolerance | raises harm *level*, distinct from curvature |

### Why this is not a sort

γ comes from recovery tolerance: 3.0 for a zero-tolerance department, 1.15 for a tolerant
one. Because harm is **superlinear**, the marginal cost of the 40th percent of a cut is far
higher than the 5th. So after a few percent have been taken from the cheapest slice, the
*next* percent costs more than the *first* percent from a slice ranked above it — and the
optimiser switches. The result is many shallow cuts instead of one deep one.

### Why greedy is optimal here

Each `H_i` is convex and increasing, and the constraint is a single linear budget. That
makes this a **separable convex program**, whose KKT conditions state that at the optimum
every actively-degraded slice has equal marginal harm. Water-filling on `dH/dd` constructs
exactly that condition, so the greedy result is the true optimum up to the quantum size —
not a heuristic of unknown quality. `tests/unit/arbitration.test.ts` asserts the marginal
harms converge to within one quantum.

### Compliance is a constraint, not a weight

A `LIFE_SAFETY` slice is removed from the candidate set entirely. Weights can be outvoted by
an unlucky combination of other factors; constraints cannot.

---

## Architecture

Ports and adapters, because the brief requires the modelled network to be replaceable by a
real one without touching anything above it.

```
┌──────────────────────────────────────────────────────────────────┐
│ INTERFACE   routes → controllers → validators                    │ HTTP only
├──────────────────────────────────────────────────────────────────┤
│ APPLICATION services, jobs, orchestration                        │ use cases
├──────────────────────────────────────────────────────────────────┤
│ DOMAIN      policy engine · CBHA arbitration · harm · solver     │ PURE — zero I/O
├──────────────────────────────────────────────────────────────────┤
│ PORTS       IRepository · INetworkTelemetryPort · IAuthPort      │ owned by the domain
├──────────────────────────────────────────────────────────────────┤
│ ADAPTERS    Firestore │ in-memory      Firebase │ dev-auth       │ swapped at the
│             synthetic │ Open5GS │ free5GC │ Kubernetes           │ composition root
└──────────────────────────────────────────────────────────────────┘
```

Three environment variables select the entire wiring:

```bash
DATASTORE_DRIVER=firestore     # or: memory
AUTH_DRIVER=firebase           # or: dev
TELEMETRY_PROVIDER=open5gs      # or: synthetic | free5gc | kubernetes
```

### The network seam

`INetworkTelemetryPort` has four methods — `sample`, `applyAllocation`, `describeCapacity`,
`ping`. The capacity monitor, contention detector, arbitration engine and dashboard talk to
nothing else. Moving to a live Open5GS core is:

```bash
TELEMETRY_PROVIDER=open5gs
TELEMETRY_PROMETHEUS_URL=http://prometheus.5gc.svc:9090
TELEMETRY_CONTROL_PLANE_URL=http://pcf.5gc.svc:8080
```

The Prometheus adapter is a real client with configurable PromQL (metric names differ
between cores and versions, so hard-coding them is the most common way a telemetry
integration breaks on upgrade). Slices carry native 3GPP S-NSSAI, so no data migration is
needed.

### The synthetic network is a physics model

Not a random-number generator. Three properties make it behave like a real feed:

1. **Demand is independent of allocation.** Degrading a slice reduces what it *gets*, not
   what it *wants* — so contention persists until genuinely resolved.
2. **Latency follows M/M/1 queueing**, `≈ base / (1 − ρ)`, producing the characteristic knee
   that SLA-stress scoring depends on.
3. **Packet loss is overflow**, computed from demand exceeding allocation, not sampled
   independently.

Plus diurnal load curves, Poisson bursts, and correlated CPU/memory — all seeded, so a
scenario replays identically.

---

## Verification

```bash
npm test
```

**424 tests.** The suite is the argument, not the documentation:

| Suite | What it pins |
|---|---|
| `arbitration.test.ts` | KKT optimality, convexity spreads cuts, compliance constraints hold, **QoS class cannot reach the engine** |
| `policyEngine.test.ts` | log-normalised cost cannot be gamed, every score is explainable |
| `repository.contract.test.ts` | one contract suite, **run against both Firestore and in-memory** |
| `controlLoop.test.ts` | congestion → detection → arbitration → degradation → recovery, end to end |
| `trafficModel.test.ts` | the queueing relationships actually hold |

To include the Firestore driver:

```bash
npx firebase emulators:start --only firestore --project demo-arbitration
```

```bash
npm run test:firestore --workspace backend
```

---

## Deployment

**Frontend → Firebase Hosting**

```bash
npm run build --workspace frontend && npx firebase deploy --only hosting
```

**Backend → Render or Railway** — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Both a
`render.yaml` and a `Dockerfile` are provided.

Production refuses to start with `DATASTORE_DRIVER=memory` or `AUTH_DRIVER=dev`, or with
the default `JWT_SECRET`.

---

## Further reading

| Document | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | layer rules, ports, decisions and their rationale |
| [`docs/ALGORITHM.md`](docs/ALGORITHM.md) | CBHA in full, with the mathematics |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Firebase, Render, Docker, environment reference |
| `/api/docs` | OpenAPI 3.1, served by the running backend |
