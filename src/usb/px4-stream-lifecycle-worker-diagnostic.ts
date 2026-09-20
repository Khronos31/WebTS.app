import type { DiagnosticWorkerLike } from './webusb-worker-diagnostic';

export type Px4WorkerFixtureDiagnostic =
  | 'OK'
  | 'WASM_UNAVAILABLE'
  | 'WORKER_FAILED'
  | 'TIMEOUT'
  | 'INVALID_RESULT';

export interface Px4WorkerFixtureReport {
  readonly diagnostic: Px4WorkerFixtureDiagnostic;
  readonly attached: boolean;
  readonly readBytes: number | null;
  readonly packets: number | null;
  readonly bytes: number | null;
  readonly finalTerminal: number | null;
  readonly detached: boolean;
  readonly released: boolean;
  readonly shutdown: boolean;
}

interface Px4WorkerFixtureResponse {
  readonly type: 'px4-worker-fixture-result';
  readonly report: Px4WorkerFixtureReport;
}

const defaultModuleUrl = '/build/upstream-wasm/px4-stream-lifecycle-worker-browser.js';

export function runPx4StreamLifecycleWorker(
  moduleUrl = defaultModuleUrl,
  timeoutMs = 15_000,
  workerFactory: () => DiagnosticWorkerLike = () => new Worker(
    new URL('./px4-stream-lifecycle-worker.ts', import.meta.url), { type: 'module' },
  ),
): Promise<Px4WorkerFixtureReport> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(fixedReport('WORKER_FAILED'));
  }
  let worker: DiagnosticWorkerLike;
  try {
    worker = workerFactory();
  } catch {
    return Promise.resolve(fixedReport('WORKER_FAILED'));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (report: Px4WorkerFixtureReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      try { worker.terminate(); } catch { /* fixed diagnostics only */ }
      resolve(report);
    };
    const onMessage = (event: MessageEvent<unknown> | ErrorEvent) => {
      const data = 'data' in event ? event.data as Partial<Px4WorkerFixtureResponse> | null : null;
      if (data?.type !== 'px4-worker-fixture-result') {
        finish(fixedReport('INVALID_RESULT'));
        return;
      }
      if (!isValidReport(data.report)) {
        finish(fixedReport('INVALID_RESULT'));
        return;
      }
      finish(data.report);
    };
    const onError = () => finish(fixedReport('WORKER_FAILED'));
    const timer = setTimeout(() => finish(fixedReport('TIMEOUT')), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try {
      worker.postMessage({ type: 'run', moduleUrl });
    } catch {
      finish(fixedReport('WORKER_FAILED'));
    }
  });
}

export function fixedReport(diagnostic: Px4WorkerFixtureDiagnostic): Px4WorkerFixtureReport {
  return Object.freeze({
    diagnostic,
    attached: false,
    readBytes: null,
    packets: null,
    bytes: null,
    finalTerminal: null,
    detached: false,
    released: false,
    shutdown: false,
  });
}

function isValidReport(value: unknown): value is Px4WorkerFixtureReport {
  try {
    const report = value as Partial<Px4WorkerFixtureReport> | null;
    if (!report) return false;
    if (report.diagnostic === 'OK') {
      return report.attached === true && report.readBytes === 188 &&
        report.packets === 2 && report.bytes === 376 && report.finalTerminal === 5 &&
        report.detached === true && report.released === true && report.shutdown === true;
    }
    return (report.diagnostic === 'WASM_UNAVAILABLE' ||
      report.diagnostic === 'WORKER_FAILED' || report.diagnostic === 'TIMEOUT' ||
      report.diagnostic === 'INVALID_RESULT') && report.attached === false &&
      report.readBytes === null && report.packets === null && report.bytes === null &&
      report.finalTerminal === null && report.detached === false &&
      report.released === false && report.shutdown === false;
  } catch {
    return false;
  }
}
