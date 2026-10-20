import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { formatBandwidth, formatPercent, humanise } from '@/lib/format';
import { Tooltip } from '@/components/ui';
import type { MergedSlice } from '@/hooks/useLiveData';
import type { Department } from '@/types/api';

/**
 * Network topology.
 *
 * Departments arranged around a central enterprise core, with a link per department whose
 * appearance encodes live state.
 *
 * WHY SVG AND NOT A GRAPH LIBRARY
 * ===============================
 * The layout is a radial star with a fixed centre — a force-directed layout would jitter on
 * every telemetry tick, which is unreadable on a wall display and actively unpleasant to
 * watch. A deterministic polar layout is stable frame to frame, so a department stays where
 * the operator learned to look for it.
 *
 * ENCODING
 * --------
 *   link WIDTH      allocated bandwidth (thicker = more capacity committed)
 *   link COLOUR     worst slice health in that department
 *   flowing DASHES  traffic actually passing; they stop when a link is starved
 *   pulsing RING    department currently degraded
 *
 * Animation is CSS, so it costs nothing per tick and honours `prefers-reduced-motion`.
 */
export function NetworkTopology({
  entries,
  className,
}: {
  entries: MergedSlice[];
  className?: string;
}): JSX.Element {
  const nodes = useMemo(() => buildNodes(entries), [entries]);

  const size = 560;
  const centre = size / 2;
  const radius = size * 0.36;

  if (nodes.length === 0) {
    return (
      <div className={cn('grid place-items-center py-16 text-sm text-content-muted', className)}>
        No departments to display.
      </div>
    );
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="mx-auto h-auto w-full max-w-[560px]"
        role="img"
        aria-label="Network topology showing departments connected to the enterprise core"
      >
        <defs>
          {/* Soft glow behind the core, so it reads as the hub rather than as another node. */}
          <radialGradient id="coreGlow">
            <stop offset="0%" stopColor="rgb(var(--brand))" stopOpacity="0.30" />
            <stop offset="70%" stopColor="rgb(var(--brand))" stopOpacity="0.06" />
            <stop offset="100%" stopColor="rgb(var(--brand))" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx={centre} cy={centre} r={radius * 0.55} fill="url(#coreGlow)" />

        {/* Links first, so nodes paint over them. */}
        {nodes.map((node, index) => {
          const { x, y } = polar(centre, radius, index, nodes.length);
          return (
            <TopologyLink
              key={`link-${node.department.id}`}
              points={{ x1: centre, y1: centre, x2: x, y2: y }}
              node={node}
            />
          );
        })}

        {/* Core */}
        <g>
          <circle
            cx={centre}
            cy={centre}
            r="34"
            className="fill-surface-raised stroke-brand"
            strokeWidth="2"
          />
          <text
            x={centre}
            y={centre - 4}
            textAnchor="middle"
            className="fill-content text-[11px] font-semibold"
          >
            CORE
          </text>
          <text
            x={centre}
            y={centre + 9}
            textAnchor="middle"
            className="fill-content-subtle text-[9px]"
          >
            5G Network
          </text>
        </g>

        {/* Department nodes */}
        {nodes.map((node, index) => {
          const { x, y } = polar(centre, radius, index, nodes.length);
          return <DepartmentNode key={node.department.id} node={node} x={x} y={y} centre={centre} />;
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface TopologyNode {
  department: Department;
  sliceCount: number;
  allocatedMbps: number;
  demandMbps: number;
  usedMbps: number;
  degradedCount: number;
  worstHealth: 'HEALTHY' | 'WARNING' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';
  starved: boolean;
}

function buildNodes(entries: MergedSlice[]): TopologyNode[] {
  const byDepartment = new Map<string, TopologyNode>();

  for (const entry of entries) {
    if (!entry.department) continue;

    const existing = byDepartment.get(entry.department.id) ?? {
      department: entry.department,
      sliceCount: 0,
      allocatedMbps: 0,
      demandMbps: 0,
      usedMbps: 0,
      degradedCount: 0,
      worstHealth: 'UNKNOWN' as const,
      starved: false,
    };

    existing.sliceCount += 1;
    existing.allocatedMbps += entry.live?.allocatedMbps ?? entry.slice.allocatedMbps;
    existing.demandMbps += entry.live?.demandMbps ?? 0;
    existing.usedMbps += entry.live?.usedMbps ?? 0;
    if (entry.slice.status === 'DEGRADED') existing.degradedCount += 1;

    const health = entry.live?.health ?? entry.slice.health;
    if (healthRank(health) > healthRank(existing.worstHealth)) existing.worstHealth = health;

    byDepartment.set(entry.department.id, existing);
  }

  for (const node of byDepartment.values()) {
    // "Starved" means demand meaningfully exceeds what is being delivered — the condition
    // that stops the flow animation.
    node.starved = node.demandMbps > node.usedMbps * 1.05 + 1;
  }

  // Stable ordering by criticality so a department does not move between renders.
  return [...byDepartment.values()].sort((a, b) => {
    const rank = criticalityRank(a.department.criticality) - criticalityRank(b.department.criticality);
    return rank !== 0 ? rank : a.department.name.localeCompare(b.department.name);
  });
}

/** Unknown criticalities sort last rather than throwing off the layout. */
function criticalityRank(criticality: string): number {
  return CRITICALITY_RANK[criticality] ?? 99;
}

function healthRank(health: string): number {
  return HEALTH_RANK[health] ?? 0;
}

const HEALTH_RANK: Record<string, number> = {
  UNKNOWN: 0,
  HEALTHY: 1,
  WARNING: 2,
  DEGRADED: 3,
  CRITICAL: 4,
};

const CRITICALITY_RANK: Record<string, number> = {
  MISSION_CRITICAL: 0,
  BUSINESS_CRITICAL: 1,
  BUSINESS_OPERATIONAL: 2,
  ADMINISTRATIVE: 3,
  BEST_EFFORT: 4,
};

/** Start at 12 o'clock and go clockwise, so the most critical department is at the top. */
function polar(centre: number, radius: number, index: number, total: number) {
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return { x: centre + radius * Math.cos(angle), y: centre + radius * Math.sin(angle) };
}

function linkColour(node: TopologyNode): string {
  if (node.degradedCount > 0) return 'rgb(var(--critical))';
  switch (node.worstHealth) {
    case 'CRITICAL':
      return 'rgb(var(--critical))';
    case 'DEGRADED':
      return 'rgb(var(--degraded))';
    case 'WARNING':
      return 'rgb(var(--warning))';
    case 'HEALTHY':
      return 'rgb(var(--healthy))';
    default:
      return 'rgb(var(--content-subtle))';
  }
}

function TopologyLink({
  points,
  node,
}: {
  points: { x1: number; y1: number; x2: number; y2: number };
  node: TopologyNode;
}) {
  const colour = linkColour(node);
  // Width encodes committed bandwidth, on a compressed scale so a 6 Gbps link does not
  // become a 60-pixel slab beside a 200 Mbps one.
  const width = Math.max(1.5, Math.min(7, Math.sqrt(node.allocatedMbps) / 12));

  return (
    <g>
      <line {...points} stroke={colour} strokeWidth={width} strokeOpacity={0.28} strokeLinecap="round" />

      {/* Flowing dashes = traffic passing. They stop when the link is starved, which makes
          "this department is not getting what it asked for" visible without reading a number. */}
      <line
        {...points}
        stroke={colour}
        strokeWidth={width}
        strokeOpacity={0.85}
        strokeLinecap="round"
        strokeDasharray="6 14"
        style={
          node.starved
            ? undefined
            : { animation: 'topologyFlow 1.4s linear infinite' }
        }
      />
    </g>
  );
}

function DepartmentNode({
  node,
  x,
  y,
  centre,
}: {
  node: TopologyNode;
  x: number;
  y: number;
  centre: number;
}) {
  const colour = linkColour(node);
  const degraded = node.degradedCount > 0;
  // Labels flip to the outside of the circle so they never overlap the core.
  const anchor = x < centre - 20 ? 'end' : x > centre + 20 ? 'start' : 'middle';
  const labelOffset = anchor === 'end' ? -26 : anchor === 'start' ? 26 : 0;
  const labelY = anchor === 'middle' ? (y < centre ? -30 : 38) : 0;

  return (
    <Tooltip
      content={
        <>
          <strong>{node.department.name}</strong>
          <br />
          {humanise(node.department.criticality)} · {node.sliceCount} slice(s)
          <br />
          Allocated {formatBandwidth(node.allocatedMbps)}, demand{' '}
          {formatBandwidth(node.demandMbps)}
          <br />
          Max degradation {formatPercent(node.department.effectiveDegradationCeiling, 0)}
          {node.department.structurallyExempt && ' — structurally exempt'}
        </>
      }
    >
      <g className="cursor-pointer">
        {degraded && (
          <circle cx={x} cy={y} r="26" fill={colour} fillOpacity="0.12" className="animate-pulse-slow" />
        )}

        <circle
          cx={x}
          cy={y}
          r="20"
          className="fill-surface-raised"
          stroke={colour}
          strokeWidth={degraded ? 2.5 : 1.75}
        />

        <text x={x} y={y + 4} textAnchor="middle" className="fill-content text-[11px] font-semibold">
          {node.sliceCount}
        </text>

        <text
          x={x + labelOffset}
          y={y + labelY + (anchor === 'middle' ? 0 : 4)}
          textAnchor={anchor}
          className="fill-content-muted text-[10px] font-medium"
        >
          {truncate(node.department.name, 18)}
        </text>

        {node.department.structurallyExempt && (
          <circle cx={x + 15} cy={y - 15} r="4.5" className="fill-info" />
        )}
      </g>
    </Tooltip>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
