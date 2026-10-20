export class TokenBucket {
  private rateBps: number;
  private burstBytes: number;
  private tokens: number;

  constructor(rateKbps: number, burstDurationS = 0.1, startFull = true) {
    this.rateBps = (rateKbps * 1000) / 8; // bytes per second
    this.burstBytes = Math.max(64, this.rateBps * burstDurationS);
    this.tokens = startFull ? this.burstBytes : 0;
  }

  public setRateKbps(rateKbps: number, burstDurationS = 0.1): void {
    this.rateBps = (rateKbps * 1000) / 8;
    this.burstBytes = Math.max(64, this.rateBps * burstDurationS);
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
