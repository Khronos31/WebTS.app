/** Fixed-code wrapper for the source-backed PX4 tagged TS demux fixture. */
export interface Px4TaggedTsDemuxModule {
  readonly HEAPU8: Uint8Array;
  ccall(
    name: 'webts_px4_tagged_ts_demux_mock',
    returnType: 'number',
    argTypes: readonly ['number', 'number', 'number'],
    args: readonly [number, number, number],
    opts: { readonly async: true },
  ): number | Promise<number>;
  _malloc(size: number): number;
  _free(pointer: number): void;
}

export type Px4TaggedTsDemuxDiagnostic = 'OK' | 'INVALID_ARGUMENT' | 'INTERNAL';

export interface Px4TaggedTsDemuxReport {
  readonly diagnostic: Px4TaggedTsDemuxDiagnostic;
  readonly inputBytesAccepted: number;
  readonly emittedPackets: number;
  readonly discardedSyncSearchBytes: number;
  readonly invalidTagPackets: number;
  readonly syncLossEvents: number;
  readonly bufferedBytes: number;
  readonly receiverPacketCounts: readonly [number, number, number, number];
  readonly retryVerified: boolean;
  readonly resetVerified: boolean;
  readonly boundaryVerified: boolean;
  readonly packetTagsVerified: boolean;
}

const WORDS = 12;
const BYTES = WORDS * Uint32Array.BYTES_PER_ELEMENT;

/** Runs only synthetic tagged packets through upstream TaggedTsDemux. */
export async function runPx4TaggedTsDemuxMock(
  moduleFactory: () => Px4TaggedTsDemuxModule | Promise<Px4TaggedTsDemuxModule>,
  scenario: number,
): Promise<Px4TaggedTsDemuxReport> {
  if (!Number.isSafeInteger(scenario) || scenario < 0 || scenario > 5) return invalidReport();
  let module: Px4TaggedTsDemuxModule;
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
      'webts_px4_tagged_ts_demux_mock', 'number', ['number', 'number', 'number'],
      [scenario, pointer, WORDS], { async: true },
    );
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > 0xffffffff) return internalReport();
    const words = readWords(module.HEAPU8, pointer);
    if (words === null || words[0] !== raw) return internalReport();
    if (raw === 2 || raw === 255) return raw === 2 ? invalidReport() : internalReport();
    return Object.freeze({
      diagnostic: raw === 0 ? 'OK' : 'INTERNAL',
      inputBytesAccepted: words[1], emittedPackets: words[2],
      discardedSyncSearchBytes: words[3], invalidTagPackets: words[4],
      syncLossEvents: words[5], bufferedBytes: words[6],
      receiverPacketCounts: [words[7], words[8], words[9], words[10]] as const,
      retryVerified: (words[11] & (1 << 0)) !== 0,
      resetVerified: (words[11] & (1 << 1)) !== 0,
      boundaryVerified: (words[11] & (1 << 3)) !== 0,
      packetTagsVerified: (words[11] & (1 << 2)) !== 0,
    });
  } catch {
    return internalReport();
  } finally {
    if (pointer > 0) {
      try { module._free(pointer); } catch { /* fixed diagnostics only */ }
    }
  }
}

function isValidModule(value: unknown): value is Px4TaggedTsDemuxModule {
  try {
    const module = value as Partial<Px4TaggedTsDemuxModule> | null;
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

function emptyReport(diagnostic: Px4TaggedTsDemuxDiagnostic): Px4TaggedTsDemuxReport {
  return Object.freeze({ diagnostic, inputBytesAccepted: 0, emittedPackets: 0,
    discardedSyncSearchBytes: 0, invalidTagPackets: 0, syncLossEvents: 0, bufferedBytes: 0,
    receiverPacketCounts: [0, 0, 0, 0] as const, retryVerified: false,
    resetVerified: false, boundaryVerified: false, packetTagsVerified: false });
}

function invalidReport(): Px4TaggedTsDemuxReport { return emptyReport('INVALID_ARGUMENT'); }
function internalReport(): Px4TaggedTsDemuxReport { return emptyReport('INTERNAL'); }
