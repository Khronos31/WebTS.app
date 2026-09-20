import type { DiagnosticWorkerLike } from './webusb-worker-diagnostic';

export type LibusbEventSmokeDiagnostic = 'OBSERVED' | 'FAILED' | 'TIMEOUT' | 'WORKER_FAILED' | 'INVALID_RESULT';
export type LibusbEventSmokeClass = 'SUCCESS' | 'NO_EVENT_TIMEOUT';
export interface LibusbEventSmokeReport {
  readonly diagnostic: LibusbEventSmokeDiagnostic;
  readonly eventClass: LibusbEventSmokeClass | null;
  readonly physicalAbortProven: false;
  /** Fixed native stage, exposed only for a timed-out Worker. */
  readonly stage: number | null;
}
type WorkerResponse =
  | { readonly type: 'libusb-cancel-worker-result'; readonly report: LibusbEventSmokeReport }
  | { readonly type: 'libusb-cancel-worker-progress'; readonly stage: unknown };
const defaultModuleUrl = '/build/libusb-webusb-cancel-worker/libusb-webusb-cancel-worker-browser.js';

export function runLibusbEventSmokeWorker(
  moduleUrl = defaultModuleUrl,
  timeoutMs = 10_000,
  workerFactory: () => DiagnosticWorkerLike = () => new Worker(
    new URL('./libusb-cancel-worker.ts', import.meta.url), { type: 'module' },
  ),
): Promise<LibusbEventSmokeReport> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.resolve(fixedEventReport('WORKER_FAILED'));
  let worker: DiagnosticWorkerLike;
  try { worker = workerFactory(); } catch { return Promise.resolve(fixedEventReport('WORKER_FAILED')); }
  return new Promise((resolve) => {
    let settled = false;
    let lastStage: number | null = null;
    const finish = (report: LibusbEventSmokeReport) => {
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
        if (Number.isSafeInteger(stage) && (stage as number) >= 1 && (stage as number) <= 5) lastStage = stage as number;
        return;
      }
      if (data?.type !== 'libusb-cancel-worker-result' || !isReport(data.report)) {
        finish(fixedEventReport('INVALID_RESULT'));
        return;
      }
      finish({ ...data.report, stage: null });
    };
    const onError = () => finish(fixedEventReport('WORKER_FAILED'));
    const timer = setTimeout(() => finish(fixedEventReport('TIMEOUT', lastStage)), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try { worker.postMessage({ type: 'run-event', moduleUrl }); }
    catch { finish(fixedEventReport('WORKER_FAILED')); }
  });
}

export function fixedEventReport(diagnostic: LibusbEventSmokeDiagnostic, stage: number | null = null): LibusbEventSmokeReport {
  return Object.freeze({ diagnostic, eventClass: null, physicalAbortProven: false as const, stage });
}

function isReport(value: unknown): value is LibusbEventSmokeReport {
  try {
    const report = value as Partial<LibusbEventSmokeReport> | null;
    if (!report || (report.stage !== undefined && report.stage !== null)) return false;
    if (report.diagnostic === 'OBSERVED') {
      return (report.eventClass === 'SUCCESS' || report.eventClass === 'NO_EVENT_TIMEOUT') && report.physicalAbortProven === false;
    }
    return (report.diagnostic === 'FAILED' || report.diagnostic === 'TIMEOUT' ||
      report.diagnostic === 'WORKER_FAILED' || report.diagnostic === 'INVALID_RESULT') &&
      report.eventClass === null && report.physicalAbortProven === false;
  } catch { return false; }
}
