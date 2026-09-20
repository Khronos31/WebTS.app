import { describe, expect, it } from 'vitest';
import { TsStreamSink } from '../src/tuner';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('TsStreamSink', () => {
  it('counts reception, queue copies, dequeue, depth, and peak without retaining input ownership', () => {
    const sink = new TsStreamSink({ maxBytes: 8, maxChunks: 2, overflowPolicy: 'drop-newest' });
    const input = bytes(1, 2);
    expect(sink.receive(input)).toBe(true);
    input[0] = 9;
    const output = sink.dequeue();
    expect(output).toEqual(bytes(1, 2));
    expect(output).not.toBe(input);
    expect(sink.getStats()).toMatchObject({
      receivedBytes: 2,
      receivedChunks: 1,
      acceptedBytes: 2,
      dequeuedBytes: 2,
      copyBytes: 4,
      queuedBytes: 0,
      peakQueuedBytes: 2,
    });
  });

  it('counts overflow, drops, transfer errors, and externally supplied measurements', () => {
    const sink = new TsStreamSink({ maxBytes: 4, maxChunks: 2, overflowPolicy: 'drop-oldest' });
    sink.receive(bytes(1, 1));
    sink.receive(bytes(2, 2));
    expect(sink.receive(bytes(3, 3))).toBe(true);
    sink.recordTransferError();
    sink.setMeasurements({ continuityErrors: 3, memoryBytes: 12345 });
    expect(sink.getStats()).toMatchObject({
      receivedBytes: 6,
      acceptedBytes: 6,
      droppedBytes: 2,
      droppedChunks: 1,
      overflowEvents: 1,
      transferErrors: 1,
      queuedBytes: 4,
      peakQueuedBytes: 4,
      continuityErrors: 3,
      memoryBytes: 12345,
    });
    expect(sink.drain()).toEqual([bytes(2, 2), bytes(3, 3)]);
  });

  it('marks continuity and memory as unmeasured by default', () => {
    const stats = new TsStreamSink({ maxBytes: 4, maxChunks: 1 }).getStats();
    expect(stats.continuityErrors).toBeNull();
    expect(stats.memoryBytes).toBeNull();
  });

  it('uses bounded drop-oldest by default and validates input before counting it', () => {
    const sink = new TsStreamSink({ maxBytes: 4, maxChunks: 2 });
    sink.receive(bytes(1, 1));
    sink.receive(bytes(2, 2));
    expect(sink.receive(bytes(3, 3))).toBe(true);
    expect(sink.drain()).toEqual([bytes(2, 2), bytes(3, 3)]);
    expect(sink.getStats()).toMatchObject({ overflowEvents: 1, droppedBytes: 2, clearedBytes: 0 });

    expect(() => sink.receive({ byteLength: 1 } as unknown as Uint8Array)).toThrow(TypeError);
    expect(sink.getStats().receivedBytes).toBe(6);
    expect(sink.receive(new Uint8Array())).toBe(false);
    expect(sink.getStats()).toMatchObject({ overflowEvents: 1, droppedChunks: 2 });
    expect(() => sink.drain(-1)).toThrow(RangeError);
  });

  it('counts one overflow event per receive even when several chunks are dropped', () => {
    const sink = new TsStreamSink({ maxBytes: 6, maxChunks: 3, overflowPolicy: 'drop-oldest' });
    sink.receive(bytes(1, 1));
    sink.receive(bytes(2, 2));
    sink.receive(bytes(3, 3));
    expect(sink.receive(bytes(4, 4, 4, 4))).toBe(true);
    expect(sink.getStats()).toMatchObject({ overflowEvents: 1, droppedChunks: 2, droppedBytes: 4 });
  });

  it('clears the old queue and starts fresh metrics on disconnect/reconnect', () => {
    const sink = new TsStreamSink({ maxBytes: 8, maxChunks: 2 });
    expect(() => sink.reconnect()).toThrow(/disconnect first/);
    sink.receive(bytes(1, 2));
    sink.recordTransferError();
    sink.setMeasurements({ continuityErrors: 1, memoryBytes: 10 });
    const firstSession = sink.getStats().sessionId;
    const finalStats = sink.disconnect();
    expect(finalStats).toMatchObject({
      sessionId: firstSession,
      active: false,
      receivedBytes: 2,
      transferErrors: 1,
      queuedBytes: 0,
      clearedBytes: 2,
      continuityErrors: 1,
      memoryBytes: 10,
    });
    expect(sink.receive(bytes(3))).toBe(false);
    expect(sink.dequeue()).toBeUndefined();
    expect(sink.getStats()).toMatchObject({
      sessionId: firstSession,
      active: false,
      receivedBytes: 2,
      transferErrors: 1,
      queuedBytes: 0,
      clearedBytes: 2,
      continuityErrors: 1,
      memoryBytes: 10,
    });
    expect(sink.getLastSessionStats()).toEqual(finalStats);

    expect(sink.reconnect()).toBe(firstSession + 1);
    sink.receive(bytes(4, 5));
    expect(sink.getStats()).toMatchObject({
      sessionId: firstSession + 1,
      active: true,
      receivedBytes: 2,
      acceptedBytes: 2,
      queuedBytes: 2,
      transferErrors: 0,
      continuityErrors: null,
      memoryBytes: null,
    });
    expect(sink.dequeue()).toEqual(bytes(4, 5));
  });
});
