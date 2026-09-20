import type { DiagnosticWorkerLike } from './webusb-worker-diagnostic';

export type LibusbUserFreeDiagnostic = 'OBSERVED' | 'FAILED' | 'TIMEOUT' | 'WORKER_FAILED' | 'INVALID_RESULT';
export interface LibusbUserFreeReport {
  readonly diagnostic: LibusbUserFreeDiagnostic;
  readonly callbackCount: number | null;
  readonly callbackStatus: number | null;
  readonly eventResult: number | null;
  readonly backendCancelReturn: number | null;
  readonly freedInCallback: boolean | null;
  readonly physicalAbortProven: false;
  /** Fixed native stage, exposed only for a timed-out Worker. */
  readonly stage: number | null;
}
type WorkerResponse =
  | { readonly type: 'libusb-cancel-worker-result'; readonly report: LibusbUserFreeReport }
  | { readonly type: 'libusb-cancel-worker-progress'; readonly stage: unknown };
const defaultModuleUrl = '/build/libusb-webusb-cancel-worker-zero-fastpath/libusb-webusb-cancel-worker-zero-fastpath-browser.js';

export function runLibusbUserFreeWorker(
  moduleUrl = defaultModuleUrl,
  timeoutMs = 10_000,
  workerFactory: () => DiagnosticWorkerLike = () => new Worker(
    new URL('./libusb-cancel-worker.ts', import.meta.url), { type: 'module' },
  ),
): Promise<LibusbUserFreeReport> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.resolve(fixedReport('WORKER_FAILED'));
  let worker: DiagnosticWorkerLike;
  try { worker = workerFactory(); } catch { return Promise.resolve(fixedReport('WORKER_FAILED')); }
  return new Promise((resolve) => {
    let settled = false;
    let lastStage: number | null = null;
    const finish = (report: LibusbUserFreeReport) => {
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
        if (Number.isSafeInteger(stage) && (stage as number) >= 14 && (stage as number) <= 22) lastStage = stage as number;
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
    try { worker.postMessage({ type: 'run-user-free', moduleUrl }); }
    catch { finish(fixedReport('WORKER_FAILED')); }
  });
}

export function fixedReport(diagnostic: LibusbUserFreeDiagnostic, stage: number | null = null): LibusbUserFreeReport {
  return Object.freeze({ diagnostic, callbackCount: null, callbackStatus: null, eventResult: null,
    backendCancelReturn: null, freedInCallback: null, physicalAbortProven: false as const, stage });
}

function isReport(value: unknown): value is LibusbUserFreeReport {
  try {
    const report = value as Partial<LibusbUserFreeReport> | null;
    if (!report || (report.stage !== undefined && report.stage !== null)) return false;
    if (report.diagnostic === 'OBSERVED') {
      return report.callbackCount === 1 && report.callbackStatus === 3 && report.eventResult === 0 &&
        report.backendCancelReturn === 0 && report.freedInCallback === true && report.physicalAbortProven === false;
    }
    return (report.diagnostic === 'FAILED' || report.diagnostic === 'TIMEOUT' ||
      report.diagnostic === 'WORKER_FAILED' || report.diagnostic === 'INVALID_RESULT') &&
      report.callbackCount === null && report.callbackStatus === null && report.eventResult === null &&
      report.backendCancelReturn === null && report.freedInCallback === null && report.physicalAbortProven === false;
  } catch { return false; }
}
