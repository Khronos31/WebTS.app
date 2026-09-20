/** Fixed-code wrapper for the upstream Siano ts_queue fixture. */
export interface SianoTsQueueModule {
  readonly HEAPU8: Uint8Array;
  ccall(
    name: 'webts_siano_ts_queue_mock',
    returnType: 'number',
    argTypes: readonly ['number', 'number', 'number'],
    args: readonly [number, number, number],
    opts: { readonly async: true },
  ): number | Promise<number>;
  _malloc(size: number): number;
  _free(pointer: number): void;
}

export type SianoTsQueueDiagnostic = 'OK' | 'REJECTED' | 'INVALID_ARGUMENT' | 'INTERNAL';

export interface SianoTsQueueReport {
  readonly diagnostic: SianoTsQueueDiagnostic;
  readonly acceptedBytes: number;
  readonly dequeuedBytes: number;
  readonly droppedChunks: number;
  readonly queuedChunks: number;
  readonly fifoVerified: boolean;
  readonly reinitialized: boolean;
  readonly acceptedChunks: number;
}

const WORDS = 7;
const BYTES = WORDS * Uint32Array.BYTES_PER_ELEMENT;

/** Runs only synthetic queue operations; no USB, TS stream, or payload exits the module. */
export async function runSianoTsQueueMock(
  moduleFactory: () => SianoTsQueueModule | Promise<SianoTsQueueModule>,
  scenario: number,
): Promise<SianoTsQueueReport> {
  if (!Number.isSafeInteger(scenario) || scenario < 0 || scenario > 4) return invalidReport();
  let module: SianoTsQueueModule;
  try {
    module = await moduleFactory();
    if (!isValidModule(module)) return internalReport();
  } catch {
    return internalReport();
  }
  let pointer = 0;
  try {
    pointer = module._malloc(BYTES);
    if (!Number.isSafeInteger(pointer) || pointer <= 0) return internalReport();
    const raw = await module.ccall(
      'webts_siano_ts_queue_mock',
      'number',
      ['number', 'number', 'number'],
      [scenario, pointer, WORDS],
      { async: true },
    );
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > 0xffffffff) return internalReport();
    const words = readWords(module.HEAPU8, pointer, WORDS);
    if (words === null || words[0] !== raw) return internalReport();
    const diagnostic = decodeDiagnostic(words[0]);
    if (diagnostic === 'INTERNAL' || diagnostic === 'INVALID_ARGUMENT') return internalReport(diagnostic);
    return Object.freeze({
      diagnostic,
      acceptedBytes: words[1],
      dequeuedBytes: words[2],
      droppedChunks: words[3],
      queuedChunks: words[4],
      fifoVerified: (words[5] & (1 << 1)) !== 0,
      reinitialized: (words[5] & (1 << 2)) !== 0,
      acceptedChunks: words[6],
    });
  } catch {
    return internalReport();
  } finally {
    if (pointer > 0) {
      try { module._free(pointer); } catch { /* fixed diagnostics only */ }
    }
  }
}

function isValidModule(value: unknown): value is SianoTsQueueModule {
  try {
    const module = value as Partial<SianoTsQueueModule> | null;
    return Boolean(module && module.HEAPU8 instanceof Uint8Array &&
      typeof module.ccall === 'function' && typeof module._malloc === 'function' &&
      typeof module._free === 'function');
  } catch {
    return false;
  }
}

function readWords(heap: Uint8Array, pointer: number, count: number): number[] | null {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer + count * 4 > heap.byteLength) return null;
  const view = new DataView(heap.buffer, heap.byteOffset + pointer, count * 4);
  const words: number[] = [];
  for (let index = 0; index < count; index++) words.push(view.getUint32(index * 4, true));
  return words;
}

function decodeDiagnostic(value: number): SianoTsQueueDiagnostic {
  if (value === 0) return 'OK';
  if (value === 1) return 'REJECTED';
  if (value === 2) return 'INVALID_ARGUMENT';
  return 'INTERNAL';
}

function invalidReport(): SianoTsQueueReport {
  return Object.freeze({ diagnostic: 'INVALID_ARGUMENT', acceptedBytes: 0, dequeuedBytes: 0,
    droppedChunks: 0, queuedChunks: 0, fifoVerified: false, reinitialized: false, acceptedChunks: 0 });
}

function internalReport(diagnostic: 'INTERNAL' | 'INVALID_ARGUMENT' = 'INTERNAL'): SianoTsQueueReport {
  return Object.freeze({ diagnostic, acceptedBytes: 0, dequeuedBytes: 0, droppedChunks: 0,
    queuedChunks: 0, fifoVerified: false, reinitialized: false, acceptedChunks: 0 });
}
