import { describe, expect, it } from 'vitest';
import {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
} from '@/constants/enums';
import {
  computeBusinessPriority,
  explainRanking,
  rankByPriority,
  type BusinessProfile,
} from '@/domain/policyEngine';
import { defaultPolicyDefinition, resolvePolicy, type Policy } from '@/models/policy.model';

/**
 * The Business Policy Engine is the platform's value judgement made explicit. These tests
 * pin that judgement so it cannot drift silently.
 */

const policy = resolvePolicy({
  ...defaultPolicyDefinition(),
  id: 'POL-TEST',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
} as Policy);

const profile = (overrides: Partial<BusinessProfile> = {}): BusinessProfile => ({
  departmentId: 'DEP-1',
  departmentName: 'Manufacturing',
  criticality: DepartmentCriticality.BUSINESS_OPERATIONAL,
  businessImportance: 50,
  downtimeCostPerMinute: 1000,
  recoveryTolerance: RecoveryTolerance.MODERATE,
  complianceLevel: ComplianceLevel.INTERNAL,
  customerImpact: CustomerImpact.INDIRECT,
  operationalImportance: 50,
  policyWeightMultiplier: 1,
  ...overrides,
});

describe('score bounds and determinism', () => {
  it('produces a score inside 0–100', () => {
    const extremes: BusinessProfile[] = [
      profile({
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        businessImportance: 100,
        downtimeCostPerMinute: 10_000_000,
        recoveryTolerance: RecoveryTolerance.ZERO,
        complianceLevel: ComplianceLevel.LIFE_SAFETY,
        customerImpact: CustomerImpact.SEVERE_EXTERNAL,
        operationalImportance: 100,
        policyWeightMultiplier: 2,
      }),
      profile({
        criticality: DepartmentCriticality.BEST_EFFORT,
        businessImportance: 0,
        downtimeCostPerMinute: 0,
        recoveryTolerance: RecoveryTolerance.HIGH,
        complianceLevel: ComplianceLevel.NONE,
        customerImpact: CustomerImpact.NONE,
        operationalImportance: 0,
        policyWeightMultiplier: 0.5,
      }),
    ];

    for (const candidate of extremes) {
      const result = computeBusinessPriority(candidate, policy);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it('is deterministic — identical inputs give an identical result forever', () => {
    // This is what makes a March decision re-executable in December.
    const input = profile();
    expect(computeBusinessPriority(input, policy)).toEqual(computeBusinessPriority(input, policy));
  });

  it('records the policy identity that produced the score', () => {
    const result = computeBusinessPriority(profile(), policy);
    expect(result.policyId).toBe('POL-TEST');
    expect(result.policyRevision).toBe(1);
  });
});

describe('monotonicity', () => {
  it('scores a more critical department higher, all else equal', () => {
    const ranked = [
      DepartmentCriticality.BEST_EFFORT,
      DepartmentCriticality.ADMINISTRATIVE,
      DepartmentCriticality.BUSINESS_OPERATIONAL,
      DepartmentCriticality.BUSINESS_CRITICAL,
      DepartmentCriticality.MISSION_CRITICAL,
    ].map((criticality) => computeBusinessPriority(profile({ criticality }), policy).score);

    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i]!).toBeGreaterThan(ranked[i - 1]!);
    }
  });

  it('scores higher downtime cost higher', () => {
    const cheap = computeBusinessPriority(profile({ downtimeCostPerMinute: 100 }), policy).score;
    const expensive = computeBusinessPriority(profile({ downtimeCostPerMinute: 100_000 }), policy).score;
    expect(expensive).toBeGreaterThan(cheap);
  });

  it('scores lower recovery tolerance higher', () => {
    // A department that cannot tolerate any degradation is more important to protect.
    const tolerant = computeBusinessPriority(
      profile({ recoveryTolerance: RecoveryTolerance.HIGH }),
      policy,
    ).score;
    const intolerant = computeBusinessPriority(
      profile({ recoveryTolerance: RecoveryTolerance.ZERO }),
      policy,
    ).score;
    expect(intolerant).toBeGreaterThan(tolerant);
  });

  it('scores greater customer impact higher', () => {
    const internal = computeBusinessPriority(
      profile({ customerImpact: CustomerImpact.INTERNAL_ONLY }),
      policy,
    ).score;
    const external = computeBusinessPriority(
      profile({ customerImpact: CustomerImpact.SEVERE_EXTERNAL }),
      policy,
    ).score;
    expect(external).toBeGreaterThan(internal);
  });
});

