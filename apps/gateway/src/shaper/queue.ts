export interface QueueChunk {
  sliceCode: string;
  data: Buffer;
  isProbe?: boolean;
  probeSeq?: number;
  enqueuedAtNs: bigint;
  sessionId?: string;
  onTransmit?: (chunk: QueueChunk) => void;
}

export class FifoQueue {
  private items: QueueChunk[] = [];
  private currentBytes = 0;
  private maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(1024, Math.floor(maxBytes));
  }

  public setCapacityBytes(maxBytes: number): void {
    this.maxBytes = Math.max(1024, Math.floor(maxBytes));
  }

  public getCapacityBytes(): number {
    return this.maxBytes;
  }

  public getDepthBytes(): number {
    return this.currentBytes;
  }

  public getDepthCount(): number {
    return this.items.length;
  }

  /**
   * Attempts to enqueue a chunk.
   * Returns true if enqueued; returns false if dropped (tail-drop).
   */
  public enqueue(chunk: QueueChunk): boolean {
    const chunkLen = chunk.data.length;
    if (this.currentBytes + chunkLen > this.maxBytes) {
      // Tail drop
      return false;
    }
    this.items.push(chunk);
    this.currentBytes += chunkLen;
    return true;
  }

  public dequeue(): QueueChunk | undefined {
    const item = this.items.shift();
    if (item) {
      this.currentBytes -= item.data.length;
    }
    return item;
  }

  public peek(): QueueChunk | undefined {
    return this.items[0];
  }

  public clear(): void {
    this.items = [];
    this.currentBytes = 0;
  }
}
