export {};

interface LifecycleModule {
  readonly HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  ccall(name: string, returnType: 'number', argTypes: string[], args: number[]): number;
}

interface WorkerRequest {
  readonly type: 'run';
  readonly moduleUrl: string;
}

interface WorkerReport {
  readonly diagnostic: 'OK' | 'WASM_UNAVAILABLE' | 'WORKER_FAILED' | 'INVALID_RESULT';
  readonly attached: boolean;
  readonly readBytes: number | null;
  readonly packets: number | null;
  readonly bytes: number | null;
  readonly finalTerminal: number | null;
  readonly detached: boolean;
  readonly released: boolean;
  readonly shutdown: boolean;
}

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
};

workerScope.onmessage = async (event) => {
  if (!event.data || event.data.type !== 'run') return;
  const report = await execute(event.data.moduleUrl);
  workerScope.postMessage({ type: 'px4-worker-fixture-result', report });
};

async function execute(moduleUrl: string): Promise<WorkerReport> {
  let module: LifecycleModule;
  try {
    const imported = await import(/* @vite-ignore */ moduleUrl) as { default?: unknown };
    const factory = imported.default;
    if (typeof factory !== 'function') return failed('WASM_UNAVAILABLE');
    module = await (factory as (options: { locateFile: (path: string) => string }) => Promise<LifecycleModule>)({
      locateFile: (path) => new URL(`/build/upstream-wasm/${path}`, self.location.origin).href,
    });
  } catch {
    return failed('WASM_UNAVAILABLE');
  }
  const words = 10;
  const pointer = module._malloc(words * 4);
  if (!Number.isSafeInteger(pointer) || pointer <= 0) return failed('WORKER_FAILED');
  try {
    const diagnostic = module.ccall('webts_px4_stream_lifecycle_mock', 'number', ['number', 'number'], [pointer, words]);
    const view = new DataView(module.HEAPU8.buffer, module.HEAPU8.byteOffset + pointer, words * 4);
    const values = Array.from({ length: words }, (_, index) => view.getUint32(index * 4, true));
    if (diagnostic !== 0 || values[0] !== 0 || values[1] !== 1 || values[2] !== 188 ||
        values[3] !== 2 || values[4] !== 376 || values[5] !== 5 ||
        values[6] !== 1 || values[7] !== 1 || values[8] !== 1) return failed('INVALID_RESULT');
    return {
      diagnostic: 'OK', attached: true, readBytes: values[2], packets: values[3],
      bytes: values[4], finalTerminal: values[5], detached: true, released: true,
      shutdown: true,
    };
  } catch {
    return failed('WORKER_FAILED');
  } finally {
    module.HEAPU8.fill(0, pointer, pointer + words * 4);
    module._free(pointer);
  }
}

function failed(diagnostic: WorkerReport['diagnostic']): WorkerReport {
  return {
    diagnostic, attached: false, readBytes: null, packets: null, bytes: null,
    finalTerminal: null, detached: false, released: false, shutdown: false,
  };
}
