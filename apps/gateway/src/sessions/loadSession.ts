import { ServerResponse } from 'node:http';
import http from 'node:http';
import https from 'node:https';

export interface LoadSessionOptions {
  sessionId: string;
  deviceId: string;
  sliceCode: string;
  initialRateKbps: number;
  mode: 'local' | 'internet';
  res: ServerResponse;
  internetSourceUrl?: string;
  onClose: (sessionId: string) => void;
}

export class LoadSession {
  public readonly sessionId: string;
  public readonly deviceId: string;
  public readonly sliceCode: string;
  private rateKbps: number;
  private mode: 'local' | 'internet';
  private res: ServerResponse;
  private internetSourceUrl: string;
  private onClose: (sessionId: string) => void;

  private isClosed = false;
  private isPaused = false;
  private totalBytesSent = 0;

  // Internet mode upstream
  private upstreamReq?: http.ClientRequest;
  private upstreamBuffer: Buffer[] = [];
  private upstreamBufferedBytes = 0;

  constructor(opts: LoadSessionOptions) {
    this.sessionId = opts.sessionId;
    this.deviceId = opts.deviceId;
    this.sliceCode = opts.sliceCode;
    this.rateKbps = opts.initialRateKbps;
    this.mode = opts.mode;
    this.res = opts.res;
    this.internetSourceUrl =
      opts.internetSourceUrl || 'https://speed.cloudflare.com/__down?bytes=25000000';
    this.onClose = opts.onClose;

    // Handle backpressure and client disconnect
    this.res.on('close', () => this.destroy());
    this.res.on('drain', () => {
      this.isPaused = false;
    });

    if (this.mode === 'internet') {
      this.startInternetFetch();
    }
  }

  public getRateKbps(): number {
    return this.rateKbps;
  }

  public getMode(): 'local' | 'internet' {
    return this.mode;
  }

  public getTotalBytes(): number {
    return this.totalBytesSent;
  }

  public isSocketWritable(): boolean {
    return !this.isClosed && !this.res.writableEnded && !this.isPaused;
  }

  public updateRate(newRateKbps: number, newMode?: 'local' | 'internet'): void {
    this.rateKbps = Math.max(0, newRateKbps);
    if (newMode && newMode !== this.mode) {
      this.mode = newMode;
      if (this.mode === 'internet') {
        this.startInternetFetch();
      } else {
        this.stopInternetFetch();
      }
    }
  }

  /**
   * Generates a chunk of up to maxBytes (default <= 1024 bytes) for this tick.
   */
  public produceChunk(maxBytes: number): Buffer | null {
    if (this.isClosed) return null;
    const len = Math.min(1024, Math.max(1, maxBytes));

    if (this.mode === 'local') {
      // Fast zero-fill or random pattern
      const buf = Buffer.alloc(len, 0xaa);
      return buf;
    } else {
      // Internet mode: pull from upstream buffer
      if (this.upstreamBuffer.length > 0) {
        const top = this.upstreamBuffer[0]!;
        if (top.length <= len) {
          this.upstreamBuffer.shift();
          this.upstreamBufferedBytes -= top.length;
          return top;
        } else {
          const slice = top.subarray(0, len);
          this.upstreamBuffer[0] = top.subarray(len);
          this.upstreamBufferedBytes -= len;
          return slice;
        }
      } else {
        // Fallback local chunk if upstream is fetching
        return Buffer.alloc(len, 0x55);
      }
    }
  }

  /**
   * Called by the shaper when a chunk is transmitted out of rootQueue.
   */
  public transmitChunk(chunk: Buffer): boolean {
    if (this.isClosed || this.res.writableEnded) return false;

    this.totalBytesSent += chunk.length;
    const canContinue = this.res.write(chunk);
    if (!canContinue) {
      this.isPaused = true;
    }
    return canContinue;
  }

  private startInternetFetch(): void {
    if (this.upstreamReq) return;
    const client = this.internetSourceUrl.startsWith('https') ? https : http;

    try {
      this.upstreamReq = client.get(this.internetSourceUrl, (res) => {
        res.on('data', (data: Buffer) => {
          this.upstreamBuffer.push(data);
          this.upstreamBufferedBytes += data.length;

          // Pause upstream if we have buffered more than 256 KB
          if (this.upstreamBufferedBytes > 256 * 1024) {
            res.pause();
          }
        });

        res.on('end', () => {
          this.upstreamReq = undefined;
          if (!this.isClosed && this.mode === 'internet') {
            // Reopen when upstream stream ends
            setTimeout(() => this.startInternetFetch(), 500);
          }
        });
      });

      this.upstreamReq.on('error', () => {
        this.upstreamReq = undefined;
      });
    } catch {
      this.upstreamReq = undefined;
    }
  }

  private stopInternetFetch(): void {
    if (this.upstreamReq) {
      try {
        this.upstreamReq.destroy();
      } catch {}
      this.upstreamReq = undefined;
    }
    this.upstreamBuffer = [];
    this.upstreamBufferedBytes = 0;
  }

  public destroy(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.stopInternetFetch();
    try {
      if (!this.res.writableEnded) {
        this.res.end();
      }
    } catch {}
    this.onClose(this.sessionId);
  }
}
