// Window-side wrapper for the test-only libusb transfer-ownership regression
// Worker. It owns the bounded timeout and the terminate, and turns anything
// unexpected into a fixed diagnostic.
//
// Terminating the Worker bounds this fixture. It is not a claim that pending
// WebUSB promises, libusb handles or physical transfers were released.

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

/** Mirrors VARIANT_SPECS in scripts/lib/libusb-variants.mjs. */
export const LIBUSB_OWNERSHIP_VARIANTS = Object.freeze(['stock', 'patched'] as const);

export type LibusbOwnershipVariant = (typeof LIBUSB_OWNERSHIP_VARIANTS)[number];

const NUMERIC_FIELDS = Object.freeze([
  'scenario', 'stage', 'callbackCount', 'callbackStatus', 'cancelReturn',
  'secondCancelReturn', 'eventResult', 'privConstructed', 'privDestroyed',
  'logicalSignals', 'lateAfterDetach', 'lateAfterSettle', 'freedInCallback',
  'secondHandleClosed', 'callbackCountB', 'callbackStatusB', 'transferredBytes',
  'suppressedConsoleErrors', 'fakeTransferInCalls',
] as const);

export type LibusbOwnershipReport =
  & { readonly diagnostic: LibusbOwnershipDiagnostic }
  & { readonly [K in (typeof NUMERIC_FIELDS)[number]]: number | null }
  & { readonly physicalAbortProven: false; readonly realUsbUsed: false };

const DIAGNOSTICS: readonly string[] = [
  'OK', 'DIVERGED', 'UNKNOWN_SCENARIO', 'INVALID_OUTPUT', 'SETUP_FAILED',
  'HARNESS_FAILED', 'TIMEOUT', 'WORKER_FAILED', 'INVALID_RESULT',
];

export interface OwnershipWorkerLike {
  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void;
  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void;
  postMessage(message: unknown): void;
  terminate(): void;
}

export function ownershipModuleUrl(variant: LibusbOwnershipVariant): string {
  return `/build/libusb-ownership-browser/libusb-ownership-${variant}.mjs`;
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
  timeoutMs = 20_000,
  workerFactory: () => OwnershipWorkerLike = () =>
    new Worker(new URL('./libusb-ownership-worker.ts', import.meta.url), { type: 'module' }),
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

  let worker: OwnershipWorkerLike;
  try {
    worker = workerFactory();
  } catch {
    return Promise.resolve(fixedOwnershipReport('WORKER_FAILED'));
  }

  return new Promise((resolve) => {
    let settled = false;
    // The C++ harness posts fixed numeric progress stages. They never decide
    // the result; only a timeout surfaces the last one reached.
    let lastStage: number | null = null;

    const finish = (report: LibusbOwnershipReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      try { worker.terminate(); } catch { /* fixed diagnostic only */ }
      resolve(report);
    };

    const onMessage = (event: MessageEvent<unknown> | ErrorEvent) => {
      const data = 'data' in event
        ? (event.data as { type?: unknown; stage?: unknown; report?: unknown } | null)
        : null;
      if (data?.type === 'libusb-ownership-progress') {
        const { stage } = data;
        if (typeof stage === 'number' && Number.isSafeInteger(stage) && stage >= 1 && stage <= 9) {
          lastStage = stage;
        }
        return;
      }
      if (data?.type !== 'libusb-ownership-worker-result') {
        finish(fixedOwnershipReport('INVALID_RESULT'));
        return;
      }
      finish(normalize(data.report, scenarioIndex) ?? fixedOwnershipReport('INVALID_RESULT'));
    };

    const onError = () => finish(fixedOwnershipReport('WORKER_FAILED', lastStage));
    const timer = setTimeout(() => finish(fixedOwnershipReport('TIMEOUT', lastStage)), timeoutMs);

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try {
      worker.postMessage({ type: 'run-ownership-scenario', moduleUrl, scenario: scenarioIndex });
    } catch {
      finish(fixedOwnershipReport('WORKER_FAILED'));
    }
  });
}

function normalize(value: unknown, expectedScenario: number): LibusbOwnershipReport | null {
  try {
    const source = value as Record<string, unknown> | null;
    if (!source) return null;
    const { diagnostic } = source;
    if (typeof diagnostic !== 'string' || !DIAGNOSTICS.includes(diagnostic)) return null;

    const report: Record<string, unknown> = { diagnostic };
    for (const field of NUMERIC_FIELDS) {
      const raw = source[field];
      if (raw === null) { report[field] = null; continue; }
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return null;
      report[field] = raw;
    }
    // One Worker runs exactly one scenario; a report naming a different one is
    // not trusted.
    if (report.scenario !== null && report.scenario !== expectedScenario) return null;
    report.physicalAbortProven = false;
    report.realUsbUsed = false;
    return Object.freeze(report) as unknown as LibusbOwnershipReport;
  } catch {
    return null;
  }
}
