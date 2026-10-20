import { SliceStats } from '@cn/shared';

export interface SliceCounters {
  arrivalBytes: number;
  sentBytes: number;
  sliceDroppedBytes: number;
  rootDroppedBytes: number;
  probeQueueDelaysMs: number[];
}

export class SliceMeter {
  private sliceCode: string;
  private currentLimitKbps: number;

  // Window counters
  private windowStartMs: number;
  private currentCounters: SliceCounters;
  private lastCompletedStats: SliceStats;

  // Probe measurement callbacks
  private activeDevicesCount = 0;
  private activeSessionsCount = 0;

  constructor(sliceCode: string, initialLimitKbps: number) {
    this.sliceCode = sliceCode;
    this.currentLimitKbps = initialLimitKbps;
    this.windowStartMs = Date.now();
    this.currentCounters = this.createEmptyCounters();
    this.lastCompletedStats = {
      code: sliceCode,
      atMs: this.windowStartMs,
      demandKbps: 0,
      limitKbps: initialLimitKbps,
      usedKbps: 0,
      droppedKbps: 0,
      queueMs: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
      jitterMs: null,
      lossPct: 0,
      availabilityPct: null,
      activeDevices: 0,
      activeSessions: 0,
      saturated: false,
    };
  }

  private createEmptyCounters(): SliceCounters {
    return {
      arrivalBytes: 0,
      sentBytes: 0,
      sliceDroppedBytes: 0,
      rootDroppedBytes: 0,
      probeQueueDelaysMs: [],
    };
  }

  public setLimitKbps(limitKbps: number): void {
    this.currentLimitKbps = limitKbps;
  }

  public getLimitKbps(): number {
    return this.currentLimitKbps;
  }

  public recordArrival(bytes: number): void {
    this.currentCounters.arrivalBytes += bytes;
  }

  public recordSent(bytes: number): void {
    this.currentCounters.sentBytes += bytes;
  }

  public recordSliceDrop(bytes: number): void {
    this.currentCounters.sliceDroppedBytes += bytes;
  }

  public recordRootDrop(bytes: number): void {
    this.currentCounters.rootDroppedBytes += bytes;
  }

  public recordProbeQueueDelay(ms: number): void {
    this.currentCounters.probeQueueDelaysMs.push(ms);
  }

  public updateActiveCounts(devices: number, sessions: number): void {
    this.activeDevicesCount = devices;
    this.activeSessionsCount = sessions;
  }

  /**
   * Finalizes the current window and computes the SliceStats snapshot.
   * @param windowDurationS actual duration in seconds
   * @param clientProbeStats external probe stats from ProbeManager (rtt p50/p95, jitter, loss, avail)
   * @param currentQueueDepthBytes current depth of slice queue
   */
  public rotateWindow(
    windowDurationS: number,
    clientProbeStats: {
      p50: number | null;
      p95: number | null;
      jitter: number | null;
      lostProbes: number;
      sentProbes: number;
      availabilityPct: number | null;
    },
    currentQueueDepthBytes = 0
  ): SliceStats {
    const now = Date.now();
    const dur = Math.max(0.001, windowDurationS);

    const c = this.currentCounters;
    const demandKbps = Math.round((c.arrivalBytes * 8) / (dur * 1000));
    const usedKbps = Math.round((c.sentBytes * 8) / (dur * 1000));
    const totalDroppedBytes = c.sliceDroppedBytes + c.rootDroppedBytes;
    const droppedKbps = Math.round((totalDroppedBytes * 8) / (dur * 1000));

    // Queue delay in ms
    let queueMs = 0;
    if (c.probeQueueDelaysMs.length > 0) {
      queueMs = Math.round(
        c.probeQueueDelaysMs.reduce((a, b) => a + b, 0) / c.probeQueueDelaysMs.length
      );
    } else if (this.currentLimitKbps > 0) {
      queueMs = Math.round((currentQueueDepthBytes * 8 * 1000) / (this.currentLimitKbps * 1000));
    }

    // Loss percentage: max of byte drop percentage and probe loss percentage
    const byteLossPct =
      c.arrivalBytes > 0 ? (totalDroppedBytes / c.arrivalBytes) * 100 : 0;
    const probeLossPct =
      clientProbeStats.sentProbes > 0
        ? (clientProbeStats.lostProbes / clientProbeStats.sentProbes) * 100
        : 0;
    const lossPct = Math.min(100, Math.max(byteLossPct, probeLossPct));

    const saturated =
      demandKbps >= 0.95 * this.currentLimitKbps ||
      totalDroppedBytes > 0 ||
      queueMs > 30;

    this.lastCompletedStats = {
      code: this.sliceCode,
      atMs: now,
      demandKbps,
      limitKbps: this.currentLimitKbps,
      usedKbps,
      droppedKbps,
      queueMs,
      latencyP50Ms: clientProbeStats.p50,
      latencyP95Ms: clientProbeStats.p95,
      jitterMs: clientProbeStats.jitter,
      lossPct: parseFloat(lossPct.toFixed(2)),
      availabilityPct:
        clientProbeStats.availabilityPct !== null
          ? parseFloat(clientProbeStats.availabilityPct.toFixed(3))
          : null,
      activeDevices: this.activeDevicesCount,
      activeSessions: this.activeSessionsCount,
      saturated,
    };

    // Reset counters
    this.currentCounters = this.createEmptyCounters();
    this.windowStartMs = now;

    return this.lastCompletedStats;
  }

  public getLatestStats(): SliceStats {
    return this.lastCompletedStats;
  }
}
