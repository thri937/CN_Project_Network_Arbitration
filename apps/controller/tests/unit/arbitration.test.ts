import { describe, expect, it } from 'vitest';
import {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
  SliceDisposition,
} from '@/constants/enums';
import { RECOVERY_TOLERANCE_PROFILE } from '@/constants/tunables';
import { computeBusinessPriority, type BusinessProfile } from '@/domain/policyEngine';
import { arbitrate } from '@/domain/arbitration/engine';
import { ArbitrationVerdict, type ArbitrationCandidate, type ArbitrationRequest } from '@/domain/arbitration/types';
import {
  buildHarmContext,
  fairnessMultiplier,
  harmAt,
  meanBurdenOf,
  recoveryUrgency,
  slaStressMultiplier,
} from '@/domain/arbitration/harm';
import { defaultPolicyDefinition, resolvePolicy, type Policy } from '@/models/policy.model';

/**
 * CBHA ARBITRATION ENGINE
 * =======================
 * These tests pin the behaviour that distinguishes this algorithm from priority-based
 * degradation. If any of them stops holding, the platform has quietly become the thing it
 * was built to replace.
 */

const policy = resolvePolicy({
  ...defaultPolicyDefinition(),
  id: 'POL-ARB',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
} as Policy);

let idCounter = 0;

function candidate(overrides: Partial<ArbitrationCandidate> & { business?: Partial<BusinessProfile> } = {}): ArbitrationCandidate {
  idCounter += 1;
  const id = overrides.sliceId ?? `SLC-${String(idCounter).padStart(3, '0')}`;

  const businessProfile: BusinessProfile = {
    departmentId: overrides.departmentId ?? `DEP-${id}`,
    departmentName: overrides.departmentName ?? `Dept ${id}`,
    criticality: DepartmentCriticality.BUSINESS_OPERATIONAL,
    businessImportance: 50,
    downtimeCostPerMinute: 1000,
    recoveryTolerance: RecoveryTolerance.MODERATE,
    complianceLevel: ComplianceLevel.INTERNAL,
    customerImpact: CustomerImpact.INDIRECT,
    operationalImportance: 50,
    policyWeightMultiplier: 1,
    ...overrides.business,
  };

  const priority = computeBusinessPriority(businessProfile, policy);
  const tolerance = businessProfile.recoveryTolerance;

  const { business: _business, ...rest } = overrides;

  return {
    sliceId: id,
    sliceCode: id.toLowerCase(),
    sliceName: `Slice ${id}`,
    departmentId: businessProfile.departmentId,
    departmentName: businessProfile.departmentName,
    demandMbps: 1000,
    allocatedMbps: 1000,
    baselineAllocatedMbps: 1000,
    minGuaranteedMbps: 200,
    priority,
    maxDegradationPercent: 50,
    harmCurvature: RECOVERY_TOLERANCE_PROFILE[tolerance].harmCurvature,
    recoveryIntoleranceScore: RECOVERY_TOLERANCE_PROFILE[tolerance].intoleranceScore,
    recoveryWindowSeconds: RECOVERY_TOLERANCE_PROFILE[tolerance].recoveryWindowSeconds,
    downtimeCostPerMinute: businessProfile.downtimeCostPerMinute,
    slaStress: 0.2,
    burdenScore: 0,
    telemetryAgeMs: 2000,
    ...rest,
  };
}

function request(
  candidates: ArbitrationCandidate[],
  overrides: Partial<ArbitrationRequest> = {},
): ArbitrationRequest {
  const totalDemand = candidates.reduce((sum, c) => sum + c.demandMbps, 0);
  return {
    contentionId: 'CTN-TEST',
    candidates,
    offeredCapacityMbps: 3000,
    totalDemandMbps: totalDemand,
    atMs: Date.UTC(2026, 5, 15, 14, 0, 0),
    settings: policy.arbitration,
    policyId: policy.policyId,
    policyRevision: policy.revision,
    policyName: policy.policyName,
    ...overrides,
  };
}

