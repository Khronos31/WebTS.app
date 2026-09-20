import { describe, expect, it } from 'vitest';
import { runLibusbCancelWorker, type LibusbCancelWorkerReport } from '../src/usb/libusb-cancel-worker-diagnostic';
import { runLibusbCancelSettleWorker } from '../src/usb/libusb-cancel-settle-worker-diagnostic';
import { runLibusbEventSmokeWorker } from '../src/usb/libusb-cancel-event-worker-diagnostic';
import { runLibusbUserFreeWorker } from '../src/usb/libusb-cancel-user-free-worker-diagnostic';
import { runLibusbPendingCloseWorker } from '../src/usb/libusb-pending-close-worker-diagnostic';
import type { DiagnosticWorkerLike } from '../src/usb/webusb-worker-diagnostic';

class FakeWorker implements DiagnosticWorkerLike {
  private readonly listeners = new Map<'message' | 'error', Set<(event: MessageEvent<unknown> | ErrorEvent) => void>>([
    ['message', new Set()], ['error', new Set()],
  ]);
  onPost: (worker: FakeWorker) => void = () => undefined;
  terminated = false;
  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void { this.listeners.get(type)?.add(listener); }
  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void { this.listeners.get(type)?.delete(listener); }
  postMessage(): void { this.onPost(this); }
  terminate(): void { this.terminated = true; }
  message(data: unknown): void { for (const listener of this.listeners.get('message') ?? []) listener({ data } as MessageEvent<unknown>); }
  error(): void { for (const listener of this.listeners.get('error') ?? []) listener({} as ErrorEvent); }
}

const observed: LibusbCancelWorkerReport = {
  diagnostic: 'OBSERVED', backendCancelReturn: 0,
  callbacksBeforePromiseSettlement: 0,
  callbacksAfterTaskTurnWithoutPromiseSettlement: 0,
  transferStatusWhilePromisePending: 255, fakeTransferInCalls: 1,
  cancelDidNotSettleWithinTaskTurn: true, fakePromiseStillPending: true,
  physicalAbortProven: false,
};

