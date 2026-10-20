import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '@/config/env';
import { Collections } from '@/constants/collections';
import { ErrorCode } from '@/constants/errorCodes';
import {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
  UserRole,
} from '@/constants/enums';
import { PolicyStatus } from '@/models/policy.model';
import { createTestHarness, type SignedInUser, type TestHarness } from '../helpers/testApp';

const API = env.API_PREFIX;

const validDepartment = {
  name: 'Manufacturing Plant 3',
  criticality: DepartmentCriticality.MISSION_CRITICAL,
  businessImportance: 92,
  downtimeCostPerMinute: 8400,
  recoveryTolerance: RecoveryTolerance.LOW,
  maxAllowedDegradationPercent: 15,
  complianceLevel: ComplianceLevel.CONTRACTUAL,
  customerImpact: CustomerImpact.DIRECT,
  operationalImportance: 88,
};

describe('departments & business policies', () => {
  let harness: TestHarness;
  let app: Express;
  let admin: SignedInUser;
  let manager: SignedInUser;
  let viewer: SignedInUser;

  beforeAll(async () => {
    harness = await createTestHarness();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    await harness.reset();
    admin = await harness.signInAs(UserRole.ADMIN, 'dept-admin@corp.example');
    manager = await harness.signInAs(UserRole.MANAGER, 'dept-manager@corp.example');
    viewer = await harness.signInAs(UserRole.VIEWER, 'dept-viewer@corp.example');
  });

  /* ================================================================== */
  describe('department CRUD', () => {
    it('creates a department and derives a code from the name', async () => {
      const res = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send(validDepartment)
        .expect(201);

      expect(res.body.data.code).toBe('manufacturing-plant-3');
      expect(res.body.data.criticality).toBe(DepartmentCriticality.MISSION_CRITICAL);
      expect(res.headers.location).toBe(`/departments/${res.body.data.id}`);
    });

    it('rejects a duplicate code', async () => {
      await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send(validDepartment)
        .expect(201);

      const res = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send(validDepartment)
        .expect(409);
      expect(res.body.error.code).toBe(ErrorCode.ALREADY_EXISTS);
    });

    it('rejects unknown fields', async () => {
      await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send({ ...validDepartment, sneakyPriority: 'URLLC' })
        .expect(400);
    });

    it('rejects out-of-range scores', async () => {
      await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send({ ...validDepartment, businessImportance: 150 })
        .expect(400);
    });

    it('rejects a negative downtime cost', async () => {
      await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send({ ...validDepartment, downtimeCostPerMinute: -1 })
        .expect(400);
    });

    it('updates a department', async () => {
      const create = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send(validDepartment)
        .expect(201);

      const res = await request(app)
        .patch(`${API}/departments/${create.body.data.id}`)
        .set('Authorization', manager.auth)
        .send({ businessImportance: 70, downtimeCostPerMinute: 5000 })
        .expect(200);

      expect(res.body.data.businessImportance).toBe(70);
      expect(res.body.data.name).toBe('Manufacturing Plant 3'); // untouched
      expect(res.body.data.version).toBe(2);
    });

    it('deletes a department with no slices', async () => {
      const create = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send(validDepartment)
        .expect(201);

      await request(app)
        .delete(`${API}/departments/${create.body.data.id}`)
        .set('Authorization', admin.auth)
        .expect(204);

      await request(app)
        .get(`${API}/departments/${create.body.data.id}`)
        .set('Authorization', viewer.auth)
        .expect(404);
    });

    it('refuses to delete a department that still has slices', async () => {
      // R2 — orphaned slices would enter the arbitration snapshot with no business
      // context, leaving the engine no defensible basis on which to rank them.
      const create = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send(validDepartment)
        .expect(201);

      await harness.container.datastore.repository(Collections.SLICES).create({
        departmentId: create.body.data.id,
        name: 'attached-slice',
        allocatedMbps: 100,
        status: 'ACTIVE',
      } as never);

      const res = await request(app)
        .delete(`${API}/departments/${create.body.data.id}`)
        .set('Authorization', admin.auth)
        .expect(409);

      expect(res.body.error.code).toBe(ErrorCode.RESOURCE_IN_USE);
      expect(res.body.error.details.count).toBe(1);
    });
  });

  /* ================================================================== */
  describe('compliance ceiling (rule R1)', () => {
    it('rejects a degradation limit looser than the compliance level permits', async () => {
      // REGULATED caps degradation at 20 %.
      const res = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send({
          ...validDepartment,
          complianceLevel: ComplianceLevel.REGULATED,
          maxAllowedDegradationPercent: 60,
        })
        .expect(400);

      expect(res.body.error.details[0].field).toBe('maxAllowedDegradationPercent');
    });

    it('reports LIFE_SAFETY departments as structurally exempt', async () => {
      const res = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send({
          ...validDepartment,
          name: 'Emergency Response',
          complianceLevel: ComplianceLevel.LIFE_SAFETY,
          maxAllowedDegradationPercent: 0,
        })
        .expect(201);

      expect(res.body.data.effectiveDegradationCeiling).toBe(0);
      expect(res.body.data.structurallyExempt).toBe(true);
    });

    it('re-validates against the MERGED entity when only compliance is patched', async () => {
      // The subtle case: the patch alone looks fine, but combined with the existing
      // 15 % limit it would leave a REGULATED department above its 20 % ceiling... it
      // does not, so this must SUCCEED — and then tightening further must fail.
      const create = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send({ ...validDepartment, maxAllowedDegradationPercent: 50 })
        .expect(201);

      const res = await request(app)
        .patch(`${API}/departments/${create.body.data.id}`)
        .set('Authorization', manager.auth)
        .send({ complianceLevel: ComplianceLevel.REGULATED })
        .expect(422);

      expect(res.body.error.code).toBe(ErrorCode.POLICY_VIOLATION);
      expect(res.body.error.details.ceiling).toBe(20);
      expect(res.body.error.details.configured).toBe(50);
    });

    it('accepts a compliance tightening when the limit is lowered in the same request', async () => {
      const create = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send({ ...validDepartment, maxAllowedDegradationPercent: 50 })
        .expect(201);

      const res = await request(app)
        .patch(`${API}/departments/${create.body.data.id}`)
        .set('Authorization', manager.auth)
        .send({ complianceLevel: ComplianceLevel.REGULATED, maxAllowedDegradationPercent: 10 })
        .expect(200);

      expect(res.body.data.effectiveDegradationCeiling).toBe(10);
    });

    it('reports the effective ceiling as the tighter of the two limits', async () => {
      const res = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send({
          ...validDepartment,
          complianceLevel: ComplianceLevel.REGULATED,
          maxAllowedDegradationPercent: 5,
        })
        .expect(201);

      // Department says 5, compliance says 20 → the department's own limit wins.
      expect(res.body.data.effectiveDegradationCeiling).toBe(5);
    });
  });

  /* ================================================================== */
  describe('department authorisation', () => {
    it('lets any authenticated user read', async () => {
      await request(app).get(`${API}/departments`).set('Authorization', viewer.auth).expect(200);
    });

    it('denies creation to VIEWER', async () => {
      const res = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', viewer.auth)
        .send(validDepartment)
        .expect(403);
      expect(res.body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
    });

    it('denies deletion to MANAGER', async () => {
      const create = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send(validDepartment)
        .expect(201);

      await request(app)
        .delete(`${API}/departments/${create.body.data.id}`)
        .set('Authorization', manager.auth)
        .expect(403);
    });
  });

  /* ================================================================== */
  describe('policy lifecycle', () => {
    it('seeds a default policy when none exists', async () => {
      // P3 — a platform that refuses to arbitrate because nobody configured a policy is a
      // worse outage than one arbitrating on a documented baseline.
      const res = await request(app)
        .get(`${API}/policies/active`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.status).toBe(PolicyStatus.ACTIVE);
      expect(res.body.data.revision).toBe(1);
      const total = Object.values(res.body.data.weights as Record<string, number>).reduce(
        (a, b) => a + b,
        0,
      );
      expect(total).toBeCloseTo(1, 9);
    });

    it('exposes the fully resolved configuration the engine consumes', async () => {
      const res = await request(app)
        .get(`${API}/policies/effective`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(res.body.data.criticalityScore.MISSION_CRITICAL).toBe(100);
      expect(res.body.data.complianceCeilingPercent.LIFE_SAFETY).toBe(0);
      expect(res.body.data.harmCurvature.ZERO).toBeGreaterThan(res.body.data.harmCurvature.HIGH);
      expect(res.body.data.arbitration.fairnessLambda).toBeGreaterThan(0);
    });

    it('rejects a weight vector that does not sum to 1', async () => {
      const res = await request(app)
        .post(`${API}/policies`)
        .set('Authorization', admin.auth)
        .send({
          name: 'Broken Weights',
          weights: {
            departmentCriticality: 0.5,
            businessImportance: 0.5,
            downtimeCost: 0.5,
            compliance: 0,
            customerImpact: 0,
            operationalImportance: 0,
            recoveryIntolerance: 0,
          },
        })
        .expect(400);

      expect(res.body.error.details[0].message).toContain('sum to exactly 1.0');
    });

    it('creates a policy as DRAFT and leaves the active one governing', async () => {
      const before = await request(app)
        .get(`${API}/policies/active`)
        .set('Authorization', viewer.auth)
        .expect(200);

      const draft = await request(app)
        .post(`${API}/policies`)
        .set('Authorization', admin.auth)
        .send({ name: 'Cost-Weighted Policy' })
        .expect(201);

      expect(draft.body.data.status).toBe(PolicyStatus.DRAFT);

      const after = await request(app)
        .get(`${API}/policies/active`)
        .set('Authorization', viewer.auth)
        .expect(200);
      expect(after.body.data.id).toBe(before.body.data.id);
    });

    it('activates a draft and archives the previous active policy atomically', async () => {
      // P1 — exactly one ACTIVE policy at any moment.
      const previous = await request(app)
        .get(`${API}/policies/active`)
        .set('Authorization', viewer.auth)
        .expect(200);

      const draft = await request(app)
        .post(`${API}/policies`)
        .set('Authorization', admin.auth)
        .send({
          name: 'Compliance-First Policy',
          weights: {
            departmentCriticality: 0.2,
            businessImportance: 0.1,
            downtimeCost: 0.15,
            compliance: 0.35,
            customerImpact: 0.1,
            operationalImportance: 0.05,
            recoveryIntolerance: 0.05,
          },
        })
        .expect(201);

      await request(app)
        .post(`${API}/policies/${draft.body.data.id}/activate`)
        .set('Authorization', admin.auth)
        .send({})
        .expect(200);

      const active = await request(app)
        .get(`${API}/policies/active`)
        .set('Authorization', viewer.auth)
        .expect(200);
      expect(active.body.data.id).toBe(draft.body.data.id);
      expect(active.body.data.weights.compliance).toBe(0.35);

      const archived = await request(app)
        .get(`${API}/policies/${previous.body.data.id}`)
        .set('Authorization', viewer.auth)
        .expect(200);
      expect(archived.body.data.status).toBe(PolicyStatus.ARCHIVED);
      expect(archived.body.data.archivedAt).toBeTruthy();

      const all = await harness.container.repositories.policies.findAllActive();
      expect(all).toHaveLength(1);
    });

    it('forks a new draft when the ACTIVE policy is edited, leaving it untouched', async () => {
      // P2 — mutating an active policy would silently rewrite the justification for every
      // decision it has already governed.
      const active = await request(app)
        .get(`${API}/policies/active`)
        .set('Authorization', viewer.auth)
        .expect(200);
      const originalLambda = active.body.data.arbitration.fairnessLambda;

      const forked = await request(app)
        .patch(`${API}/policies/${active.body.data.id}`)
        .set('Authorization', admin.auth)
        .send({ arbitration: { fairnessLambda: 1.5 } })
        .expect(200);

      expect(forked.body.data.id).not.toBe(active.body.data.id);
      expect(forked.body.data.status).toBe(PolicyStatus.DRAFT);
      expect(forked.body.data.supersedes).toBe(active.body.data.id);
      expect(forked.body.data.revision).toBeGreaterThan(active.body.data.revision);
      expect(forked.body.data.arbitration.fairnessLambda).toBe(1.5);

      const unchanged = await request(app)
        .get(`${API}/policies/${active.body.data.id}`)
        .set('Authorization', viewer.auth)
        .expect(200);
      expect(unchanged.body.data.arbitration.fairnessLambda).toBe(originalLambda);
      expect(unchanged.body.data.status).toBe(PolicyStatus.ACTIVE);
    });

    it('merges a partial arbitration patch over the current settings', async () => {
      const draft = await request(app)
        .post(`${API}/policies`)
        .set('Authorization', admin.auth)
        .send({ name: 'Partial Patch Policy' })
        .expect(201);

      const before = draft.body.data.arbitration;

      const updated = await request(app)
        .patch(`${API}/policies/${draft.body.data.id}`)
        .set('Authorization', admin.auth)
        .send({ arbitration: { slaStressGain: 1.2 } })
        .expect(200);

      expect(updated.body.data.arbitration.slaStressGain).toBe(1.2);
      // Every other field must survive the partial patch.
      expect(updated.body.data.arbitration.fairnessLambda).toBe(before.fairnessLambda);
      expect(updated.body.data.arbitration.degradationQuantum).toBe(before.degradationQuantum);
    });

    it('never lets a policy loosen a compliance ceiling', async () => {
      // A tenant must not be able to configure their way out of a life-safety exemption.
      const draft = await request(app)
        .post(`${API}/policies`)
        .set('Authorization', admin.auth)
        .send({
          name: 'Dangerous Policy',
          complianceCeilingOverrides: { LIFE_SAFETY: 100, REGULATED: 90 },
        })
        .expect(201);

      await request(app)
        .post(`${API}/policies/${draft.body.data.id}/activate`)
        .set('Authorization', admin.auth)
        .send({})
        .expect(200);

      const effective = await request(app)
        .get(`${API}/policies/effective`)
        .set('Authorization', viewer.auth)
        .expect(200);

      // Overrides are clamped to the built-in defaults, which only ever tighten.
      expect(effective.body.data.complianceCeilingPercent.LIFE_SAFETY).toBe(0);
      expect(effective.body.data.complianceCeilingPercent.REGULATED).toBe(20);
    });

    it('lets a policy TIGHTEN a compliance ceiling', async () => {
      const draft = await request(app)
        .post(`${API}/policies`)
        .set('Authorization', admin.auth)
        .send({ name: 'Stricter Policy', complianceCeilingOverrides: { CONTRACTUAL: 25 } })
        .expect(201);

      await request(app)
        .post(`${API}/policies/${draft.body.data.id}/activate`)
        .set('Authorization', admin.auth)
        .send({})
        .expect(200);

      const effective = await request(app)
        .get(`${API}/policies/effective`)
        .set('Authorization', viewer.auth)
        .expect(200);

      expect(effective.body.data.complianceCeilingPercent.CONTRACTUAL).toBe(25); // was 60
    });

    it('refuses to activate an already-active policy', async () => {
      const active = await request(app)
        .get(`${API}/policies/active`)
        .set('Authorization', viewer.auth)
        .expect(200);

      await request(app)
        .post(`${API}/policies/${active.body.data.id}/activate`)
        .set('Authorization', admin.auth)
        .send({})
        .expect(400);
    });

    it('refuses to delete a non-draft policy', async () => {
      const active = await request(app)
        .get(`${API}/policies/active`)
        .set('Authorization', viewer.auth)
        .expect(200);

      await request(app)
        .delete(`${API}/policies/${active.body.data.id}`)
        .set('Authorization', admin.auth)
        .expect(400);
    });

    it('denies policy writes to MANAGER', async () => {
      // Changing the weight vector changes every future arbitration outcome enterprise-wide.
      await request(app)
        .post(`${API}/policies`)
        .set('Authorization', manager.auth)
        .send({ name: 'Manager Attempt' })
        .expect(403);
    });

    it('lets any authenticated user read the governing rules', async () => {
      // A department lead who cannot see the rules cannot challenge them.
      await request(app).get(`${API}/policies/effective`).set('Authorization', viewer.auth).expect(200);
    });
  });

  /* ================================================================== */
  describe('audit trail', () => {
    it('records department creation with the resulting configuration', async () => {
      const create = await request(app)
        .post(`${API}/departments`)
        .set('Authorization', manager.auth)
        .send(validDepartment)
        .expect(201);

      const entries = await harness.container.services.audit.timelineFor(create.body.data.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.action).toBe('DEPARTMENT_CREATED');
      expect(entries[0]!.actor.userId).toBe(manager.userId);
      expect(entries[0]!.summary).toContain('MISSION_CRITICAL');
    });

    it('records policy activation with the weights that took effect', async () => {
      const draft = await request(app)
        .post(`${API}/policies`)
        .set('Authorization', admin.auth)
        .send({ name: 'Audited Policy' })
        .expect(201);

      await request(app)
        .post(`${API}/policies/${draft.body.data.id}/activate`)
        .set('Authorization', admin.auth)
        .send({})
        .expect(200);

      const entries = await harness.container.services.audit.timelineFor(draft.body.data.id);
      const activation = entries.find((e) => e.action === 'POLICY_ACTIVATED');
      expect(activation).toBeDefined();
      expect(activation!.metadata?.weights).toBeDefined();
    });
  });
});