/* ================================================================== */
describe('THE CENTRAL INVARIANT — network QoS never influences the outcome', () => {
  it('has no field through which a QoS class could reach the engine', () => {
    const input = candidate();
    const keys = Object.keys(input).map((k) => k.toLowerCase());

    for (const forbidden of ['qos', 'fiveqi', '5qi', 'sst', 'snssai', 'profile', 'urllc', 'embb']) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false);
    }
  });

  it('produces an identical plan for slices that differ only in business context', () => {
    // Two identical networks; in one, the high-priority department would conventionally be
    // tagged eMBB (low QoS priority) and the low-priority one URLLC (high QoS priority).
    // Since the engine cannot see either tag, the outcome depends purely on the business
    // facts — which is the entire point of the platform.
    const hospital = candidate({
      sliceId: 'SLC-HOSPITAL',
      business: {
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        complianceLevel: ComplianceLevel.REGULATED,
        customerImpact: CustomerImpact.SEVERE_EXTERNAL,
        downtimeCostPerMinute: 50_000,
      },
      maxDegradationPercent: 20,
    });

    const signage = candidate({
      sliceId: 'SLC-SIGNAGE',
      business: {
        criticality: DepartmentCriticality.BEST_EFFORT,
        complianceLevel: ComplianceLevel.NONE,
        customerImpact: CustomerImpact.NONE,
        downtimeCostPerMinute: 20,
      },
    });

    const plan = arbitrate(request([hospital, signage], { offeredCapacityMbps: 1500 }));

    // The low-business-value slice absorbs the reduction, regardless of any notional
    // network priority it might carry.
    const signageAlloc = plan.allocations.find((a) => a.sliceId === 'SLC-SIGNAGE')!;
    const hospitalAlloc = plan.allocations.find((a) => a.sliceId === 'SLC-HOSPITAL')!;

    expect(plan.verdict).toBe(ArbitrationVerdict.FEASIBLE);
    expect(signageAlloc.reductionMbps).toBeGreaterThan(hospitalAlloc.reductionMbps);
  });
});

