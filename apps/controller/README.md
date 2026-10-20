# Controller (`@cn/controller`)

The controller is the **brain**. It reads measurements from the gateway, decides which slices to
slow down when the link is overloaded, applies the decision, and records everything.

**Technology:**
- Node.js 22+ with Express 4 (REST API under `/api/v1`, OpenAPI docs at `/api/docs`);
- Zod (validation);
- Socket.IO (live updates to the dashboard);
- Pino (logs);
- JSON Web Tokens (sessions);
- an in-memory datastore saved to `apps/controller/.data/`.

Every 2 seconds it:

1. **Reads** each slice's measured demand, carried rate, latency and loss from the gateway
   (`GET /v1/stats`).
2. **Detects contention:** total demand above 102 % of the 950 kbps link for 2 samples.
3. **Decides** with the CBHA engine (Convex Business-Harm Arbitration).
   - The shortage is the carried traffic minus 97 % of the link.
   - It is taken in small steps from whichever slice loses the least business value per kbps.
   - No slice goes past its compliance ceiling or below its contractual floor.
4. **Applies** the plan in two phases: save the decision, set the limits on the gateway, then
   check what the gateway enforced. It also writes a plain-English explanation and an audit
   entry.
5. **Recovers:** once contention clears (3 normal samples), each cut slice is restored when its
   recovery window ends. The window is 2 min for low tolerance, 10 min for moderate and 30 min
   for high. An administrator can override and restore at once.

## Code map

| Path | What it is |
|---|---|
| `src/domain/policyEngine.ts` | Business priority score (0–100) from department facts |
| `src/domain/arbitration/` | The CBHA engine: `harm.ts`, `solver.ts` (water-filling), `alternatives.ts` (four rival plans), `engine.ts` (plan and explanation) |
| `src/services/` | Contention detection, arbitration, two-phase allocation, recovery, audit, notifications |
| `src/jobs/scheduler.ts` | The 2 s control loop and 5 s recovery sweep |
| `src/telemetry/adapters/gateway.telemetry.adapter.ts` | The link to the gateway: stats in, limits out, catalogue, devices, operator demand |
| `src/testbed/catalogue.ts` | The 7 departments and 7 slices (one definition for the seed, the demo and the gateway) |
| `src/testbed/experimentRecorder.ts` | Writes every gateway window to CSV; unknown values stay blank |
| `src/controllers/testbed.controller.ts` | `/api/v1/testbed/*`: status, devices, join codes, operator demand, scenarios, arbitration on/off, recording download |
| `src/scripts/seed.ts` | Creates the testbed (refuses a 10 Gbps setting by mistake) |

**Units:** the engine doesn't care about units. Fields are named `…Mbps`, but in this testbed
**1 unit = 1 kbps**, and every sentence it writes says kbps.

The controller resends the slice catalogue whenever the gateway starts or restarts, including
any limits in force. So the two can be started in any order.

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

The tests include the engine (optimality, safety rules), the gateway adapter, the testbed
catalogue, and a closed-loop test that runs the real gateway in-process.

## Sign-in

Local sign-in with no passwords, for your own network only. Use **Sign in as Admin, Manager or
Viewer**, or type a name.
- **Managers** run scenarios, set device demand and turn arbitration on or off.
- **Admins** can also override decisions, edit the policy and read the audit log.
