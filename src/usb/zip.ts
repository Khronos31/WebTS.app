// ZIP から1エントリだけ取り出す最小実装。ライブラリは足さない。
// 対応するのは stored (0) と deflate (8) のみ。暗号化・ZIP64・マルチボリュームは
// 扱わず、見つけたら明示的に失敗する。

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_LOCATOR_SIGNATURE = 0x07064b50;

export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export class ZipError extends Error {}

/** 末尾から End of Central Directory を探し、エントリ一覧を返す。 */
export function listZipEntries(archive: Uint8Array): ZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = findEndOfCentralDirectory(view, archive.byteLength);

  const entryCount = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new ZipError('ZIP64 は未対応です');
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.byteLength || view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipError('central directory の並びが壊れています');
    }
    const flags = view.getUint16(cursor + 8, true);
    if ((flags & 0x0001) !== 0) throw new ZipError('暗号化された ZIP は扱いません');
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    entries.push({
      name: decodeName(archive.subarray(cursor + 46, cursor + 46 + nameLength)),
      compressionMethod: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      localHeaderOffset: view.getUint32(cursor + 42, true),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 指定した名前のエントリを展開して返す。 */
export async function readZipEntry(archive: Uint8Array, name: string): Promise<Uint8Array> {
  const entry = listZipEntries(archive).find((candidate) => candidate.name === name);
  if (!entry) throw new ZipError(`ZIP にエントリがありません: ${name}`);

  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const header = entry.localHeaderOffset;
  if (view.getUint32(header, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipError('local file header が見つかりません');
  }
  const nameLength = view.getUint16(header + 26, true);
  const extraLength = view.getUint16(header + 28, true);
  const start = header + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    if (compressed.byteLength !== entry.uncompressedSize) {
      throw new ZipError('stored エントリの長さが一致しません');
    }
    return compressed.slice();
  }
  if (entry.compressionMethod !== 8) {
    throw new ZipError(`未対応の圧縮方式です: ${entry.compressionMethod}`);
  }

  // ZIP の deflate は raw deflate（zlib ヘッダなし）。
  const stream = new Blob([compressed as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  if (inflated.byteLength !== entry.uncompressedSize) {
    throw new ZipError('展開後の長さが central directory と一致しません');
  }
  return inflated;
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  // コメント長は最大 65535。末尾から後ろ向きに探す。
  const lowest = Math.max(0, length - (0xffff + 22));
  for (let offset = length - 22; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      if (offset >= 20 && view.getUint32(offset - 20, true) === ZIP64_END_LOCATOR_SIGNATURE) {
        throw new ZipError('ZIP64 は未対応です');
      }
      return offset;
    }
  }
  throw new ZipError('ZIP として読めません');
}

function decodeName(bytes: Uint8Array): string {
  // ドライバの ZIP は ASCII のパスしか持たない。非 UTF-8 でも壊れないよう
  // fatal にはしない。
  return new TextDecoder('utf-8').decode(bytes);
}