/* ================================================================== */
describe('THIS IS NOT A SORT — convexity spreads the cut', () => {
  it('degrades several slices shallowly rather than one deeply', () => {
    // A priority-sort algorithm takes everything from the lowest-ranked slice. CBHA does
    // not, because after a few percent the NEXT percent from that slice costs more than
    // the FIRST percent from a slice ranked above it.
    const slices = [
      candidate({ sliceId: 'SLC-A', business: { businessImportance: 30 } }),
      candidate({ sliceId: 'SLC-B', business: { businessImportance: 40 } }),
      candidate({ sliceId: 'SLC-C', business: { businessImportance: 50 } }),
      candidate({ sliceId: 'SLC-D', business: { businessImportance: 60 } }),
    ];

    // 4000 demand against 3000 capacity → ~1090 Mbps must be freed with headroom.
    const plan = arbitrate(request(slices, { offeredCapacityMbps: 3000 }));

    const degraded = plan.allocations.filter((a) => a.disposition === SliceDisposition.DEGRADED);

    expect(plan.verdict).toBe(ArbitrationVerdict.FEASIBLE);
    // More than one slice shares the burden.
    expect(degraded.length).toBeGreaterThan(1);

    // And no single slice was gutted while others went untouched.
    const deepest = Math.max(...degraded.map((a) => a.degradationPercent));
    expect(deepest).toBeLessThan(50);
  });

  it('equalises marginal harm across degraded slices — the KKT condition', () => {
    // The optimality signature of water-filling on a convex objective: at the optimum,
    // every interior slice has the same marginal harm.
    const slices = [
      candidate({ sliceId: 'SLC-A', business: { businessImportance: 45 } }),
      candidate({ sliceId: 'SLC-B', business: { businessImportance: 50 } }),
      candidate({ sliceId: 'SLC-C', business: { businessImportance: 55 } }),
    ];

    const plan = arbitrate(request(slices, { offeredCapacityMbps: 2400 }));
    const degraded = plan.allocations.filter(
      (a) => a.disposition === SliceDisposition.DEGRADED && a.reductionMbps > 1,
    );

    expect(degraded.length).toBeGreaterThan(1);

    const marginals = degraded.map((a) => a.marginalHarmAtStop);
    const spread = (Math.max(...marginals) - Math.min(...marginals)) / Math.max(...marginals);

    // Within one quantum's worth of each other.
    expect(spread).toBeLessThan(0.25);
  });

  it('takes less from a department with low recovery tolerance', () => {
    // Regression guard for a real defect. Expressing intolerance through curvature ALONE
    // is backwards: a larger γ makes the harm curve start flatter, so the zero-tolerance
    // department looked cheapest at low depth and was cut first. Intolerance must scale the
    // harm LEVEL as well as its curvature — see `intoleranceScale` in harm.ts.
    const intolerant = candidate({
      sliceId: 'SLC-INTOLERANT',
      business: { recoveryTolerance: RecoveryTolerance.ZERO, businessImportance: 50 },
    });
    const tolerant = candidate({
      sliceId: 'SLC-TOLERANT',
      business: { recoveryTolerance: RecoveryTolerance.HIGH, businessImportance: 50 },
    });

    const plan = arbitrate(request([intolerant, tolerant], { offeredCapacityMbps: 1500 }));

    const intolerantCut = plan.allocations.find((a) => a.sliceId === 'SLC-INTOLERANT')!;
    const tolerantCut = plan.allocations.find((a) => a.sliceId === 'SLC-TOLERANT')!;

    expect(tolerantCut.reductionMbps).toBeGreaterThan(intolerantCut.reductionMbps);
  });

  it('beats a priority sort on total business harm', () => {
    // The platform's quantified value, asserted rather than claimed.
    const slices = [
      candidate({ sliceId: 'SLC-1', business: { businessImportance: 20, recoveryTolerance: RecoveryTolerance.ZERO } }),
      candidate({ sliceId: 'SLC-2', business: { businessImportance: 55, recoveryTolerance: RecoveryTolerance.HIGH } }),
      candidate({ sliceId: 'SLC-3', business: { businessImportance: 60, recoveryTolerance: RecoveryTolerance.HIGH } }),
    ];

    const plan = arbitrate(request(slices, { offeredCapacityMbps: 2200 }));
    const prioritySort = plan.alternatives.find((a) => a.strategy === 'PRIORITY_SORT')!;

    expect(prioritySort).toBeDefined();
    expect(plan.totalHarm).toBeLessThanOrEqual(prioritySort.totalHarm);
  });

  it('prices counterfactuals on the same scale during a second pass', () => {
    // Regression guard for a real defect. On a second pass during one contention, a slice
    // may already carry depth from the first. The chosen plan's harm counted that depth;
    // the counterfactuals skipped every slice they did not cut again — so a priority sort
    // making the IDENTICAL cut was reported as ~80 % less harmful, and the headline
    // "harm avoided" figure on the Reports page went negative.
    const fresh = candidate({ sliceId: 'SLC-FRESH', business: { businessImportance: 10 } });
    const alreadyCut = candidate({
      sliceId: 'SLC-ALREADY-CUT',
      allocatedMbps: 800, // 20 % below baseline from the earlier pass
      business: { businessImportance: 90 },
    });

    // The already-cut slice's limit holds back 200 Mbps of its demand, so the link carries
    // 1,800 Mbps; 1,700 offered leaves ~150 Mbps to shed.
    const plan = arbitrate(request([fresh, alreadyCut], { offeredCapacityMbps: 1700 }));
    const prioritySort = plan.alternatives.find((a) => a.strategy === 'PRIORITY_SORT')!;

    // Precondition: both strategies take the whole reduction from the low-priority slice,
    // so the two plans are the same plan and must be priced the same.
    expect(plan.degradedSliceIds).toEqual(['SLC-FRESH']);
    expect(prioritySort.feasible).toBe(true);
    expect(prioritySort.affectedSliceCount).toBe(1);

    expect(prioritySort.totalHarm).toBeCloseTo(plan.totalHarm, 4);
    expect(prioritySort.harmPenaltyPercent).toBeCloseTo(0, 1);

    // And no feasible alternative undercuts the optimum.
    for (const alternative of plan.alternatives.filter((a) => a.feasible)) {
      expect(alternative.totalHarm).toBeGreaterThanOrEqual(plan.totalHarm - 1e-6);
    }
  });

  it('reaches the optimum when slices differ in size', () => {
    // Regression guard for a real defect. The solver ranked slices by dH/dd — harm per unit
    // of DEPTH — while every quantum frees the same number of Mbps, so a large slice's cost
    // per Mbps was overstated. With equal-sized slices (every other test here) the two
    // rankings coincide; with unequal ones the plan reached twice the optimal harm.
    const big = candidate({
      sliceId: 'SLC-BIG',
      demandMbps: 4000,
      allocatedMbps: 4000,
      baselineAllocatedMbps: 4000,
      minGuaranteedMbps: 0,
    });
    const small = candidate({
      sliceId: 'SLC-SMALL',
      demandMbps: 400,
      allocatedMbps: 400,
      baselineAllocatedMbps: 400,
      minGuaranteedMbps: 0,
    });
    const settings = { ...policy.arbitration, targetHeadroomFraction: 0 };
    const plan = arbitrate(request([big, small], { offeredCapacityMbps: 4000, settings }));

    // Brute-force the optimum of the same objective, on the same harm contexts.
    const contexts = [big, small].map((c) =>
      buildHarmContext(c, settings, meanBurdenOf([big, small]), big.recoveryWindowSeconds),
    );
    let optimum = Number.POSITIVE_INFINITY;
    for (let fromBig = 0; fromBig <= 400; fromBig += 0.5) {
      const harm = harmAt(contexts[0]!, fromBig / 4000) + harmAt(contexts[1]!, (400 - fromBig) / 400);
      optimum = Math.min(optimum, harm);
    }

    expect(plan.achievedReductionMbps).toBeCloseTo(400, 3);
    expect(plan.totalHarm).toBeLessThanOrEqual(optimum * 1.02);
    // Identical departments: a 10 % cut is the same harm on either slice, so the large one
    // frees ten times the bandwidth for it and should carry nearly all of the reduction.
    const bigCut = plan.allocations.find((a) => a.sliceId === 'SLC-BIG')!.reductionMbps;
    expect(bigCut).toBeGreaterThan(360);
  });
});

