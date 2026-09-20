import type { DiagnosticWorkerLike } from './webusb-worker-diagnostic';

export type LibusbPendingCloseDiagnostic = 'OBSERVED' | 'FAILED' | 'TIMEOUT' | 'WORKER_FAILED' | 'INVALID_RESULT';
export interface LibusbPendingCloseReport {
  readonly diagnostic: LibusbPendingCloseDiagnostic;
  readonly callbacks: number | null;
  readonly status: number | null;
  readonly closeReturned: boolean;
  readonly fakeTransferInCalls: number | null;
  readonly promiseSettlementObserved: false;
  readonly physicalAbortProven: false;
  /** Fixed native stage, exposed only for a timed-out Worker. */
  readonly stage: number | null;
}
type WorkerResponse =
  | { readonly type: 'libusb-cancel-worker-result'; readonly report: LibusbPendingCloseReport }
  | { readonly type: 'libusb-cancel-worker-progress'; readonly stage: unknown };
const defaultModuleUrl = '/build/libusb-webusb-cancel-worker-zero-fastpath/libusb-webusb-cancel-worker-zero-fastpath-browser.js';

export function runLibusbPendingCloseWorker(
  moduleUrl = defaultModuleUrl,
  timeoutMs = 10_000,
  workerFactory: () => DiagnosticWorkerLike = () => new Worker(
    new URL('./libusb-cancel-worker.ts', import.meta.url), { type: 'module' },
  ),
): Promise<LibusbPendingCloseReport> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.resolve(fixedReport('WORKER_FAILED'));
  let worker: DiagnosticWorkerLike;
  try { worker = workerFactory(); } catch { return Promise.resolve(fixedReport('WORKER_FAILED')); }
  return new Promise((resolve) => {
    let settled = false;
    let lastStage: number | null = null;
    const finish = (report: LibusbPendingCloseReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      try { worker.terminate(); } catch { /* fixed diagnostic only */ }
      resolve(report);
    };
    const onMessage = (event: MessageEvent<unknown> | ErrorEvent) => {
      const data = 'data' in event ? event.data as WorkerResponse | null : null;
      if (data?.type === 'libusb-cancel-worker-progress') {
        const stage = data.stage;
        if (Number.isSafeInteger(stage) && (stage as number) >= 23 && (stage as number) <= 28) lastStage = stage as number;
        return;
      }
      if (data?.type !== 'libusb-cancel-worker-result' || !isReport(data.report)) {
        finish(fixedReport('INVALID_RESULT'));
        return;
      }
      finish({ ...data.report, stage: null });
    };
    const onError = () => finish(fixedReport('WORKER_FAILED'));
    const timer = setTimeout(() => finish(fixedReport('TIMEOUT', lastStage)), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try { worker.postMessage({ type: 'run-pending-close', moduleUrl }); }
    catch { finish(fixedReport('WORKER_FAILED')); }
  });
}

export function fixedReport(diagnostic: LibusbPendingCloseDiagnostic, stage: number | null = null): LibusbPendingCloseReport {
  return Object.freeze({ diagnostic, callbacks: null, status: null, closeReturned: false,
    fakeTransferInCalls: null, promiseSettlementObserved: false as const,
    physicalAbortProven: false as const, stage });
}

function isReport(value: unknown): value is LibusbPendingCloseReport {
  try {
    const report = value as Partial<LibusbPendingCloseReport> | null;
    if (!report || (report.stage !== undefined && report.stage !== null)) return false;
    if (report.diagnostic === 'OBSERVED') {
      return report.callbacks === 0 && report.status === 255 && report.closeReturned === true &&
        report.fakeTransferInCalls === 1 && report.promiseSettlementObserved === false && report.physicalAbortProven === false;
    }
    return (report.diagnostic === 'FAILED' || report.diagnostic === 'TIMEOUT' ||
      report.diagnostic === 'WORKER_FAILED' || report.diagnostic === 'INVALID_RESULT') &&
      report.callbacks === null && report.status === null && report.closeReturned === false &&
      report.fakeTransferInCalls === null && report.promiseSettlementObserved === false && report.physicalAbortProven === false;
  } catch { return false; }
}
