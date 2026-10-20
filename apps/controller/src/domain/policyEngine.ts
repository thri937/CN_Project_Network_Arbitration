import type {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
} from '@/constants/enums';
import type { PolicyWeightVector } from '@/constants/tunables';
import type { ResolvedPolicy } from '@/models/policy.model';
import { clamp, logNormalise, round } from '@/utils/math';

/**
 * BUSINESS POLICY ENGINE — PURE DOMAIN
 * ====================================
 * Converts a department's business attributes into a single Business Priority Score
 * (0–100) that the arbitration engine can rank on.
 *
 * ARCHITECTURAL RULES THIS FILE OBEYS ABSOLUTELY:
 *   • no I/O, no repositories, no clock, no logger, no config imports
 *   • every input arrives as a parameter; every output is returned
 *   • given identical inputs it returns an identical result, forever
 *
 * That purity is not stylistic. It is what makes it possible to take an arbitration
 * decision recorded in March — which stored its inputs and its resolved policy — and
 * re-execute it in December to prove the number was right. A scoring function that reached
 * out to a datastore could never be replayed, and "explainable" would be a claim rather
 * than a property.
 *
 * WHAT THIS ENGINE DELIBERATELY DOES NOT SEE
 * ==========================================
 * It has no parameter for QoS class, 5QI, slice profile, SST, or any network-layer
 * priority. It cannot consider them because they are not in its signature. That is the
 * platform's central thesis expressed as a type.
 */

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/**
 * The business facts about a department, flattened.
 *
 * A plain structure rather than the `Department` entity: the engine must be callable with
 * values reconstructed from a historical audit record, which is not a live entity and has
 * no id, version or timestamps.
 */
export interface BusinessProfile {
  departmentId: string;
  departmentName: string;
  criticality: DepartmentCriticality;
  businessImportance: number;
  downtimeCostPerMinute: number;
  recoveryTolerance: RecoveryTolerance;
  complianceLevel: ComplianceLevel;
  customerImpact: CustomerImpact;
  operationalImportance: number;
  /** Bounded escape hatch, [0.5, 2.0]. Applied last, to the final score. */
  policyWeightMultiplier: number;
}

/**
 * Historical degradation burden for the slices of this department.
 *
 * Not a scoring INPUT — it deliberately does not raise or lower the business priority
 * score. A department's importance to the business does not change because it was unlucky
 * last Tuesday. Burden is carried alongside the score and consumed separately by the
 * arbitration engine's fairness term, which is where "who has already suffered" belongs.
 *
 * Conflating the two would be a modelling error with a visible symptom: a critical
 * department degraded twice would score as *less* critical, and would then be degraded
 * again more readily.
 */
