import type { DiagnosticWorkerLike } from './webusb-worker-diagnostic';

// Window-side wrapper for the test-only libusb transfer-ownership regression
// Worker. It owns the bounded timeout and the Worker terminate, and converts
// anything unexpected into a fixed diagnostic. Worker termination is not a
// claim that pending WebUSB promises, libusb handles, or physical transfers
// were released.

export type LibusbOwnershipDiagnostic =
  | 'OK'
  | 'DIVERGED'
  | 'UNKNOWN_SCENARIO'
  | 'INVALID_OUTPUT'
  | 'SETUP_FAILED'
  | 'HARNESS_FAILED'
  | 'TIMEOUT'
  | 'WORKER_FAILED'
  | 'INVALID_RESULT';

export const LIBUSB_OWNERSHIP_SCENARIOS = Object.freeze([
  'pending-cancel-bounded',
  'late-resolve-after-cancel',
  'late-reject-after-cancel',
  'user-free-then-late-resolve',
  'double-cancel',
  'disconnect-while-pending',
  'multi-handle-cancel-close',
  'natural-completion',
  'disconnect-user-free-then-late-resolve',
  'cancel-then-disconnect-before-events',
] as const);

export type LibusbOwnershipScenario = (typeof LIBUSB_OWNERSHIP_SCENARIOS)[number];

export const LIBUSB_OWNERSHIP_VARIANTS = Object.freeze(['stock', 'patched'] as const);
export type LibusbOwnershipVariant = (typeof LIBUSB_OWNERSHIP_VARIANTS)[number];

export interface LibusbOwnershipReport {
  readonly diagnostic: LibusbOwnershipDiagnostic;
  readonly scenario: number | null;
  readonly stage: number | null;
  readonly callbackCount: number | null;
  readonly callbackStatus: number | null;
  readonly cancelReturn: number | null;
  readonly secondCancelReturn: number | null;
  readonly eventResult: number | null;
  readonly privConstructed: number | null;
  readonly privDestroyed: number | null;
  readonly logicalSignals: number | null;
  readonly lateAfterDetach: number | null;
  readonly lateAfterSettle: number | null;
  readonly freedInCallback: number | null;
  readonly secondHandleClosed: number | null;
  readonly callbackCountB: number | null;
  readonly callbackStatusB: number | null;
  readonly transferredBytes: number | null;
  readonly suppressedConsoleErrors: number | null;
  readonly fakeTransferInCalls: number | null;
  readonly physicalAbortProven: false;
  readonly realUsbUsed: false;
}

const NUMERIC_FIELDS = Object.freeze([
  'scenario', 'stage', 'callbackCount', 'callbackStatus', 'cancelReturn',
  'secondCancelReturn', 'eventResult', 'privConstructed', 'privDestroyed',
  'logicalSignals', 'lateAfterDetach', 'lateAfterSettle', 'freedInCallback',
  'secondHandleClosed', 'callbackCountB', 'callbackStatusB', 'transferredBytes',
  'suppressedConsoleErrors', 'fakeTransferInCalls',
] as const);

const DIAGNOSTICS = Object.freeze<readonly LibusbOwnershipDiagnostic[]>([
  'OK', 'DIVERGED', 'UNKNOWN_SCENARIO', 'INVALID_OUTPUT', 'SETUP_FAILED',
  'HARNESS_FAILED', 'TIMEOUT', 'WORKER_FAILED', 'INVALID_RESULT',
]);

export function ownershipModuleUrl(variant: LibusbOwnershipVariant): string {
  return `/build/libusb-webusb-ownership-worker/libusb-webusb-ownership-worker-${variant}-browser.js`;
}

export function fixedOwnershipReport(
  diagnostic: LibusbOwnershipDiagnostic,
  stage: number | null = null,
): LibusbOwnershipReport {
  const report: Record<string, unknown> = { diagnostic };
  for (const field of NUMERIC_FIELDS) report[field] = null;
  report.stage = stage;
  report.physicalAbortProven = false;
  report.realUsbUsed = false;
  return Object.freeze(report) as unknown as LibusbOwnershipReport;
}

