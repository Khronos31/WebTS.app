/**
 * Fixed-code wrapper for the source-backed Siano live statistics seam.
 *
 * The native side reports sanitized counters added by an explicit build-time
 * patch against the locked upstream source. Values are decimal strings so a
 * uint64 counter never passes through an imprecise JS number.
 */
export interface SianoLiveStatsModule {
  readonly HEAPU8: Uint8Array;
  ccall(
    name: 'webts_siano_live_stats_snapshot' | 'webts_siano_live_stats_mock',
    returnType: 'number',
    argTypes: readonly ['number', 'number', 'number'],
    args: readonly [number, number, number],
    opts: { readonly async: true },
  ): number | Promise<number>;
  _malloc(size: number): number;
  _free(pointer: number): void;
}

export type SianoLiveStatsDiagnostic =
  | 'OK'
  | 'STALE'
  | 'INVALID_ARGUMENT'
  | 'BUSY'
  | 'POISONED'
  | 'INTERNAL';

export type SianoLiveStatsState =
  | 'IDLE'
  | 'OPEN'
  | 'STREAMING'
  | 'VERSIONED'
  | 'POISONED'
  | 'OPENING'
  | 'CLOSING'
  | 'STARTING';

export type SianoLiveStatsStreamError =
  | 'NONE'
  | 'IO'
  | 'NO_DEVICE'
  | 'INTERRUPTED'
  | 'TIMEOUT'
  | 'OTHER';

export interface SianoLiveStatsReport {
  readonly diagnostic: SianoLiveStatsDiagnostic;
  readonly state: SianoLiveStatsState;
  readonly generation: number;
  readonly queueMeasured: boolean;
  readonly dropsMeasured: boolean;
  readonly transfersMeasured: boolean;
  readonly streamErrorMeasured: boolean;
  readonly queueClosed: boolean;
  readonly countersSaturated: boolean;
  readonly acceptedBytes: string | null;
  readonly dequeuedBytes: string | null;
  readonly droppedBytes: string | null;
  readonly truncatedBytes: string | null;
  readonly transferErrors: string | null;
  readonly queueChunks: number | null;
  readonly droppedChunks: number | null;
  readonly activeTransfers: number | null;
  readonly streamError: SianoLiveStatsStreamError | null;
}

const WORDS = 18;
const BYTES = WORDS * Uint32Array.BYTES_PER_ELEMENT;
const QUEUE_MEASURED = 1 << 0;
const DROPS_MEASURED = 1 << 1;
const TRANSFERS_MEASURED = 1 << 2;
const ERROR_MEASURED = 1 << 3;
const QUEUE_CLOSED = 1 << 4;
const ACCEPTED_UNMEASURED = 1 << 5;
const DEQUEUED_UNMEASURED = 1 << 6;
const TRANSFER_ERRORS_UNMEASURED = 1 << 7;
const COUNTERS_SATURATED = 1 << 9;

const DIAGNOSTICS: readonly SianoLiveStatsDiagnostic[] = [
  'OK', 'STALE', 'INVALID_ARGUMENT', 'BUSY', 'POISONED',
];
const STATES: readonly SianoLiveStatsState[] = [
  'IDLE', 'OPEN', 'STREAMING', 'VERSIONED', 'POISONED',
  'OPENING', 'CLOSING', 'STARTING',
];
const STREAM_ERRORS: readonly SianoLiveStatsStreamError[] = [
  'NONE', 'IO', 'NO_DEVICE', 'INTERRUPTED', 'TIMEOUT', 'OTHER',
];

/** Snapshot the current native session; callers must serialize with lifecycle calls. */
export async function runSianoLiveStatsSnapshot(
  moduleFactory: () => SianoLiveStatsModule | Promise<SianoLiveStatsModule>,
  expectedGeneration = 0,
): Promise<SianoLiveStatsReport> {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || expectedGeneration > 0xffffffff) {
    return invalidReport();
  }
  return runNative(moduleFactory, 'webts_siano_live_stats_snapshot', expectedGeneration);
}

/** Runs only the USB-free native snapshot fixture. */
export async function runSianoLiveStatsMock(
  moduleFactory: () => SianoLiveStatsModule | Promise<SianoLiveStatsModule>,
  scenario: number,
): Promise<SianoLiveStatsReport> {
  if (!Number.isSafeInteger(scenario) || scenario < 0 || scenario > 3) return invalidReport();
  return runNative(moduleFactory, 'webts_siano_live_stats_mock', scenario);
}

