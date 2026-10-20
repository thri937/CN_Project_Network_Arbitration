import {
  ComplianceLevel,
  CustomerImpact,
  DepartmentCriticality,
  RecoveryTolerance,
  SliceProfile,
} from '@/constants/enums';
import type { CreateDepartmentPayload } from '@/models/department.model';
import type { CreateSlicePayload, Slice } from '@/models/slice.model';

/**
 * THE 7-DEPARTMENT / 7-SLICE TESTBED
 * ==================================
 * One definition, used by the seed and by `npm run demo:local`, so the demo runs exactly the
 * slices, floors and SLA targets a real hotspot session runs.
 *
 * Bandwidth is SOURCE's value in Mbps × s, where s = total capacity (kbps) / 10,000. At 1 Mbps,
 * s = 0.1 and 600 Mbps becomes 60 kbps. Latency/jitter/loss targets are re-baselined for Wi-Fi
 * (docs/TESTBED.md §3); throughput targets scale with s.
 */

export interface TestbedSlice extends Omit<CreateSlicePayload, 'departmentId'> {
  joinCode: string;
}

export interface TestbedDepartment extends CreateDepartmentPayload {
  slices: TestbedSlice[];
}

/** The slice record the gateway needs (southbound `PUT /v1/slices`). */
export interface GatewayCatalogueItem {
  code: string;
  name: string;
  department: string;
  sNssai: { sst: number; sd?: string };
  profile: string;
  baselineKbps: number;
  floorKbps: number;
  burstKbps: number;
  currentLimitKbps: number;
  slaTargets: {
    latencyMs: number;
    jitterMs: number;
    lossPct: number;
    minThroughputKbps: number;
    availabilityPct: number;
  };
  joinCode: string;
}

