import { FifoQueue, QueueChunk } from './queue.js';
import { MAX_CHUNK_BYTES, TokenBucket } from './tokenBucket.js';
import { SliceMeter } from '../meter/sliceMeter.js';
import { LoadSession } from '../sessions/loadSession.js';
import { SliceCatalogueItem } from '@cn/shared';

export interface SliceRuntime {
  item: SliceCatalogueItem;
  bucket: TokenBucket;
  queue: FifoQueue;
  meter: SliceMeter;
  sessions: Map<string, LoadSession>;
  // For DRR mode
  drrDeficit: number;
  drrQuantum: number;
  /** The quantum for the current DRR visit has been added (a visit can span ticks). */
  drrCredited: boolean;
}

export interface ShaperConfig {
  totalCapacityKbps: number;
  reservedCapacityKbps: number;
  tickMs?: number;
  queueSeconds?: number;
  rootDiscipline?: 'fifo' | 'drr';
}

export class ShaperScheduler {
  private totalKbps: number;
  private reservedKbps: number;
  private offeredKbps: number;
  private tickMs: number;
  private queueSeconds: number;
  private rootDiscipline: 'fifo' | 'drr';

  // Root Link
  private rootBucket: TokenBucket;
  private rootQueue: FifoQueue;

  // Slices: sliceCode -> SliceRuntime
  private slices = new Map<string, SliceRuntime>();
  private sliceOrder: string[] = [];
  private rrIndex = 0;
  private drrIndex = 0;

  // Clock & Tick tracking
  private isRunning = false;
  private timer?: NodeJS.Timeout;
  private lastTickNs = 0n;
  private virtualNowNs = 0n;
  private useVirtualClock = false;

  // Callback on transmit probe or custom chunk
  public onTransmitProbe?: (chunk: QueueChunk) => void;

  constructor(cfg: ShaperConfig) {
    this.totalKbps = cfg.totalCapacityKbps;
    this.reservedKbps = cfg.reservedCapacityKbps;
    this.offeredKbps = Math.max(1, this.totalKbps - this.reservedKbps);
    this.tickMs = cfg.tickMs || 20;
    this.queueSeconds = cfg.queueSeconds || 0.5;
    this.rootDiscipline = cfg.rootDiscipline || 'fifo';

    this.rootBucket = new TokenBucket(this.offeredKbps, 0.1);
    // Root queue capacity = queueSeconds * offeredBytesPerSec
    const offeredBps = (this.offeredKbps * 1000) / 8;
    this.rootQueue = new FifoQueue(offeredBps * this.queueSeconds);
  }

  public getOfferedKbps(): number {
    return this.offeredKbps;
  }

  public getTotalKbps(): number {
    return this.totalKbps;
  }

  public getReservedKbps(): number {
    return this.reservedKbps;
  }

  public getDiscipline(): 'fifo' | 'drr' {
    return this.rootDiscipline;
  }

  public setDiscipline(d: 'fifo' | 'drr'): void {
    this.rootDiscipline = d;
  }

  /**
   * A slice queue holds queueSeconds of traffic at the slice's CURRENT limit. Sizing it on the
   * baseline would leave a slice cut to its floor with a queue that takes seconds to drain
   * (140 kbps of buffer drained at 28 kbps is 2.5 s), longer than the probe timeout. Every
   * probe would then count as lost even though the slice is moving.
   */
  private sliceQueueCapacity(limitKbps: number): number {
    return Math.max(2 * MAX_CHUNK_BYTES, ((limitKbps * 1000) / 8) * this.queueSeconds);
  }

  /**
   * DRR weight: 20 ms of traffic at the slice's limit, so the link is shared in proportion to the
   * limits. Not rounded up to a chunk: a slice whose quantum is smaller than a chunk banks its
   * deficit over several visits, which keeps the weights exact for small limits.
   */
  private drrQuantumFor(limitKbps: number): number {
    return Math.max(1, ((limitKbps * 1000) / 8) * 0.02);
  }

  public registerSlice(item: SliceCatalogueItem): void {
    const queueCapacity = this.sliceQueueCapacity(item.currentLimitKbps);

    if (this.slices.has(item.code)) {
      const existing = this.slices.get(item.code)!;
      existing.item = item;
      existing.bucket.setRateKbps(item.currentLimitKbps);
      existing.queue.setCapacityBytes(queueCapacity);
      existing.meter.setLimitKbps(item.currentLimitKbps);
      existing.drrQuantum = this.drrQuantumFor(item.currentLimitKbps);
      return;
    }

    const bucket = new TokenBucket(item.currentLimitKbps, 0.1);
    const queue = new FifoQueue(queueCapacity);
    const meter = new SliceMeter(item.code, item.currentLimitKbps);
    const quantum = this.drrQuantumFor(item.currentLimitKbps);

    this.slices.set(item.code, {
      item,
      bucket,
      queue,
      meter,
      sessions: new Map(),
      drrDeficit: 0,
      drrQuantum: quantum,
      drrCredited: false,
    });

    this.sliceOrder.push(item.code);
  }

