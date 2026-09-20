import type { DiagnosticWorkerLike } from './webusb-worker-diagnostic';

export type LibusbCancelWorkerDiagnostic = 'OBSERVED' | 'FAILED' | 'TIMEOUT' | 'WORKER_FAILED' | 'INVALID_RESULT';

export interface LibusbCancelWorkerReport {
  readonly diagnostic: LibusbCancelWorkerDiagnostic;
  readonly backendCancelReturn: number | null;
  readonly callbacksBeforePromiseSettlement: number | null;
  readonly callbacksAfterTaskTurnWithoutPromiseSettlement: number | null;
  readonly transferStatusWhilePromisePending: number | null;
  readonly fakeTransferInCalls: number | null;
  readonly cancelDidNotSettleWithinTaskTurn: boolean;
  readonly fakePromiseStillPending: boolean;
  readonly physicalAbortProven: false;
}

interface WorkerResponse {
  readonly type: 'libusb-cancel-worker-result';
  readonly report: LibusbCancelWorkerReport;
}

const defaultModuleUrl = '/build/libusb-webusb-cancel-worker/libusb-webusb-cancel-worker-browser.js';

export function runLibusbCancelWorker(
  moduleUrl = defaultModuleUrl,
  timeoutMs = 10_000,
  workerFactory: () => DiagnosticWorkerLike = () => new Worker(
    new URL('./libusb-cancel-worker.ts', import.meta.url), { type: 'module' },
  ),
): Promise<LibusbCancelWorkerReport> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.resolve(fixedReport('WORKER_FAILED'));
  let worker: DiagnosticWorkerLike;
  try { worker = workerFactory(); } catch { return Promise.resolve(fixedReport('WORKER_FAILED')); }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (report: LibusbCancelWorkerReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      try { worker.terminate(); } catch { /* fixed diagnostic only */ }
      resolve(report);
    };
    const onMessage = (event: MessageEvent<unknown> | ErrorEvent) => {
      const data = 'data' in event ? event.data as Partial<WorkerResponse> | null : null;
      if (data?.type !== 'libusb-cancel-worker-result' || !isReport(data.report)) {
        finish(fixedReport('INVALID_RESULT'));
        return;
      }
      finish(data.report);
    };
    const onError = () => finish(fixedReport('WORKER_FAILED'));
    const timer = setTimeout(() => finish(fixedReport('TIMEOUT')), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try { worker.postMessage({ type: 'run', moduleUrl }); }
    catch { finish(fixedReport('WORKER_FAILED')); }
  });
}

export function fixedReport(diagnostic: LibusbCancelWorkerDiagnostic): LibusbCancelWorkerReport {
  return Object.freeze({
    diagnostic, backendCancelReturn: null, callbacksBeforePromiseSettlement: null,
    callbacksAfterTaskTurnWithoutPromiseSettlement: null, transferStatusWhilePromisePending: null,
    fakeTransferInCalls: null, cancelDidNotSettleWithinTaskTurn: false,
    fakePromiseStillPending: false, physicalAbortProven: false as const,
  });
}

function isReport(value: unknown): value is LibusbCancelWorkerReport {
  try {
    const report = value as Partial<LibusbCancelWorkerReport> | null;
    if (!report) return false;
    if (report.diagnostic === 'OBSERVED') {
      return report.backendCancelReturn === 0 && report.callbacksBeforePromiseSettlement === 0 &&
        report.callbacksAfterTaskTurnWithoutPromiseSettlement === 0 &&
        report.transferStatusWhilePromisePending === 255 && report.fakeTransferInCalls === 1 &&
        report.cancelDidNotSettleWithinTaskTurn === true && report.fakePromiseStillPending === true &&
        report.physicalAbortProven === false;
    }
    return (report.diagnostic === 'FAILED' || report.diagnostic === 'TIMEOUT' ||
      report.diagnostic === 'WORKER_FAILED' || report.diagnostic === 'INVALID_RESULT') &&
      report.backendCancelReturn === null && report.callbacksBeforePromiseSettlement === null &&
      report.callbacksAfterTaskTurnWithoutPromiseSettlement === null &&
      report.transferStatusWhilePromisePending === null && report.fakeTransferInCalls === null &&
      report.cancelDidNotSettleWithinTaskTurn === false && report.fakePromiseStillPending === false &&
      report.physicalAbortProven === false;
  } catch { return false; }
}