/* ================================================================== */
describe('arbitrates the traffic the link carries, not the limits', () => {
  // Regression guard for a real defect. The deficit was computed from raw demand and cuts
  // were taken from limits, so (a) lowering a limit a slice wasn't using counted as freed
  // bandwidth though no traffic changed, and (b) because demand never falls when limits do,
  // every later pass saw the same deficit and cut again.
  const carried = (c: { demandMbps: number }, limit: number) => Math.min(c.demandMbps, limit);

  /** Re-run the engine on the network as the plan left it: new limits, same demand. */
  const afterPlan = (cands: ArbitrationCandidate[], plan: ReturnType<typeof arbitrate>) =>
    cands.map((c) => {
      const a = plan.allocations.find((x) => x.sliceId === c.sliceId);
      return { ...c, allocatedMbps: a ? a.newAllocationMbps : c.allocatedMbps };
    });

  it('sheds real traffic, so the plan actually relieves the link', () => {
    // A slice using 1,811 of a 2,400 Mbps limit: lowering the limit to 2,115 frees nothing.
    const underUsing = candidate({
      sliceId: 'SLC-UNDER', demandMbps: 1811, allocatedMbps: 2400, baselineAllocatedMbps: 2400,
      minGuaranteedMbps: 600, business: { businessImportance: 30 },
    });
    const busy = candidate({
      sliceId: 'SLC-BUSY', demandMbps: 3000, allocatedMbps: 3000, baselineAllocatedMbps: 3000,
      minGuaranteedMbps: 600, business: { businessImportance: 30 },
    });
    const cands = [underUsing, busy];
    const offered = 4300;
    const plan = arbitrate(request(cands, { offeredCapacityMbps: offered }));

    expect(plan.verdict).toBe(ArbitrationVerdict.FEASIBLE);
    // Required is measured on carried traffic: 1,811 + 3,000 − 97 % of 4,300.
    expect(plan.requiredReductionMbps).toBeCloseTo(4811 - offered * 0.97, 3);

    const carriedAfter = afterPlan(cands, plan).reduce((s, c) => s + carried(c, c.allocatedMbps), 0);
    expect(carriedAfter).toBeLessThanOrEqual(offered * 0.97 + 1e-3);

    // Every Mbps reported as freed came off traffic the slice was actually sending.
    for (const a of plan.allocations.filter((x) => x.reductionMbps > 0)) {
      const c = cands.find((x) => x.sliceId === a.sliceId)!;
      expect(carried(c, c.allocatedMbps) - carried(c, a.newAllocationMbps)).toBeCloseTo(a.reductionMbps, 3);
    }
  });

  it('finds nothing to do on a second pass once the link is relieved', () => {
    const cands = [
      candidate({ sliceId: 'SLC-A', business: { businessImportance: 20 } }),
      candidate({ sliceId: 'SLC-B', business: { businessImportance: 40 } }),
      candidate({ sliceId: 'SLC-C', business: { businessImportance: 60 } }),
    ];
    const first = arbitrate(request(cands, { offeredCapacityMbps: 2500 }));
    expect(first.verdict).toBe(ArbitrationVerdict.FEASIBLE);

    // Demand is unchanged — it never falls when limits do — but the carried load now fits.
    const second = arbitrate(request(afterPlan(cands, first), { offeredCapacityMbps: 2500 }));
    expect(second.verdict).toBe(ArbitrationVerdict.NOT_REQUIRED);
    expect(second.degradedSliceIds).toHaveLength(0);
  });

  it('never cuts a slice past its ceiling across successive passes', () => {
    const slice = candidate({
      sliceId: 'SLC-CAPPED', maxDegradationPercent: 50, minGuaranteedMbps: 100,
      business: { businessImportance: 10 },
    });
    const other = candidate({ sliceId: 'SLC-OTHER', business: { businessImportance: 90 } });
    const cands = [slice, other];

    const first = arbitrate(request(cands, { offeredCapacityMbps: 1300 }));
    const afterFirst = afterPlan(cands, first);
    const capped = afterFirst.find((c) => c.sliceId === 'SLC-CAPPED')!;
    expect(capped.allocatedMbps).toBeGreaterThanOrEqual(500 - 1e-6); // 50 % of 1,000

    // The shortage persists (capacity shrank further); the capped slice must not go lower.
    const second = arbitrate(request(afterFirst, { offeredCapacityMbps: 1000 }));
    const cut = second.allocations.find((a) => a.sliceId === 'SLC-CAPPED')!;
    expect(cut.newAllocationMbps).toBeGreaterThanOrEqual(500 - 1e-6);
  });
});

