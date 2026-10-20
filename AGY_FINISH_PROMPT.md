# Finish prompt for agy — CN_Real_Network_arbitration

Work in `D:\CN project\CN project\CN_Real_Network_arbitration`. Read `AGY_PROMPT.md` (the original
spec) and this file. **Do not modify `D:\CN project\CN project\CN` (SOURCE).** Do not change the
business-rule files (`apps/controller/src/domain/**`, `constants/tunables.ts`, `constants/enums.ts`,
`models/policy.model.ts`).

A reviewer has fixed several bugs. Their work is **uncommitted** in the working tree. Keep all of
it. Your job is to verify it, finish the docs, then commit and push.

---

## A. Already fixed (uncommitted). Keep it; don't redo it.

1. **QR codes now scan.** The hand-written encoder `apps/dashboard/src/lib/qrcode.ts` produced
   codes no decoder could read. It was deleted. The dashboard and `scripts/lan-info.ts` now use
   the `qrcode` npm package. Dashboard QR URLs use `http://<ip>:8080/join?code=…`.
2. **One device per browser tab.** The portal stores `cn_bound_device` in **sessionStorage**
   (`apps/portal/src/App.tsx`).
3. **Portal route fix.** The portal called `/portal-api/snapshots`, but the gateway serves
   `/portal-api/snapshot`. Fixed in `App.tsx` and `SlicePage.tsx`.
4. **LAN address ranking.** The order is hotspot, Wi-Fi, Ethernet, then virtual adapters, in both
   `scripts/lan-info.ts` and `testbed.controller.ts` (`virtual` flag). The dashboard marks virtual
   adapters. The proxy's 403 page now links to the address the device reached, not a hard-coded IP.
5. **Controller type check is clean.** Fixed `closedLoop.test.ts` (it loads the gateway at
   runtime), `gatewayAdapter.test.ts` and `goldenEngine.test.ts`.
6. **Clean reinstall.** Ran `npm install` from scratch and created `package-lock.json`.
7. **Gateway stats windows.** Stats used to be closed by every `GET /v1/stats`, always dividing
   by a fixed 2 s, so a second reader corrupted the rates. Now `SouthboundServer` closes the
   windows on its own timer (`GATEWAY_STATS_WINDOW_MS`, default 2000) using real elapsed time, and
   `GET /v1/stats` is read-only.
