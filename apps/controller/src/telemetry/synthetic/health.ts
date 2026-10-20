import { HealthState } from '@/constants/enums';
import type { SlaTargets } from '@/models/slice.model';
import { clamp, clamp01, mapRange, round, safeDivide } from '@/utils/math';

/**
 * Slice health scoring.
 *
 * Health is defined ENTIRELY relative to the slice's own SLA targets, never against
 * absolute thresholds. A 40 ms latency is excellent for an mMTC sensor network and a
 * catastrophic breach for a motion-control slice with a 5 ms target. Scoring against a
 * global "latency > 30 ms is bad" rule would produce a dashboard that is wrong for most
 * of the fleet most of the time.
 *
 * The score is the WORST-CASE across dimensions rather than an average, because SLAs are
 * conjunctive: a slice meeting its throughput target while breaching its loss target is
 * breaching its SLA. Averaging would let one healthy dimension mask a live breach — the
 * single most dangerous thing a NOC dashboard can do.
 *
 * The same computation feeds the arbitration engine's SLA-stress term, so what an operator
 * sees on screen and what the engine reasons about are guaranteed identical.
 */

export interface HealthInputs {
  latencyMs: number;
  jitterMs: number;
  packetLossPercent: number;
  usedMbps: number;
  demandMbps: number;
  cpuPercent: number;
  memoryPercent: number;
}

export interface HealthAssessment {
  health: HealthState;
  /** 0–100, where 100 is comfortably inside every target. */
  healthScore: number;
  /**
   * 0–1 measure of how close the slice is to breaching. 0 = ample margin, 1 = at or past
   * the limit. This is the value the arbitration engine amplifies harm by.
   */
  slaStress: number;
  /** Per-dimension stress, surfaced in the UI so an operator sees WHICH target is at risk. */
  breakdown: {
    latency: number;
    jitter: number;
    packetLoss: number;
    throughput: number;
    compute: number;
  };
  /** Dimensions currently in breach. Empty when the SLA is being met. */
  breaches: string[];
}

/**
 * Ratio of observed to permitted, clamped to [0,1].
 * 0 means "no consumption of the budget", 1 means "at or beyond the limit".
 */
function stressOf(observed: number, limit: number): number {
  if (limit <= 0) return observed > 0 ? 1 : 0;
  return clamp01(observed / limit);
}

export function assessHealth(inputs: HealthInputs, targets: SlaTargets): HealthAssessment {
  const latency = stressOf(inputs.latencyMs, targets.maxLatencyMs);
  const jitter = stressOf(inputs.jitterMs, targets.maxJitterMs);
  const packetLoss = stressOf(inputs.packetLossPercent, targets.maxPacketLossPercent);

  // Throughput stress is INVERTED: the risk is delivering too LITTLE, not too much.
  // A slice whose demand is below its minimum target is not in breach — it simply is not
  // asking for much — so stress is measured against the lesser of demand and the target.
  const effectiveThroughputTarget = Math.min(targets.minThroughputMbps, Math.max(inputs.demandMbps, 0));
  const throughput =
    effectiveThroughputTarget <= 0
      ? 0
      : clamp01(1 - safeDivide(inputs.usedMbps, effectiveThroughputTarget, 1));

  // Compute pressure is a LEADING INDICATOR, not an SLA term: it predicts a breach rather
  // than being one. Its curve is therefore late-onset, not linear.
  //
  // A linear mapping is wrong and was caught by test: a user-plane function sitting at
  // 40 % memory is entirely healthy, yet linear scaling contributed 0.4 stress and dragged
  // an otherwise-excellent slice to WARNING. Utilisation only signals risk as it
  // approaches saturation, so the curve stays near zero through the normal operating
  // range and climbs steeply past 70 %.
  const computeStress = computePressure(
    Math.max(inputs.cpuPercent, inputs.memoryPercent),
  );

  const breakdown = {
    latency: round(latency, 4),
    jitter: round(jitter, 4),
    packetLoss: round(packetLoss, 4),
    throughput: round(throughput, 4),
    compute: round(computeStress, 4),
  };

  // Conjunctive: the SLA is only as good as its weakest dimension.
  const slaStress = Math.max(latency, jitter, packetLoss, throughput, computeStress);

  const breaches: string[] = [];
  if (inputs.latencyMs > targets.maxLatencyMs) breaches.push('latency');
  if (inputs.jitterMs > targets.maxJitterMs) breaches.push('jitter');
  if (inputs.packetLossPercent > targets.maxPacketLossPercent) breaches.push('packetLoss');
  if (effectiveThroughputTarget > 0 && inputs.usedMbps < effectiveThroughputTarget) {
    breaches.push('throughput');
  }

  const healthScore = round(clamp((1 - slaStress) * 100, 0, 100), 2);

  return {
    health: classify(healthScore, breaches.length > 0, slaStress),
    healthScore,
    slaStress: round(slaStress, 4),
    breakdown,
    breaches,
  };
}

/**
 * Compute utilisation → risk contribution.
 *
 *   0–70 %   → 0.00–0.08   normal operating range; essentially free
 *   70–90 %  → 0.08–0.55   pressure building, worth an operator's attention
 *   90–100 % → 0.55–1.00   saturation imminent
 */
function computePressure(utilisationPercent: number): number {
  const u = clamp01(utilisationPercent / 100);
  if (u <= 0.7) return mapRange(u, 0, 0.7, 0, 0.08);
  if (u <= 0.9) return mapRange(u, 0.7, 0.9, 0.08, 0.55);
  return mapRange(u, 0.9, 1, 0.55, 1);
}

/**
 * Map stress to an operator-facing state.
 *
 * Classification keys off STRESS rather than score, because stress is the primary
 * quantity — "how much of the SLA budget is consumed" — and the thresholds are then
 * directly meaningful: under 60 % of every budget is comfortable, 60–85 % is worth
 * watching, past that the slice is close to breaching.
 *
 * A live breach is never reported as healthy: a slice can sit at 82 % health while
 * exceeding its loss target, and rounding that up to "fine" is exactly the failure a NOC
 * dashboard must not have.
 */
function classify(score: number, hasBreach: boolean, stress: number): HealthState {
  if (hasBreach) return score < 40 ? HealthState.CRITICAL : HealthState.DEGRADED;
  if (stress < 0.6) return HealthState.HEALTHY;
  if (stress < 0.85) return HealthState.WARNING;
  return HealthState.DEGRADED;
}