  public updateSliceLimit(sliceCode: string, newLimitKbps: number): boolean {
    const s = this.slices.get(sliceCode);
    if (!s) return false;

    s.item.currentLimitKbps = newLimitKbps;
    s.bucket.setRateKbps(newLimitKbps);
    s.queue.setCapacityBytes(this.sliceQueueCapacity(newLimitKbps));
    s.meter.setLimitKbps(newLimitKbps);
    s.drrQuantum = this.drrQuantumFor(newLimitKbps);
    return true;
  }

  public getSlice(sliceCode: string): SliceRuntime | undefined {
    return this.slices.get(sliceCode);
  }

  public getAllSlices(): SliceRuntime[] {
    return Array.from(this.slices.values());
  }

  public addSession(session: LoadSession): void {
    const s = this.slices.get(session.sliceCode);
    if (s) {
      s.sessions.set(session.sessionId, session);
    }
  }

  public removeSession(sliceCode: string, sessionId: string): void {
    const s = this.slices.get(sliceCode);
    if (s) {
      s.sessions.delete(sessionId);
    }
  }

  public enqueueProbeChunk(sliceCode: string, probeChunk: QueueChunk): boolean {
    const s = this.slices.get(sliceCode);
    if (!s) return false;

    s.meter.recordArrival(probeChunk.data.length);
    const ok = s.queue.enqueue(probeChunk);
    if (!ok) {
      s.meter.recordSliceDrop(probeChunk.data.length);
    }
    return ok;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTickNs = process.hrtime.bigint();

    const loop = () => {
      if (!this.isRunning) return;
      this.tick();
      this.timer = setTimeout(loop, this.tickMs);
    };

    this.timer = setTimeout(loop, this.tickMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * For testing: step the shaper with an exact simulated dt in seconds.
   */
  public step(dtSeconds: number): void {
    this.useVirtualClock = true;
    this.virtualNowNs += BigInt(Math.floor(dtSeconds * 1e9));
    this.executeTick(dtSeconds, this.virtualNowNs);
  }

  private tick(): void {
    const nowNs = process.hrtime.bigint();
    const dtSeconds = Number(nowNs - this.lastTickNs) / 1e9;
    this.lastTickNs = nowNs;
    this.executeTick(dtSeconds, nowNs);
  }

  private executeTick(dtSeconds: number, nowNs: bigint): void {
    // 1. ARRIVALS
    // For every active load session s in slice i: generate bytes at s.offeredBps * dt
    for (const slice of this.slices.values()) {
      for (const session of slice.sessions.values()) {
        const rateBps = (session.getRateKbps() * 1000) / 8;
        let bytesNeeded = rateBps * dtSeconds;

        while (bytesNeeded > 0) {
          const chunkSize = Math.min(MAX_CHUNK_BYTES, Math.ceil(bytesNeeded));
          const chunkData = session.produceChunk(chunkSize);
          if (!chunkData) break;

          const chunk: QueueChunk = {
            sliceCode: slice.item.code,
            data: chunkData,
            enqueuedAtNs: nowNs,
            sessionId: session.sessionId,
            onTransmit: () => {
              session.transmitChunk(chunkData);
            },
          };

          slice.meter.recordArrival(chunkData.length);
          const enqueued = slice.queue.enqueue(chunk);
          if (!enqueued) {
            // Tail drop at slice queue
            slice.meter.recordSliceDrop(chunkData.length);
          }

          bytesNeeded -= chunkSize;
        }
      }
    }

    // 2. REFILL
    // Refill each slice's token bucket and root bucket
    for (const slice of this.slices.values()) {
      slice.bucket.refill(dtSeconds);
    }
    this.rootBucket.refill(dtSeconds);

    // 3. POLICE and 4. TRANSMIT
    if (this.rootDiscipline === 'fifo') {
      // Each slice's bucket admits chunks into ONE shared FIFO that drains at the link rate.
      this.policeFifo();
      this.transmitRootQueue(nowNs);
    } else {
      // Each slice keeps its own queue; the link serves the slices by deficit round robin.
      this.transmitDrr(nowNs);
    }
  }

  /** Drain the shared root FIFO while the link's tokens allow. */
  private transmitRootQueue(nowNs: bigint): void {
    while (this.rootQueue.getDepthCount() > 0) {
      const top = this.rootQueue.peek();
      if (!top) break;
      if (!this.rootBucket.tryConsume(top.data.length)) break; // link busy until next tick
      this.send(this.rootQueue.dequeue()!, nowNs);
    }
  }

  /** Put one chunk on the wire: meter it, time a probe, write it to its socket or session. */
  private send(chunk: QueueChunk, nowNs: bigint): void {
    const slice = this.slices.get(chunk.sliceCode);
    if (slice) slice.meter.recordSent(chunk.data.length);

    if (chunk.isProbe) {
      const queueDelayMs = Number(nowNs - chunk.enqueuedAtNs) / 1e6;
      if (slice) slice.meter.recordProbeQueueDelay(queueDelayMs);
      if (this.onTransmitProbe) this.onTransmitProbe(chunk);
    }

    if (chunk.onTransmit) {
      try {
        chunk.onTransmit(chunk);
      } catch {}
    }
  }

  private policeFifo(): void {
    if (this.sliceOrder.length === 0) return;
    let anyProgress = true;
    let loops = 0;

    while (anyProgress && loops < 50) {
      anyProgress = false;
      loops++;

      for (let i = 0; i < this.sliceOrder.length; i++) {
        const sliceIdx = (this.rrIndex + i) % this.sliceOrder.length;
        const code = this.sliceOrder[sliceIdx]!;
        const slice = this.slices.get(code);
        if (!slice || slice.queue.getDepthCount() === 0) continue;

        const nextChunk = slice.queue.peek();
        if (!nextChunk) continue;

        const chunkLen = nextChunk.data.length;
        // Check if slice token bucket has tokens
        if (slice.bucket.tryConsume(chunkLen)) {
          slice.queue.dequeue();
          const enqueued = this.rootQueue.enqueue(nextChunk);
          if (!enqueued) {
            // Root queue full -> tail drop
            slice.meter.recordRootDrop(chunkLen);
          }
          anyProgress = true;
        }
      }
    }

    if (this.sliceOrder.length > 0) {
      this.rrIndex = (this.rrIndex + 1) % this.sliceOrder.length;
    }
  }

  /**
   * Deficit round robin over the slice queues, weighted by each slice's limit (its quantum is
   * 20 ms of traffic at the limit). A chunk leaves only when the slice's own bucket AND the link
   * both have tokens, so a slice is still held to its limit, and a slice sending less than its
   * share never waits behind another slice's backlog. When the link runs out of tokens mid-visit
   * the visit resumes on the next tick without a second quantum.
   */
  private transmitDrr(nowNs: bigint): void {
    const n = this.sliceOrder.length;
    if (n === 0) return;

    let visitsWithoutSend = 0;
    while (visitsWithoutSend < n) {
      const slice = this.slices.get(this.sliceOrder[this.drrIndex % n]!);
      if (!slice || slice.queue.getDepthCount() === 0) {
        if (slice) {
          slice.drrDeficit = 0;
          slice.drrCredited = false;
        }
        this.drrIndex = (this.drrIndex + 1) % n;
        visitsWithoutSend++;
        continue;
      }

      if (!slice.drrCredited) {
        // Cap the deficit so a slice held back by its own bucket can't bank credit forever.
        slice.drrDeficit = Math.min(slice.drrDeficit + slice.drrQuantum, slice.drrQuantum + MAX_CHUNK_BYTES);
        slice.drrCredited = true;
      }

      let sent = false;
      let waitingForDeficit = false;
      while (slice.queue.getDepthCount() > 0) {
        const chunk = slice.queue.peek()!;
        const len = chunk.data.length;
        if (slice.bucket.getTokens() < len) break; // slice at its own limit this tick
        if (slice.drrDeficit < len) {
          waitingForDeficit = true; // turn used up; credit carries to the next visit
          break;
        }
        if (this.rootBucket.getTokens() < len) return; // link busy: resume this visit next tick
        slice.bucket.tryConsume(len);
        this.rootBucket.tryConsume(len);
        slice.drrDeficit -= len;
        slice.queue.dequeue();
        this.send(chunk, nowNs);
        sent = true;
      }

      if (slice.queue.getDepthCount() === 0) slice.drrDeficit = 0;
      slice.drrCredited = false;
      this.drrIndex = (this.drrIndex + 1) % n;
      // Stop after a full round in which no slice could use the link. A slice that is only short of
      // deficit gains a quantum per visit, so it will send within a few rounds: not idle.
      visitsWithoutSend = sent || waitingForDeficit ? 0 : visitsWithoutSend + 1;
    }
  }

  public getRootQueueDepthBytes(): number {
    return this.rootQueue.getDepthBytes();
  }

  public getRootQueueCapacityBytes(): number {
    return this.rootQueue.getCapacityBytes();
  }
}
