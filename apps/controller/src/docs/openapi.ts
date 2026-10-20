import { env, OFFERED_CAPACITY_MBPS } from '@/config/env';

/**
 * OpenAPI 3.1 specification.
 *
 * Hand-written rather than generated from decorators. The trade-off was considered: a
 * decorator-driven generator keeps the spec mechanically in sync with the code, at the cost
 * of littering controllers with metadata and producing documentation that describes shapes
 * without explaining decisions.
 *
 * For this system the explanation IS the product. An integrator needs to know that
 * `businessScore` is not a QoS priority, that `maxDegradationPercent` is a hard constraint
 * rather than a hint, and why reads on `/arbitration` are open to every authenticated user.
 * None of that survives generation.
 *
 * The schemas below are kept honest by the integration tests, which exercise every endpoint
 * documented here.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Runtime Arbitration for Contended, SLA-Critical Enterprise Network Slices',
      version: '1.0.0',
      description: [
        'A department-aware, auditable alternative to generic priority-based degradation.',
        '',
        '## What this API is for',
        '',
        'When demand for network capacity exceeds supply, something must give. Conventional',
        'slice controllers decide using network QoS attributes — 5QI, slice/service type,',
        'a static priority integer. That answers a business question with a network answer,',
        'and produces outcomes like throttling a cardiology telemetry slice because it was',
        'provisioned as eMBB while a digital-signage slice happened to be URLLC.',
        '',
        'This platform decides using **business policy**: department criticality, measured',
        'downtime cost, compliance obligations, customer impact, recovery tolerance, and',
        'historical fairness. Every decision is explainable, reversible and permanently',
        'recorded.',
        '',
        '## The algorithm',
        '',
        'Arbitration solves a constrained convex optimisation (CBHA — Convex Business-Harm',
        'Arbitration), not a sort. Per-slice harm rises superlinearly with degradation depth,',
        'with the exponent derived from the department\'s recovery tolerance, so the optimiser',
        'spreads shallow cuts across several slices rather than gutting one. It is solved by',
        'water-filling on marginal harm, which for a separable convex objective converges to',
        'the KKT-optimal allocation.',
        '',
        'Compliance ceilings are **constraints, not weights** — a LIFE_SAFETY slice is removed',
        'from the candidate set entirely and no amount of harm avoided elsewhere can override',
        'that.',
        '',
        '## Authentication',
        '',
        'Obtain a session by posting a Firebase ID token to `POST /auth/session`. Use the',
        'returned `accessToken` as a bearer credential. Refresh with `POST /auth/refresh`.',
        '',
        '## Roles',
        '',
        '| Role | Capability |',
        '|---|---|',
        '| `VIEWER` | Read everything, including the justification for any decision |',
        '| `MANAGER` | Operate the network: slices, departments, manual arbitration |',
        '| `ADMIN` | Everything, plus users, policy and decision overrides |',
        '',
        'Decision **reads are open to every authenticated user by design**. A department head',
        'must be able to read the record that degraded their slice, including the rejected',
        'alternatives. A platform whose justifications are visible only to its operators is',
        'not auditable in any useful sense.',
      ].join('\n'),
      contact: { name: 'Platform Engineering' },
      license: { name: 'Proprietary' },
    },

    servers: [
      { url: env.API_PREFIX, description: 'Current deployment' },
      { url: `http://localhost:${env.PORT}${env.API_PREFIX}`, description: 'Local development' },
    ],

    tags: [
      { name: 'Authentication', description: 'Session issue, refresh and sign-out' },
      { name: 'Users', description: 'User directory and role management (ADMIN)' },
      {
        name: 'Departments',
        description:
          'Business units and their arbitration attributes. These fields — and only these — ' +
          'determine which slices are degraded during contention.',
      },
      {
        name: 'Policies',
        description:
          'Governance: the weight vector and tuning that turn department attributes into a ' +
          'Business Priority Score. Versioned and immutable once active.',
      },
      { name: 'Slices', description: 'Network slice lifecycle and admission control' },
      { name: 'Telemetry', description: 'Live and historical network metrics' },
      { name: 'Capacity', description: 'Network-wide capacity measurement and trend' },
      { name: 'Contention', description: 'Detected contention events and their lifecycle' },
      { name: 'Arbitration', description: 'Decisions, simulation, and administrator override' },
      { name: 'Audit', description: 'Immutable audit trail (ADMIN, read-only)' },
      { name: 'Notifications', description: 'Operator notifications' },
      { name: 'Operations', description: 'Health and readiness probes' },
    ],

    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Backend-issued session token from `POST /auth/session`. Not the Firebase ID token.',
        },
      },

      schemas: {
        ApiSuccess: {
          type: 'object',
          required: ['success', 'data'],
          properties: {
            success: { type: 'boolean', const: true },
            data: {},
            meta: { $ref: '#/components/schemas/ResponseMeta' },
          },
        },

        ResponseMeta: {
          type: 'object',
          properties: {
            correlationId: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
            durationMs: { type: 'integer' },
            page: {
              type: 'object',
              properties: {
                limit: { type: 'integer' },
                returned: { type: 'integer' },
                nextCursor: { type: ['string', 'null'] },
                total: { type: 'integer' },
              },
            },
          },
        },

        ApiError: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { type: 'boolean', const: false },
            error: {
              type: 'object',
              required: ['code', 'message', 'correlationId', 'timestamp'],
              properties: {
                code: {
                  type: 'string',
                  description:
                    'Stable machine-readable code. Branch on this, never on `message`.',
                  examples: ['VALIDATION_FAILED', 'INSUFFICIENT_ROLE', 'CAPACITY_EXCEEDED'],
                },
                message: { type: 'string' },
                details: {},
                correlationId: { type: 'string' },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
          },
        },

        Department: {
          type: 'object',
          description:
            'A business unit. Its attributes are the ONLY inputs to arbitration ranking — ' +
            'no network QoS attribute is consulted.',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            code: { type: 'string', description: 'Immutable machine key' },
            criticality: {
              type: 'string',
              enum: [
                'MISSION_CRITICAL',
                'BUSINESS_CRITICAL',
                'BUSINESS_OPERATIONAL',
                'ADMINISTRATIVE',
                'BEST_EFFORT',
              ],
            },
            businessImportance: { type: 'number', minimum: 0, maximum: 100 },
            downtimeCostPerMinute: {
              type: 'number',
              minimum: 0,
              description:
                'Currency per minute of full outage. Normalised LOGARITHMICALLY before ' +
                'scoring, so one extreme figure cannot saturate the weight vector.',
            },
            recoveryTolerance: { type: 'string', enum: ['ZERO', 'LOW', 'MODERATE', 'HIGH'] },
            maxAllowedDegradationPercent: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              description:
                'HARD CONSTRAINT, not a hint. Arbitration may never exceed it, and it is ' +
                'further clamped by the compliance ceiling.',
            },
            complianceLevel: {
              type: 'string',
              enum: ['NONE', 'INTERNAL', 'CONTRACTUAL', 'REGULATED', 'LIFE_SAFETY'],
              description:
                'Imposes a hard degradation ceiling: LIFE_SAFETY = 0 %, REGULATED = 20 %, ' +
                'CONTRACTUAL = 60 %. A policy may tighten these, never loosen them.',
            },
            customerImpact: {
              type: 'string',
              enum: ['NONE', 'INTERNAL_ONLY', 'INDIRECT', 'DIRECT', 'SEVERE_EXTERNAL'],
            },
            operationalImportance: { type: 'number', minimum: 0, maximum: 100 },
            policyWeightMultiplier: { type: 'number', minimum: 0.5, maximum: 2 },
            effectiveDegradationCeiling: {
              type: 'number',
              readOnly: true,
              description: 'Derived: the tighter of the department limit and the compliance ceiling.',
            },
            structurallyExempt: { type: 'boolean', readOnly: true },
          },
        },

        Slice: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            code: { type: 'string' },
            departmentId: { type: 'string' },
            snssai: {
              type: 'object',
              description: '3GPP TS 23.501 S-NSSAI. Carried for core interoperability ONLY.',
              properties: {
                sst: { type: 'integer', minimum: 0, maximum: 255 },
                sd: { type: 'string', pattern: '^[0-9A-Fa-f]{6}$' },
              },
            },
            profile: {
              type: 'string',
              enum: ['EMBB', 'URLLC', 'MMTC', 'V2X'],
              description:
                'Recorded for reporting and core interoperability. NEVER read by the ' +
                'arbitration engine — it is not present in the engine input type.',
            },
            baselineAllocatedMbps: {
              type: 'number',
              description: 'Entitlement when uncontended. Degradation never writes here.',
            },
            allocatedMbps: { type: 'number', description: 'Current grant.' },
            minGuaranteedMbps: { type: 'number', description: 'Contractual floor. Never crossed.' },
            maxBurstMbps: { type: 'number' },
            status: {
              type: 'string',
              enum: ['PROVISIONING', 'ACTIVE', 'DEGRADED', 'RECOVERING', 'PAUSED', 'TERMINATED'],
            },
            health: { type: 'string', enum: ['HEALTHY', 'WARNING', 'DEGRADED', 'CRITICAL', 'UNKNOWN'] },
            healthScore: { type: 'number', minimum: 0, maximum: 100 },
          },
        },

        ArbitrationDecision: {
          type: 'object',
          description:
            'A permanent, SELF-CONTAINED account of one decision. Everything needed to ' +
            'explain it is denormalised here, so it remains readable after the policy has ' +
            'been revised and the slices deleted.',
          properties: {
            id: { type: 'string' },
            contentionId: { type: 'string' },
            trigger: { type: 'string', enum: ['AUTOMATIC', 'MANUAL', 'SIMULATION', 'REPLAY'] },
            outcome: { type: 'string', enum: ['RESOLVED', 'PARTIAL', 'ESCALATED', 'ABORTED'] },
            verdict: { type: 'string', enum: ['FEASIBLE', 'PARTIAL', 'INFEASIBLE', 'NOT_REQUIRED'] },
            requiredReductionMbps: { type: 'number' },
            achievedReductionMbps: { type: 'number' },
            totalHarm: { type: 'number', description: 'Total business harm in engine units.' },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description:
                'How sure the engine is that this is the right plan — NOT how severe the ' +
                'contention is. Components: harm margin over the runner-up, telemetry ' +
                'freshness, data completeness, constraint slack.',
            },
            rationale: { type: 'string', description: 'Prose account of the whole decision.' },
            allocations: { type: 'array', items: { $ref: '#/components/schemas/DecisionAllocation' } },
            alternatives: {
              type: 'array',
              description:
                'Counterfactual strategies evaluated and rejected, priced on the same harm ' +
                'scale. Always includes PRIORITY_SORT — what a conventional QoS controller ' +
                'would have done — so the platform\'s value is quantified on every decision.',
              items: { $ref: '#/components/schemas/DecisionAlternative' },
            },
            policySnapshot: {
              type: 'object',
              description: 'The governing policy AS IT STOOD. Snapshotted, not referenced.',
            },
          },
        },

        DecisionAllocation: {
          type: 'object',
          properties: {
            sliceId: { type: 'string' },
            sliceName: { type: 'string' },
            departmentName: { type: 'string' },
            disposition: {
              type: 'string',
              enum: ['PROTECTED', 'DEGRADED', 'UNAFFECTED', 'EXEMPT'],
              description:
                'EXEMPT means a hard constraint removed the slice from consideration. ' +
                'UNAFFECTED means it was eligible but cheaper harm existed elsewhere.',
            },
            previousAllocationMbps: { type: 'number' },
            newAllocationMbps: { type: 'number' },
            degradationPercent: { type: 'number' },
            businessScore: { type: 'number', minimum: 0, maximum: 100 },
            durationSeconds: { type: 'integer' },
            reason: { type: 'string', description: 'Written for the affected department, not for logs.' },
            factors: {
              type: 'object',
              description: 'The multipliers behind the choice, for the drill-down view.',
              properties: {
                businessScore: { type: 'number' },
                harmCurvature: { type: 'number' },
                slaStress: { type: 'number' },
                fairnessMultiplier: { type: 'number' },
                recoveryUrgency: { type: 'number' },
                intoleranceScale: { type: 'number' },
              },
            },
          },
        },

        DecisionAlternative: {
          type: 'object',
          properties: {
            strategy: {
              type: 'string',
              enum: ['PRIORITY_SORT', 'UNIFORM_CUT', 'SINGLE_VICTIM', 'PROTECT_STRESSED'],
            },
            description: { type: 'string' },
            totalHarm: { type: 'number' },
            harmPenaltyPercent: { type: 'number', description: 'How much worse than the chosen plan.' },
            feasible: { type: 'boolean' },
            rejectedBecause: { type: 'string' },
          },
        },

        NetworkSnapshot: {
          type: 'object',
          description: 'The live view the control loop acts on. Held in memory, not queried.',
          properties: {
            atMs: { type: 'integer' },
            tick: { type: 'integer' },
            totalDemandMbps: {
              type: 'number',
              description:
                'What slices are ASKING for. Unbounded, and the only signal that shows how ' +
                'oversubscribed the network is — utilisation saturates at 1.0 and cannot.',
            },
            totalAllocatedMbps: { type: 'number' },
            totalUsedMbps: { type: 'number' },
            offeredCapacityMbps: { type: 'number', examples: [OFFERED_CAPACITY_MBPS] },
            slices: { type: 'array', items: { type: 'object' } },
          },
        },
      },

      responses: {
        Unauthorized: {
          description: 'Missing, malformed or expired session token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Forbidden: {
          description: 'Authenticated, but the role is insufficient',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        NotFound: {
          description: 'Resource does not exist',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        ValidationError: {
          description: 'Request failed schema validation',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },

      parameters: {
        limit: {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
        cursor: {
          name: 'cursor',
          in: 'query',
          description:
            'Opaque cursor from the previous page. Offset pagination is deliberately not ' +
            'offered: it is unstable against a collection receiving telemetry writes every ' +
            'two seconds, and Firestore bills for skipped documents.',
          schema: { type: 'string' },
        },
        id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      },
    },

    security: [{ bearerAuth: [] }],

    paths: buildPaths(),
  };
}

/* ------------------------------------------------------------------ */

