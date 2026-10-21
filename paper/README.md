# Conference paper: the real-network testbed

**Department-Aware Arbitration of Contended Enterprise Network Slices on a Live Traffic Testbed**.
Thrishwant G, K Jaya Sai Venkatesh, Hithesh Y, K J Sathya Prathmesh.

This paper is about **this** project: real traffic through the slice gateway, phones on a
hotspot. The simulated platform has its own, separate paper in its own repository.

| File | What it is |
|---|---|
| `main.tex` | The paper, IEEE conference format (`IEEEtran`). Every figure is drawn in LaTeX (pgfplots/TikZ) from the numbers in `results/`; there are no image files |
| `references.bib` | 29 references |
| `preview-draft.pdf` | A **preview only**, compiled as a plain two-column article because IEEEtran isn't installed on this laptop. It runs to 7 pages; the real IEEE layout is denser, about 6 |
| `results/` | The raw data behind every table and figure (list below) |
| `scripts/` | The scripts that produce `results/` |

## Compile on Overleaf

1. New Project → Upload Project → upload `main.tex` and `references.bib`.
2. Menu → Compiler: **pdfLaTeX**. Click Recompile.

Overleaf has IEEEtran and pgfplots, so nothing else is needed.

## Where each number comes from

| Result | File | How to make it again |
|---|---|---|
| Table 4, Fig. 2, Fig. 3, Sections 6.2–6.3 (FIFO link, TC1–TC6) | `results/fifo-demo-local.csv` and `-summary.md` | `npm run demo:local` (about 4 minutes) |
| Same run repeated on the final code | `results/fifo-demo-local-repeat.csv` and `-summary.md` | same |
| The DRR testbed run (end of Section 6.4) | `results/drr-demo-local.csv` and `-summary.md` | `GATEWAY_ROOT_DISCIPLINE=drr npm run demo:local` |
| Table 3, shaper accuracy | `results/shaper-accuracy.csv` | `npx tsx paper/scripts/shaper-accuracy.ts` |
| Table 5, no controller, FIFO vs DRR | `results/no-arbitration.csv` | `npx tsx paper/scripts/no-arbitration.ts` |
| Fig. 2 series, TC3 timing | computed from the FIFO CSV | `npx tsx paper/scripts/extract.ts paper/results/fifo-demo-local.csv` |

Run every command from the repository root. The shaper and no-controller scripts use a virtual
clock, so they give the same numbers every time. The demo runs use real time, so their numbers
move a little from run to run. The repeat FIFO run passed every check with the same decisions;
its unloaded latency floor was 31–32 ms instead of 22–23 ms. That floor is set by the gateway's
20 ms scheduler tick and by how busy the laptop is, not by the slices.

## What the paper claims (honest summary)

- **Without arbitration** (FIFO link, lunch-hour load of 1,316 kbps on 950 kbps), every slice
  waits about 0.5 s behind the full shared queue. The Clinic loses 5.6 % of its traffic, even
  though it sends only 34 of its 60 kbps.
- **With arbitration on**, the engine cuts Canteen (to its 28 kbps floor), Office, CCTV and
  Warehouse. Clinic, Factory and Lab return to 22–23 ms p95 with zero loss. The cut slices take
  the loss.
- **Recovery takes about 22 s**: about 4 s to decide, then about 18 s for the shared queue to
  drain, because after the cut it drains at only the 3 % headroom.
- **Fair queueing (DRR) alone** protects slices that stay inside their share. At full peak it
  gives the Clinic 37.5 kbps, below its 40 kbps floor. DRR and the arbitration engine
  complement each other.
- **Scope:** every measured result is **loopback on one laptop**. The phone and hotspot run is
  supported but not yet measured, and the paper says so.

## Before you submit: checklist

- [ ] **Pick the venue.** Check its page limit and template, and whether review is double-blind.
      If it is, remove the author names and the repository link.
- [ ] **Fill in affiliations and emails** in the author block.
- [ ] **Verify every reference** against the publisher's record.
- [ ] **Replace `[repository URL]`** in "Code and Data Availability".
- [ ] **Optional: add the hotspot run.** Join seven phones, run TC3 with arbitration off for a
      minute, then on for a minute (`docs/RUNBOOK.md`, Act 5). Download the CSV from the
      dashboard, then run `npm run experiment:summary -- <file>` and add the table to Section 6.
- [ ] **Read it end to end yourselves.** You must be able to defend every sentence.
- [ ] Follow the venue's rules on AI-assisted writing, and disclose its use as they require.
