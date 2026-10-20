/** Largest chunk the scheduler queues. */
export const MAX_CHUNK_BYTES = 1024;

/**
 * A bucket must hold at least one maximum-size chunk, like a real bucket's depth is at least one
 * MTU. With depth = 0.1 s of rate, a slice cut to 28 kbps holds only 350 bytes: a 1 KB chunk at
 * the head of its queue could never be sent and would block the queue, probes included.
 */
const MIN_BURST_BYTES = MAX_CHUNK_BYTES;

export class TokenBucket {
  private rateBps: number;
  private burstBytes: number;
  private tokens: number;

  constructor(rateKbps: number, burstDurationS = 0.1, startFull = true) {
    this.rateBps = (rateKbps * 1000) / 8; // bytes per second
    this.burstBytes = Math.max(MIN_BURST_BYTES, this.rateBps * burstDurationS);
    this.tokens = startFull ? this.burstBytes : 0;
  }

  public setRateKbps(rateKbps: number, burstDurationS = 0.1): void {
    this.rateBps = (rateKbps * 1000) / 8;
    this.burstBytes = Math.max(MIN_BURST_BYTES, this.rateBps * burstDurationS);
    if (this.tokens > this.burstBytes) {
      this.tokens = this.burstBytes;
    }
  }

  public getRateKbps(): number {
    return (this.rateBps * 8) / 1000;
  }

  public getTokens(): number {
    return this.tokens;
  }

  public refill(dtSeconds: number): void {
    if (dtSeconds <= 0) return;
    this.tokens = Math.min(this.burstBytes, this.tokens + this.rateBps * dtSeconds);
  }

  public tryConsume(bytes: number): boolean {
    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return true;
    }
    return false;
  }

  public reset(full = false): void {
    this.tokens = full ? this.burstBytes : 0;
  }
}
