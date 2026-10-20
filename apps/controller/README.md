# Controller (`@cn/controller`)

The controller is the **brain**. It is the backend of the original simulated project
(`CN/backend`), copied over with its business rules **unchanged**. The only new piece is a network
adapter that talks to the real gateway instead of the simulator.

Every 2 seconds it:

1. **Reads** each slice's measured demand, throughput, latency and loss from the gateway.
2. **Detects contention**: total demand above 102 % of the 950 kbps link for 2 samples in a row.
3. **Decides** with the CBHA engine (Convex Business-Harm Arbitration). It works out how much
   traffic must be shed and takes it in small steps from whichever slice loses the least business
   value per kbps. It never cuts a slice past its policy ceiling or below its contractual floor.
4. **Applies** the plan in two phases (save the decision, then set the limits on the gateway, then
   check what the gateway enforced) and writes a plain-English explanation and an audit entry.
5. **Recovers**: once contention clears (3 normal samples), each cut slice is restored after its
   recovery window. The window is 30 s for zero tolerance, 2 min for low, 10 min for moderate and
   30 min for high. An administrator can override and restore at once.

## What is new compared with the simulated project

| File | Purpose |
|---|---|
| `src/telemetry/adapters/gateway.telemetry.adapter.ts` | The real-network adapter: `GET /v1/stats` → slice telemetry, `PUT …/limit` ← decisions. Selected with `TELEMETRY_PROVIDER=gateway` |
| `src/testbed/catalogue.ts` | The 7 departments and 7 slices, scaled to the link size. Shared by the seed and `demo:local` |
| `src/testbed/experimentRecorder.ts` | Writes experiment CSVs from the gateway's measurements; unknown values stay blank |
| `src/controllers/testbed.controller.ts`, `src/routes/testbed.routes.ts` | `/api/v1/testbed/*`: status, devices, join codes, operator demand, scenarios, arbitration on/off, experiments |
| `src/scripts/seed.ts` | Seeds the testbed and pushes the slice catalogue to the gateway |

**Unchanged** (identical to the simulated project): `src/domain/policyEngine.ts`,
`src/domain/arbitration/*`, `src/constants/tunables.ts`, `src/constants/enums.ts` and
`src/models/policy.model.ts`. These hold the weights, ceilings, harm curve, solver, contention
thresholds and cooldown. The algorithm is explained in
[`docs/source/ALGORITHM.md`](../../docs/source/ALGORITHM.md).

**Units:** fields are still named `…Mbps` because the engine doesn't care about units. In this
testbed **1 unit = 1 kbps**.

## Run and test

From the repository root:

```bash
npm run seed
```

```bash
npm run dev
```

```bash
npm test -w @cn/controller
```

- **Run** (`npm run dev`): the API is on <http://localhost:4000> and the Swagger docs are at
  <http://localhost:4000/api/docs>.
- **Test** (`npm test -w @cn/controller`): all the original tests, plus:
  - the gateway adapter;
  - golden engine checks on the 7-slice testbed;
  - a closed-loop test that runs the real gateway in-process.

## Sign-in

Local sign-in with no passwords, for use on your own network only. Use the **Admin**,
**Manager** or **Viewer** buttons, or type `admin`, `manager` or `viewer`. Managers can run
scenarios and toggle arbitration; admins can also override decisions and edit policies.
