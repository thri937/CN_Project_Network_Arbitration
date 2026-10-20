/**
 * API types.
 *
 * MANUALLY MIRRORED FROM THE BACKEND, DELIBERATELY.
 * ================================================
 * The alternative — importing the backend's Zod-inferred types across the workspace — was
 * considered and rejected. It couples the SPA's build to the server's internals, so a
 * refactor of a private field breaks the frontend compile, and it drags Zod and the whole
 * backend module graph into a browser bundle.
 *
 * These are the WIRE contract: only what crosses HTTP, only what the UI consumes. Where a
 * field's meaning is non-obvious, the comment says why rather than restating the name.
 */

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: {
    correlationId?: string;
    timestamp?: string;
    durationMs?: number;
    page?: { limit: number; returned: number; nextCursor: string | null; total?: number };
  };
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlationId: string;
    timestamp: string;
  };
}

/* ------------------------------------------------------------------ */
/* Enumerations                                                        */
/* ------------------------------------------------------------------ */

export type UserRole = 'ADMIN' | 'MANAGER' | 'VIEWER';

export type DepartmentCriticality =
  | 'MISSION_CRITICAL'
  | 'BUSINESS_CRITICAL'
  | 'BUSINESS_OPERATIONAL'
  | 'ADMINISTRATIVE'
  | 'BEST_EFFORT';

export type RecoveryTolerance = 'ZERO' | 'LOW' | 'MODERATE' | 'HIGH';
export type ComplianceLevel = 'NONE' | 'INTERNAL' | 'CONTRACTUAL' | 'REGULATED' | 'LIFE_SAFETY';
export type CustomerImpact = 'NONE' | 'INTERNAL_ONLY' | 'INDIRECT' | 'DIRECT' | 'SEVERE_EXTERNAL';

export type SliceStatus =
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'RECOVERING'
  | 'PAUSED'
  | 'TERMINATED';

export type SliceProfile = 'EMBB' | 'URLLC' | 'MMTC' | 'V2X';
export type HealthState = 'HEALTHY' | 'WARNING' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';
export type CapacityLevel = 'HEALTHY' | 'ELEVATED' | 'WARNING' | 'CRITICAL' | 'OVERSUBSCRIBED';
export type ContentionSeverity = 'MINOR' | 'MODERATE' | 'SEVERE' | 'CRITICAL';
export type ContentionStatus =
  | 'DETECTED'
  | 'ARBITRATING'
  | 'MITIGATED'
  | 'UNRESOLVABLE'
  | 'RESOLVED'
  | 'EXPIRED';
export type SliceDisposition = 'PROTECTED' | 'DEGRADED' | 'UNAFFECTED' | 'EXEMPT';
export type ArbitrationVerdict = 'FEASIBLE' | 'PARTIAL' | 'INFEASIBLE' | 'NOT_REQUIRED';
export type ArbitrationOutcome = 'RESOLVED' | 'PARTIAL' | 'ESCALATED' | 'ABORTED';
export type NotificationSeverity = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'CRITICAL';
export type RecoveryStatus =
  | 'NOT_APPLICABLE'
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'RECOVERED'
  | 'EXTENDED'
  | 'FAILED';

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

export interface PublicUser {
  id: string;
  email: string;
  displayName?: string;
  photoUrl?: string;
  role: UserRole;
  enabled: boolean;
  departmentScope: string[];
  lastLoginAt?: string;
  loginCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  expiresInSeconds: number;
  sessionId: string;
  tokenType: 'Bearer';
}

export interface Department {
  id: string;
  name: string;
  code: string;
  description?: string;
  criticality: DepartmentCriticality;
  businessImportance: number;
  downtimeCostPerMinute: number;
  recoveryTolerance: RecoveryTolerance;
  maxAllowedDegradationPercent: number;
  complianceLevel: ComplianceLevel;
  customerImpact: CustomerImpact;
  operationalImportance: number;
  policyWeightMultiplier: number;
  ownerName?: string;
  ownerEmail?: string;
  site?: string;
  active: boolean;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;