/* ================================================================== */
describe('hard constraints cannot be outvoted', () => {
  it('never degrades a LIFE_SAFETY slice, however extreme the contention', () => {
    const lifeSafety = candidate({
      sliceId: 'SLC-LIFE',
      business: { complianceLevel: ComplianceLevel.LIFE_SAFETY },
      maxDegradationPercent: 0,
    });
    const ordinary = candidate({ sliceId: 'SLC-ORDINARY' });

    // Absurd overload — nothing should shake the exemption.
    const plan = arbitrate(
      request([lifeSafety, ordinary], { offeredCapacityMbps: 100, totalDemandMbps: 2000 }),
    );

    const lifeAlloc = plan.allocations.find((a) => a.sliceId === 'SLC-LIFE')!;
    expect(lifeAlloc.disposition).toBe(SliceDisposition.EXEMPT);
    expect(lifeAlloc.reductionMbps).toBe(0);
    expect(lifeAlloc.newAllocationMbps).toBe(lifeAlloc.previousAllocationMbps);
    expect(plan.exemptSliceIds).toContain('SLC-LIFE');
  });

  it('never reduces a slice below its contractual floor', () => {
    const slices = [
      candidate({ sliceId: 'SLC-A', minGuaranteedMbps: 800, maxDegradationPercent: 90 }),
      candidate({ sliceId: 'SLC-B', minGuaranteedMbps: 700, maxDegradationPercent: 90 }),
    ];

    const plan = arbitrate(request(slices, { offeredCapacityMbps: 500 }));

    for (const allocation of plan.allocations) {
      const original = slices.find((s) => s.sliceId === allocation.sliceId)!;
      expect(allocation.newAllocationMbps).toBeGreaterThanOrEqual(original.minGuaranteedMbps - 1e-6);
    }
  });

  it('never exceeds a department’s permitted degradation depth', () => {
    const capped = candidate({ sliceId: 'SLC-CAP', maxDegradationPercent: 10, minGuaranteedMbps: 0 });
    const free = candidate({ sliceId: 'SLC-FREE', maxDegradationPercent: 80, minGuaranteedMbps: 0 });

    const plan = arbitrate(request([capped, free], { offeredCapacityMbps: 400 }));

    const cappedAlloc = plan.allocations.find((a) => a.sliceId === 'SLC-CAP')!;
    expect(cappedAlloc.degradationPercent).toBeLessThanOrEqual(10 + 1e-6);
  });

  it('reports INFEASIBLE when every slice is exempt', () => {
    const slices = [
      candidate({ sliceId: 'SLC-X', maxDegradationPercent: 0 }),
      candidate({ sliceId: 'SLC-Y', maxDegradationPercent: 0 }),
    ];

    const plan = arbitrate(request(slices, { offeredCapacityMbps: 500 }));

    expect(plan.verdict).toBe(ArbitrationVerdict.INFEASIBLE);
    expect(plan.escalationReason).toContain('No slice has degradable headroom');
    expect(plan.degradedSliceIds).toEqual([]);
  });

  it('reports PARTIAL when ceilings limit what can be freed', () => {
    const slices = [
      candidate({ sliceId: 'SLC-A', maxDegradationPercent: 5, minGuaranteedMbps: 0 }),
      candidate({ sliceId: 'SLC-B', maxDegradationPercent: 5, minGuaranteedMbps: 0 }),
    ];

    const plan = arbitrate(request(slices, { offeredCapacityMbps: 500 }));

    expect(plan.verdict).toBe(ArbitrationVerdict.PARTIAL);
    expect(plan.shortfallMbps).toBeGreaterThan(0);
    expect(plan.escalationReason).toContain('shortfall');
  });
});

