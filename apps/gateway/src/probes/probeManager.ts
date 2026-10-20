import { ServerResponse } from 'node:http';
import { ProbeResult } from '@cn/shared';

interface PendingProbe {
  deviceId: string;
  sliceCode: string;
  seq: number;
  arrivedAtNs: bigint;
  res: ServerResponse;
}

interface ProbeHistoryEntry {
  atMs: number;
  rttMs: number;
}

export class ProbeManager {
  // sliceCode -> rolling history of recent RTTs (last 5 min)
  private rttHistory = new Map<string, ProbeHistoryEntry[]>();
  // sliceCode -> lost probes count in current 2s window
  private windowProbesSent = new Map<string, number>();
  private windowProbesReceived = new Map<string, number>();

  // Rolling 5 min totals for availability
  private rolling5MinSent = new Map<string, number>();
  private rolling5MinReceived = new Map<string, number>();

  constructor() {}

  /**
   * Called when a client sends GET /probe.
   * Creates a pending probe response handle.
   */
  public createProbeHandle(
    deviceId: string,
    sliceCode: string,
    seq: number,
    res: ServerResponse
  ): PendingProbe {
    return {
      deviceId,
      sliceCode,
      seq,
      arrivedAtNs: process.hrtime.bigint(),
      res,
    };
  }

  /**
   * Called by the shaper when the probe chunk is dequeued from rootQueue.
   * Sends the 64-byte HTTP response back to the client.
   */
  public completeProbe(probe: PendingProbe): number {
    const endNs = process.hrtime.bigint();
    const queueDelayMs = Number(endNs - probe.arrivedAtNs) / 1e6;

    if (!probe.res.writableEnded) {
      probe.res.statusCode = 200;
      probe.res.setHeader('Content-Type', 'application/json');
      // Create a payload that is ~64 bytes
      const body = JSON.stringify({
        seq: probe.seq,
        t: Date.now(),
        qMs: Math.round(queueDelayMs),
      });
      // Pad to 64 bytes if needed
      const padded = body.padEnd(64, ' ');
      probe.res.end(padded);
    }

    return queueDelayMs;
  }

  /**
   * Ingest client-measured RTT batch from POST /portal-api/probe-results
   */
  public ingestResults(sliceCode: string, results: ProbeResult[]): void {
    if (results.length === 0) return;

    if (!this.rttHistory.has(sliceCode)) {
      this.rttHistory.set(sliceCode, []);
    }
    const history = this.rttHistory.get(sliceCode)!;

    const now = Date.now();
    for (const r of results) {
      history.push({ atMs: now, rttMs: r.rttMs });
    }

    // Update window counts
    const prevSent = this.windowProbesSent.get(sliceCode) || 0;
    const prevRecv = this.windowProbesReceived.get(sliceCode) || 0;
    this.windowProbesSent.set(sliceCode, prevSent + results.length);
    this.windowProbesReceived.set(sliceCode, prevRecv + results.length);

    // Update 5min counts
    this.rolling5MinSent.set(sliceCode, (this.rolling5MinSent.get(sliceCode) || 0) + results.length);
    this.rolling5MinReceived.set(
      sliceCode,
      (this.rolling5MinReceived.get(sliceCode) || 0) + results.length
    );
  }

  public recordLostProbe(sliceCode: string): void {
    this.windowProbesSent.set(sliceCode, (this.windowProbesSent.get(sliceCode) || 0) + 1);
    this.rolling5MinSent.set(sliceCode, (this.rolling5MinSent.get(sliceCode) || 0) + 1);
  }

  /**
   * Computes p50, p95, jitter, lost, sent, and rolling availability for this 2s window.
   */
  public computeWindowStats(
    sliceCode: string,
    hasActiveDevices: boolean
  ): {
    p50: number | null;
    p95: number | null;
    jitter: number | null;
    lostProbes: number;
    sentProbes: number;
    availabilityPct: number | null;
  } {
    if (!hasActiveDevices) {
      // If no device in a slice reports probes, report latency, jitter and availability as unknown (null).
      return {
        p50: null,
        p95: null,
        jitter: null,
        lostProbes: 0,
        sentProbes: 0,
        availabilityPct: null,
      };
    }

    const now = Date.now();
    const history = this.rttHistory.get(sliceCode) || [];

    // Filter to last 2-4 seconds for the immediate window
    const recent = history.filter((h) => now - h.atMs <= 4000);

    // Clean up history older than 5 minutes
    const fiveMinAgo = now - 300000;
    if (history.length > 0 && history[0]!.atMs < fiveMinAgo) {
      this.rttHistory.set(
        sliceCode,
        history.filter((h) => h.atMs >= fiveMinAgo)
      );
    }

    if (recent.length === 0) {
      return {
        p50: null,
        p95: null,
        jitter: null,
        lostProbes: 0,
        sentProbes: 0,
        availabilityPct: 100,
      };
    }

    const rtts = recent.map((r) => r.rttMs).sort((a, b) => a - b);
    const p50 = rtts[Math.floor(rtts.length * 0.50)] ?? null;
    const p95 = rtts[Math.floor(rtts.length * 0.95)] ?? null;

    // RFC 3550 jitter: mean absolute difference of successive samples
    let jitter: number | null = null;
    if (recent.length >= 2) {
      let sumDiff = 0;
      for (let i = 1; i < recent.length; i++) {
        sumDiff += Math.abs(recent[i]!.rttMs - recent[i - 1]!.rttMs);
      }
      jitter = Math.round((sumDiff / (recent.length - 1)) * 10) / 10;
    } else {
      jitter = 0;
    }

    const sent = this.windowProbesSent.get(sliceCode) || recent.length;
    const recv = this.windowProbesReceived.get(sliceCode) || recent.length;
    const lost = Math.max(0, sent - recv);

    // Reset window counters
    this.windowProbesSent.set(sliceCode, 0);
    this.windowProbesReceived.set(sliceCode, 0);

    // Rolling 5 min availability
    const rSent = this.rolling5MinSent.get(sliceCode) || 0;
    const rRecv = this.rolling5MinReceived.get(sliceCode) || 0;
    const availabilityPct = rSent > 0 ? (rRecv / rSent) * 100 : 100;

    return {
      p50: p50 !== null ? Math.round(p50) : null,
      p95: p95 !== null ? Math.round(p95) : null,
      jitter,
      lostProbes: lost,
      sentProbes: sent,
      availabilityPct,
    };
  }
}
