import { describe, expect, it } from 'vitest';
import {
  BoundedByteQueue,
  ManagedTunerAdapter,
  TunerAdapterError,
  type TunerOperations,
} from '../src/tuner';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('BoundedByteQueue', () => {
  it('preserves FIFO and owns copies on enqueue and dequeue', () => {
    const queue = new BoundedByteQueue({ maxBytes: 8, maxChunks: 3, overflowPolicy: 'drop-oldest' });
    const source = bytes(1, 2);
    expect(queue.enqueue(source)).toBe(true);
    source[0] = 9;
    const result = queue.dequeue();
    expect(result).toEqual(bytes(1, 2));
    expect(result).not.toBe(source);
    if (result) result[0] = 8;
    expect(queue.getStats()).toMatchObject({ queued: 0, accepted: 2, dequeued: 2, peak: 2 });
  });

  it('supports drop-oldest and drop-newest byte/chunk limits', () => {
    const oldest = new BoundedByteQueue({ maxBytes: 4, maxChunks: 2, overflowPolicy: 'drop-oldest' });
    oldest.enqueue(bytes(1, 1));
    oldest.enqueue(bytes(2, 2));
    oldest.enqueue(bytes(3, 3));
    expect(oldest.drain()).toEqual([bytes(2, 2), bytes(3, 3)]);
    expect(oldest.getStats()).toMatchObject({ dropped: 2, droppedChunks: 1 });

    const newest = new BoundedByteQueue({ maxBytes: 4, maxChunks: 2, overflowPolicy: 'drop-newest' });
    newest.enqueue(bytes(1, 1));
    newest.enqueue(bytes(2, 2));
    expect(newest.enqueue(bytes(3, 3))).toBe(false);
    expect(newest.drain()).toEqual([bytes(1, 1), bytes(2, 2)]);
    expect(newest.getStats()).toMatchObject({ dropped: 2, droppedChunks: 1 });
  });

  it('accounts for clear and clear overflow policy', () => {
    const queue = new BoundedByteQueue({ maxBytes: 4, maxChunks: 2, overflowPolicy: 'clear' });
    queue.enqueue(bytes(1, 2));
    queue.enqueue(bytes(3, 4));
    queue.enqueue(bytes(5, 6, 7));
    expect(queue.drain()).toEqual([bytes(5, 6, 7)]);
    expect(queue.getStats()).toMatchObject({ cleared: 4, clearedChunks: 2, accepted: 7 });
  });
});