  /** Derived server-side: the tighter of the department limit and the compliance ceiling. */
  effectiveDegradationCeiling: number;
  /** Derived: compliance forbids any degradation at all. */
  structurallyExempt: boolean;
}

export interface SlaTargets {
  maxLatencyMs: number;
  maxJitterMs: number;
  maxPacketLossPercent: number;
  minThroughputMbps: number;
  availabilityPercent: number;
}

export interface Slice {
  id: string;
  name: string;
  code: string;
  description?: string;
  departmentId: string;
  snssai: { sst: number; sd?: string };
  /** Carried for 3GPP interoperability. NOT an input to arbitration. */
  profile: SliceProfile;
  baselineAllocatedMbps: number;
  allocatedMbps: number;
  minGuaranteedMbps: number;
  maxBurstMbps: number;
  slaTargets: SlaTargets;
  status: SliceStatus;
  health: HealthState;
  healthScore: number;
  activeDegradation?: {
    decisionId: string;
    contentionId: string;
    appliedAt: string;
    expiresAt: string;
    percent: number;
    reducedMbps: number;
    reason: string;
    businessScore: number;
  };
  degradationHistory: {
    totalEvents: number;
    cumulativeDegradedSeconds: number;
    burdenScore: number;
    lastDegradedAt?: string;
    lastRecoveredAt?: string;
  };
  site?: string;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;

  /* Derived server-side, so the UI and the engine cannot disagree. */
  degradationPercent: number;
  degradableHeadroomMbps: number;
  arbitrable: boolean;
  utilisationOfBurstPercent: number;
}

export interface LiveSliceState {
  sliceId: string;
  sliceCode: string;
  sliceName: string;
  departmentId: string;
  demandMbps: number;
  allocatedMbps: number;
  baselineAllocatedMbps: number;
  minGuaranteedMbps: number;
  usedMbps: number;
  utilisation: number;
  latencyMs: number;
  jitterMs: number;
  packetLossPercent: number;
  cpuPercent: number;
  memoryPercent: number;
  activeSessions: number;
  health: HealthState;
  healthScore: number;
  /** 0–1 consumption of the SLA budget. Drives the stress indicator. */
  slaStress: number;
  breaches: string[];
  status: string;
  observedAtMs: number;
}

export interface NetworkSnapshot {
  atMs: number;
  at: string;
  slices: LiveSliceState[];
  /** What slices are ASKING for. Can exceed capacity — this is the contention signal. */
  totalDemandMbps: number;
  totalAllocatedMbps: number;
  totalUsedMbps: number;
  offeredCapacityMbps: number;
  source: string;
  tick: number;
}

export interface CapacityState {
  atMs: number;
  at: string;
  totalCapacityMbps: number;
  reservedCapacityMbps: number;
  offeredCapacityMbps: number;
  allocatedMbps: number;
  usedMbps: number;
  demandMbps: number;
  availableMbps: number;
  /** used / offered. Saturates at 1.0 — cannot show HOW oversubscribed the network is. */
  utilisation: number;
  /** demand / offered. Unbounded — the only signal that can. */
  demandRatio: number;
  allocationRatio: number;
  level: CapacityLevel;
  utilisationTrend: number;
  projectedUtilisation: number | null;
  activeSliceCount: number;
  degradedSliceCount: number;
  breachingSliceCount: number;
  oversubscribed: boolean;
  excessDemandMbps: number;
}

export interface ContentionEvent {
  id: string;
  status: ContentionStatus;
  severity: ContentionSeverity;
  detectedAt: string;
  detectedAtMs: number;
  resolvedAt?: string;
  durationSeconds?: number;
  offeredCapacityMbps: number;
  demandAtDetectionMbps: number;
  demandRatioAtDetection: number;
  excessDemandMbps: number;
  peakDemandRatio: number;
  peakExcessMbps: number;
  currentDemandRatio: number;
  currentExcessMbps: number;
  participants: {
    sliceId: string;
    sliceCode: string;
    departmentId: string;
    demandMbps: number;
    allocatedMbps: number;
    demandShare: number;
  }[];
  arbitrationCount: number;
  lastArbitrationAt?: string;
  decisionIds: string[];
  unresolvableReason?: string;
  clearanceProgress: number;
}