/* ================================================================== */
describe('historical fairness rotates the burden', () => {
  it('prefers a slice that has been degraded less recently', () => {
    // Without memory the engine picks the same victim every time, for weeks.
    const previouslyHit = candidate({ sliceId: 'SLC-TIRED', burdenScore: 200 });
    const untouched = candidate({ sliceId: 'SLC-FRESH', burdenScore: 0 });

    const plan = arbitrate(request([previouslyHit, untouched], { offeredCapacityMbps: 1600 }));

    const tired = plan.allocations.find((a) => a.sliceId === 'SLC-TIRED')!;
    const fresh = plan.allocations.find((a) => a.sliceId === 'SLC-FRESH')!;

    expect(fresh.reductionMbps).toBeGreaterThan(tired.reductionMbps);
    expect(fresh.factors.fairnessMultiplier).toBeLessThan(tired.factors.fairnessMultiplier);
  });

  it('is bounded so fairness cannot invert a large priority gap', () => {
    // Rotating the burden is desirable; degrading a hospital because a warehouse had a bad
    // week is not.
    const hospital = candidate({
      sliceId: 'SLC-HOSP',
      burdenScore: 0,
      business: {
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        complianceLevel: ComplianceLevel.REGULATED,
        customerImpact: CustomerImpact.SEVERE_EXTERNAL,
        downtimeCostPerMinute: 100_000,
      },
    });
    const warehouse = candidate({
      sliceId: 'SLC-WARE',
      burdenScore: 100_000, // absurdly burdened
      business: {
        criticality: DepartmentCriticality.BEST_EFFORT,
        complianceLevel: ComplianceLevel.NONE,
        customerImpact: CustomerImpact.NONE,
        downtimeCostPerMinute: 10,
      },
    });

    const plan = arbitrate(request([hospital, warehouse], { offeredCapacityMbps: 1600 }));

    const hospitalCut = plan.allocations.find((a) => a.sliceId === 'SLC-HOSP')!;
    const warehouseCut = plan.allocations.find((a) => a.sliceId === 'SLC-WARE')!;

    expect(warehouseCut.reductionMbps).toBeGreaterThan(hospitalCut.reductionMbps);
  });

  it('is neutral when no slice has any history', () => {
    expect(fairnessMultiplier(0, 0, 0.6)).toBe(1);
  });

  it('clamps to the configured band', () => {
    const lambda = 0.6;
    expect(fairnessMultiplier(1_000_000, 1, lambda)).toBeCloseTo(1 + lambda, 6);
    expect(fairnessMultiplier(0, 1000, lambda)).toBeCloseTo(1 / (1 + lambda), 6);
  });
});

/* ================================================================== */
describe('SLA stress and recovery urgency', () => {
  it('takes less from a slice already near its SLA limit', () => {
    const stressed = candidate({ sliceId: 'SLC-STRESSED', slaStress: 0.95 });
    const relaxed = candidate({ sliceId: 'SLC-RELAXED', slaStress: 0.05 });

    const plan = arbitrate(request([stressed, relaxed], { offeredCapacityMbps: 1600 }));

    const stressedCut = plan.allocations.find((a) => a.sliceId === 'SLC-STRESSED')!;
    const relaxedCut = plan.allocations.find((a) => a.sliceId === 'SLC-RELAXED')!;

    expect(relaxedCut.reductionMbps).toBeGreaterThan(stressedCut.reductionMbps);
  });

  it('scales the multiplier with the configured gain', () => {
    expect(slaStressMultiplier(0, 0.8)).toBe(1);
    expect(slaStressMultiplier(1, 0.8)).toBeCloseTo(1.8, 6);
    expect(slaStressMultiplier(0.5, 0.8)).toBeCloseTo(1.4, 6);
  });

  it('raises urgency with downtime cost and hold duration', () => {
    const cheapShort = recoveryUrgency(100, 60, 1000);
    const cheapLong = recoveryUrgency(100, 600, 1000);
    const expensiveLong = recoveryUrgency(100_000, 600, 1000);

    expect(cheapLong).toBeGreaterThan(cheapShort);
    expect(expensiveLong).toBeGreaterThan(cheapLong);
  });

  it('is neutral when no downtime cost is declared', () => {
    expect(recoveryUrgency(0, 600, 1000)).toBe(1);
  });
});