export function runLibusbOwnershipWorker(
  scenarioIndex: number,
  variant: LibusbOwnershipVariant = 'patched',
  timeoutMs = 15_000,
  workerFactory: () => DiagnosticWorkerLike = () => new Worker(
    new URL('./libusb-ownership-worker.ts', import.meta.url), { type: 'module' },
  ),
  moduleUrl = ownershipModuleUrl(variant),
): Promise<LibusbOwnershipReport> {
  if (!Number.isSafeInteger(scenarioIndex) || scenarioIndex < 0 ||
      scenarioIndex >= LIBUSB_OWNERSHIP_SCENARIOS.length) {
    return Promise.resolve(fixedOwnershipReport('UNKNOWN_SCENARIO'));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(fixedOwnershipReport('WORKER_FAILED'));
  }
  if (!LIBUSB_OWNERSHIP_VARIANTS.includes(variant)) {
    return Promise.resolve(fixedOwnershipReport('WORKER_FAILED'));
  }
  let worker: DiagnosticWorkerLike;
  try { worker = workerFactory(); }
  catch { return Promise.resolve(fixedOwnershipReport('WORKER_FAILED')); }
  return new Promise((resolve) => {
    let settled = false;
    // The C++ harness posts fixed numeric progress stages. They are ignored for
    // the result, and only the last one is surfaced when the Worker times out.
    let lastStage: number | null = null;
    const finish = (report: LibusbOwnershipReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      // Terminate after exactly one scenario. This bounds the fixture; it does
      // not release pending promises, libusb handles, or physical transfers.
      try { worker.terminate(); } catch { /* fixed diagnostic only */ }
      resolve(report);
    };
    const onMessage = (event: MessageEvent<unknown> | ErrorEvent) => {
      const data = 'data' in event
        ? event.data as { type?: unknown; report?: unknown } | null
        : null;
      if (data?.type === 'libusb-ownership-progress') {
        const stage = (data as { readonly stage?: unknown }).stage;
        if (typeof stage === 'number' && Number.isSafeInteger(stage) &&
            stage >= 1 && stage <= 9) {
          lastStage = stage;
        }
        return;
      }
      if (data?.type !== 'libusb-ownership-worker-result') {
        finish(fixedOwnershipReport('INVALID_RESULT'));
        return;
      }
      const report = normalize(data.report, scenarioIndex);
      finish(report ?? fixedOwnershipReport('INVALID_RESULT'));
    };
    const onError = () => finish(fixedOwnershipReport('WORKER_FAILED'));
    const timer = setTimeout(
      () => finish(fixedOwnershipReport('TIMEOUT', lastStage)), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try {
      worker.postMessage({
        type: 'run-ownership-scenario', moduleUrl, scenario: scenarioIndex,
      });
    } catch { finish(fixedOwnershipReport('WORKER_FAILED')); }
  });
}

function normalize(value: unknown, expectedScenario: number): LibusbOwnershipReport | null {
  try {
    const source = value as Record<string, unknown> | null;
    if (!source) return null;
    const diagnostic = source.diagnostic;
    if (typeof diagnostic !== 'string' ||
        !DIAGNOSTICS.includes(diagnostic as LibusbOwnershipDiagnostic)) {
      return null;
    }
    const report: Record<string, unknown> = {
      diagnostic: diagnostic as LibusbOwnershipDiagnostic,
    };
    for (const field of NUMERIC_FIELDS) {
      const raw = source[field];
      if (raw === null) { report[field] = null; continue; }
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return null;
      report[field] = raw;
    }
    // A report that names a different scenario than the one requested is not
    // trusted; the Worker runs exactly one scenario per instance.
    if (report.scenario !== null && report.scenario !== expectedScenario) return null;
    report.physicalAbortProven = false;
    report.realUsbUsed = false;
    return Object.freeze(report) as unknown as LibusbOwnershipReport;
  } catch { return null; }
}
