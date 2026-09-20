import {
  enumerateAuthorizedDevices,
  WasmEnumerationDiagnosticError,
  type LibusbEnumerationModuleFactory,
  type WasmExecutionContext,
  type WebUsbPermissionSource,
} from './wasm-enumeration-diagnostic';

export type WorkerEnumerationDiagnostic =
  | 'NONE'
  | 'UNSUPPORTED_WEBUSB'
  | 'AUTHORIZED_DEVICE_QUERY_FAILED'
  | 'WASM_UNAVAILABLE'
  | 'INVALID_MODULE'
  | 'WASM_ENUMERATION_FAILED'
  | 'WORKER_FAILED';

export interface WorkerEnumerationReport {
  readonly diagnostic: WorkerEnumerationDiagnostic;
  readonly workerWebUsbAvailable: boolean;
  readonly authorizedDeviceCount: number | null;
  readonly authorizedDeviceCountAfter: number | null;
  readonly authorizedDeviceCountDelta: number | null;
  readonly wasmDeviceCount: number | null;
  readonly wasmWebUsbDeviceCount: number | null;
  readonly wasmDiagnostic: string | null;
  readonly wasmWebUsbDiagnostic: string | null;
  readonly wasmExecutionContext: WasmExecutionContext;
}

/**
 * Runs the existing read-only enumeration contract against a Worker-scoped
 * WebUSB source. The source exposes getDevices only; requestDevice is a
 * rejecting placeholder and is never called by enumerateAuthorizedDevices.
 */
export async function runWorkerEnumeration(
  usb: WebUsbPermissionSource | null,
  moduleFactory: LibusbEnumerationModuleFactory,
): Promise<WorkerEnumerationReport> {
  const workerWebUsbAvailable = usb !== null && typeof usb.getDevices === 'function';
  if (!workerWebUsbAvailable) return fixedReport('UNSUPPORTED_WEBUSB', false);
  try {
    const report = await enumerateAuthorizedDevices(usb, moduleFactory);
    return Object.freeze({
      diagnostic: 'NONE',
      workerWebUsbAvailable: true,
      authorizedDeviceCount: report.authorizedDeviceCount,
      authorizedDeviceCountAfter: report.authorizedDeviceCountAfter,
      authorizedDeviceCountDelta: report.authorizedDeviceCountDelta,
      wasmDeviceCount: report.wasmDeviceCount,
      wasmWebUsbDeviceCount: report.wasmWebUsbDeviceCount,
      wasmDiagnostic: report.wasmDiagnostic,
      wasmWebUsbDiagnostic: report.wasmWebUsbDiagnostic,
      wasmExecutionContext: report.wasmExecutionContext,
    });
  } catch (error) {
    const diagnostic = error instanceof WasmEnumerationDiagnosticError
      ? mapDiagnostic(error.code)
      : 'WORKER_FAILED';
    return fixedReport(diagnostic, true);
  }
}

function mapDiagnostic(code: WasmEnumerationDiagnosticError['code']): WorkerEnumerationDiagnostic {
  switch (code) {
    case 'UNSUPPORTED_WEBUSB':
    case 'AUTHORIZED_DEVICE_QUERY_FAILED':
    case 'WASM_UNAVAILABLE':
    case 'INVALID_MODULE':
    case 'WASM_ENUMERATION_FAILED':
      return code;
    default:
      return 'WORKER_FAILED';
  }
}

function fixedReport(diagnostic: WorkerEnumerationDiagnostic, workerWebUsbAvailable: boolean): WorkerEnumerationReport {
  return Object.freeze({
    diagnostic,
    workerWebUsbAvailable,
    authorizedDeviceCount: null,
    authorizedDeviceCountAfter: null,
    authorizedDeviceCountDelta: null,
    wasmDeviceCount: null,
    wasmWebUsbDeviceCount: null,
    wasmDiagnostic: null,
    wasmWebUsbDiagnostic: null,
    wasmExecutionContext: 'DEDICATED_WORKER',
  });
}

export function getWorkerWebUsbSource(): WebUsbPermissionSource | null {
  const candidate = globalThis as unknown as {
    readonly navigator?: { readonly usb?: { readonly getDevices?: WebUsbPermissionSource['getDevices'] } };
  };
  const getDevices = candidate.navigator?.usb?.getDevices;
  if (typeof getDevices !== 'function') return null;
  return {
    requestDevice: async () => { throw new Error('REQUEST_DEVICE_UNAVAILABLE_IN_WORKER'); },
    getDevices: () => getDevices.call(candidate.navigator?.usb),
  };
}

export interface WorkerEnumerationRequest {
  readonly type: 'enumerate-authorized';
  readonly moduleUrl: string;
}

export interface WorkerEnumerationResponse {
  readonly type: 'enumeration-result';
  readonly report: WorkerEnumerationReport;
}

export interface DiagnosticWorkerLike {
  addEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void;
  removeEventListener(type: 'message' | 'error', listener: (event: MessageEvent<unknown> | ErrorEvent) => void): void;
  postMessage(message: unknown): void;
  terminate(): void;
}

/**
 * Starts the opt-in worker probe. A timeout terminates only the Worker object;
 * it does not claim that a pending WebUSB/libusb operation was physically
 * cancelled or that its device handle was released.
 */
export function runDedicatedWorkerEnumeration(
  moduleUrl: string,
  timeoutMs = 15_000,
  workerFactory: () => DiagnosticWorkerLike = () => new Worker(
    new URL('./webusb-enumeration-worker.ts', import.meta.url), { type: 'module' },
  ),
): Promise<WorkerEnumerationReport> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(fixedReport('WORKER_FAILED', false));
  }
  let worker: DiagnosticWorkerLike;
  try {
    worker = workerFactory();
  } catch {
    return Promise.resolve(fixedReport('WORKER_FAILED', false));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (report: WorkerEnumerationReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      try { worker.terminate(); } catch { /* fixed diagnostics only */ }
      resolve(report);
    };
    const onMessage = (event: MessageEvent<unknown> | ErrorEvent) => {
      const data = 'data' in event ? event.data as Partial<WorkerEnumerationResponse> | null : null;
      if (data?.type !== 'enumeration-result') {
        finish(fixedReport('WORKER_FAILED', false));
        return;
      }
      finish(isReport(data.report) ? data.report : fixedReport('WORKER_FAILED', false));
    };
    const onError = () => finish(fixedReport('WORKER_FAILED', false));
    const timer = setTimeout(() => finish(fixedReport('WORKER_FAILED', false)), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try {
      worker.postMessage({ type: 'enumerate-authorized', moduleUrl });
    } catch {
      finish(fixedReport('WORKER_FAILED', false));
    }
  });
}

function isReport(value: unknown): value is WorkerEnumerationReport {
  try {
    const report = value as Partial<WorkerEnumerationReport> | null;
    return Boolean(report && typeof report.diagnostic === 'string' &&
      typeof report.workerWebUsbAvailable === 'boolean' &&
      typeof report.wasmExecutionContext === 'string');
  } catch {
    return false;
  }
}
