import { describe, expect, it } from 'vitest';
import { runSianoWorkerFixture, type SianoWorkerReport } from '../src/usb/siano-worker-diagnostic';

function fakeWorker(report: SianoWorkerReport, onTerminated: () => void) {
  let message: ((event: MessageEvent) => void) | undefined;
  return {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') message = listener;
    },
    removeEventListener: () => undefined,
    postMessage: () => queueMicrotask(() => message?.({
      data: { type: 'siano-fixture-result', report },
    } as MessageEvent)),
    terminate: onTerminated,
  };
}

describe('Siano Dedicated Worker synthetic fixture boundary', () => {
  it('returns queue aggregates without payload', async () => {
    let terminated = false;
    const report: SianoWorkerReport = {
      diagnostic: 'OK', kind: 'QUEUE', scenario: 0,
      queue: {
        diagnostic: 'OK', acceptedBytes: 5, dequeuedBytes: 5, droppedChunks: 0,
        queuedChunks: 0, fifoVerified: true, reinitialized: true, acceptedChunks: 2,
      },
      liveStats: null,
    };
    await expect(runSianoWorkerFixture('/siano.js', 'QUEUE', 0, 100,
      () => fakeWorker(report, () => { terminated = true; })))
      .resolves.toEqual(report);
    expect(terminated).toBe(true);
  });

  it('returns live stats aggregates and rejects unsupported scenario 4 for live stats', async () => {
    const report: SianoWorkerReport = {
      diagnostic: 'OK', kind: 'LIVE_STATS', scenario: 2,
      queue: null,
      liveStats: {
        diagnostic: 'OK', state: 'STREAMING', generation: 1,
        queueMeasured: true, dropsMeasured: true, transfersMeasured: true,
        streamErrorMeasured: true, queueClosed: false,
        countersSaturated: false,
        acceptedBytes: null, dequeuedBytes: null, droppedBytes: null,
        truncatedBytes: null, transferErrors: null,
        queueChunks: 256, droppedChunks: 1, activeTransfers: 0, streamError: 'NONE',
      },
    };
    await expect(runSianoWorkerFixture('/siano.js', 'LIVE_STATS', 2, 100,
      () => fakeWorker(report, () => undefined)))
      .resolves.toEqual(report);
    await expect(runSianoWorkerFixture('/siano.js', 'LIVE_STATS', 4,
      15_000, () => { throw new Error('must not create worker'); }))
      .resolves.toMatchObject({ diagnostic: 'INVALID_ARGUMENT', liveStats: null });
  });

  it('uses fixed failure on worker timeout', async () => {
    let terminated = false;
    const worker = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      postMessage: () => undefined,
      terminate: () => { terminated = true; },
    };
    await expect(runSianoWorkerFixture('/siano.js', 'QUEUE', 1, 1, () => worker))
      .resolves.toMatchObject({ diagnostic: 'WORKER_FAILED', kind: 'QUEUE', queue: null, liveStats: null });
    expect(terminated).toBe(true);
  });
});