describe('ManagedTunerAdapter', () => {
  it('runs the lifecycle and cleans up a streaming close', async () => {
    const calls: string[] = [];
    const operations: TunerOperations = {
      open: async () => { calls.push('open'); },
      firmware: async () => { calls.push('firmware'); },
      tune: async () => { calls.push('tune'); },
      start: async () => { calls.push('start'); },
      stop: async () => { calls.push('stop'); },
      close: async () => { calls.push('close'); },
    };
    const adapter = new ManagedTunerAdapter(operations);
    const states: string[] = [];
    adapter.onStatusChange((status) => states.push(status.state));
    await adapter.open();
    await adapter.firmware();
    await adapter.tune({ channel: 13 });
    await adapter.start();
    await adapter.close();
    expect(calls).toEqual(['open', 'firmware', 'tune', 'start', 'stop', 'close']);
    expect(adapter.state).toBe('CLOSED');
    expect(adapter.getStatus().sessionId).toBe(1);
    expect(states).toContain('STREAMING');
  });

  it('rejects invalid order and concurrent operations', async () => {
    const adapter = new ManagedTunerAdapter();
    await expect(adapter.start()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(adapter.open()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    let resolveOpen!: () => void;
    const opening = new Promise<void>((resolve) => { resolveOpen = resolve; });
    const active = new ManagedTunerAdapter({ open: () => opening, close: async () => {} });
    const first = active.open();
    await expect(active.open()).rejects.toMatchObject({ code: 'BUSY' });
    resolveOpen();
    await first;

    const missingClose = new ManagedTunerAdapter({ open: async () => {} });
    await expect(missingClose.open()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });

    const missingStop = new ManagedTunerAdapter({ open: async () => {}, close: async () => {}, tune: async () => {}, start: async () => {} });
    await missingStop.open();
    await missingStop.tune({ channel: 13 });
    await expect(missingStop.start()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('prevents stale completion after disconnect', async () => {
    let resolveOpen!: () => void;
    const opening = new Promise<void>((resolve) => { resolveOpen = resolve; });
    let closeCalls = 0;
    const adapter = new ManagedTunerAdapter({ open: () => opening, close: async () => { closeCalls += 1; } });
    const promise = adapter.open();
    adapter.disconnect();
    expect(adapter.state).toBe('DISCONNECTED');
    resolveOpen();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
    expect(adapter.state).toBe('DISCONNECTED');
    expect(closeCalls).toBe(1);
  });

  it('honours external abort and restores the prior state', async () => {
    let resolveOpen!: () => void;
    const opening = new Promise<void>((resolve) => { resolveOpen = resolve; });
    let closeCalls = 0;
    const adapter = new ManagedTunerAdapter({ open: () => opening, close: async () => { closeCalls += 1; } });
    const controller = new AbortController();
    const promise = adapter.open(controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(TunerAdapterError);
    resolveOpen();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(adapter.state).toBe('IDLE');
    expect(closeCalls).toBe(1);
  });

  it('stops a stream that completes after start is aborted', async () => {
    let resolveStart!: () => void;
    const starting = new Promise<void>((resolve) => { resolveStart = resolve; });
    let stopCalls = 0;
    const adapter = new ManagedTunerAdapter({
      open: async () => {},
      close: async () => {},
      tune: async () => {},
      start: () => starting,
      stop: async () => { stopCalls += 1; },
    });
    await adapter.open();
    await adapter.tune({ channel: 13 });
    const controller = new AbortController();
    const promise = adapter.start(controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
    resolveStart();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(stopCalls).toBe(1);
    expect(adapter.state).toBe('TUNED');
  });

  it('reflects a delayed stop success after abort in the lifecycle state', async () => {
    let resolveStop!: () => void;
    const stopping = new Promise<void>((resolve) => { resolveStop = resolve; });
    const adapter = new ManagedTunerAdapter({
      open: async () => {}, close: async () => {}, tune: async () => {}, start: async () => {}, stop: () => stopping,
    });
    await adapter.open();
    await adapter.tune({ channel: 13 });
    await adapter.start();
    const controller = new AbortController();
    const promise = adapter.stop(controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
    resolveStop();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(adapter.state).toBe('TUNED');
    expect(adapter.getStatus().error).toMatchObject({ code: 'ABORTED', operation: 'stop' });
  });

  it('reflects a delayed close success after abort as CLOSED', async () => {
    let resolveClose!: () => void;
    const closing = new Promise<void>((resolve) => { resolveClose = resolve; });
    const adapter = new ManagedTunerAdapter({ open: async () => {}, close: () => closing });
    await adapter.open();
    const controller = new AbortController();
    const promise = adapter.close(controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
    resolveClose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(adapter.state).toBe('CLOSED');
    expect(adapter.getStatus().error).toMatchObject({ code: 'ABORTED', operation: 'close' });
  });

  it('attempts compensating cleanup when open or start partially fails', async () => {
    const openCalls: string[] = [];
    const openFailure = new Error('open failed');
    const openAdapter = new ManagedTunerAdapter({
      open: async () => { openCalls.push('open'); throw openFailure; },
      close: async () => { openCalls.push('close'); },
    });
    await expect(openAdapter.open()).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    expect(openCalls).toEqual(['open', 'close']);
    expect(openAdapter.state).toBe('IDLE');

    const startCalls: string[] = [];
    const startFailure = new Error('start failed');
    const startAdapter = new ManagedTunerAdapter({
      open: async () => {},
      close: async () => {},
      tune: async () => {},
      start: async () => { startCalls.push('start'); throw startFailure; },
      stop: async () => { startCalls.push('stop'); },
    });
    await startAdapter.open();
    await startAdapter.tune({ channel: 13 });
    await expect(startAdapter.start()).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    expect(startCalls).toEqual(['start', 'stop']);
    expect(startAdapter.state).toBe('TUNED');
  });

  it('always attempts close after stop failure and preserves both cleanup errors', async () => {
    const stopError = new Error('stop failed');
    const closeError = new Error('close failed');
    const calls: string[] = [];
    const adapter = new ManagedTunerAdapter({
      open: async () => {},
      tune: async () => {},
      start: async () => {},
      stop: async () => { calls.push('stop'); throw stopError; },
      close: async () => { calls.push('close'); throw closeError; },
    });
    await adapter.open();
    await adapter.tune({ channel: 13 });
    await adapter.start();
    const result = adapter.close();
    await expect(result).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    expect(calls).toEqual(['stop', 'close']);
    expect(adapter.state).toBe('STREAMING');
    const failure = await result.catch((error: unknown) => error as TunerAdapterError) as TunerAdapterError;
    expect(failure.cause).toEqual({ code: 'OPERATION_FAILED', operation: 'close', cleanupFailed: true });
    expect(adapter.getStatus().error).toEqual({ code: 'OPERATION_FAILED', operation: 'close', cleanupFailed: true });
  });

  it('keeps OPEN state when close fails before any tuning', async () => {
    const closeError = new Error('close failed');
    const adapter = new ManagedTunerAdapter({ open: async () => {}, close: async () => { throw closeError; } });
    await adapter.open();
    await expect(adapter.close()).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    expect(adapter.state).toBe('OPEN');
  });
});