function ok(description: string, schemaRef?: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': {
        schema: schemaRef
          ? {
              allOf: [
                { $ref: '#/components/schemas/ApiSuccess' },
                { type: 'object', properties: { data: { $ref: schemaRef } } },
              ],
            }
          : { $ref: '#/components/schemas/ApiSuccess' },
      },
    },
  };
}

function okArray(description: string, schemaRef: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          allOf: [
            { $ref: '#/components/schemas/ApiSuccess' },
            { type: 'object', properties: { data: { type: 'array', items: { $ref: schemaRef } } } },
          ],
        },
      },
    },
  };
}

const AUTH_ERRORS = {
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
};

function buildPaths(): Record<string, unknown> {
  return {
    '/auth/session': {
      post: {
        tags: ['Authentication'],
        summary: 'Exchange a provider ID token for a platform session',
        description:
          'The backend never sees a password. The client authenticates against Firebase and ' +
          'posts the resulting ID token here. The role attached to the returned session comes ' +
          'from OUR datastore, never from the provider token — an IdP compromise cannot mint ' +
          'an administrator.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['idToken'],
                properties: { idToken: { type: 'string', minLength: 16, maxLength: 4096 } },
              },
            },
          },
        },
        responses: {
          200: ok('Session issued'),
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/auth/refresh': {
      post: {
        tags: ['Authentication'],
        summary: 'Exchange a refresh token for a new access token',
        description:
          'The user record is re-read on every refresh, which bounds how long a revoked role ' +
          'can survive in an issued token.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refreshToken'],
                properties: { refreshToken: { type: 'string' } },
              },
            },
          },
        },
        responses: { 200: ok('New session issued'), 401: { $ref: '#/components/responses/Unauthorized' } },
      },
    },

    '/auth/me': {
      get: {
        tags: ['Authentication'],
        summary: "The caller's authoritative profile",
        responses: { 200: ok('Current user'), ...AUTH_ERRORS },
      },
    },

    '/departments': {
      get: {
        tags: ['Departments'],
        summary: 'List departments',
        parameters: [
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/cursor' },
        ],
        responses: { 200: okArray('Departments', '#/components/schemas/Department'), ...AUTH_ERRORS },
      },
      post: {
        tags: ['Departments'],
        summary: 'Create a department (MANAGER)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Department' } } },
        },
        responses: {
          201: ok('Created', '#/components/schemas/Department'),
          400: { $ref: '#/components/responses/ValidationError' },
          ...AUTH_ERRORS,
        },
      },
    },

    '/departments/{id}': {
      get: {
        tags: ['Departments'],
        summary: 'Fetch a department',
        parameters: [{ $ref: '#/components/parameters/id' }],
        responses: {
          200: ok('Department', '#/components/schemas/Department'),
          404: { $ref: '#/components/responses/NotFound' },
          ...AUTH_ERRORS,
        },
      },
      patch: {
        tags: ['Departments'],
        summary: 'Update a department (MANAGER)',
        description:
          'Re-validates the compliance ceiling against the MERGED entity, so a patch that ' +
          'only tightens `complianceLevel` cannot strand an existing degradation limit above ' +
          'the new ceiling.',
        parameters: [{ $ref: '#/components/parameters/id' }],
        responses: {
          200: ok('Updated', '#/components/schemas/Department'),
          422: { description: 'Compliance ceiling violated' },
          ...AUTH_ERRORS,
        },
      },
      delete: {
        tags: ['Departments'],
        summary: 'Delete a department (ADMIN)',
        description: 'Refused while slices still reference it — orphans have no business context.',
        parameters: [{ $ref: '#/components/parameters/id' }],
        responses: { 204: { description: 'Deleted' }, 409: { description: 'Slices still attached' }, ...AUTH_ERRORS },
      },
    },

    '/slices': {
      get: {
        tags: ['Slices'],
        summary: 'List slices',
        parameters: [
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/cursor' },
        ],
        responses: { 200: okArray('Slices', '#/components/schemas/Slice'), ...AUTH_ERRORS },
      },
      post: {
        tags: ['Slices'],
        summary: 'Create a slice (MANAGER)',
        description:
          'ADMISSION CONTROL: the sum of `minGuaranteedMbps` across arbitrable slices may ' +
          'never exceed offered capacity. If it did, arbitration would be infeasible by ' +
          'construction — every slice already at its floor with the network still ' +
          'oversubscribed. Baseline oversubscription is permitted and expected; it is the ' +
          'condition this platform manages.',
        responses: {
          201: ok('Created', '#/components/schemas/Slice'),
          422: { description: 'CAPACITY_EXCEEDED — guaranteed minimums would exceed capacity' },
          ...AUTH_ERRORS,
        },
      },
    },

    '/slices/headroom': {
      get: {
        tags: ['Slices'],
        summary: 'Admission-control headroom',
        responses: { 200: ok('Headroom'), ...AUTH_ERRORS },
      },
    },

    '/slices/{id}/pause': {
      post: {
        tags: ['Slices'],
        summary: 'Pause a slice (MANAGER)',
        description:
          'Releases its capacity and removes it from arbitration. Clears any active ' +
          'degradation, since a paused slice consumes nothing.',
        parameters: [{ $ref: '#/components/parameters/id' }],
        responses: { 200: ok('Paused', '#/components/schemas/Slice'), ...AUTH_ERRORS },
      },
    },

    '/slices/{id}/resume': {
      post: {
        tags: ['Slices'],
        summary: 'Resume a paused slice (MANAGER)',
        description: 'Re-admitted against current capacity, so resuming can legitimately fail.',
        parameters: [{ $ref: '#/components/parameters/id' }],
        responses: { 200: ok('Resumed', '#/components/schemas/Slice'), ...AUTH_ERRORS },
      },
    },

    '/telemetry/live': {
      get: {
        tags: ['Telemetry'],
        summary: 'The live snapshot the control loop is acting on',
        description:
          'Returns the IN-MEMORY snapshot, not a datastore query — an operator must see ' +
          'exactly what the arbitration engine sees. `snapshotAgeMs` and `stale` make ' +
          'staleness visible rather than something to infer.',
        responses: { 200: ok('Live snapshot'), ...AUTH_ERRORS },
      },
    },

    '/telemetry/faults': {
      post: {
        tags: ['Telemetry'],
        summary: 'Inject a fault (MANAGER, synthetic provider only)',
        description:
          'Drives the modelled network into contention on demand. Returns 501 when a live ' +
          'telemetry provider is active — against a real network the equivalent is a traffic ' +
          'generator.',
        responses: { 200: ok('Fault injected'), 501: { description: 'Not available for this provider' }, ...AUTH_ERRORS },
      },
    },

    '/capacity': {
      get: {
        tags: ['Capacity'],
        summary: 'Live network capacity',
        description:
          'Reports THREE distinct ratios. `utilisation` saturates at 1.0 and cannot show how ' +
          'oversubscribed the network is; `demandRatio` is unbounded and can. A UI showing ' +
          'only utilisation cannot distinguish "full" from "300 % oversubscribed".',
        responses: { 200: ok('Capacity state'), ...AUTH_ERRORS },
      },
    },

    '/contention/current': {
      get: {
        tags: ['Contention'],
        summary: 'The open contention event, if any',
        description:
          'Includes the arbitration gate and detector tuning, so "why has this not triggered ' +
          'arbitration yet?" is answerable from the UI rather than the source.',
        responses: { 200: ok('Open contention'), ...AUTH_ERRORS },
      },
    },

    '/arbitration': {
      get: {
        tags: ['Arbitration'],
        summary: 'Decision history',
        parameters: [
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/cursor' },
        ],
        responses: {
          200: okArray('Decisions', '#/components/schemas/ArbitrationDecision'),
          ...AUTH_ERRORS,
        },
      },
    },

    '/arbitration/simulate': {
      post: {
        tags: ['Arbitration'],
        summary: 'Compute a plan WITHOUT applying it (MANAGER)',
        description:
          'Lets an operator see exactly what the engine would do before authorising it. An ' +
          'automated control loop nobody can interrogate is one that gets switched off after ' +
          'its first surprising decision.',
        responses: { 200: ok('Plan (not applied)'), ...AUTH_ERRORS },
      },
    },

    '/arbitration/trigger': {
      post: {
        tags: ['Arbitration'],
        summary: 'Run arbitration now (MANAGER)',
        description:
          'Bypasses the automatic cadence but NOT the safety gates — the cooldown and ' +
          'in-flight checks still apply. A human clicking twice must not compound ' +
          'degradations any more than a runaway scheduler may.',
        responses: {
          200: ok('Decision applied'),
          409: { description: 'No open contention, or a gate is active' },
          ...AUTH_ERRORS,
        },
      },
    },

    '/arbitration/{id}': {
      get: {
        tags: ['Arbitration'],
        summary: 'Full decision record',
        description:
          'Open to every authenticated user. A department head must be able to read the ' +
          'record that degraded their slice, including the rejected alternatives.',
        parameters: [{ $ref: '#/components/parameters/id' }],
        responses: {
          200: ok('Decision', '#/components/schemas/ArbitrationDecision'),
          404: { $ref: '#/components/responses/NotFound' },
          ...AUTH_ERRORS,
        },
      },
    },

    '/arbitration/{id}/override': {
      post: {
        tags: ['Arbitration'],
        summary: 'Override a decision (ADMIN)',
        description:
          'Requires a substantive reason (≥ 10 characters), enforced by schema rather than ' +
          'convention. An override with no recorded justification is precisely the ' +
          'unaccountable intervention this platform exists to eliminate.',
        parameters: [{ $ref: '#/components/parameters/id' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reason'],
                properties: {
                  reason: { type: 'string', minLength: 10, maxLength: 2000 },
                  restoreAll: { type: 'boolean', default: true },
                },
              },
            },
          },
        },
        responses: { 200: ok('Overridden'), 400: { $ref: '#/components/responses/ValidationError' }, ...AUTH_ERRORS },
      },
    },

    '/audit': {
      get: {
        tags: ['Audit'],
        summary: 'Audit log (ADMIN)',
        description:
          'READ-ONLY BY CONSTRUCTION. There is no mutating route here and there never will ' +
          'be — not even for an administrator. Immutability is enforced in three independent ' +
          'places: no route, no mutating service method, and a hard deny in the Firestore ' +
          'security rules.',
        parameters: [
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/cursor' },
        ],
        responses: { 200: ok('Audit entries'), ...AUTH_ERRORS },
      },
    },

    '/notifications': {
      get: {
        tags: ['Notifications'],
        summary: "The caller's notifications and visible broadcasts",
        responses: { 200: ok('Notifications'), ...AUTH_ERRORS },
      },
    },

    '/health/ready': {
      get: {
        tags: ['Operations'],
        summary: 'Readiness probe',
        description:
          'Aggregates every registered dependency. `degraded` still serves traffic — an ' +
          'orchestrator must not restart it. `down` returns 503 and withholds traffic. An ' +
          'open contention reports `degraded`: it is a network condition, not a platform ' +
          'fault, and pulling the instance from rotation would be exactly wrong.',
        security: [],
        responses: { 200: ok('Ready or degraded'), 503: { description: 'Not ready' } },
      },
    },
  };
}
