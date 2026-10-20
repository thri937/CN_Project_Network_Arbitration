import { AuditAction } from '@/constants/enums';
import { DEFAULT_POLICY_WEIGHTS } from '@/constants/tunables';
import type { IClock } from '@/interfaces/clock.port';
import type { IDatastore } from '@/interfaces/repository.port';
import { diffFields } from '@/models/auditLog.model';
import {
  ArbitrationSettingsSchema,
  PolicyStatus,
  defaultPolicyDefinition,
  resolvePolicy,
  type CreatePolicyPayload,
  type Policy,
  type ResolvedPolicy,
  type UpdatePolicyPayload,
} from '@/models/policy.model';
import type { PolicyRepository } from '@/repositories/policy.repository';
import type { ActorContext, Page } from '@/types/common';
import { InvalidStateTransitionError, PolicyViolationError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import type { AuditService } from './audit.service';

const log = createLogger('policy-service');

/**
 * Business policy lifecycle.
 *
 * INVARIANTS
 * ==========
 *   P1. Exactly one policy is ACTIVE. Enforced transactionally in `activate()`.
 *   P2. An ACTIVE policy is never mutated. `update()` on an active policy creates a new
 *       revision and archives the current one, so the weights that justified a past
 *       decision remain readable forever.
 *   P3. There is always SOME governing policy. If a deployment has none, the built-in
 *       default is seeded on first read rather than failing — a platform that refuses to
 *       arbitrate because nobody configured a policy is a worse outage than one that
 *       arbitrates on a documented, auditable baseline.
 *
 * CACHING
 * =======
 * The resolved active policy is cached in memory. It is read on every arbitration run
 * (every few seconds) and changes at most a few times a year. The cache is invalidated
 * explicitly on any mutation through this service, and carries a TTL so a multi-instance
 * deployment converges within `CACHE_TTL_MS` even when the change was made on another node.
 */
export class PolicyService {
  private cache: { resolved: ResolvedPolicy; loadedAtMs: number } | null = null;

  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly policies: PolicyRepository,
    private readonly datastore: IDatastore,
    private readonly audit: AuditService,
    private readonly clock: IClock,
  ) {}

  /**
   * The resolved policy governing arbitration right now.
   *
   * Every caller in the domain layer goes through here, so there is exactly one definition
   * of "the current rules" and it cannot drift between the scoring engine, the arbitration
   * engine and the explanation shown to an operator.
   */
  async getActiveResolved(): Promise<ResolvedPolicy> {
    const now = this.clock.now();
    if (this.cache && now - this.cache.loadedAtMs < PolicyService.CACHE_TTL_MS) {
      return this.cache.resolved;
    }

    const active = (await this.policies.findActive()) ?? (await this.seedDefault());
    const resolved = resolvePolicy(active);
    this.cache = { resolved, loadedAtMs: now };
    return resolved;
  }

  async getActive(): Promise<Policy> {
    return (await this.policies.findActive()) ?? (await this.seedDefault());
  }

  invalidateCache(): void {
    this.cache = null;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /** Create a DRAFT policy. Drafts govern nothing until explicitly activated. */
  async create(payload: CreatePolicyPayload, actor: ActorContext): Promise<Policy> {
    const revision = (await this.policies.highestRevision()) + 1;

    const created = await this.policies.base.create(
      {
        name: payload.name,
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        revision,
        status: PolicyStatus.DRAFT,
        weights: payload.weights ?? { ...DEFAULT_POLICY_WEIGHTS },
        scoreOverrides: payload.scoreOverrides ?? {},
        ...(payload.complianceCeilingOverrides
          ? { complianceCeilingOverrides: payload.complianceCeilingOverrides }
          : {}),
        arbitration: ArbitrationSettingsSchema.parse(payload.arbitration ?? {}),
        ...(payload.rationale !== undefined ? { rationale: payload.rationale } : {}),
      },
      { actor },
    );

    await this.audit.record({
      action: AuditAction.POLICY_CREATED,
      actor,
      summary: `Policy '${created.name}' created as revision ${revision} (DRAFT)`,
      target: { type: 'Policy', id: created.id, name: created.name },
      changes: diffFields({}, payload as Record<string, unknown>),
    });

    log.info({ policyId: created.id, revision }, 'policy draft created');
    return created;
  }

  /**
   * Update a policy.
   *
   * P2: a DRAFT is edited in place; an ACTIVE policy is never touched. Editing an active
   * policy forks a new DRAFT revision that records what it supersedes, leaving the current
   * rules in force until someone deliberately activates the successor.
   */
  async update(id: string, payload: UpdatePolicyPayload, actor: ActorContext): Promise<Policy> {
    const current = await this.policies.base.getById(id);

    if (current.status === PolicyStatus.ARCHIVED) {
      throw new InvalidStateTransitionError('Policy', PolicyStatus.ARCHIVED, 'edited');
    }

    if (current.status === PolicyStatus.ACTIVE) {
      const fork = await this.forkRevision(current, payload, actor);
      log.info(
        { from: current.id, to: fork.id, revision: fork.revision },
        'active policy edited; forked a new draft revision',
      );
      return fork;
    }

    // `arbitration` arrives as a PARTIAL override and must be merged over the current
    // settings and re-parsed, so every field is present and within bounds before it is
    // persisted. Destructuring it out first prevents the partial from leaking through the
    // spread into a field typed as complete.
    const { arbitration: arbitrationPatch, ...rest } = payload;

    const updated = await this.policies.base.update(
      id,
      {
        ...rest,
        ...(arbitrationPatch
          ? {
              arbitration: ArbitrationSettingsSchema.parse({
                ...current.arbitration,
                ...arbitrationPatch,
              }),
            }
          : {}),
      },
      { actor, expectedVersion: current.version },
    );

    await this.audit.record({
      action: AuditAction.POLICY_UPDATED,
      actor,
      summary: `Draft policy '${updated.name}' (revision ${updated.revision}) updated`,
      target: { type: 'Policy', id, name: updated.name },
      changes: diffFields(
        current as unknown as Record<string, unknown>,
        payload as Record<string, unknown>,
      ),
    });

    this.invalidateCache();
    return updated;
  }

  private async forkRevision(
    source: Policy,
    payload: UpdatePolicyPayload,
    actor: ActorContext,
  ): Promise<Policy> {
    const revision = (await this.policies.highestRevision()) + 1;

    return this.policies.base.create(
      {
        name: payload.name ?? source.name,
        ...(payload.description ?? source.description
          ? { description: payload.description ?? source.description }
          : {}),
        revision,
        supersedes: source.id,
        status: PolicyStatus.DRAFT,
        weights: payload.weights ?? source.weights,
        scoreOverrides: payload.scoreOverrides ?? source.scoreOverrides,
        ...(payload.complianceCeilingOverrides ?? source.complianceCeilingOverrides
          ? {
              complianceCeilingOverrides:
                payload.complianceCeilingOverrides ?? source.complianceCeilingOverrides,
            }
          : {}),
        arbitration: ArbitrationSettingsSchema.parse({
          ...source.arbitration,
          ...(payload.arbitration ?? {}),
        }),
        ...(payload.rationale ?? source.rationale
          ? { rationale: payload.rationale ?? source.rationale }
          : {}),
      },
      { actor },
    );
  }

  /**
   * Activate a policy, atomically archiving whatever was active before.
   *
   * P1 depends on this being one transaction: two administrators activating different
   * drafts concurrently must not both succeed and leave two ACTIVE policies, because the
   * engine would then silently pick whichever the datastore returned first.
   */
  async activate(id: string, actor: ActorContext): Promise<Policy> {
    const activated = await this.datastore.runTransaction(async (tx) => {
      // --- reads first ---
      const target = await this.policies.base.getById(id, { tx });

      if (target.status === PolicyStatus.ACTIVE) {
        throw new InvalidStateTransitionError('Policy', PolicyStatus.ACTIVE, PolicyStatus.ACTIVE);
      }
      if (target.status === PolicyStatus.ARCHIVED) {
        throw new InvalidStateTransitionError('Policy', PolicyStatus.ARCHIVED, PolicyStatus.ACTIVE);
      }

      assertWeightsSumToOne(target);

      const currentlyActive = await this.policies.findAllActive({ tx });
      const now = this.clock.nowIso();

      // --- writes ---
      // `applyUpdate` (write-only) rather than `update` (read-modify-write): every entity
      // was already loaded above, and a second read at this point would violate the
      // reads-before-writes rule that both datastore drivers enforce.
      for (const policy of currentlyActive) {
        if (policy.id === id) continue;
        await this.policies.base.applyUpdate(
          policy,
          { status: PolicyStatus.ARCHIVED, archivedAt: now },
          { tx, actor, expectedVersion: policy.version },
        );
      }

      return this.policies.base.applyUpdate(
        target,
        { status: PolicyStatus.ACTIVE, effectiveFrom: now },
        { tx, actor, expectedVersion: target.version },
      );
    }, `policy.activate:${id}`);

    this.invalidateCache();

    await this.audit.record({
      action: AuditAction.POLICY_ACTIVATED,
      actor,
      summary: `Policy '${activated.name}' revision ${activated.revision} is now governing arbitration`,
      target: { type: 'Policy', id, name: activated.name },
      metadata: { weights: activated.weights, arbitration: activated.arbitration },
    });

    log.warn(
      { policyId: id, revision: activated.revision, weights: activated.weights },
      'ACTIVE ARBITRATION POLICY CHANGED',
    );
    return activated;
  }

  async getById(id: string): Promise<Policy> {
    return this.policies.base.getById(id);
  }

  async list(
    status: PolicyStatus | undefined,
    page: { limit: number; cursor?: string },
  ): Promise<Page<Policy>> {
    return this.policies.listByStatus(status, page);
  }

  /** Delete a DRAFT. Active and archived revisions are permanent by design. */
  async deleteDraft(id: string, actor: ActorContext): Promise<void> {
    const policy = await this.policies.base.getById(id);
    if (policy.status !== PolicyStatus.DRAFT) {
      throw new InvalidStateTransitionError('Policy', policy.status, 'deleted');
    }

    await this.policies.base.delete(id, { expectedVersion: policy.version });

    await this.audit.record({
      action: AuditAction.POLICY_UPDATED,
      actor,
      summary: `Draft policy '${policy.name}' (revision ${policy.revision}) deleted`,
      target: { type: 'Policy', id, name: policy.name },
    });
  }

  /**
   * Show the caller exactly what the engine will use, including which values came from
   * the policy and which fell back to the built-in defaults. Powers the "Effective
   * Configuration" panel on the Business Policies screen.
   */
  async explainActive(): Promise<ResolvedPolicy> {
    return this.getActiveResolved();
  }

  /* ------------------------------------------------------------------ */

  private async seedDefault(): Promise<Policy> {
    // Guarded against the race where several instances boot simultaneously: the create is
    // performed inside a transaction that first re-checks for an active policy.
    return this.datastore.runTransaction(async (tx) => {
      const existing = await this.policies.findActive({ tx });
      if (existing) return existing;

      const seeded = await this.policies.base.create(defaultPolicyDefinition(), { tx });
      log.warn({ policyId: seeded.id }, 'no policy configured; seeded the built-in default');
      return seeded;
    }, 'policy.seedDefault');
  }
}

function assertWeightsSumToOne(policy: Policy): void {
  const total = Object.values(policy.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-6) {
    throw new PolicyViolationError(
      `Policy weights must sum to 1.0; revision ${policy.revision} sums to ${total.toFixed(6)}`,
      { policyId: policy.id, total },
    );
  }
}