export function testbedScenario(totalCapacityKbps: number): TestbedDepartment[] {
  const s = totalCapacityKbps / 10000;

  const sla = (
    latency: number,
    jitter: number,
    loss: number,
    throughput: number,
    availability: number,
  ) => ({
    maxLatencyMs: latency,
    maxJitterMs: jitter,
    maxPacketLossPercent: loss,
    minThroughputMbps: Math.round(throughput * s),
    availabilityPercent: availability,
  });

  return [
    {
      name: 'Clinic',
      description:
        'On-site occupational health clinic. Patient monitoring and emergency comms. ' +
        'LIFE_SAFETY compliance makes its slices structurally exempt from degradation.',
      criticality: DepartmentCriticality.MISSION_CRITICAL,
      businessImportance: 100,
      downtimeCostPerMinute: 25_000,
      recoveryTolerance: RecoveryTolerance.ZERO,
      maxAllowedDegradationPercent: 0,
      complianceLevel: ComplianceLevel.LIFE_SAFETY,
      customerImpact: CustomerImpact.SEVERE_EXTERNAL,
      operationalImportance: 100,
      ownerName: 'Dr Amara Okonkwo',
      ownerEmail: 'clinical.lead@example.com',
      site: 'Building A — Clinic',
      tags: ['life-safety', 'regulated'],
      slices: [
        {
          name: 'Patient Telemetry',
          snssai: { sst: 2, sd: '000101' },
          profile: SliceProfile.URLLC,
          baselineAllocatedMbps: Math.round(600 * s),
          minGuaranteedMbps: Math.round(400 * s),
          maxBurstMbps: Math.round(900 * s),
          slaTargets: sla(150, 25, 0.1, 400, 99.999),
          site: 'Building A',
          tags: ['telemetry', 'life-safety', 'join:CLN101'],
          joinCode: 'CLN101',
        },
      ],
    },

    {
      name: 'Factory',
      description:
        'Primary production line. Motion control, robotics and machine vision. A stoppage ' +
        'costs £8,400 per minute of output.',
      criticality: DepartmentCriticality.MISSION_CRITICAL,
      businessImportance: 94,
      downtimeCostPerMinute: 8400,
      recoveryTolerance: RecoveryTolerance.LOW,
      maxAllowedDegradationPercent: 15,
      complianceLevel: ComplianceLevel.CONTRACTUAL,
      customerImpact: CustomerImpact.DIRECT,
      operationalImportance: 96,
      ownerName: 'Priya Raghunathan',
      ownerEmail: 'factory.ops@example.com',
      site: 'Building C — Plant',
      tags: ['ot', 'production'],
      slices: [
        {
          name: 'Factory Automation',
          snssai: { sst: 2, sd: '000201' },
          profile: SliceProfile.URLLC,
          baselineAllocatedMbps: Math.round(3800 * s),
          minGuaranteedMbps: Math.round(1700 * s),
          maxBurstMbps: Math.round(5800 * s),
          slaTargets: sla(180, 30, 0.1, 1500, 99.99),
          site: 'Building C',
          tags: ['ot', 'realtime', 'join:FAC201'],
          joinCode: 'FAC201',
        },
      ],
    },

    {
      name: 'Quality lab',
      description: 'Test rigs, spectrometry and batch-release documentation. Regulated output.',
      criticality: DepartmentCriticality.BUSINESS_CRITICAL,
      businessImportance: 68,
      downtimeCostPerMinute: 1600,
      recoveryTolerance: RecoveryTolerance.LOW,
      maxAllowedDegradationPercent: 20,
      complianceLevel: ComplianceLevel.REGULATED,
      customerImpact: CustomerImpact.DIRECT,
      operationalImportance: 70,
      ownerName: 'Sofia Marchetti',
      ownerEmail: 'qa.lab@example.com',
      site: 'Building B — Lab',
      tags: ['regulated', 'quality'],
      slices: [
        {
          name: 'Lab Instrumentation',
          snssai: { sst: 1, sd: '000401' },
          profile: SliceProfile.EMBB,
          baselineAllocatedMbps: Math.round(1800 * s),
          minGuaranteedMbps: Math.round(500 * s),
          maxBurstMbps: Math.round(2600 * s),
          slaTargets: sla(500, 70, 3.0, 450, 99.9),
          site: 'Building B',
          tags: ['lab', 'join:LAB401'],
          joinCode: 'LAB401',
        },
      ],
    },

    {
      name: 'Warehouse',
      description: 'Automated guided vehicles, scanners and yard management.',
      criticality: DepartmentCriticality.BUSINESS_CRITICAL,
      businessImportance: 72,
      downtimeCostPerMinute: 2100,
      recoveryTolerance: RecoveryTolerance.MODERATE,
      maxAllowedDegradationPercent: 35,
      complianceLevel: ComplianceLevel.INTERNAL,
      customerImpact: CustomerImpact.INDIRECT,
      operationalImportance: 78,
      ownerName: 'Tomas Lindqvist',
      ownerEmail: 'warehouse@example.com',
      site: 'Building D — Warehouse',
      tags: ['logistics'],
      slices: [
        {
          name: 'Warehouse Operations',
          snssai: { sst: 2, sd: '000301' },
          profile: SliceProfile.URLLC,
          baselineAllocatedMbps: Math.round(1600 * s),
          minGuaranteedMbps: Math.round(550 * s),
          maxBurstMbps: Math.round(2500 * s),
          slaTargets: sla(250, 40, 0.5, 450, 99.95),
          site: 'Building D',
          tags: ['logistics', 'join:WHS301'],
          joinCode: 'WHS301',
        },
      ],
    },

    {
      name: 'Security',
      description: 'CCTV, access control and building management.',
      criticality: DepartmentCriticality.BUSINESS_OPERATIONAL,
      businessImportance: 58,
      downtimeCostPerMinute: 700,
      recoveryTolerance: RecoveryTolerance.MODERATE,
      maxAllowedDegradationPercent: 40,
      complianceLevel: ComplianceLevel.CONTRACTUAL,
      customerImpact: CustomerImpact.INTERNAL_ONLY,
      operationalImportance: 66,
      ownerName: 'Grace Whitfield',
      ownerEmail: 'security@example.com',
      site: 'Site-wide',
      tags: ['security'],
      slices: [
        {
          name: 'CCTV',
          snssai: { sst: 1, sd: '000601' },
          profile: SliceProfile.EMBB,
          baselineAllocatedMbps: Math.round(2400 * s),
          minGuaranteedMbps: Math.round(600 * s),
          maxBurstMbps: Math.round(3600 * s),
          slaTargets: sla(900, 145, 8.0, 500, 99.0),
          site: 'Site-wide',
          tags: ['cctv', 'join:SEC601'],
          joinCode: 'SEC601',
        },
      ],
    },

    {
      name: 'Office IT',
      description: 'Office Wi-Fi, collaboration and back-office systems.',
      criticality: DepartmentCriticality.BUSINESS_OPERATIONAL,
      businessImportance: 52,
      downtimeCostPerMinute: 900,
      recoveryTolerance: RecoveryTolerance.MODERATE,
      maxAllowedDegradationPercent: 45,
      complianceLevel: ComplianceLevel.INTERNAL,
      customerImpact: CustomerImpact.INTERNAL_ONLY,
      operationalImportance: 55,
      ownerName: 'Daniel Osei',
      ownerEmail: 'office.it@example.com',
      site: 'Building A — Offices',
      tags: ['corporate', 'office'],
      slices: [
        {
          name: 'Office Wi-Fi',
          snssai: { sst: 1, sd: '000501' },
          profile: SliceProfile.EMBB,
          baselineAllocatedMbps: Math.round(3200 * s),
          minGuaranteedMbps: Math.round(700 * s),
          maxBurstMbps: Math.round(5000 * s),
          slaTargets: sla(600, 95, 5.0, 600, 99.5),
          site: 'Building A',
          tags: ['office', 'join:OFF501'],
          joinCode: 'OFF501',
        },
      ],
    },

    {
      name: 'Canteen',
      description:
        'Canteen menus, wayfinding and lobby displays. Provisioned as URLLC by a historical ' +
        'template — the classic case where network profile and business value disagree.',
      criticality: DepartmentCriticality.BEST_EFFORT,
      businessImportance: 8,
      downtimeCostPerMinute: 15,
      recoveryTolerance: RecoveryTolerance.HIGH,
      maxAllowedDegradationPercent: 80,
      complianceLevel: ComplianceLevel.NONE,
      customerImpact: CustomerImpact.NONE,
      operationalImportance: 10,
      ownerName: 'Canteen Facilities',
      ownerEmail: 'canteen@example.com',
      site: 'Site-wide',
      tags: ['canteen', 'best-effort'],
      slices: [
        {
          name: 'Canteen Signage',
          snssai: { sst: 2, sd: '000701' },
          profile: SliceProfile.URLLC,
          baselineAllocatedMbps: Math.round(1400 * s),
          minGuaranteedMbps: Math.round(280 * s),
          maxBurstMbps: Math.round(2000 * s),
          slaTargets: sla(350, 60, 10.0, 80, 98.0),
          site: 'Site-wide',
          tags: ['signage', 'join:CAN701'],
          joinCode: 'CAN701',
        },
      ],
    },
  ];
}

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function gatewayCatalogueItem(departmentName: string, slice: TestbedSlice): GatewayCatalogueItem {
  return {
    code: slugify(slice.name),
    name: slice.name,
    department: departmentName,
    sNssai: slice.snssai,
    profile: slice.profile,
    baselineKbps: slice.baselineAllocatedMbps,
    floorKbps: slice.minGuaranteedMbps,
    burstKbps: slice.maxBurstMbps,
    currentLimitKbps: slice.baselineAllocatedMbps,
    slaTargets: {
      latencyMs: slice.slaTargets.maxLatencyMs,
      jitterMs: slice.slaTargets.maxJitterMs,
      lossPct: slice.slaTargets.maxPacketLossPercent,
      minThroughputKbps: slice.slaTargets.minThroughputMbps,
      availabilityPct: slice.slaTargets.availabilityPercent,
    },
    joinCode: slice.joinCode,
  };
}