export interface DecisionAllocation {
  sliceId: string;
  sliceCode: string;
  sliceName: string;
  departmentId: string;
  departmentName: string;
  disposition: SliceDisposition;
  demandMbps: number;
  previousAllocationMbps: number;
  newAllocationMbps: number;
  reductionMbps: number;
  degradationPercent: number;
  businessScore: number;
  harmIncurred: number;
  marginalHarmAtStop: number;
  durationSeconds: number;
  expiresAt?: string;
  /** Written for the affected department, not for logs. Rendered verbatim. */
  reason: string;
  factors: {
    businessScore: number;
    harmCurvature: number;
    slaStress: number;
    fairnessMultiplier: number;
    recoveryUrgency: number;
    intoleranceScale: number;
    maxDegradationPercent: number;
    headroomMbps: number;
  };
  applied: boolean;
  effectiveMbps?: number;
  applicationError?: string;
  recoveryStatus: RecoveryStatus;
  recoveredAt?: string;
}

export interface DecisionAlternative {
  strategy: string;
  description: string;
  totalHarm: number;
  /**
   * How much worse than the chosen plan — the platform's value, quantified per decision.
   *
   * NULL when the alternative was infeasible: its harm is lower only because it degrades
   * less while failing to resolve the contention, so the comparison would be misleading.
   */
  harmPenaltyPercent: number | null;
  feasible: boolean;
  achievedReductionMbps: number;
  affectedSliceCount: number;
  rejectedBecause: string;
}

export interface ArbitrationDecision {
  id: string;
  contentionId: string;
  trigger: 'AUTOMATIC' | 'MANUAL' | 'SIMULATION' | 'REPLAY';
  outcome: ArbitrationOutcome;
  verdict: ArbitrationVerdict;
  decidedAt: string;
  decidedAtMs: number;
  offeredCapacityMbps: number;
  totalDemandMbps: number;
  requiredReductionMbps: number;
  achievedReductionMbps: number;
  shortfallMbps: number;
  allocations: DecisionAllocation[];
  degradedSliceIds: string[];
  protectedSliceIds: string[];
  exemptSliceIds: string[];
  totalHarm: number;
  /** How sure the engine is this is the RIGHT plan — not how severe the contention is. */
  confidence: number;
  confidenceBreakdown: Record<string, number>;
  alternatives: DecisionAlternative[];
  rationale: string;
  escalationReason?: string;
  policySnapshot: {
    policyId: string;
    policyName: string;
    revision: number;
    weights: Record<string, number>;
    arbitration: Record<string, number | boolean>;
  };
  administrator: string;
  administratorEmail?: string;
  overriddenBy?: string;
  overrideReason?: string;
  recoveryStatus: RecoveryStatus;
  fullyRecoveredAt?: string;
  diagnostics: Record<string, number | boolean>;
}

export interface ArbitrationPlan {
  contentionId: string;
  verdict: ArbitrationVerdict;
  requiredReductionMbps: number;
  achievedReductionMbps: number;
  shortfallMbps: number;
  allocations: DecisionAllocation[];
  totalHarm: number;
  confidence: number;
  confidenceBreakdown: Record<string, number>;
  alternatives: DecisionAlternative[];
  rationale: string;
  escalationReason?: string;
  diagnostics: Record<string, number | boolean>;
}

