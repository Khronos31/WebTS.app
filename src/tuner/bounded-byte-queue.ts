/**
 * WebTS.app - Bounded byte queue for the streaming pipeline
 * License: GPL-2.0-only
 */

export type ByteQueueOverflowPolicy = 'drop-oldest' | 'drop-newest' | 'reject' | 'clear';

export interface BoundedByteQueueOptions {
  readonly maxBytes: number;
  readonly maxChunks: number;
  readonly overflowPolicy?: ByteQueueOverflowPolicy;
}

export interface ByteQueueStats {
  /** All counters are bytes; *Chunks fields provide event counts. */
  readonly queued: number;
  readonly peak: number;
  readonly accepted: number;
  readonly dequeued: number;
  readonly dropped: number;
  readonly cleared: number;
  readonly queuedChunks: number;
  readonly peakChunks: number;
  readonly acceptedChunks: number;
  readonly dequeuedChunks: number;
  readonly droppedChunks: number;
  readonly clearedChunks: number;
}

function validateLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function validateDrainLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('maxChunks to drain must be a non-negative safe integer');
  }
}

/** A FIFO queue with explicit byte/chunk limits and copy ownership. */
export class BoundedByteQueue {
  private readonly maxBytes: number;
  private readonly maxChunks: number;
  private readonly overflowPolicy: ByteQueueOverflowPolicy;
  private readonly chunks: Uint8Array[] = [];
  private queuedBytes = 0;
  private peakBytes = 0;
  private peakChunkCount = 0;
  private acceptedBytes = 0;
  private dequeuedBytes = 0;
  private droppedBytes = 0;
  private clearedBytes = 0;
  private acceptedChunkCount = 0;
  private dequeuedChunkCount = 0;
  private droppedChunkCount = 0;
  private clearedChunkCount = 0;

  public constructor(options: BoundedByteQueueOptions);
  public constructor(maxBytes: number, maxChunks: number, overflowPolicy?: ByteQueueOverflowPolicy);
  public constructor(
    optionsOrMaxBytes: BoundedByteQueueOptions | number,
    maxChunks?: number,
    overflowPolicy: ByteQueueOverflowPolicy = 'drop-oldest',
  ) {
    const options = typeof optionsOrMaxBytes === 'number'
      ? { maxBytes: optionsOrMaxBytes, maxChunks: maxChunks ?? 1, overflowPolicy }
      : optionsOrMaxBytes;
    validateLimit('maxBytes', options.maxBytes);
    validateLimit('maxChunks', options.maxChunks);
    this.maxBytes = options.maxBytes;
    this.maxChunks = options.maxChunks;
    this.overflowPolicy = options.overflowPolicy ?? 'drop-oldest';
  }

  public get capacityBytes(): number { return this.maxBytes; }
  public get capacityChunks(): number { return this.maxChunks; }
  public get policy(): ByteQueueOverflowPolicy { return this.overflowPolicy; }
  public get size(): number { return this.queuedBytes; }
  public get length(): number { return this.chunks.length; }
  public get isEmpty(): boolean { return this.chunks.length === 0; }
  public get queuedChunks(): number { return this.chunks.length; }

  /** Enqueue a copy of chunk; returns false when the policy rejects it. */
  public enqueue(chunk: Uint8Array): boolean {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('chunk must be a Uint8Array');
    const incoming = chunk.byteLength;
    if (incoming === 0 || incoming > this.maxBytes) {
      this.droppedBytes += incoming;
      this.droppedChunkCount += 1;
      return false;
    }
    const overLimit = (): boolean =>
      this.queuedBytes + incoming > this.maxBytes || this.chunks.length + 1 > this.maxChunks;
    if (overLimit()) {
      if (this.overflowPolicy === 'drop-newest' || this.overflowPolicy === 'reject') {
        this.droppedBytes += incoming;
        this.droppedChunkCount += 1;
        return false;
      }
      if (this.overflowPolicy === 'clear') this.clear();
      else while (overLimit() && this.chunks.length > 0) this.discardOldest();
    }
    if (overLimit()) {
      this.droppedBytes += incoming;
      this.droppedChunkCount += 1;
      return false;
    }
    this.chunks.push(new Uint8Array(chunk));
    this.queuedBytes += incoming;
    this.acceptedBytes += incoming;
    this.acceptedChunkCount += 1;
    this.peakBytes = Math.max(this.peakBytes, this.queuedBytes);
    this.peakChunkCount = Math.max(this.peakChunkCount, this.chunks.length);
    return true;
  }

  public push(chunk: Uint8Array): boolean { return this.enqueue(chunk); }

  /** Dequeue a copy, so consumers cannot mutate queue-owned storage. */
  public dequeue(): Uint8Array | undefined {
    const chunk = this.chunks.shift();
    if (!chunk) return undefined;
    this.queuedBytes -= chunk.byteLength;
    this.dequeuedBytes += chunk.byteLength;
    this.dequeuedChunkCount += 1;
    return new Uint8Array(chunk);
  }

  public pop(): Uint8Array | undefined { return this.dequeue(); }

  public drain(maxChunks = Number.MAX_SAFE_INTEGER): Uint8Array[] {
    validateDrainLimit(maxChunks);
    const result: Uint8Array[] = [];
    while (result.length < maxChunks) {
      const chunk = this.dequeue();
      if (!chunk) break;
      result.push(chunk);
    }
    return result;
  }

  /** Remove all queued chunks and account for the removed bytes. */
  public clear(): void {
    if (this.chunks.length === 0) return;
    this.clearedBytes += this.queuedBytes;
    this.clearedChunkCount += this.chunks.length;
    this.chunks.length = 0;
    this.queuedBytes = 0;
  }

  /** Clear payload and counters for a new owner/session. */
  public reset(): void {
    this.chunks.length = 0;
    this.queuedBytes = 0;
    this.peakBytes = 0;
    this.peakChunkCount = 0;
    this.acceptedBytes = 0;
    this.dequeuedBytes = 0;
    this.droppedBytes = 0;
    this.clearedBytes = 0;
    this.acceptedChunkCount = 0;
    this.dequeuedChunkCount = 0;
    this.droppedChunkCount = 0;
    this.clearedChunkCount = 0;
  }

  public getStats(): ByteQueueStats {
    return Object.freeze({
      queued: this.queuedBytes,
      peak: this.peakBytes,
      accepted: this.acceptedBytes,
      dequeued: this.dequeuedBytes,
      dropped: this.droppedBytes,
      cleared: this.clearedBytes,
      queuedChunks: this.chunks.length,
      peakChunks: this.peakChunkCount,
      acceptedChunks: this.acceptedChunkCount,
      dequeuedChunks: this.dequeuedChunkCount,
      droppedChunks: this.droppedChunkCount,
      clearedChunks: this.clearedChunkCount,
    });
  }

  public get stats(): ByteQueueStats { return this.getStats(); }

  private discardOldest(): void {
    const chunk = this.chunks.shift();
    if (!chunk) return;
    this.queuedBytes -= chunk.byteLength;
    this.droppedBytes += chunk.byteLength;
    this.droppedChunkCount += 1;
  }
}