/* ================================================================== */
describe('explainability', () => {
  it('gives every slice a reason naming concrete values', () => {
    const plan = arbitrate(
      request([candidate({ sliceId: 'SLC-A' }), candidate({ sliceId: 'SLC-B' })], {
        offeredCapacityMbps: 1600,
      }),
    );

    for (const allocation of plan.allocations) {
      expect(allocation.reason.length).toBeGreaterThan(60);
      expect(allocation.reason).toMatch(/\d/); // contains actual numbers
    }
  });

  it('records the factors behind every decision', () => {
    const plan = arbitrate(request([candidate(), candidate()], { offeredCapacityMbps: 1600 }));

    for (const allocation of plan.allocations) {
      expect(allocation.factors.businessScore).toBeGreaterThan(0);
      expect(allocation.factors.harmCurvature).toBeGreaterThanOrEqual(1);
      expect(allocation.factors.fairnessMultiplier).toBeGreaterThan(0);
      expect(allocation.factors.recoveryUrgency).toBeGreaterThanOrEqual(1);
    }
  });

  it('evaluates and prices counterfactual strategies', () => {
    const plan = arbitrate(
      request([candidate(), candidate(), candidate()], { offeredCapacityMbps: 2200 }),
    );

    const strategies = plan.alternatives.map((a) => a.strategy);
    expect(strategies).toContain('PRIORITY_SORT');
    expect(strategies).toContain('UNIFORM_CUT');
    expect(strategies).toContain('SINGLE_VICTIM');

    for (const alternative of plan.alternatives) {
      expect(alternative.rejectedBecause.length).toBeGreaterThan(40);
      expect(Number.isFinite(alternative.totalHarm)).toBe(true);
    }
  });

  it('snapshots the governing policy so the decision stays explainable', () => {
    const plan = arbitrate(request([candidate()], { offeredCapacityMbps: 500 }));
    expect(plan.policyId).toBe('POL-ARB');
    expect(plan.policyRevision).toBe(1);
    expect(plan.policyName).toBeTruthy();
  });

  it('writes a rationale describing the whole decision', () => {
    const plan = arbitrate(
      request([candidate(), candidate()], { offeredCapacityMbps: 1600 }),
    );

    expect(plan.rationale).toContain('offered capacity');
    expect(plan.rationale.toLowerCase()).toContain('marginal');
    expect(plan.rationale.length).toBeGreaterThan(150);
  });
});

