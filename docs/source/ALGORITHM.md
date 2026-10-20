# CBHA — Convex Business-Harm Arbitration

The arbitration algorithm, in full.

---

## 1. The problem

At time *t*, total demand exceeds offered capacity:

```
Σ demand_i  >  C_offered
```

Choose a degradation vector **d** = (d₁ … dₙ), where `dᵢ ∈ [0, maxᵢ]` is the fraction of
slice *i*'s baseline allocation removed, such that enough bandwidth is freed and total
**business harm** is minimised:

```
minimise    Σ H_i(d_i)

subject to  Σ (baseline_i · d_i)  ≥  ΔD                    (free the deficit)
            0 ≤ d_i ≤ max_i                                (policy ceiling)
            allocated_i − baseline_i·d_i  ≥  floor_i       (contractual floor)
            d_i = 0  ∀ i ∈ Exempt                          (compliance)
```

where `ΔD = Σ demand − C_offered · (1 − headroom)`.

The headroom term matters: targeting exactly the capacity line makes the system oscillate,
because the next tick's noise puts it back over. Default is 3 %.

---

## 2. The harm function

```
H_i(d_i) = BPS_i · (d_i / max_i)^γ_i · S_i · F_i · U_i · I_i
```

| Symbol | Name | Range | Source |
|---|---|---|---|
| `BPS_i` | Business Priority Score | 0–100 | Business Policy Engine |
| `γ_i` | harm curvature | 1.15–3.0 | recovery tolerance |
| `S_i` | SLA stress multiplier | 1 – 1+g | live telemetry |
| `F_i` | fairness multiplier | 1/(1+λ) – 1+λ | degradation history |
| `U_i` | recovery urgency | ≥ 1 | downtime cost × duration |
| `I_i` | intolerance scale | 1.0–2.5 | recovery tolerance |

### 2.1 Business Priority Score

A weighted sum of seven business factors, each normalised to 0–100:

```
BPS = ( w₁·criticality + w₂·importance + w₃·cost + w₄·compliance
      + w₅·customerImpact + w₆·operational + w₇·intolerance ) × multiplier
```

Weights sum to exactly 1.0 (enforced at policy-save time; otherwise scores are incomparable
between revisions and every historical trend breaks).

**Cost is log-normalised.** `logNormalise(cost, reference)` maps the reference to 50, one
decade above to ~75, two to ~87.5 — asymptotic, never reaching 100. Linear normalisation
would let one department declaring £500 000/min score 100 while everyone else rounds to
zero, turning the cost weight into an absolute override and making the platform trivially
gameable.

### 2.2 γ — harm curvature, and why this is not a sort

γ derives from recovery tolerance:

| Tolerance | γ | Intolerance scale | Recovery window |
|---|---|---|---|
| `ZERO` | 3.00 | 2.50 | 30 s |
| `LOW` | 2.20 | 2.08 | 120 s |
| `MODERATE` | 1.60 | 1.60 | 600 s |
| `HIGH` | 1.15 | 1.18 | 1800 s |

Because γ > 1, harm is **superlinear**: the marginal cost of the 40th percent of a cut is far
higher than the 5th. Concretely, for γ = 2.2 the marginal cost at depth 0.4 is about 15×
that at depth 0.05.

The consequence is the entire point of the algorithm. After a few percent have been taken
from the cheapest slice, the *next* percent from it costs more than the *first* percent from
a slice ranked well above it — so the optimiser switches. Many shallow cuts, rather than one
deep one.

A priority sort cannot produce this. It takes everything from the lowest-ranked slice before
touching anyone else, so one department absorbs a 60 % cut while five ranked one place above
it are untouched.

### 2.3 Curvature and level are different — a bug worth recording

The original design expressed recovery tolerance through γ **alone**. That is wrong, and the
test suite caught it.

For `H ∝ (d/max)^γ`, a **larger γ makes the curve start flatter**. The marginal harm of the
first few percent is therefore *lower* for an intolerant department than a tolerant one — so
water-filling, which spends where marginal harm is lowest, cut the zero-tolerance department
**first and deepest**. Precisely backwards.

Curvature controls how fast harm *accelerates*; it says nothing about the *level*. A
department that cannot tolerate degradation has both: any cut hurts more, and each further
percent hurts disproportionately more again. `I_i` supplies the level.

### 2.4 Fairness — what stops the same victim every time

```
F_i = clamp( 1 + λ·(burden_i / burden̄ − 1),  1/(1+λ),  1+λ )
```

Without it the engine is memoryless: identical inputs give identical outputs, so the
unluckiest slice is chosen again on every contention event, for weeks. Its department
experiences the platform as persecution, and they are right to.

`burden` combines depth and duration — Σ (degradation fraction × seconds) — so 50 % for
10 minutes and 25 % for 20 minutes count equally, which is the intuitively fair comparison.

The clamp is essential: fairness must *nudge*, never override. Rotating the burden is
desirable; degrading a hospital because a warehouse had a bad week is not.

The mean excludes slices with zero burden. Including them would drag it toward zero,
inflating every non-zero slice's relative burden and firing the term hard on the very first
degradation.

### 2.5 SLA stress

```
S_i = 1 + g · stress_i,   stress ∈ [0,1]
```

`stress` is the **worst** dimension of latency, jitter, loss, throughput and compute against
that slice's own targets — not an average. SLAs are conjunctive: meeting throughput while
breaching loss is still a breach, and averaging would let a healthy dimension mask a live
one.

### 2.6 Recovery urgency

