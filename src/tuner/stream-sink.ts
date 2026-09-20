/**
 * WebTS.app - Payload-free statistics sink for simulated TS input
 * License: GPL-2.0-only
 */

import {
  BoundedByteQueue,
  type ByteQueueOverflowPolicy,
} from './bounded-byte-queue';

export interface StreamMeasurementSample {
  /** Optional externally measured value; this sink never derives it from TS. */
  readonly continuityErrors?: number;
  /** Optional externally sampled process/worker memory in bytes. */
  readonly memoryBytes?: number;
}

export interface TsStreamSinkOptions {
  readonly maxBytes?: number;
  readonly maxChunks?: number;
  readonly overflowPolicy?: ByteQueueOverflowPolicy;
}

export interface TsStreamStats {
  readonly sessionId: number;
  readonly active: boolean;
  readonly receivedBytes: number;
  readonly receivedChunks: number;
  readonly acceptedBytes: number;
  readonly acceptedChunks: number;
  readonly dequeuedBytes: number;
  readonly dequeuedChunks: number;
  readonly droppedBytes: number;
  readonly droppedChunks: number;
  readonly clearedBytes: number;
  readonly clearedChunks: number;
  readonly overflowEvents: number;
  readonly transferErrors: number;
  /** Bytes copied at the queue boundary (enqueue + dequeue copies). */
  readonly copyBytes: number;
  readonly queuedBytes: number;
  readonly queuedChunks: number;
  readonly peakQueuedBytes: number;
  readonly peakQueuedChunks: number;
  /** Null means this sink did not measure TS continuity. */
  readonly continuityErrors: number | null;
  /** Null means no external memory sample was supplied. */
  readonly memoryBytes: number | null;
}

/**
 * Receives simulated Uint8Array chunks into a bounded queue and exposes
 * counters only. It never logs, persists, parses, or returns payloads except
 * through explicit dequeue calls made by the local consumer.
 */
export class TsStreamSink {
  private readonly queue: BoundedByteQueue;
  private session = 1;
  private activeSession = true;
  private receivedBytes = 0;
  private receivedChunks = 0;
  private overflowEvents = 0;
  private transferErrors = 0;
  private copyBytes = 0;
  private continuityErrors: number | null = null;
  private memoryBytes: number | null = null;
  private lastSessionStats: TsStreamStats | null = null;

  public constructor(options: TsStreamSinkOptions = {}) {
    this.queue = new BoundedByteQueue({
      maxBytes: options.maxBytes ?? 1024 * 1024,
      maxChunks: options.maxChunks ?? 1024,
      overflowPolicy: options.overflowPolicy ?? 'drop-oldest',
    });
  }

  public get queueCapacityBytes(): number { return this.queue.capacityBytes; }
  public get queueCapacityChunks(): number { return this.queue.capacityChunks; }

  /** Accept one simulated transfer. No payload is retained outside the queue. */
  public receive(chunk: Uint8Array): boolean {
    if (!this.activeSession) return false;
    if (!(chunk instanceof Uint8Array)) throw new TypeError('chunk must be a Uint8Array');
    this.receivedBytes += chunk.byteLength;
    this.receivedChunks += 1;
    const before = this.queue.getStats();
    const accepted = this.queue.enqueue(chunk);
    const after = this.queue.getStats();
    this.copyBytes += after.accepted - before.accepted;
    const overflowChunks = (after.droppedChunks - before.droppedChunks)
      + (after.clearedChunks - before.clearedChunks);
    // Empty chunks are rejected by the byte queue and counted as dropped, but
    // are invalid input rather than a capacity overflow event.
    if (overflowChunks > 0 && chunk.byteLength > 0) this.overflowEvents += 1;
    return accepted;
  }

  public enqueue(chunk: Uint8Array): boolean { return this.receive(chunk); }

  /** Return one copied chunk to the local consumer. */
  public dequeue(): Uint8Array | undefined {
    if (!this.activeSession) return undefined;
    const before = this.queue.getStats();
    const chunk = this.queue.dequeue();
    const after = this.queue.getStats();
    this.copyBytes += after.dequeued - before.dequeued;
    return chunk;
  }

  public drain(maxChunks?: number): Uint8Array[] {
    const result: Uint8Array[] = [];
    const limit = maxChunks ?? Number.MAX_SAFE_INTEGER;
    validateDrainLimit(limit);
    while (result.length < limit) {
      const chunk = this.dequeue();
      if (!chunk) break;
      result.push(chunk);
    }
    return result;
  }

  /** Count a transfer failure without retaining the error or its message. */
  public recordTransferError(): void {
    if (this.activeSession) this.transferErrors += 1;
  }

  /** Inject measurements obtained by an external sampler; omitted values remain unmeasured. */
  public setMeasurements(sample: StreamMeasurementSample): void {
    if (!this.activeSession) return;
    if (sample.continuityErrors !== undefined) {
      validateMeasurement('continuityErrors', sample.continuityErrors);
      this.continuityErrors = sample.continuityErrors;
    }
    if (sample.memoryBytes !== undefined) {
      validateMeasurement('memoryBytes', sample.memoryBytes);
      this.memoryBytes = sample.memoryBytes;
    }
  }

  /** Clear queued payload while keeping cumulative queue counters and session identity. */
  public clear(): void {
    this.queue.clear();
  }

  /** End the session, discard queued payload, and return its final statistics. */
  public disconnect(): TsStreamStats {
    if (!this.activeSession) return this.lastSessionStats ?? this.getStats();
    this.queue.clear();
    this.activeSession = false;
    const finalStats = this.getStats();
    this.lastSessionStats = finalStats;
    return finalStats;
  }

  /** Start a new session with empty queue and fresh counters. */
  public reconnect(): number {
    if (this.activeSession) {
      throw new Error('Cannot reconnect an active stream session; disconnect first');
    }
    this.session += 1;
    this.queue.reset();
    this.activeSession = true;
    this.resetMetrics();
    return this.session;
  }

  /** Retrieve the most recently disconnected session without retaining payload. */
  public getLastSessionStats(): TsStreamStats | null {
    return this.lastSessionStats;
  }

  public getStats(): TsStreamStats {
    const queueStats = this.queue.getStats();
    return Object.freeze({
      sessionId: this.session,
      active: this.activeSession,
      receivedBytes: this.receivedBytes,
      receivedChunks: this.receivedChunks,
      acceptedBytes: queueStats.accepted,
      acceptedChunks: queueStats.acceptedChunks,
      dequeuedBytes: queueStats.dequeued,
      dequeuedChunks: queueStats.dequeuedChunks,
      droppedBytes: queueStats.dropped,
      droppedChunks: queueStats.droppedChunks,
      clearedBytes: queueStats.cleared,
      clearedChunks: queueStats.clearedChunks,
      overflowEvents: this.overflowEvents,
      transferErrors: this.transferErrors,
      copyBytes: this.copyBytes,
      queuedBytes: queueStats.queued,
      queuedChunks: queueStats.queuedChunks,
      peakQueuedBytes: queueStats.peak,
      peakQueuedChunks: queueStats.peakChunks,
      continuityErrors: this.continuityErrors,
      memoryBytes: this.memoryBytes,
    });
  }

  private resetMetrics(): void {
    this.receivedBytes = 0;
    this.receivedChunks = 0;
    this.overflowEvents = 0;
    this.transferErrors = 0;
    this.copyBytes = 0;
    this.continuityErrors = null;
    this.memoryBytes = null;
  }
}

function validateMeasurement(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function validateDrainLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('maxChunks must be a non-negative safe integer');
}
