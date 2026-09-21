import { describe, expect, it } from 'vitest';
import {
  LIBUSB_OWNERSHIP_SCENARIOS,
  LIBUSB_OWNERSHIP_VARIANTS,
  fixedOwnershipReport,
  ownershipModuleUrl,
  runLibusbOwnershipWorker,
  type OwnershipWorkerLike,
} from '../src/usb/libusb-ownership-diagnostic';

class FakeWorker implements OwnershipWorkerLike {
  private readonly listeners = new Map<'message' | 'error', Set<(event: MessageEvent<unknown> | ErrorEvent) => void>>([
    ['message', new Set()],
    ['error', new Set()],
  ]);

  onPost: (worker: FakeWorker, message: unknown) => void = () => undefined;
  terminated = false;
  lastMessage: unknown = null;

  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void {
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.lastMessage = message;
    this.onPost(this, message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data } as MessageEvent<unknown>);
    }
  }

  fail(): void {
    for (const listener of this.listeners.get('error') ?? []) listener({} as ErrorEvent);
  }
}

function report(scenario: number, overrides: Record<string, unknown> = {}) {
  return {
    diagnostic: 'OK', scenario, stage: 8, callbackCount: 1, callbackStatus: 3,
    cancelReturn: 0, secondCancelReturn: -1000, eventResult: 0, privConstructed: 1,
    privDestroyed: 1, logicalSignals: 1, lateAfterDetach: 0, lateAfterSettle: 0,
    freedInCallback: 0, secondHandleClosed: 0, callbackCountB: 0, callbackStatusB: -1,
    transferredBytes: -1, suppressedConsoleErrors: 0, fakeTransferInCalls: 1,
    physicalAbortProven: false, realUsbUsed: false, ...overrides,
  };
}

function replyWith(payload: unknown) {
  return (worker: FakeWorker) => {
    queueMicrotask(() => worker.emit({ type: 'libusb-ownership-worker-result', report: payload }));
  };
}

describe('libusb ownership Worker diagnostic', () => {
  it('names one generated module per variant and knows every scenario', () => {
    expect(LIBUSB_OWNERSHIP_VARIANTS).toEqual(['stock', 'patched']);
    expect(LIBUSB_OWNERSHIP_SCENARIOS).toHaveLength(10);
    expect(ownershipModuleUrl('stock')).toContain('libusb-ownership-stock.mjs');
    expect(ownershipModuleUrl('patched')).toContain('libusb-ownership-patched.mjs');
  });

  it('passes the requested scenario through and returns the fixed report', async () => {
    let worker: FakeWorker | undefined;
    const expected = report(3, { freedInCallback: 1, lateAfterDetach: 1 });
    const result = await runLibusbOwnershipWorker(3, 'patched', 100, () => {
      const created = new FakeWorker();
      created.onPost = replyWith(expected);
      worker = created;
      return created;
    });
    expect(result).toEqual(expected);
    expect(worker?.terminated).toBe(true);
    expect(worker?.lastMessage).toMatchObject({ type: 'run-ownership-scenario', scenario: 3 });
  });

  it('keeps the stock failure baseline reportable rather than treating it as an error', async () => {
    const diverged = report(0, {
      diagnostic: 'DIVERGED', callbackCount: 0, callbackStatus: -1,
      privConstructed: -1, privDestroyed: -1, logicalSignals: -1,
      lateAfterDetach: -1, lateAfterSettle: -1,
    });
    const result = await runLibusbOwnershipWorker(0, 'stock', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = replyWith(diverged);
      return worker;
    });
    expect(result.diagnostic).toBe('DIVERGED');
    expect(result.callbackCount).toBe(0);
  });

  it('ignores progress messages and surfaces the last stage only on timeout', async () => {
    let pending: FakeWorker | undefined;
    const result = await runLibusbOwnershipWorker(0, 'patched', 40, () => {
      pending = new FakeWorker();
      pending.onPost = (worker) => {
        worker.emit({ type: 'libusb-ownership-progress', stage: 4 });
        worker.emit({ type: 'libusb-ownership-progress', stage: 6 });
      };
      return pending;
    });
    expect(result.diagnostic).toBe('TIMEOUT');
    expect(result.stage).toBe(6);
    expect(pending?.terminated).toBe(true);
  });

  it('rejects a report that names a different scenario', async () => {
    const result = await runLibusbOwnershipWorker(1, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = replyWith(report(5));
      return worker;
    });
    expect(result).toEqual(fixedOwnershipReport('INVALID_RESULT'));
  });

  it('rejects malformed replies, unknown diagnostics and non-integer fields', async () => {
    const wrongType = await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = (created) => queueMicrotask(() => created.emit({ type: 'other' }));
      return worker;
    });
    expect(wrongType).toEqual(fixedOwnershipReport('INVALID_RESULT'));

    const unknown = await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = replyWith(report(0, { diagnostic: 'SOMETHING_ELSE' }));
      return worker;
    });
    expect(unknown).toEqual(fixedOwnershipReport('INVALID_RESULT'));

    const fractional = await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = replyWith(report(0, { callbackCount: 1.5 }));
      return worker;
    });
    expect(fractional).toEqual(fixedOwnershipReport('INVALID_RESULT'));
  });

  it('returns fixed diagnostics for worker errors and invalid arguments', async () => {
    const errored = await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = (created) => queueMicrotask(() => created.fail());
      return worker;
    });
    expect(errored.diagnostic).toBe('WORKER_FAILED');

    expect(await runLibusbOwnershipWorker(99, 'patched', 100, () => new FakeWorker()))
      .toEqual(fixedOwnershipReport('UNKNOWN_SCENARIO'));
    expect(await runLibusbOwnershipWorker(0, 'patched', 0, () => new FakeWorker()))
      .toEqual(fixedOwnershipReport('WORKER_FAILED'));
    expect(await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      throw new Error('construction refused');
    })).toEqual(fixedOwnershipReport('WORKER_FAILED'));
  });

  it('never claims a physical abort or real USB use', () => {
    for (const diagnostic of ['OK', 'DIVERGED', 'TIMEOUT', 'WORKER_FAILED'] as const) {
      const fixed = fixedOwnershipReport(diagnostic);
      expect(fixed.physicalAbortProven).toBe(false);
      expect(fixed.realUsbUsed).toBe(false);
      expect(Object.isFrozen(fixed)).toBe(true);
    }
  });
});
