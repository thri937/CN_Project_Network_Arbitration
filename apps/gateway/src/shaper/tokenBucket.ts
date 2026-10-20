export class TokenBucket {
  private rateBps: number;
  private burstBytes: number;
  private tokens: number;

  constructor(rateKbps: number, burstDurationS = 0.1) {
    this.rateBps = (rateKbps * 1000) / 8; // bytes per second
    this.burstBytes = Math.max(1024, this.rateBps * burstDurationS);
    this.tokens = this.burstBytes; // start full
  }

  public setRateKbps(rateKbps: number, burstDurationS = 0.1): void {
    this.rateBps = (rateKbps * 1000) / 8;
    this.burstBytes = Math.max(1024, this.rateBps * burstDurationS);
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

  public reset(): void {
    this.tokens = this.burstBytes;
  }
}