describe('libusb cancellation Worker diagnostic', () => {
  it('accepts the fixed source-bound observation and terminates the Worker', async () => {
    let worker: FakeWorker | undefined;
    const report = await runLibusbCancelWorker('/worker.js', 100, () => {
      const current = new FakeWorker();
      current.onPost = () => queueMicrotask(() => current.message({ type: 'libusb-cancel-worker-result', report: observed }));
      worker = current;
      return current;
    });
    expect(report).toEqual(observed);
    expect(worker?.terminated).toBe(true);
  });

  it('returns fixed diagnostics for malformed replies and timeout', async () => {
    const malformed = await runLibusbCancelWorker('/worker.js', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = () => queueMicrotask(() => worker.message({ type: 'wrong', raw: 'hidden' }));
      return worker;
    });
    expect(malformed).toMatchObject({ diagnostic: 'INVALID_RESULT', physicalAbortProven: false });

    let pending: FakeWorker | undefined;
    const timeout = await runLibusbCancelWorker('/worker.js', 1, () => {
      pending = new FakeWorker();
      return pending;
    });
    expect(timeout).toMatchObject({ diagnostic: 'TIMEOUT', backendCancelReturn: null });
    expect(pending?.terminated).toBe(true);
  });

  it('accepts the separate exactly-once CANCELLED settle report', async () => {
    let worker: FakeWorker | undefined;
    const report = await runLibusbCancelSettleWorker('/worker.js', 100, () => {
      const current = new FakeWorker();
      current.onPost = () => queueMicrotask(() => current.message({
        type: 'libusb-cancel-worker-result',
        report: {
          diagnostic: 'OBSERVED', callbackCount: 1, callbackStatus: 3,
          eventResult: 0, backendCancelReturn: 0, physicalAbortProven: false,
        },
      }));
      worker = current;
      return current;
    });
    expect(report).toMatchObject({ diagnostic: 'OBSERVED', callbackCount: 1, callbackStatus: 3 });
    expect(worker?.terminated).toBe(true);
  });

  it('forwards only fixed progress stages and reports the last stage on timeout', async () => {
    let worker: FakeWorker | undefined;
    const report = await runLibusbCancelSettleWorker('/worker.js', 10, () => {
      const current = new FakeWorker();
      current.onPost = () => {
        queueMicrotask(() => current.message({ type: 'libusb-cancel-worker-progress', stage: 7 }));
        queueMicrotask(() => current.message({ type: 'libusb-cancel-worker-progress', stage: 999 }));
      };
      worker = current;
      return current;
    });
    expect(report).toMatchObject({ diagnostic: 'TIMEOUT', stage: 7 });
    expect(worker?.terminated).toBe(true);
  });

  it('accepts the fixed event-loop discriminator and preserves timeout stage', async () => {
    let worker: FakeWorker | undefined;
    const report = await runLibusbEventSmokeWorker('/worker.js', 100, () => {
      const current = new FakeWorker();
      current.onPost = () => queueMicrotask(() => current.message({
        type: 'libusb-cancel-worker-result',
        report: { diagnostic: 'OBSERVED', eventClass: 'NO_EVENT_TIMEOUT', physicalAbortProven: false },
      }));
      worker = current;
      return current;
    });
    expect(report).toMatchObject({ diagnostic: 'OBSERVED', eventClass: 'NO_EVENT_TIMEOUT', stage: null });
    expect(worker?.terminated).toBe(true);

    const timeout = await runLibusbEventSmokeWorker('/worker.js', 10, () => {
      const current = new FakeWorker();
      current.onPost = () => queueMicrotask(() => current.message({ type: 'libusb-cancel-worker-progress', stage: 3 }));
      return current;
    });
    expect(timeout).toMatchObject({ diagnostic: 'TIMEOUT', stage: 3 });
  });

  it('accepts the source-bound callback-free report and preserves its timeout stage', async () => {
    let worker: FakeWorker | undefined;
    const report = await runLibusbUserFreeWorker('/worker.js', 100, () => {
      const current = new FakeWorker();
      current.onPost = () => queueMicrotask(() => current.message({
        type: 'libusb-cancel-worker-result',
        report: {
          diagnostic: 'OBSERVED', callbackCount: 1, callbackStatus: 3,
          eventResult: 0, backendCancelReturn: 0, freedInCallback: true,
          physicalAbortProven: false,
        },
      }));
      worker = current;
      return current;
    });
    expect(report).toMatchObject({ diagnostic: 'OBSERVED', freedInCallback: true, stage: null });
    expect(worker?.terminated).toBe(true);

    const timeout = await runLibusbUserFreeWorker('/worker.js', 10, () => {
      const current = new FakeWorker();
      current.onPost = () => queueMicrotask(() => current.message({ type: 'libusb-cancel-worker-progress', stage: 20 }));
      return current;
    });
    expect(timeout).toMatchObject({ diagnostic: 'TIMEOUT', stage: 20 });
  });

  it('accepts the pending-close observation and keeps timeout stage fixed', async () => {
    let worker: FakeWorker | undefined;
    const report = await runLibusbPendingCloseWorker('/worker.js', 100, () => {
      const current = new FakeWorker();
      current.onPost = () => queueMicrotask(() => current.message({
        type: 'libusb-cancel-worker-result',
        report: {
          diagnostic: 'OBSERVED', callbacks: 0, status: 255, closeReturned: true,
          fakeTransferInCalls: 1, promiseSettlementObserved: false,
          physicalAbortProven: false,
        },
      }));
      worker = current;
      return current;
    });
    expect(report).toMatchObject({ diagnostic: 'OBSERVED', closeReturned: true, stage: null });
    expect(worker?.terminated).toBe(true);

    const timeout = await runLibusbPendingCloseWorker('/worker.js', 10, () => {
      const current = new FakeWorker();
      current.onPost = () => queueMicrotask(() => current.message({ type: 'libusb-cancel-worker-progress', stage: 26 }));
      return current;
    });
    expect(timeout).toMatchObject({ diagnostic: 'TIMEOUT', stage: 26 });
  });
});
