export {};

// Test-only Dedicated Worker for the libusb transfer-ownership regression.
// It loads one opt-in generated module, which installs a fake navigator.usb of
// its own, and runs exactly one scenario. No real USB, requestDevice, firmware,
// tune, TS or B25 path is reachable from here. The caller terminates the Worker
// after one scenario, because an unmet expectation parks libusb state.

interface OwnershipModule {
  ccall(
    name: string,
    returnType: 'number',
    argTypes: readonly string[],
    args: readonly number[],
    options?: { async: true },
  ): Promise<number>;
  _malloc(size: number): number;
  _free(pointer: number): void;
  readonly HEAPU8: Uint8Array;
}

interface WorkerRequest {
  readonly type: 'run-ownership-scenario';
  readonly moduleUrl: string;
  readonly scenario: number;
}

export const REPORT_WORDS = 20;

export const REPORT_FIELDS = [
  'scenario', 'stage', 'callbackCount', 'callbackStatus', 'cancelReturn',
  'secondCancelReturn', 'eventResult', 'privConstructed', 'privDestroyed',
  'logicalSignals', 'lateAfterDetach', 'lateAfterSettle', 'freedInCallback',
  'secondHandleClosed', 'callbackCountB', 'callbackStatusB', 'transferredBytes',
  'suppressedConsoleErrors', 'fakeTransferInCalls', 'physicalAbortProven',
] as const;

const DIAGNOSTICS = ['OK', 'DIVERGED', 'UNKNOWN_SCENARIO', 'INVALID_OUTPUT',
  'SETUP_FAILED', 'HARNESS_FAILED'] as const;

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = async (event) => {
  if (!event.data || event.data.type !== 'run-ownership-scenario') return;
  const report = await execute(event.data.moduleUrl, event.data.scenario);
  scope.postMessage({ type: 'libusb-ownership-worker-result', report });
};

async function execute(moduleUrl: string, scenario: number): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(scenario) || scenario < 0 || scenario > 32) {
    return failed('INVALID_RESULT');
  }
  let module: OwnershipModule;
  try {
    const imported = (await import(/* @vite-ignore */ moduleUrl)) as { default?: unknown };
    if (typeof imported.default !== 'function') return failed('WORKER_FAILED');
    module = await (imported.default as () => Promise<OwnershipModule>)();
  } catch {
    return failed('WORKER_FAILED');
  }

  let pointer = 0;
  try {
    pointer = module._malloc(REPORT_WORDS * 4);
    if (!Number.isSafeInteger(pointer) || pointer <= 0) return failed('WORKER_FAILED');
    const code = await module.ccall(
      'webts_libusb_ownership_regression', 'number',
      ['number', 'number', 'number'], [scenario, pointer, REPORT_WORDS], { async: true },
    );
    const diagnostic = DIAGNOSTICS[code];
    if (diagnostic === undefined) return failed('INVALID_RESULT');
    const view = new DataView(
      module.HEAPU8.buffer as ArrayBuffer, module.HEAPU8.byteOffset + pointer, REPORT_WORDS * 4,
    );
    const report: Record<string, unknown> = { diagnostic };
    REPORT_FIELDS.forEach((field, index) => {
      report[field] = view.getInt32(index * 4, true);
    });
    report.physicalAbortProven = false;
    report.realUsbUsed = false;
    return report;
  } catch {
    return failed('WORKER_FAILED');
  } finally {
    try {
      if (pointer > 0) {
        module.HEAPU8.fill(0, pointer, pointer + REPORT_WORDS * 4);
        module._free(pointer);
      }
    } catch {
      // fixed diagnostics only
    }
  }
}

function failed(diagnostic: 'WORKER_FAILED' | 'INVALID_RESULT'): Record<string, unknown> {
  const report: Record<string, unknown> = { diagnostic };
  for (const field of REPORT_FIELDS) report[field] = null;
  report.physicalAbortProven = false;
  report.realUsbUsed = false;
  return report;
}
