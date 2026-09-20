import { describe, expect, it } from 'vitest';
import {
  runPx4StreamLifecycleWorker,
  type Px4WorkerFixtureReport,
} from '../src/usb/px4-stream-lifecycle-worker-diagnostic';
import type { DiagnosticWorkerLike } from '../src/usb/webusb-worker-diagnostic';

function fakeWorker(post: (worker: FakeWorker) => void): FakeWorker {
  const worker = new FakeWorker();
  worker.onPost = () => post(worker);
  return worker;
}

class FakeWorker implements DiagnosticWorkerLike {
  private readonly listeners = new Map<'message' | 'error', Set<(event: MessageEvent<unknown> | ErrorEvent) => void>>([
    ['message', new Set()], ['error', new Set()],
  ]);
  onPost: () => void = () => undefined;
  terminated = false;

  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void {
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(_message: unknown): void { this.onPost(); }
  terminate(): void { this.terminated = true; }

  message(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data } as MessageEvent<unknown>);
  }

  error(): void {
    for (const listener of this.listeners.get('error') ?? []) listener({} as ErrorEvent);
  }
}

const successReport: Px4WorkerFixtureReport = {
  diagnostic: 'OK', attached: true, readBytes: 188, packets: 2, bytes: 376,
  finalTerminal: 5, detached: true, released: true, shutdown: true,
};

describe('PX4 stream lifecycle Worker diagnostic', () => {
  it('accepts only the complete fixed success report and terminates the worker', async () => {
    let worker: FakeWorker | undefined;
    const report = await runPx4StreamLifecycleWorker('/worker.js', 100, () => {
      const current = fakeWorker((currentWorker) => queueMicrotask(() => currentWorker.message({
        type: 'px4-worker-fixture-result', report: successReport,
      })));
      worker = current;
      return current;
    });
    expect(report).toEqual(successReport);
    expect(worker?.terminated).toBe(true);
  });

  it('sanitizes worker errors and malformed replies to fixed diagnostics', async () => {
    const error = await runPx4StreamLifecycleWorker('/worker.js', 100, () =>
      fakeWorker((current) => queueMicrotask(() => current.error())));
    expect(error).toMatchObject({ diagnostic: 'WORKER_FAILED', attached: false });

    const malformed = await runPx4StreamLifecycleWorker('/worker.js', 100, () =>
      fakeWorker((current) => queueMicrotask(() => current.message({
        type: 'px4-worker-fixture-result', report: { ...successReport, bytes: 375 },
      }))));
    expect(malformed).toMatchObject({ diagnostic: 'INVALID_RESULT', bytes: null });

    const fixedFailure = await runPx4StreamLifecycleWorker('/worker.js', 100, () =>
      fakeWorker((current) => queueMicrotask(() => current.message({
        type: 'px4-worker-fixture-result',
        report: {
          diagnostic: 'WASM_UNAVAILABLE', attached: false, readBytes: null,
          packets: null, bytes: null, finalTerminal: null,
          detached: false, released: false, shutdown: false,
        },
      }))));
    expect(fixedFailure).toMatchObject({ diagnostic: 'WASM_UNAVAILABLE', bytes: null });
  });

  it('terminates and reports TIMEOUT when the worker remains pending', async () => {
    let worker: FakeWorker | undefined;
    const report = await runPx4StreamLifecycleWorker('/worker.js', 1, () => {
      const current = fakeWorker(() => undefined);
      worker = current;
      return current;
    });
    expect(report).toMatchObject({ diagnostic: 'TIMEOUT', shutdown: false });
    expect(worker?.terminated).toBe(true);
  });
});