describe('logarithmic downtime-cost normalisation', () => {
  it('maps the policy reference cost to 50', () => {
    const result = computeBusinessPriority(
      profile({ downtimeCostPerMinute: policy.arbitration.downtimeCostReference }),
      policy,
    );
    const cost = result.contributions.find((c) => c.factor === 'downtimeCost')!;
    expect(cost.normalised).toBeCloseTo(50, 1);
  });

  it('prevents one extreme figure from erasing every other factor', () => {
    // THE defence against a gameable platform. Under linear normalisation a department
    // declaring an astronomical cost would score 100 while everyone else rounded to 0,
    // turning the cost weight into an absolute override.
    const enormousCost = computeBusinessPriority(
      profile({
        downtimeCostPerMinute: 50_000_000,
        criticality: DepartmentCriticality.BEST_EFFORT,
        businessImportance: 0,
        complianceLevel: ComplianceLevel.NONE,
        customerImpact: CustomerImpact.NONE,
        operationalImportance: 0,
        recoveryTolerance: RecoveryTolerance.HIGH,
      }),
      policy,
    );

    const genuinelyCritical = computeBusinessPriority(
      profile({
        downtimeCostPerMinute: 5000,
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        businessImportance: 95,
        complianceLevel: ComplianceLevel.LIFE_SAFETY,
        customerImpact: CustomerImpact.SEVERE_EXTERNAL,
        operationalImportance: 90,
        recoveryTolerance: RecoveryTolerance.ZERO,
      }),
      policy,
    );

    // A department whose ONLY claim is a huge number must not outrank one that is
    // critical on every other axis.
    expect(genuinelyCritical.score).toBeGreaterThan(enormousCost.score);
  });

  it('compresses each additional order of magnitude', () => {
    const at1x = computeBusinessPriority(profile({ downtimeCostPerMinute: 1000 }), policy);
    const at10x = computeBusinessPriority(profile({ downtimeCostPerMinute: 10_000 }), policy);
    const at100x = computeBusinessPriority(profile({ downtimeCostPerMinute: 100_000 }), policy);

    const normalised = (r: typeof at1x) => r.contributions.find((c) => c.factor === 'downtimeCost')!.normalised;

    const firstDecade = normalised(at10x) - normalised(at1x);
    const secondDecade = normalised(at100x) - normalised(at10x);

    expect(firstDecade).toBeGreaterThan(0);
    expect(secondDecade).toBeGreaterThan(0);
    // Diminishing returns: each further decade buys less.
    expect(secondDecade).toBeLessThan(firstDecade);
  });

  it('handles a zero cost without breaking the score', () => {
    const result = computeBusinessPriority(profile({ downtimeCostPerMinute: 0 }), policy);
    const cost = result.contributions.find((c) => c.factor === 'downtimeCost')!;
    expect(cost.normalised).toBe(0);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});

describe('explainability', () => {
  it('returns a contribution for every policy factor', () => {
    const result = computeBusinessPriority(profile(), policy);
    expect(result.contributions.map((c) => c.factor).sort()).toEqual(
      [
        'businessImportance',
        'compliance',
        'customerImpact',
        'departmentCriticality',
        'downtimeCost',
        'operationalImportance',
        'recoveryIntolerance',
      ].sort(),
    );
  });

  it('has contributions that sum to the base score', () => {
    // If the parts do not reconstruct the whole, the breakdown is decorative rather than
    // an explanation, and the audit record would be misleading.
    const result = computeBusinessPriority(profile({ businessImportance: 73 }), policy);
    const total = result.contributions.reduce((sum, c) => sum + c.weighted, 0);
    expect(total).toBeCloseTo(result.baseScore, 2);
  });

  it('has shares that sum to 100 %', () => {
    const result = computeBusinessPriority(profile(), policy);
    const shares = result.contributions.reduce((sum, c) => sum + c.sharePercent, 0);
    expect(shares).toBeCloseTo(100, 1);
  });

  it('carries the raw business statement alongside the number', () => {
    const result = computeBusinessPriority(
      profile({ criticality: DepartmentCriticality.MISSION_CRITICAL, downtimeCostPerMinute: 8400 }),
      policy,
    );

    expect(result.contributions.find((c) => c.factor === 'departmentCriticality')!.rawValue).toBe(
      'MISSION_CRITICAL',
    );
    expect(result.contributions.find((c) => c.factor === 'downtimeCost')!.rawValue).toBe(8400);
  });

  it('writes an operator-readable explanation for every factor', () => {
    const result = computeBusinessPriority(profile(), policy);
    for (const contribution of result.contributions) {
      expect(contribution.explanation.length).toBeGreaterThan(20);
      // Explanations must be prose, not a restatement of the enum name.
      expect(contribution.explanation).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it('states that compliance also acts as a hard constraint', () => {
    // Compliance is unusual: it both scores AND imposes a ceiling. An operator reading
    // only the score would otherwise miss the more important half.
    const result = computeBusinessPriority(
      profile({ complianceLevel: ComplianceLevel.LIFE_SAFETY }),
      policy,
    );
    const compliance = result.contributions.find((c) => c.factor === 'compliance')!;
    expect(compliance.explanation).toContain('HARD');
    expect(compliance.explanation).toContain('0%');
  });

  it('names the dominant factor in the summary', () => {
    const result = computeBusinessPriority(
      profile({ criticality: DepartmentCriticality.MISSION_CRITICAL }),
      policy,
    );
    expect(result.summary).toContain('Manufacturing');
    expect(result.summary).toMatch(/driven mainly by/);
  });
});

describe('department multiplier', () => {
  it('scales the base score', () => {
    const plain = computeBusinessPriority(profile({ policyWeightMultiplier: 1 }), policy);
    const boosted = computeBusinessPriority(profile({ policyWeightMultiplier: 1.5 }), policy);

    expect(boosted.baseScore).toBeCloseTo(plain.baseScore, 5);
    expect(boosted.score).toBeCloseTo(Math.min(100, plain.baseScore * 1.5), 2);
  });

  it('is clamped so it cannot override the policy entirely', () => {
    // A wider range would let an operator bypass governance through the back door — which
    // is precisely the ungovernable behaviour the platform replaces.
    const absurd = computeBusinessPriority(profile({ policyWeightMultiplier: 99 }), policy);
    expect(absurd.multiplier).toBe(2);

    const negative = computeBusinessPriority(profile({ policyWeightMultiplier: -5 }), policy);
    expect(negative.multiplier).toBe(0.5);
  });

  it('keeps the base score visible so the multiplier’s effect is auditable', () => {
    const result = computeBusinessPriority(profile({ policyWeightMultiplier: 1.8 }), policy);
    expect(result.baseScore).toBeLessThan(result.score);
    expect(result.summary).toContain('1.8×');
  });
});

describe('policy sensitivity', () => {
  it('changes the score when the weight vector changes', () => {
    const complianceFirst = resolvePolicy({
      ...defaultPolicyDefinition(),
      id: 'POL-COMPLIANCE',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      weights: {
        departmentCriticality: 0.1,
        businessImportance: 0.05,
        downtimeCost: 0.05,
        compliance: 0.65,
        customerImpact: 0.05,
        operationalImportance: 0.05,
        recoveryIntolerance: 0.05,
      },
    } as Policy);

    const regulated = profile({ complianceLevel: ComplianceLevel.REGULATED });

    const underDefault = computeBusinessPriority(regulated, policy).score;
    const underComplianceFirst = computeBusinessPriority(regulated, complianceFirst).score;

    expect(underComplianceFirst).toBeGreaterThan(underDefault);
  });

  it('honours a policy score override', () => {
    const custom = resolvePolicy({
      ...defaultPolicyDefinition(),
      id: 'POL-OVERRIDE',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      scoreOverrides: { criticality: { [DepartmentCriticality.ADMINISTRATIVE]: 95 } },
    } as Policy);

    const admin = profile({ criticality: DepartmentCriticality.ADMINISTRATIVE });
    const contribution = computeBusinessPriority(admin, custom).contributions.find(
      (c) => c.factor === 'departmentCriticality',
    )!;

    expect(contribution.normalised).toBe(95);
  });
});

describe('ranking and comparison', () => {
  it('ranks highest score first', () => {
    const scores = [
      computeBusinessPriority(profile({ departmentId: 'DEP-LOW', criticality: DepartmentCriticality.BEST_EFFORT }), policy),
      computeBusinessPriority(profile({ departmentId: 'DEP-HIGH', criticality: DepartmentCriticality.MISSION_CRITICAL }), policy),
      computeBusinessPriority(profile({ departmentId: 'DEP-MID', criticality: DepartmentCriticality.BUSINESS_OPERATIONAL }), policy),
    ];

    expect(rankByPriority(scores).map((s) => s.departmentId)).toEqual([
      'DEP-HIGH',
      'DEP-MID',
      'DEP-LOW',
    ]);
  });

  it('breaks ties deterministically', () => {
    // Without a stable tiebreak, two equal departments could swap order between runs and
    // produce different arbitration outcomes from identical inputs.
    const a = computeBusinessPriority(profile({ departmentId: 'DEP-B' }), policy);
    const b = computeBusinessPriority(profile({ departmentId: 'DEP-A' }), policy);

    expect(rankByPriority([a, b]).map((s) => s.departmentId)).toEqual(['DEP-A', 'DEP-B']);
    expect(rankByPriority([b, a]).map((s) => s.departmentId)).toEqual(['DEP-A', 'DEP-B']);
  });

  it('explains why one department outranks another', () => {
    const hospital = computeBusinessPriority(
      profile({
        departmentId: 'DEP-MED',
        departmentName: 'Clinical Systems',
        criticality: DepartmentCriticality.MISSION_CRITICAL,
        complianceLevel: ComplianceLevel.LIFE_SAFETY,
        customerImpact: CustomerImpact.SEVERE_EXTERNAL,
      }),
      policy,
    );

    const signage = computeBusinessPriority(
      profile({
        departmentId: 'DEP-SIGN',
        departmentName: 'Digital Signage',
        criticality: DepartmentCriticality.BEST_EFFORT,
        complianceLevel: ComplianceLevel.NONE,
        customerImpact: CustomerImpact.NONE,
      }),
      policy,
    );

    const explanation = explainRanking(hospital, signage);

    expect(explanation.gap).toBeGreaterThan(0);
    expect(explanation.summary).toContain('Clinical Systems');
    expect(explanation.summary).toContain('Digital Signage');
    // Ordered by contribution to the gap, largest first.
    expect(Math.abs(explanation.drivers[0]!.delta)).toBeGreaterThanOrEqual(
      Math.abs(explanation.drivers[explanation.drivers.length - 1]!.delta),
    );
  });
});

describe('the platform’s central claim', () => {
  it('has no parameter through which a QoS class could influence the score', () => {
    // The engine's signature accepts only business attributes. Network-layer priority is
    // not merely ignored — it is unrepresentable. This test guards the type.
    const input = profile();
    const keys = Object.keys(input);

    for (const forbidden of ['qos', 'qosClass', 'profile', 'sst', 'snssai', 'fiveQi', 'priority']) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
    }
  });

  it('gives identical scores to departments differing only in network profile', () => {
    // Two departments with the same business facts must score identically, whatever their
    // slices' network characteristics happen to be — the engine never sees them.
    const a = computeBusinessPriority(profile({ departmentId: 'DEP-URLLC' }), policy);
    const b = computeBusinessPriority(profile({ departmentId: 'DEP-EMBB' }), policy);
    expect(a.score).toBe(b.score);
  });
});