async function runNative(
  moduleFactory: () => SianoLiveStatsModule | Promise<SianoLiveStatsModule>,
  name: 'webts_siano_live_stats_snapshot' | 'webts_siano_live_stats_mock',
  firstArgument: number,
): Promise<SianoLiveStatsReport> {
  let module: SianoLiveStatsModule;
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
    const raw = await module.ccall(name, 'number', ['number', 'number', 'number'],
      [firstArgument, pointer, WORDS], { async: true });
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > 0xffffffff) return internalReport();
    const words = readWords(module.HEAPU8, pointer);
    if (words === null || words[0] !== raw) return internalReport();
    const decoded = decode(words);
    return decoded ?? internalReport();
  } catch {
    return internalReport();
  } finally {
    if (pointer > 0) {
      try { module._free(pointer); } catch { /* fixed diagnostics only */ }
    }
  }
}

function isValidModule(value: unknown): value is SianoLiveStatsModule {
  try {
    const module = value as Partial<SianoLiveStatsModule> | null;
    return Boolean(module && module.HEAPU8 instanceof Uint8Array &&
      typeof module.ccall === 'function' && typeof module._malloc === 'function' &&
      typeof module._free === 'function');
  } catch {
    return false;
  }
}

function readWords(heap: Uint8Array, pointer: number): number[] | null {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer + BYTES > heap.byteLength) return null;
  const view = new DataView(heap.buffer, heap.byteOffset + pointer, BYTES);
  const words: number[] = [];
  for (let index = 0; index < WORDS; index++) words.push(view.getUint32(index * 4, true));
  return words;
}

function decode(words: readonly number[]): SianoLiveStatsReport | null {
  const diagnostic = DIAGNOSTICS[words[0]];
  const state = STATES[words[1]];
  const flags = words[3];
  if (diagnostic === undefined || state === undefined) {
    return null;
  }
  const acceptedBytes = (flags & ACCEPTED_UNMEASURED) !== 0 ? null : readU64(words, 8);
  const dequeuedBytes = (flags & DEQUEUED_UNMEASURED) !== 0 ? null : readU64(words, 10);
  const droppedBytes = (flags & ACCEPTED_UNMEASURED) !== 0 ? null : readU64(words, 12);
  const truncatedBytes = (flags & ACCEPTED_UNMEASURED) !== 0 ? null : readU64(words, 14);
  const transferErrors = (flags & TRANSFER_ERRORS_UNMEASURED) !== 0 ? null : readU64(words, 16);
  const queueMeasured = (flags & QUEUE_MEASURED) !== 0;
  const dropsMeasured = (flags & DROPS_MEASURED) !== 0;
  const transfersMeasured = (flags & TRANSFERS_MEASURED) !== 0;
  const streamErrorMeasured = (flags & ERROR_MEASURED) !== 0;
  const streamError = streamErrorMeasured ? STREAM_ERRORS[words[7]] : null;
  if (streamErrorMeasured && streamError === undefined) return null;
  return Object.freeze({
    diagnostic,
    state,
    generation: words[2],
    queueMeasured,
    dropsMeasured,
    transfersMeasured,
    streamErrorMeasured,
    queueClosed: (flags & QUEUE_CLOSED) !== 0,
    countersSaturated: (flags & COUNTERS_SATURATED) !== 0,
    acceptedBytes,
    dequeuedBytes,
    droppedBytes,
    truncatedBytes,
    transferErrors,
    queueChunks: queueMeasured ? words[4] : null,
    droppedChunks: dropsMeasured ? words[5] : null,
    activeTransfers: transfersMeasured ? words[6] : null,
    streamError,
  });
}

function invalidReport(): SianoLiveStatsReport {
  return Object.freeze({
    diagnostic: 'INVALID_ARGUMENT', state: 'IDLE', generation: 0,
    queueMeasured: false, dropsMeasured: false, transfersMeasured: false,
    streamErrorMeasured: false, queueClosed: false,
    countersSaturated: false,
    acceptedBytes: null, dequeuedBytes: null, droppedBytes: null,
    truncatedBytes: null, transferErrors: null,
    queueChunks: null, droppedChunks: null, activeTransfers: null, streamError: null,
  });
}

function readU64(words: readonly number[], lowIndex: number): string {
  return (BigInt(words[lowIndex] >>> 0) +
    (BigInt(words[lowIndex + 1] >>> 0) << 32n)).toString(10);
}

function internalReport(): SianoLiveStatsReport {
  return Object.freeze({ ...invalidReport(), diagnostic: 'INTERNAL' });
}