8. **Shaper starvation bug.** A slice cut to 28 kbps had 350 bytes of tokens, which is less than
   one 1 KB chunk, so it carried 0 kbps with 100 % loss. Now:
   - token buckets hold at least `MAX_CHUNK_BYTES` (1 KB);
   - slice queues hold 0.5 s at the **current** limit (resized on every limit change);
   - a regression test was added (`apps/gateway/tests/gateway.test.ts`, "keeps a deeply cut
     slice moving").

   The gateway now has 15 tests, all passing.
9. **Shared testbed definition.** `apps/controller/src/testbed/catalogue.ts` holds the 7
   departments and 7 slices (`testbedScenario`, `gatewayCatalogueItem`, `slugify`). The seed
   imports it.
10. **Honest experiment CSVs.** `apps/controller/src/testbed/experimentRecorder.ts` records the
    gateway's own stats every window. Unknown values are left **blank**, never 0. Contention state
    and decision id are real. The adapter has `readStats()`, and its extras no longer fill unknown
    values with 0. The dashboard recorder (`testbed.controller.ts`) uses it, and `bootstrap.ts`
    passes `contention`.
11. **`scripts/demo-local.ts` was rewritten.** It:
    - seeds the real testbed and calls `container.startJobs()`;
    - uses 2 s sampling;
    - checks every test case against real criteria;
    - runs TC6 with a 25 s warm-up and 40 s of measurement, OFF then ON (`--quick` makes it
      shorter);
    - writes `experiments/<timestamp>-demo-local.csv` and `-summary.md`.
12. `scripts/calibrate.ts` uses the real slice codes and reports "no measurement" instead of 0.
    `scripts/experiment-summary.ts` groups by scenario.
13. **Docs partly corrected:**
    - `docs/LIMITATIONS.md`: proxy not shaped, plus §2.6 gaps.
    - `docs/API.md`: `/v1/stats` semantics, proxy.
    - `docs/ARCHITECTURE.md`: CBHA is **Convex Business-Harm Arbitration**; control-loop
      diagram; recovery windows; jitter formula; probe interval; queue/bucket sizing; QR.
    - `docs/OPEN-QUESTIONS.md`: WSL can't shape hotspot traffic; known gaps.
    - `docs/TESTBED.md` §2.
14. **New READMEs** in `apps/gateway`, `apps/controller`, `apps/portal`, `apps/dashboard`,
    `apps/agent` and `packages/shared`.
15. **Deleted** the old `experiments/1792…-tc-demo-summary.md` files. Their numbers contradicted
    their own data.

**Last measured demo (before fix 8).** TC1, TC2, TC4, TC5 and TC6 passed. TC3 failed only because
the cut Canteen carried 0 kbps, which fix 8 addresses. TC6 results (loopback, means over 20
windows of 2 s each):

| Slice | p95 OFF (ms) | p95 ON (ms) | Loss OFF (%) | Loss ON (%) |
|---|---:|---:|---:|---:|
| Patient Telemetry | 506 | 28 | 4.64 | 0.00 |
| Factory Automation | 507 | 29 | 16.65 | 0.00 |
| Lab Instrumentation | 500 | 30 | 9.19 | 0.00 |
| Warehouse Operations | 505 | 618 | 14.27 | 4.41 |
| CCTV | 630 | 566 | 22.64 | 15.37 |
| Office Wi-Fi | 585 | 707 | 28.56 | 32.08 |
| Canteen Signage | 946 | — | 59.57 | 100.00 (the bug, now fixed) |

---

## B. Verify (do this first)

1. `npm run build`. It must succeed. Phones get the portal from `apps/portal/dist`, so the build
   is required.
2. `npm test`. Expect all controller tests to pass (439+ passed, 50 skipped) and the gateway
   15/15.
3. Run `npx tsc --noEmit -p .` in each of `apps/controller`, `apps/gateway`, `apps/dashboard`,
   `apps/portal`, `apps/agent` and `packages/shared`. Expect 0 errors.
4. `npm run demo:local`, about 6 minutes, with nothing else heavy running. All 6 test cases must
   pass.
   - If TC3 still fails, investigate the real cause from the CSV. Don't loosen the checks.
   - Keep the new `experiments/*-summary.md`; you'll use it in step C.

## C. Finish the docs (accurate, plain English)

- **`README.md` (root): rewrite it for a reader who wants to understand the project.**
  - Explain what it is, how it relates to the simulated SOURCE project, and include a picture.
  - Include the 7-slice table and how one decision flows: measure → detect → decide → apply →
    recover.
  - Quick start: `npm install` → `npm run setup` → `npm run build` → `npm run seed` → firewall
    script (as administrator) → hotspot → `npm run dev` → `npm run lan:info` → join from phones.
  - Explain what to try (TC1–TC6 by hand) and `demo:local`.
  - Show the **measured** TC6 table from your new summary, labelled "loopback, one laptop".
  - Add a folder map linking the per-app READMEs, the scripts and tests, and the limitations.
  - **Remove these false claims:**
    - "zero packet loss" as a guarantee;
    - "Canteen flood triggers CBHA within 4 s and cuts it to 28 kbps". In fact a Canteen flood
      alone is held by its own 140 kbps limit and nothing is cut (TC2);
    - "TC5 baselines restored". Recovery takes 2–30 min by policy, and Override restores at once;
    - "~128 ms with 0 % loss";
    - "489 tests".
- **`docs/TESTBED.md`:**
  - §4: delete the made-up calibration output (codes like `slice-telemetry` don't exist).
    Replace it with how to run `npm run calibrate` and an empty table to fill in from a hotspot
    run.
  - §5: TC3 demand ratio is 1,309/950 ≈ 1.38. TC5 expectation: contention closes after 3 clear
    samples, recovery is scheduled (2–30 min), and Override restores. TC9 cannot pass because the
    proxy is unshaped.
  - §6: replace with the new `demo:local` results (loopback), plus a placeholder for the hotspot
    run.
- **`docs/RUNBOOK.md`:**
  - Act 2: carried load is ≈877 kbps.
  - Act 3: replace "quadratic harm minimization" with marginal-harm water-filling. Don't promise
    exact cuts; Factory is not guaranteed to stay at baseline.
  - Act 4: don't claim 0 % Clinic loss *before* arbitration acts. For recovery, use Override.
  - Act 5: after toggling ON, wait ~25 s for queues to drain before reading numbers. Name each
    recording per phase.
- **`experiments/README.md`:** describe the new file names and columns. Blank means unknown.

## D. Optional, if time allows (otherwise leave them listed in OPEN-QUESTIONS)

- Proxy shaping for TC9: pace `:8888` tunnels through the slice's bucket with TCP backpressure
  and count them in demand.
- Upload load sessions.
- An operator-control opt-out switch on the portal.

## E. Commit and push

1. Commit everything in this repo. `.env` and `experiments/*.csv` are git-ignored; keep it that
   way. Write a clear message summarising sections A–C.
2. Push to the user's new **private** repo: `https://github.com/thri937/CN_Project_Network_Arbitration`.
   It contains only GitHub's "Initial commit" with a one-line `README.md`. The local branch is
   `master`. Run these one at a time:
   ```
   git branch -m master main
   git remote add origin https://github.com/thri937/CN_Project_Network_Arbitration.git
   git fetch origin
   git merge origin/main --allow-unrelated-histories
   ```
   If `README.md` conflicts, keep ours:
   ```
   git checkout --ours README.md
   git add README.md
   git commit
   ```
   Then push:
   ```
   git push -u origin main
   ```
   Do **not** force-push.
3. Report:
   - test counts;
   - each type check result;
   - `demo:local` PASS/FAIL per test case;
   - the TC6 table;
   - the pushed commit hash.