```
U_i = 1 + √(cost_i / reference) · (minutes / 10)
```

Square-rooted because `downtimeCost` is *already* a weighted term inside BPS. Applying its
full linear force again here would double-count it and let cost dominate a second time
through the back door.

---

## 3. The solver

Marginal-harm water-filling:

```
while (freed < ΔD and iterations < cap):
    for each eligible slice i:
        m_i = (dH_i/dd evaluated at current depth + quantum/2) / baseline_i
    give the next quantum to argmin(m_i)
    freed += quantum
```

`m_i` is marginal harm **per Mbps freed**. Every quantum removes the same number of Mbps,
which is a smaller depth on a larger slice, so ranking on `dH/dd` alone would ignore slice
size. An earlier version did exactly that; on fleets of unequal slices it settled up to 2×
above the optimal harm regardless of quantum, and `arbitration.test.ts` now pins the case.

```
dH/dd = BPS · multiplier · γ · d^(γ−1) / max^γ
```

### 3.1 Why greedy is optimal, not merely a heuristic

Each `H_i` is convex and increasing on `[0, maxᵢ]` (γ ≥ 1), and the constraint is a single
linear budget. That makes this a **separable convex program**. Its KKT conditions state that
at the optimum, every slice with an interior solution has **equal marginal harm per Mbps**
(`dH_i/dd_i = μ · baseline_i`), and every slice at a boundary has marginal harm per Mbps no
lower than that common value.

Always spending the next unit where it is currently cheapest drives the active slices'
marginal harms toward one another — it is the iterative construction of exactly that
condition. So the result is the true optimum up to the quantum size, not an approximation of
unknown quality.

`arbitration.test.ts` asserts this directly: after a run, the marginal harms of degraded
slices agree to within one quantum.

### 3.2 Why not an off-the-shelf convex solver

A general solver would give the exact continuous optimum. Rejected because:

- this runs every two seconds inside a control loop and must finish in single-digit
  milliseconds (measured: ~1 ms for 9 slices, < 40 ms for 60);
- the greedy path is **explainable** — every quantum has a recorded reason, so an operator
  can be shown why the 47th went to Warehouse rather than Facilities. "The dual variables
  converged" is not an explanation anyone can act on;
- it would add a substantial dependency inside the most safety-relevant path in the system.

At the default 0.5 % quantum, the gap to the continuous optimum is well under one percent of
one slice's allocation.

### 3.3 Evaluating at the quantum midpoint

At exactly `d = 0` with γ > 1 the true derivative is zero — the first infinitesimal slice of
degradation is free. Mathematically correct, operationally useless: the solver would split
the first quantum across every eligible slice, touching dozens of departments to save a few
Mbps. A NOC would far rather see three slices degraded than thirty. Evaluating at the
midpoint of the quantum about to be allocated is both a better numerical estimate of its
average cost and prices the first quantum honestly.

---

## 4. Constraints

Enforced **before** optimisation, by removing slices from the candidate set — not as large
weights. Weights can be outvoted by an unlucky combination of other factors; constraints
cannot.

| Compliance level | Ceiling |
|---|---|
| `LIFE_SAFETY` | 0 % — structurally exempt |
| `REGULATED` | 20 % |
| `CONTRACTUAL` | 60 % |
| `INTERNAL` / `NONE` | 100 % |

A policy may **tighten** a ceiling but never loosen one; overrides are clamped to the
built-in defaults so a tenant cannot configure their way out of a safety exemption.

The effective ceiling is the tighter of the compliance ceiling and the department's own
declared limit, further bounded by the slice's contractual floor.

---

## 5. Confidence

Answers *"how sure is the engine that this is the right plan?"* — **not** how severe the
contention is.

| Component | Weight | Meaning |
|---|---|---|
| harm margin | 0.40 | how much better than the runner-up plan |
| telemetry freshness | 0.25 | stale data means the network may have moved on |
| data completeness | 0.20 | candidates missing business context degrade the ranking |
| constraint slack | 0.15 | a plan pressed against every ceiling has little room to be right |

A plan barely ahead of an alternative is a coin-toss dressed as a decision, and the score
says so.

---

## 6. Counterfactuals

Every decision prices four alternative strategies on the identical harm scale:

| Strategy | Why it is evaluated |
|---|---|
| `PRIORITY_SORT` | **the benchmark** — what a conventional QoS controller does |
| `UNIFORM_CUT` | the strategy stakeholders most often propose |
| `SINGLE_VICTIM` | minimises the number of departments affected |
| `PROTECT_STRESSED` | the instinct of an operator watching the dashboard turn red |

`PRIORITY_SORT` is the important one. Pricing it on every single decision produces a
continuous, auditable record of how much business harm this platform avoids relative to the
approach it replaces.

**Infeasible alternatives report `harmPenaltyPercent: null`.** Harm is only comparable
between plans that free comparable bandwidth; an infeasible strategy always shows lower harm
for the trivial reason that it degrades less while failing to resolve the contention.
Reporting that as a negative penalty would rank a plan that does not work above the one that
does — which is exactly the kind of confidently-wrong number this platform exists to
eliminate.

---

## 7. What the engine cannot see

`ArbitrationCandidate` has no field for QoS class, 5QI, SST, S-NSSAI or slice profile. The
engine cannot consider network priority because it is **not in the type**.

That is the platform's central claim expressed as a compile-time guarantee, and
`arbitration.test.ts` asserts it end-to-end: two networks differing only in which slice
carries the higher QoS profile produce identical outcomes, decided entirely by business
context.
