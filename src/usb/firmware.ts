// ベンダードライバから IT930x ファームウェアを取り出し、上流に検証させ、
// ブラウザ内にキャッシュする。
//
// webts.app からファームウェアを配布しない。利用者がプレクスからドライバを
// 取得し、このページへ渡す。取り出したバイト列は IndexedDB に置くだけで、
// どこへも送信しない。

import { loadIdentityModule, type IdentityModule } from './px4-identity';
import { listZipEntries, readZipEntry } from './zip';

/**
 * 取得元の固定値。Khronos31/hassio-addons の
 * mirakc/px4-firmware-source.tsv から写した。ファームウェア本体の SHA-256 は
 * ここに書かず、同梱した上流 px4/identity.h の値を WASM 経由で使う。
 */
export const FIRMWARE_SOURCE = Object.freeze({
  archiveUrl: 'https://plex-net.co.jp/plex/pxw3u4/pxw3u4_BDA_ver1x64.zip',
  archiveSize: 213_410,
  archiveSha256: 'bdf3b4eb84b69ccbacb4ba3df2f59c93c803ef6d3f61e7a90a531c22c301a200',
  sysEntry: 'pxw3u4_BDA_ver1x64/PXW3U4.sys',
  sysSize: 189_440,
  sysSha256: '8c7b526e2c92f9b42440b55b99b309c33f2011f4e11de310acf0c1da58038722',
  /**
   * px4_drv の fwtool/fwinfo.tsv が上記 .sys に対して使う code_ofs。
   * 探索を1回で終わらせるためのヒントで、正しさはハッシュ一致が保証する。
   * 違うバージョンのドライバでも走査で見つかる。
   */
  firmwareOffsetHint: 0x0002_87d0,
  /** これより小さいエントリはファームウェアを含み得ないので検査しない。 */
  firmwareMinimumSize: 2169,
});

export type FirmwareStage =
  | 'archive-read'
  | 'archive-verified'
  | 'sys-extracted'
  | 'sys-verified'
  | 'firmware-located'
  | 'firmware-accepted'
  | 'cached';

export interface FirmwareResult {
  readonly bytes: Uint8Array;
  readonly offset: number;
  /** どのファイル（ZIP エントリ名など）から取れたか。 */
  readonly source: string;
  /** ヒントが当たったか。外れた場合は走査で見つけたことを意味する。 */
  readonly usedHint: boolean;
  readonly archiveMatchedPin: boolean;
  readonly sysMatchedPin: boolean;
}

export class FirmwareError extends Error {
  constructor(message: string, readonly stage: FirmwareStage | 'start') {
    super(message);
  }
}