export interface DegradationBurden {
  /** Σ (degradation fraction × seconds), over the policy's fairness lookback window. */
  burdenScore: number;
  eventsInWindow: number;
  secondsDegradedInWindow: number;
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export type PolicyFactor = keyof PolicyWeightVector;

/**
 * One factor's journey from a business statement to a number.
 *
 * Stored verbatim in the arbitration audit record. A score without this breakdown is a
 * black box, and a black box that reduces a hospital's bandwidth is not defensible in a
 * review — which is the entire failure mode this platform exists to avoid.
 */
export interface FactorContribution {
  factor: PolicyFactor;
  /** The business statement, e.g. `"MISSION_CRITICAL"` or `8400` (currency/minute). */
  rawValue: string | number;
  /** After ordinal→cardinal translation and normalisation, 0–100. */
  normalised: number;
  /** The policy weight applied. */
  weight: number;
  /** normalised × weight. */
  weighted: number;
  /** Share of the pre-multiplier total, 0–100. Answers "what drove this score?". */
  sharePercent: number;
  /** Operator-facing sentence, rendered directly in the UI. */
  explanation: string;
}

export interface BusinessPriorityScore {
  departmentId: string;
  departmentName: string;
  /** Final score, 0–100, after the department multiplier. */
  score: number;
  /** Score before the multiplier, so the multiplier's effect is visible. */
  baseScore: number;
  multiplier: number;
  contributions: FactorContribution[];
  /** Policy identity, so the score can be tied to the rules that produced it. */
  policyId: string;
  policyRevision: number;
  /** One-line summary for a dashboard card. */
  summary: string;
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

/**
 * Compute the Business Priority Score.
 *
 * Every factor is normalised to 0–100 before weighting. Without that, factors measured on
 * different scales would contribute in proportion to their units rather than their
 * importance, and the weight vector would mean nothing.
 */
export function computeBusinessPriority(
  profile: BusinessProfile,
  policy: ResolvedPolicy,
): BusinessPriorityScore {
  const weights = policy.weights;

  const factors: { factor: PolicyFactor; raw: string | number; normalised: number; explanation: string }[] = [
    {
      factor: 'departmentCriticality',
      raw: profile.criticality,
      normalised: policy.criticalityScore[profile.criticality],
      explanation: `Criticality ${humanise(profile.criticality)} scores ${policy.criticalityScore[profile.criticality]}/100 under this policy`,
    },
    {
      factor: 'businessImportance',
      raw: profile.businessImportance,
      // Already expressed on a 0–100 scale by the department's own declaration.
      normalised: clamp(profile.businessImportance, 0, 100),
      explanation: `Declared business importance of ${profile.businessImportance}/100 relative to peer departments`,
    },
    {
      factor: 'downtimeCost',
      raw: profile.downtimeCostPerMinute,
      normalised: normaliseDowntimeCost(profile.downtimeCostPerMinute, policy),
      explanation: buildDowntimeExplanation(profile.downtimeCostPerMinute, policy),
    },
    {
      factor: 'compliance',
      raw: profile.complianceLevel,
      normalised: policy.complianceScore[profile.complianceLevel],
      explanation:
        `Compliance level ${humanise(profile.complianceLevel)} scores ` +
        `${policy.complianceScore[profile.complianceLevel]}/100. Note: compliance also imposes a HARD ` +
        `degradation ceiling of ${policy.complianceCeilingPercent[profile.complianceLevel]}%, applied as a ` +
        `constraint rather than through this score`,
    },
    {
      factor: 'customerImpact',
      raw: profile.customerImpact,
      normalised: policy.customerImpactScore[profile.customerImpact],
      explanation: `Customer impact ${humanise(profile.customerImpact)} scores ${policy.customerImpactScore[profile.customerImpact]}/100`,
    },
    {
      factor: 'operationalImportance',
      raw: profile.operationalImportance,
      normalised: clamp(profile.operationalImportance, 0, 100),
      explanation: `Declared operational importance of ${profile.operationalImportance}/100 for day-to-day running`,
    },
    {
      factor: 'recoveryIntolerance',
      raw: profile.recoveryTolerance,
      normalised: policy.recoveryIntoleranceScore[profile.recoveryTolerance],
      explanation:
        `Recovery tolerance ${humanise(profile.recoveryTolerance)} gives an intolerance of ` +
        `${policy.recoveryIntoleranceScore[profile.recoveryTolerance]}/100 ` +
        `(recovery window ${policy.recoveryWindowSeconds[profile.recoveryTolerance]}s)`,
    },
  ];

  const weighted = factors.map((f) => ({ ...f, weight: weights[f.factor], product: f.normalised * weights[f.factor] }));
  const baseScore = weighted.reduce((total, f) => total + f.product, 0);

  const contributions: FactorContribution[] = weighted.map((f) => ({
    factor: f.factor,
    rawValue: f.raw,
    normalised: round(f.normalised, 2),
    weight: round(f.weight, 4),
    weighted: round(f.product, 3),
    // Share of the base score, so "what drove this?" has a numeric answer. Guarded against
    // a zero base score, which occurs when every factor is at its floor.
    sharePercent: baseScore > 0 ? round((f.product / baseScore) * 100, 2) : 0,
    explanation: f.explanation,
  }));

  const multiplier = clamp(profile.policyWeightMultiplier, 0.5, 2);
  const score = clamp(baseScore * multiplier, 0, 100);

  return {
    departmentId: profile.departmentId,
    departmentName: profile.departmentName,
    score: round(score, 3),
    baseScore: round(baseScore, 3),
    multiplier: round(multiplier, 3),
    contributions,
    policyId: policy.policyId,
    policyRevision: policy.revision,
    summary: buildSummary(profile, score, multiplier, contributions),
  };
}

/**
 * Downtime cost → 0–100.
 *
 * Logarithmic, and this is the single most consequential normalisation choice in the
 * platform. Downtime cost is unbounded and spans four or more orders of magnitude across a
 * real enterprise: a trading desk at £500,000/minute and a stationery store at £50/minute.
 *
 * Under LINEAR normalisation the trading desk scores 100 and every other department rounds
 * to 0. The `downtimeCost` weight then behaves as an absolute override, the other six
 * factors become decorative, and the platform silently degenerates into "protect whoever
 * declared the biggest number" — which is both gameable and indefensible.
 *
 * Log-normalisation maps the policy's reference cost to 50 and compresses both tails, so an
 * order of magnitude more cost buys roughly 25 points rather than 99. Cost still dominates
 * among near-equals; it can no longer erase every other consideration.
 */
function normaliseDowntimeCost(costPerMinute: number, policy: ResolvedPolicy): number {
  return logNormalise(costPerMinute, policy.arbitration.downtimeCostReference, 10);
}

function buildDowntimeExplanation(costPerMinute: number, policy: ResolvedPolicy): string {
  const reference = policy.arbitration.downtimeCostReference;
  const normalised = round(normaliseDowntimeCost(costPerMinute, policy), 1);

  if (costPerMinute <= 0) {
    return 'No downtime cost declared, contributing 0 to the score';
  }

  const ratio = costPerMinute / reference;
  const comparison =
    ratio >= 1
      ? `${round(ratio, 1)}× the reference of ${reference}/min`
      : `${round(1 / ratio, 1)}× below the reference of ${reference}/min`;

  return (
    `Downtime costs ${costPerMinute}/min — ${comparison} — normalising to ${normalised}/100. ` +
    `Scaling is logarithmic so a single extreme figure cannot saturate the score`
  );
}

function buildSummary(
  profile: BusinessProfile,
  score: number,
  multiplier: number,
  contributions: FactorContribution[],
): string {
  const dominant = [...contributions].sort((a, b) => b.weighted - a.weighted)[0];
  const multiplierNote =
    multiplier === 1
      ? ''
      : ` (including a ${multiplier}× department multiplier)`;

  return (
    `${profile.departmentName} scores ${round(score, 1)}/100${multiplierNote}, driven mainly by ` +
    `${dominant ? humaniseFactor(dominant.factor) : 'no single factor'} ` +
    `(${dominant ? dominant.sharePercent : 0}% of the total)`
  );
}

/* ------------------------------------------------------------------ */
/* Comparison helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Explain why one department outranks another.
 *
 * Powers the "why was my slice chosen and not theirs?" answer in the UI. Returns the
 * factors ordered by how much they contributed to the gap, which is the only honest way to
 * answer that question — the gap is rarely due to one factor.
 */
export function explainRanking(
  higher: BusinessPriorityScore,
  lower: BusinessPriorityScore,
): {
  gap: number;
  drivers: { factor: PolicyFactor; delta: number; explanation: string }[];
  summary: string;
} {
  const lowerByFactor = new Map(lower.contributions.map((c) => [c.factor, c]));

  const drivers = higher.contributions
    .map((contribution) => {
      const counterpart = lowerByFactor.get(contribution.factor);
      const delta = round(contribution.weighted - (counterpart?.weighted ?? 0), 3);
      return {
        factor: contribution.factor,
        delta,
        explanation:
          `${humaniseFactor(contribution.factor)}: ${higher.departmentName} ` +
          `${contribution.rawValue} vs ${lower.departmentName} ${counterpart?.rawValue ?? 'n/a'} ` +
          `(${delta >= 0 ? '+' : ''}${delta} weighted points)`,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const gap = round(higher.score - lower.score, 3);
  const top = drivers[0];

  return {
    gap,
    drivers,
    summary:
      `${higher.departmentName} outranks ${lower.departmentName} by ${gap} points, ` +
      `driven principally by ${top ? humaniseFactor(top.factor) : 'no single factor'}`,
  };
}

/** Rank a set of scores, highest first. Ties broken by department id for determinism. */
export function rankByPriority(scores: BusinessPriorityScore[]): BusinessPriorityScore[] {
  return [...scores].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // A stable tiebreak matters: without it, two equally-scored departments could swap
    // order between runs and produce different arbitration outcomes from identical inputs.
    return a.departmentId.localeCompare(b.departmentId);
  });
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

/** `MISSION_CRITICAL` → `Mission Critical`. */
function humanise(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const FACTOR_LABELS: Readonly<Record<PolicyFactor, string>> = Object.freeze({
  departmentCriticality: 'department criticality',
  businessImportance: 'business importance',
  downtimeCost: 'downtime cost',
  compliance: 'compliance obligations',
  customerImpact: 'customer impact',
  operationalImportance: 'operational importance',
  recoveryIntolerance: 'recovery intolerance',
});

export function humaniseFactor(factor: PolicyFactor): string {
  return FACTOR_LABELS[factor];
}