/** The join code stored on a slice as a `join:XXXXXX` tag. */
export function joinCodeOf(slice: Pick<Slice, 'tags' | 'code'>): string {
  return slice.tags.find((t) => t.startsWith('join:'))?.slice(5) ?? slice.code.slice(0, 6).toUpperCase();
}

/**
 * The gateway catalogue for slices as they are stored now. It uses each slice's CURRENT limit,
 * so re-sending the catalogue (controller restart, join-code rotation) never resets a cut slice
 * to its baseline behind the controller's back.
 */
export function catalogueFromSlices(
  slices: readonly Slice[],
  departmentName: (departmentId: string) => string,
): GatewayCatalogueItem[] {
  return slices.map((s) => ({
    code: s.code,
    name: s.name,
    department: departmentName(s.departmentId),
    sNssai: s.snssai,
    profile: s.profile,
    baselineKbps: s.baselineAllocatedMbps,
    floorKbps: s.minGuaranteedMbps,
    burstKbps: s.maxBurstMbps,
    currentLimitKbps: s.allocatedMbps,
    slaTargets: {
      latencyMs: s.slaTargets.maxLatencyMs,
      jitterMs: s.slaTargets.maxJitterMs,
      lossPct: s.slaTargets.maxPacketLossPercent,
      minThroughputKbps: s.slaTargets.minThroughputMbps,
      availabilityPct: s.slaTargets.availabilityPercent,
    },
    joinCode: joinCodeOf(s),
  }));
}