const PX4_ERROR = Object.freeze<Record<number, string>>({
  0: 'OK', 1: 'INVALID_ARGUMENT', 3: 'NOT_FOUND', 10: 'FIRMWARE_REJECTED',
  11: 'UNSUPPORTED', 14: 'BUFFER_TOO_SMALL', 255: 'INTERNAL',
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ドライバの ZIP（または展開済みの .sys）からファームウェアを取り出す。
 * 各段でサイズとハッシュを照合し、最後は上流の FirmwareProvider::load() に
 * 通す。上流はサイズ・SHA-256・scatter image の妥当性まで見る。
 */
export async function extractFirmware(
  input: Uint8Array,
  onStage: (stage: FirmwareStage) => void = () => undefined,
  /** テストから生成モジュールを差し替えるため。既定ではページが読むものを使う。 */
  providedModule?: IdentityModule,
): Promise<FirmwareResult> {
  onStage('archive-read');
  const module = providedModule ?? (await loadIdentityModule());

  const looksLikeZip = input.length >= 4 && input[0] === 0x50 && input[1] === 0x4b;
  const archiveMatchedPin = looksLikeZip &&
    input.length === FIRMWARE_SOURCE.archiveSize &&
    (await sha256Hex(input)) === FIRMWARE_SOURCE.archiveSha256;

  // 探す対象。ZIP なら中の各エントリ、そうでなければ渡されたバイト列そのもの。
  // エントリ名には依存しない。正解判定は上流の SHA-256 との一致なので、
  // ドライバの版が変わって名前や構成が動いても壊れない。固定名は最初に試す
  // だけの近道である。
  const candidates: { label: string; bytes: Uint8Array }[] = [];
  let entryNames: string[] = [];

  if (looksLikeZip) {
    onStage('archive-verified');
    let entries;
    try {
      entries = listZipEntries(input);
    } catch (error) {
      throw new FirmwareError(`ZIP として読めませんでした: ${describe(error)}`, 'archive-read');
    }
    entryNames = entries.map((entry) => entry.name);
    const ordered = [
      ...entries.filter((entry) => entry.name === FIRMWARE_SOURCE.sysEntry),
      ...entries.filter((entry) => entry.name !== FIRMWARE_SOURCE.sysEntry),
    ];
    for (const entry of ordered) {
      if (entry.uncompressedSize < FIRMWARE_SOURCE.firmwareMinimumSize) continue;
      try {
        candidates.push({ label: entry.name, bytes: await readZipEntry(input, entry.name) });
      } catch {
        // 1エントリが展開できなくても他を試す。
      }
    }
    if (candidates.length === 0) {
      throw new FirmwareError(
        `ZIP の中に検査できるファイルがありません。含まれていたのは: ${entryNames.join(', ')}`,
        'archive-verified',
      );
    }
    onStage('sys-extracted');
  } else {
    candidates.push({ label: '(渡されたファイル)', bytes: input });
    onStage('sys-extracted');
  }

  let sysMatchedPin = false;
  for (const candidate of candidates) {
    if (candidate.bytes.length === FIRMWARE_SOURCE.sysSize &&
        (await sha256Hex(candidate.bytes)) === FIRMWARE_SOURCE.sysSha256) {
      sysMatchedPin = true;
      break;
    }
  }
  onStage('sys-verified');

  const size = module.ccall('webts_px4_firmware_expected_size', 'number', [], []);
  for (const candidate of candidates) {
    const offset = locate(module, candidate.bytes).offset;
    if (offset < 0) continue;
    onStage('firmware-located');

    const bytes = candidate.bytes.slice(offset, offset + size);
    const verdict = validate(module, bytes);
    if (verdict !== 0) {
      throw new FirmwareError(
        `ファームウェアらしき ${size} バイトは見つかりましたが、上流の検証が通りませんでした: `
        + `${PX4_ERROR[verdict] ?? `UNKNOWN_${verdict}`}`,
        'firmware-located',
      );
    }
    onStage('firmware-accepted');
    return {
      bytes,
      offset,
      source: candidate.label,
      usedHint: offset === FIRMWARE_SOURCE.firmwareOffsetHint,
      archiveMatchedPin,
      sysMatchedPin,
    };
  }

  throw new FirmwareError(
    'このファイルの中に、上流が期待するファームウェアが見つかりませんでした。'
    + `検査したのは ${candidates.map((c) => c.label).join(', ')}。`
    + `ZIP の固定ハッシュは${archiveMatchedPin ? '一致' : '不一致'}、`
    + `.sys の固定ハッシュは${sysMatchedPin ? '一致' : '不一致'}でした。`
    + 'プレクスの PX-W3U4 用 BDA ドライバかどうか確認してください。',
    'sys-verified',
  );
}

function locate(module: IdentityModule, sys: Uint8Array): { offset: number } {
  const pointer = module._malloc(sys.length);
  try {
    module.HEAPU8.set(sys, pointer);
    const offset = module.ccall(
      'webts_px4_firmware_find', 'number',
      ['number', 'number', 'number'],
      [pointer, sys.length, FIRMWARE_SOURCE.firmwareOffsetHint],
    );
    return { offset };
  } finally {
    module.HEAPU8.fill(0, pointer, pointer + sys.length);
    module._free(pointer);
  }
}

function validate(module: IdentityModule, bytes: Uint8Array): number {
  const pointer = module._malloc(bytes.length);
  try {
    module.HEAPU8.set(bytes, pointer);
    return module.ccall(
      'webts_px4_firmware_validate', 'number', ['number', 'number'], [pointer, bytes.length],
    );
  } finally {
    module.HEAPU8.fill(0, pointer, pointer + bytes.length);
    module._free(pointer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- キャッシュ -------------------------------------------------------------

const DATABASE = 'webts-firmware';
const STORE = 'it930x';
const KEY = 'firmware';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB を開けません'));
  });
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB の操作に失敗しました'));
    transaction.oncomplete = () => database.close();
  }));
}

/** IT930x はコールドブート毎にファームウェアを要求するので、取り出した結果を残す。 */
export async function cacheFirmware(bytes: Uint8Array): Promise<void> {
  await transact('readwrite', (store) => store.put(bytes, KEY));
}

export async function readCachedFirmware(): Promise<Uint8Array | null> {
  const stored = await transact<unknown>('readonly', (store) => store.get(KEY) as IDBRequest<unknown>);
  if (stored instanceof Uint8Array) return stored;
  if (stored instanceof ArrayBuffer) return new Uint8Array(stored);
  return null;
}

export async function clearCachedFirmware(): Promise<void> {
  await transact('readwrite', (store) => store.delete(KEY));
}
