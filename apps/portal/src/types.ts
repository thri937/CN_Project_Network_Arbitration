import type {
  SliceCatalogueItem,
  SliceSnapshot,
  BoundDevice,
  HealthStatus,
  SliceState,
} from '@cn/shared';

export type {
  SliceCatalogueItem,
  SliceSnapshot,
  BoundDevice,
  HealthStatus,
  SliceState,
};

export interface ChartSample {
  time: string;
  demandKbps: number;
  limitKbps: number;
  usedKbps: number;
  droppedKbps: number;
  latencyMs: number;
  jitterMs: number;
  lossPct: number;
}