export interface Policy {
  id: string;
  name: string;
  description?: string;
  revision: number;
  supersedes?: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  effectiveFrom?: string;
  archivedAt?: string;
  weights: Record<string, number>;
  arbitration: {
    fairnessLambda: number;
    fairnessLookbackSeconds: number;
    slaStressGain: number;
    targetHeadroomFraction: number;
    degradationQuantum: number;
    downtimeCostReference: number;
    requireApproval: boolean;
  };
  rationale?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedPolicy {
  policyId: string;
  policyName: string;
  revision: number;
  weights: Record<string, number>;
  criticalityScore: Record<string, number>;
  complianceScore: Record<string, number>;
  customerImpactScore: Record<string, number>;
  recoveryIntoleranceScore: Record<string, number>;
  harmCurvature: Record<string, number>;
  recoveryWindowSeconds: Record<string, number>;
  complianceCeilingPercent: Record<string, number>;
  arbitration: Policy['arbitration'];
}

export interface AuditLog {
  id: string;
  action: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  occurredAt: string;
  occurredAtMs: number;
  sequence: number;
  /** Copied, not referenced — the trail stays truthful after a user is renamed or removed. */
  actor: { userId: string; email: string; role: string; displayName?: string; ip?: string };
  target?: { type: string; id: string; name?: string; departmentId?: string };
  summary: string;
  changes?: { field: string; before?: unknown; after?: unknown }[];
  correlationId: string;
  metadata?: Record<string, unknown>;
}

export interface Notification {
  id: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  broadcast: boolean;
  recipientId?: string;
  minimumRole: UserRole;
  subject?: { type: string; id: string; name?: string };
  read: boolean;
  readAt?: string;
  at: string;
  atMs: number;
  link?: string;
}

export interface Settings {
  id: string;
  organisationName: string;
  currencyCode: string;
  currencySymbol: string;
  autoArbitrationEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceReason?: string;
  dashboard: {
    pollIntervalMs: number;
    chartWindowPoints: number;
    defaultTheme: 'light' | 'dark' | 'system';
  };
  notifications: {
    dashboardEnabled: boolean;
    emailEnabled: boolean;
    slackEnabled: boolean;
    teamsEnabled: boolean;
    minimumSeverity: NotificationSeverity;
  };
  version: number;
}

export interface TelemetrySample {
  id: string;
  sliceId: string;
  sliceCode: string;
  departmentId: string;
  at: string;
  atMs: number;
  demandMbps: number;
  allocatedMbps: number;
  usedMbps: number;
  utilisation: number;
  latencyMs: number;
  jitterMs: number;
  packetLossPercent: number;
  cpuPercent: number;
  memoryPercent: number;
  activeSessions: number;
  health: HealthState;
  healthScore: number;
  source: string;
}

export interface SystemStatus {
  adapters: {
    datastore: string;
    auth: string;
    telemetry: string;
    telemetryCapabilities: {
      enforcement: boolean;
      computeMetrics: boolean;
      capacityDiscovery: boolean;
      streaming: boolean;
      nominalSampleAgeMs: number;
    };
  };
  network: { totalCapacityMbps: number; reservedCapacityMbps: number; offeredCapacityMbps: number };
  controlLoop: {
    autoArbitration: boolean;
    telemetryTickMs: number;
    snapshotAgeMs: number | null;
    telemetryHealth: { status: string; message?: string };
    openContention: string | null;
  };
  jobs: {
    name: string;
    intervalMs: number;
    runs: number;
    failures: number;
    lastDurationMs: number | null;
    lastError: string | null;
    overruns: number;
  }[];
  uptimeSeconds: number;
  version: string;
  environment: string;
}

export interface ReportOverview {
  window: { fromMs: number; toMs: number };
  headline: {
    arbitrationRuns: number;
    bandwidthFreedMbps: number;
    meanConfidence: number;
    /** The headline figure: business harm avoided versus a conventional priority sort. */
    harmAvoidedVsPrioritySortPercent: number;
  };
  outcomes: Record<string, number>;
  degradationsByDepartment: {
    departmentId: string;
    departmentName: string;
    degradationCount: number;
    totalReducedMbps: number;
  }[];
  capacity: {
    level: CapacityLevel;
    utilisation: number;
    demandRatio: number;
    oversubscribed: boolean;
    availableMbps: number;
  } | null;
  admission: {
    offeredCapacityMbps: number;
    committedFloorMbps: number;
    availableFloorMbps: number;
    committedBaselineMbps: number;
    baselineOversubscriptionRatio: number;
  };
  departments: {
    departmentId: string;
    name: string;
    criticality: DepartmentCriticality;
    complianceLevel: ComplianceLevel;
    sliceCount: number;
    allocatedMbps: number;
    degradedSliceCount: number;
    effectiveDegradationCeiling: number;
    shareOfCapacityPercent: number;
  }[];
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