/* ================================================================== */
describe('confidence scoring', () => {
  it('is high for a clear-cut decision on fresh data', () => {
    const plan = arbitrate(
      request(
        [
          candidate({ sliceId: 'SLC-HIGH', telemetryAgeMs: 1000, business: { businessImportance: 95 } }),
          candidate({ sliceId: 'SLC-LOW', telemetryAgeMs: 1000, business: { businessImportance: 5 } }),
        ],
        { offeredCapacityMbps: 1700 },
      ),
    );

    expect(plan.confidence).toBeGreaterThan(0.5);
    expect(plan.confidenceBreakdown.telemetryFreshness).toBeGreaterThan(0.9);
    expect(plan.confidenceBreakdown.dataCompleteness).toBe(1);
  });

  it('falls when telemetry is stale', () => {
    const fresh = arbitrate(
      request([candidate({ telemetryAgeMs: 1000 }), candidate({ telemetryAgeMs: 1000 })], {
        offeredCapacityMbps: 1600,
      }),
    );
    const stale = arbitrate(
      request([candidate({ telemetryAgeMs: 300_000 }), candidate({ telemetryAgeMs: 300_000 })], {
        offeredCapacityMbps: 1600,
      }),
    );

    expect(stale.confidenceBreakdown.telemetryFreshness).toBeLessThan(
      fresh.confidenceBreakdown.telemetryFreshness,
    );
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  it('collapses constraint slack when the plan is pressed against every ceiling', () => {
    const slices = [
      candidate({ sliceId: 'SLC-A', maxDegradationPercent: 5, minGuaranteedMbps: 0 }),
      candidate({ sliceId: 'SLC-B', maxDegradationPercent: 5, minGuaranteedMbps: 0 }),
    ];
    const plan = arbitrate(request(slices, { offeredCapacityMbps: 500 }));

    expect(plan.confidenceBreakdown.constraintSlack).toBe(0);
  });

  it('stays within 0–1', () => {
    const plan = arbitrate(request([candidate()], { offeredCapacityMbps: 500 }));
    expect(plan.confidence).toBeGreaterThanOrEqual(0);
    expect(plan.confidence).toBeLessThanOrEqual(1);
  });
});

/* ================================================================== */
describe('determinism and robustness', () => {
  it('returns an identical plan for identical input', () => {
    const slices = [candidate({ sliceId: 'SLC-A' }), candidate({ sliceId: 'SLC-B' })];
    const first = arbitrate(request(slices, { offeredCapacityMbps: 1600 }));
    const second = arbitrate(request(slices, { offeredCapacityMbps: 1600 }));

    // `computeMs` is wall-clock and legitimately differs.
    expect({ ...first, diagnostics: { ...first.diagnostics, computeMs: 0 } }).toEqual({
      ...second,
      diagnostics: { ...second.diagnostics, computeMs: 0 },
    });
  });

  it('is insensitive to candidate ordering', () => {
    const a = candidate({ sliceId: 'SLC-A', business: { businessImportance: 30 } });
    const b = candidate({ sliceId: 'SLC-B', business: { businessImportance: 60 } });

    const forwards = arbitrate(request([a, b], { offeredCapacityMbps: 1600 }));
    const backwards = arbitrate(request([b, a], { offeredCapacityMbps: 1600 }));

    const reductionOf = (plan: typeof forwards, id: string) =>
      plan.allocations.find((x) => x.sliceId === id)!.reductionMbps;

    expect(reductionOf(forwards, 'SLC-A')).toBeCloseTo(reductionOf(backwards, 'SLC-A'), 2);
    expect(reductionOf(forwards, 'SLC-B')).toBeCloseTo(reductionOf(backwards, 'SLC-B'), 2);
  });

  it('returns NOT_REQUIRED when demand already fits', () => {
    const plan = arbitrate(
      request([candidate({ demandMbps: 500 })], { offeredCapacityMbps: 5000, totalDemandMbps: 500 }),
    );

    expect(plan.verdict).toBe(ArbitrationVerdict.NOT_REQUIRED);
    expect(plan.allocations).toEqual([]);
    expect(plan.confidence).toBe(1);
  });

  it('handles an empty candidate list without throwing', () => {
    const plan = arbitrate(request([], { offeredCapacityMbps: 1000, totalDemandMbps: 5000 }));
    expect(plan.verdict).toBe(ArbitrationVerdict.INFEASIBLE);
  });

  it('never overshoots the required reduction', () => {
    const slices = [candidate({ sliceId: 'SLC-A' }), candidate({ sliceId: 'SLC-B' })];
    const plan = arbitrate(request(slices, { offeredCapacityMbps: 1900 }));

    // Degrading more than necessary is pure, avoidable harm.
    expect(plan.achievedReductionMbps).toBeLessThanOrEqual(plan.requiredReductionMbps + 1e-6);
  });

  it('converges within the iteration ceiling on a large fleet', () => {
    const fleet = Array.from({ length: 60 }, (_, i) =>
      candidate({ sliceId: `SLC-${i}`, business: { businessImportance: 20 + (i % 60) } }),
    );

    const plan = arbitrate(
      request(fleet, { offeredCapacityMbps: 40_000, totalDemandMbps: 60_000 }),
    );

    expect(plan.diagnostics.converged).toBe(true);
    // The control loop runs every two seconds; this must be comfortably inside that.
    expect(plan.diagnostics.computeMs).toBeLessThan(500);
  });

  it('continues degrading from an already-degraded state without restarting the curve', () => {
    // A second arbitration pass during the same contention must not treat a slice already
    // at 30 % degradation as if it were untouched.
    const partial = candidate({
      sliceId: 'SLC-PARTIAL',
      allocatedMbps: 700,
      baselineAllocatedMbps: 1000,
      minGuaranteedMbps: 200,
      maxDegradationPercent: 50,
    });
    const untouched = candidate({
      sliceId: 'SLC-UNTOUCHED',
      allocatedMbps: 1000,
      baselineAllocatedMbps: 1000,
      minGuaranteedMbps: 200,
      maxDegradationPercent: 50,
    });

    const plan = arbitrate(
      request([partial, untouched], { offeredCapacityMbps: 1400, totalDemandMbps: 2000 }),
    );

    const partialCut = plan.allocations.find((a) => a.sliceId === 'SLC-PARTIAL')!;
    const untouchedCut = plan.allocations.find((a) => a.sliceId === 'SLC-UNTOUCHED')!;

    // The already-degraded slice sits further up its harm curve, so it is the more
    // expensive place to take the next unit.
    expect(untouchedCut.reductionMbps).toBeGreaterThan(partialCut.reductionMbps);
  });
});
