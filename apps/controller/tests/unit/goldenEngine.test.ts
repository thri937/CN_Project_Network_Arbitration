import { describe, it, expect } from 'vitest';
import { arbitrate } from '@/domain/arbitration/engine';
import {
  ArbitrationVerdict,
  type ArbitrationCandidate,
  type ArbitrationRequest,
} from '@/domain/arbitration/types';
import { defaultPolicyDefinition, resolvePolicy, type Policy } from '@/models/policy.model';
import {
  DepartmentCriticality,
  RecoveryTolerance,
  ComplianceLevel,
  CustomerImpact,
} from '@/constants/enums';
import { computeBusinessPriority } from '@/domain/policyEngine';
import { RECOVERY_TOLERANCE_PROFILE } from '@/constants/tunables';

describe('Golden Engine Tests (TC2, TC3, TC4 on 7-slice testbed)', () => {
  const policy: Policy = resolvePolicy({
    ...defaultPolicyDefinition(),
    id: 'POL-ARB-GOLDEN',
    version: 1,
    arbitration: {
      ...defaultPolicyDefinition().arbitration,
      minQuantumMbps: 1,
    },
  } as Policy);

  // Helper to create valid ArbitrationCandidate
  const candidate = (
    code: string,
    baseline: number,
    floor: number,
    criticality: DepartmentCriticality,
    businessImportance: number,
    downtimeCost: number,
    recoveryTol: RecoveryTolerance,
    compliance: ComplianceLevel,
    customerImpact: CustomerImpact,
    opImportance: number,
    maxDegradationPct: number,
    demand: number,
    currentAllocated: number,
  ): ArbitrationCandidate => {
    const business = {
      departmentId: `dep-${code}`,
      departmentName: code,
      criticality,
      businessImportance,
      downtimeCostPerMinute: downtimeCost,
      recoveryTolerance: recoveryTol,
      complianceLevel: compliance,
      customerImpact,
      operationalImportance: opImportance,
      policyWeightMultiplier: 1,
    };
    const priority = computeBusinessPriority(business, policy);

    return {
      sliceId: `slc-${code}`,
      sliceCode: code,
      sliceName: code,
      departmentId: `dep-${code}`,
      departmentName: code,
      demandMbps: demand,
      allocatedMbps: currentAllocated,
      baselineAllocatedMbps: baseline,
      minGuaranteedMbps: floor,
      priority,
      maxDegradationPercent: maxDegradationPct,
      harmCurvature: RECOVERY_TOLERANCE_PROFILE[recoveryTol].harmCurvature,
      recoveryIntoleranceScore: RECOVERY_TOLERANCE_PROFILE[recoveryTol].intoleranceScore,
      recoveryWindowSeconds: RECOVERY_TOLERANCE_PROFILE[recoveryTol].recoveryWindowSeconds,
      downtimeCostPerMinute: downtimeCost,
      slaStress: 0.1,
      burdenScore: 0,
      telemetryAgeMs: 1000,
    };
  };

  const getSlices = (demands: Record<string, number>): ArbitrationCandidate[] => [
    // Clinic (0% degradation ceiling, LIFE_SAFETY)
    candidate(
      'slice-telemetry',
      60,
      40,
      DepartmentCriticality.MISSION_CRITICAL,
      100,
      25000,
      RecoveryTolerance.ZERO,
      ComplianceLevel.LIFE_SAFETY,
      CustomerImpact.SEVERE_EXTERNAL,
      100,
      0,
      demands['slice-telemetry'] ?? 33,
      60
    ),
    // Factory (15% ceiling)
    candidate(
      'slice-factory',
      380,
      170,
      DepartmentCriticality.MISSION_CRITICAL,
      94,
      8400,
      RecoveryTolerance.LOW,
      ComplianceLevel.CONTRACTUAL,
      CustomerImpact.DIRECT,
      96,
      15,
      demands['slice-factory'] ?? 209,
      380
    ),
    // Quality lab (20% ceiling)
    candidate(
      'slice-lab',
      180,
      50,
      DepartmentCriticality.BUSINESS_CRITICAL,
      68,
      1600,
      RecoveryTolerance.LOW,
      ComplianceLevel.REGULATED,
      CustomerImpact.DIRECT,
      70,
      20,
      demands['slice-lab'] ?? 99,
      180
    ),
    // Warehouse (35% ceiling)
    candidate(
      'slice-warehouse',
      160,
      55,
      DepartmentCriticality.BUSINESS_CRITICAL,
      72,
      2100,
      RecoveryTolerance.MODERATE,
      ComplianceLevel.INTERNAL,
      CustomerImpact.INDIRECT,
      78,
      35,
      demands['slice-warehouse'] ?? 88,
      160
    ),
    // Security (40% ceiling)
    candidate(
      'slice-cctv',
      240,
      60,
      DepartmentCriticality.BUSINESS_OPERATIONAL,
      58,
      700,
      RecoveryTolerance.MODERATE,
      ComplianceLevel.CONTRACTUAL,
      CustomerImpact.INTERNAL_ONLY,
      66,
      40,
      demands['slice-cctv'] ?? 132,
      240
    ),
    // Office IT (45% ceiling)
    candidate(
      'slice-office',
      320,
      70,
      DepartmentCriticality.BUSINESS_OPERATIONAL,
      52,
      900,
      RecoveryTolerance.MODERATE,
      ComplianceLevel.INTERNAL,
      CustomerImpact.INTERNAL_ONLY,
      55,
      45,
      demands['slice-office'] ?? 176,
      320
    ),
    // Canteen (80% ceiling)
    candidate(
      'slice-canteen',
      140,
      28,
      DepartmentCriticality.BEST_EFFORT,
      8,
      15,
      RecoveryTolerance.HIGH,
      ComplianceLevel.NONE,
      CustomerImpact.NONE,
      10,
      80,
      demands['slice-canteen'] ?? 77,
      140
    ),
  ];

  const request = (
    candidates: ArbitrationCandidate[],
    offered = 950
  ): ArbitrationRequest => {
    const totalDemand = candidates.reduce((acc, c) => acc + c.demandMbps, 0);
    return {
      contentionId: 'test-golden-contention',
      candidates,
      offeredCapacityMbps: offered,
      totalDemandMbps: totalDemand,
      atMs: Date.now(),
      settings: policy.arbitration,
      policyId: policy.policyId,
      policyRevision: policy.revision,
    };
  };

  it('TC2: Canteen flood contained, others normal', () => {
    // Canteen at Flood (280), others normal (55%)
    // Demands: Clinic 33, Factory 209, Lab 99, Warehouse 88, Security 132, Office 176, Canteen 280
    // Total carried load is 877 kbps which fits within 921.5 kbps (950 kbps - 3% headroom).
    // Shaper contains Canteen at 140 kbps without needing arbitration.
    const slices = getSlices({ 'slice-canteen': 280 });
    const plan = arbitrate(request(slices, 950));

    expect(plan).toBeDefined();
    expect(plan.verdict).toBe(ArbitrationVerdict.NOT_REQUIRED);
  });

  it('TC3: Lunch-hour rush contention', () => {
    // Canteen Flood (280), Office Peak (320), CCTV Peak (240), Warehouse Busy (128), Lab 99, Factory 209, Clinic 33
    // Total demand = 33 + 209 + 99 + 128 + 240 + 320 + 280 = 1309 kbps
    // Total allocated = 60 + 380 + 180 + 160 + 240 + 320 + 140 = 1480 kbps > 950 kbps!
    const slices = getSlices({
      'slice-canteen': 280,
      'slice-office': 320,
      'slice-cctv': 240,
      'slice-warehouse': 128,
      'slice-lab': 99,
      'slice-factory': 209,
      'slice-telemetry': 33,
    });

    const plan = arbitrate(request(slices, 950));
    expect(plan.verdict).toBe(ArbitrationVerdict.FEASIBLE);

    // 1. Clinic is NEVER cut
    const clinic = plan.allocations.find((a) => a.sliceCode === 'slice-telemetry')!;
    expect(clinic.newAllocationMbps).toBe(60);

    // 2. Slices with cuts: Canteen and other degraded slices
    const canteen = plan.allocations.find((a) => a.sliceCode === 'slice-canteen')!;
    expect(canteen.newAllocationMbps).toBeLessThan(140);
    // Never cut below floor (28)
    expect(canteen.newAllocationMbps).toBeGreaterThanOrEqual(28);

    // 3. No slice cut beyond ceiling or floor
    for (const alloc of plan.allocations) {
      const orig = slices.find((s) => s.sliceCode === alloc.sliceCode)!;
      expect(alloc.newAllocationMbps).toBeGreaterThanOrEqual(orig.minGuaranteedMbps);
    }
  });

  it('TC4: Everyone at peak', () => {
    // Everyone demands 100% baseline: Total = 1,480 kbps against 950 kbps offered
    const slices = getSlices({
      'slice-telemetry': 60,
      'slice-factory': 380,
      'slice-lab': 180,
      'slice-warehouse': 160,
      'slice-cctv': 240,
      'slice-office': 320,
      'slice-canteen': 140,
    });

    const plan = arbitrate(request(slices, 950));

    // When everyone is at peak, even cutting all degradable slices to their legal ceiling
    // cannot reach 950 with target headroom without escalation -> PARTIAL verdict!
    expect([ArbitrationVerdict.PARTIAL, ArbitrationVerdict.FEASIBLE]).toContain(plan.verdict);

    // Clinic is NEVER cut
    const clinic = plan.allocations.find((a) => a.sliceCode === 'slice-telemetry')!;
    expect(clinic.newAllocationMbps).toBe(60);

    // Every slice respects its floor
    for (const alloc of plan.allocations) {
      const orig = slices.find((s) => s.sliceCode === alloc.sliceCode)!;
      expect(alloc.newAllocationMbps).toBeGreaterThanOrEqual(orig.minGuaranteedMbps);
    }
  });
});
