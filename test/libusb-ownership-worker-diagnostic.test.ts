import { describe, expect, it } from 'vitest';
import {
  LIBUSB_OWNERSHIP_SCENARIOS,
  fixedOwnershipReport,
  ownershipModuleUrl,
  runLibusbOwnershipWorker,
} from '../src/usb/libusb-ownership-worker-diagnostic';
import type { DiagnosticWorkerLike } from '../src/usb/webusb-worker-diagnostic';

class FakeWorker implements DiagnosticWorkerLike {
  private readonly listeners = new Map<'message' | 'error', Set<(event: MessageEvent<unknown> | ErrorEvent) => void>>([
    ['message', new Set()], ['error', new Set()],
  ]);
  onPost: (worker: FakeWorker, message: unknown) => void = () => undefined;
  terminated = false;
  lastMessage: unknown = null;
  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void { this.listeners.get(type)?.add(listener); }
  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void { this.listeners.get(type)?.delete(listener); }
  postMessage(message: unknown): void { this.lastMessage = message; this.onPost(this, message); }
  terminate(): void { this.terminated = true; }
  message(data: unknown): void { for (const listener of this.listeners.get('message') ?? []) listener({ data } as MessageEvent<unknown>); }
  error(): void { for (const listener of this.listeners.get('error') ?? []) listener({} as ErrorEvent); }
}

function observedReport(scenario: number, overrides: Record<string, unknown> = {}) {
  return {
    diagnostic: 'OK', scenario, stage: 8, callbackCount: 1, callbackStatus: 3,
    cancelReturn: 0, secondCancelReturn: -1000, eventResult: 0, privConstructed: 1,
    privDestroyed: 1, logicalSignals: 1, lateAfterDetach: 0, lateAfterSettle: 0,
    freedInCallback: 0, secondHandleClosed: 0, callbackCountB: 0, callbackStatusB: -1,
    transferredBytes: -1, suppressedConsoleErrors: 0, fakeTransferInCalls: 1,
    physicalAbortProven: false, realUsbUsed: false, ...overrides,
  };
}

function reply(_scenario: number, report: unknown) {
  return (worker: FakeWorker) => {
    queueMicrotask(() => worker.message({
      type: 'libusb-ownership-worker-result', report,
    }));
  };
}

describe('libusb transfer ownership Worker diagnostic', () => {
  it('names one generated module per backend variant', () => {
    expect(ownershipModuleUrl('stock')).toContain('ownership-worker-stock-browser.js');
    expect(ownershipModuleUrl('patched')).toContain('ownership-worker-patched-browser.js');
    expect(LIBUSB_OWNERSHIP_SCENARIOS).toHaveLength(10);
  });

  it('passes the requested scenario to the Worker and returns the fixed report', async () => {
    let worker: FakeWorker | undefined;
    const expected = observedReport(3, { freedInCallback: 1, lateAfterDetach: 1 });
    const report = await runLibusbOwnershipWorker(3, 'patched', 100, () => {
      const current = new FakeWorker();
      current.onPost = reply(3, expected);
      worker = current;
      return current;
    });
    expect(report).toEqual(expected);
    expect(worker?.terminated).toBe(true);
    expect(worker?.lastMessage).toMatchObject({
      type: 'run-ownership-scenario', scenario: 3,
    });
  });

  it('keeps the stock failure baseline as a reportable diverged result', async () => {
    const diverged = observedReport(0, {
      diagnostic: 'DIVERGED', callbackCount: 0, callbackStatus: -1,
      privConstructed: -1, privDestroyed: -1, logicalSignals: -1,
      lateAfterDetach: -1, lateAfterSettle: -1,
    });
    const report = await runLibusbOwnershipWorker(0, 'stock', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = reply(0, diverged);
      return worker;
    });
    expect(report.diagnostic).toBe('DIVERGED');
    expect(report.callbackCount).toBe(0);
    expect(report.physicalAbortProven).toBe(false);
  });

  it('rejects a report that names a different scenario', async () => {
    const report = await runLibusbOwnershipWorker(1, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = reply(1, observedReport(5));
      return worker;
    });
    expect(report).toEqual(fixedOwnershipReport('INVALID_RESULT'));
  });

  it('rejects malformed replies, unknown diagnostics and non-integer fields', async () => {
    const wrongType = await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = (current) => queueMicrotask(() => current.message({ type: 'other' }));
      return worker;
    });
    expect(wrongType).toEqual(fixedOwnershipReport('INVALID_RESULT'));

    const unknownDiagnostic = await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = reply(0, observedReport(0, { diagnostic: 'SOMETHING_ELSE' }));
      return worker;
    });
    expect(unknownDiagnostic).toEqual(fixedOwnershipReport('INVALID_RESULT'));

    const fractional = await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = reply(0, observedReport(0, { callbackCount: 1.5 }));
      return worker;
    });
    expect(fractional).toEqual(fixedOwnershipReport('INVALID_RESULT'));
  });

  it('bounds the fixture with a timeout and terminates the Worker', async () => {
    let pending: FakeWorker | undefined;
    const report = await runLibusbOwnershipWorker(0, 'patched', 1, () => {
      pending = new FakeWorker();
      return pending;
    });
    expect(report).toEqual(fixedOwnershipReport('TIMEOUT'));
    expect(pending?.terminated).toBe(true);
  });

  it('returns fixed diagnostics for Worker errors and invalid arguments', async () => {
    const workerError = await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      const worker = new FakeWorker();
      worker.onPost = (current) => queueMicrotask(() => current.error());
      return worker;
    });
    expect(workerError).toEqual(fixedOwnershipReport('WORKER_FAILED'));

    const outOfRange = await runLibusbOwnershipWorker(99, 'patched', 100, () => new FakeWorker());
    expect(outOfRange).toEqual(fixedOwnershipReport('UNKNOWN_SCENARIO'));

    const badTimeout = await runLibusbOwnershipWorker(0, 'patched', 0, () => new FakeWorker());
    expect(badTimeout).toEqual(fixedOwnershipReport('WORKER_FAILED'));

    const throwingFactory = await runLibusbOwnershipWorker(0, 'patched', 100, () => {
      throw new Error('construction refused');
    });
    expect(throwingFactory).toEqual(fixedOwnershipReport('WORKER_FAILED'));
  });

  it('never exposes a physical abort or real USB claim', () => {
    for (const diagnostic of ['OK', 'DIVERGED', 'TIMEOUT', 'WORKER_FAILED'] as const) {
      const report = fixedOwnershipReport(diagnostic);
      expect(report.physicalAbortProven).toBe(false);
      expect(report.realUsbUsed).toBe(false);
      expect(Object.isFrozen(report)).toBe(true);
    }
  });
});
