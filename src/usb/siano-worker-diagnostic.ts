import type { SianoLiveStatsReport } from './siano-live-stats-diagnostic';
import type { SianoTsQueueReport } from './siano-ts-queue-diagnostic';
import { type DiagnosticWorkerLike } from './webusb-worker-diagnostic';

export type SianoWorkerFixtureKind = 'QUEUE' | 'LIVE_STATS';
export type SianoWorkerDiagnostic = 'OK' | 'INVALID_ARGUMENT' | 'INTERNAL' | 'WASM_UNAVAILABLE' | 'WORKER_FAILED';

export interface SianoWorkerReport {
  readonly diagnostic: SianoWorkerDiagnostic;
  readonly kind: SianoWorkerFixtureKind;
  readonly scenario: number;
  readonly queue: SianoTsQueueReport | null;
  readonly liveStats: SianoLiveStatsReport | null;
}

export interface SianoWorkerRequest {
  readonly type: 'siano-fixture';
  readonly moduleUrl: string;
  readonly kind: SianoWorkerFixtureKind;
  readonly scenario: number;
}

export interface SianoWorkerResponse {
  readonly type: 'siano-fixture-result';
  readonly report: SianoWorkerReport;
}

export function runSianoWorkerFixture(
  moduleUrl: string,
  kind: SianoWorkerFixtureKind,
  scenario: number,
  timeoutMs = 15_000,
  workerFactory: () => DiagnosticWorkerLike = () => new Worker(
    new URL('./webusb-enumeration-worker.ts', import.meta.url), { type: 'module' },
  ),
): Promise<SianoWorkerReport> {
  const maxScenario = kind === 'QUEUE' ? 4 : 3;
  if (!Number.isSafeInteger(scenario) || scenario < 0 || scenario > maxScenario) {
    return Promise.resolve(fixedReport('INVALID_ARGUMENT', kind, scenario));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(fixedReport('WORKER_FAILED', kind, scenario));
  }
  let worker: DiagnosticWorkerLike;
  try {
    worker = workerFactory();
  } catch {
    return Promise.resolve(fixedReport('WORKER_FAILED', kind, scenario));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (report: SianoWorkerReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      try { worker.terminate(); } catch { /* fixed diagnostics only */ }
      resolve(report);
    };
    const onMessage = (event: MessageEvent<unknown> | ErrorEvent) => {
      const data = 'data' in event ? event.data as Partial<SianoWorkerResponse> | null : null;
      if (data?.type !== 'siano-fixture-result') {
        finish(fixedReport('WORKER_FAILED', kind, scenario));
        return;
      }
      const report = data.report;
      finish(isReport(report) ? report : fixedReport('WORKER_FAILED', kind, scenario));
    };
    const onError = () => finish(fixedReport('WORKER_FAILED', kind, scenario));
    const timer = setTimeout(() => finish(fixedReport('WORKER_FAILED', kind, scenario)), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try {
      worker.postMessage({ type: 'siano-fixture', moduleUrl, kind, scenario });
    } catch {
      finish(fixedReport('WORKER_FAILED', kind, scenario));
    }
  });
}

function isReport(value: unknown): value is SianoWorkerReport {
  try {
    const report = value as Partial<SianoWorkerReport> | null;
    return Boolean(report && (report.kind === 'QUEUE' || report.kind === 'LIVE_STATS') &&
      typeof report.diagnostic === 'string' && Number.isSafeInteger(report.scenario));
  } catch {
    return false;
  }
}

export function fixedReport(
  diagnostic: SianoWorkerDiagnostic,
  kind: SianoWorkerFixtureKind,
  scenario: number,
): SianoWorkerReport {
  return Object.freeze({ diagnostic, kind, scenario, queue: null, liveStats: null });
}
