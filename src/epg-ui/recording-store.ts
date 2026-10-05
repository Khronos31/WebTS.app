/** 録画はこの origin の OPFS だけに保存する。TS をサーバーへ送らない。 */
export interface RecordingInfo {
  version: 1;
  id: string;
  title: string;
  channelName: string;
  serviceId: number;
  /** 受信した波。動作報告（録画の再生）に使う。0.4.0 より前の録画には無い。 */
  wave?: 'GR' | 'BS' | 'CS';
  createdAt: number;
  durationMs: number;
  bytes: number;
  incompleteReason: string;
}

export type RecordingSource = Pick<RecordingInfo, 'title' | 'channelName' | 'serviceId' | 'wave'>;
export interface RecordingSink {
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  commit(info: RecordingInfo): Promise<void>;
  abort(): Promise<void>;
}

export const RECORDINGS_CHANGED = 'webts-recordings-changed';
const ROOT = 'webts-recordings-v1';

export function recordingStorageSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!recordingStorageSupported()) throw new Error('このブラウザでは録画の保存を利用できません。');
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}

function validId(id: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('録画 ID が不正です。');
}

function changed(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RECORDINGS_CHANGED));
}

export async function openRecordingSink(id: string): Promise<RecordingSink> {
  validId(id);
  const parent = await root();
  const directory = await parent.getDirectoryHandle(id, { create: true });
  let stream: FileSystemWritableFileStream;
  try {
    stream = await (await directory.getFileHandle('stream.ts', { create: true })).createWritable();
  } catch (error) {
    await parent.removeEntry(id, { recursive: true }).catch(() => {});
    throw error;
  }
  return {
    write: (bytes) => stream.write(bytes),
    async commit(info) {
      // データの close に成功してから、一覧に公開する manifest を確定する。
      await stream.close();
      const meta = await (await directory.getFileHandle('recording.json', { create: true })).createWritable();
      try {
        await meta.write(JSON.stringify(info));
        await meta.close();
      } catch (error) {
        await meta.abort().catch(() => {});
        throw error;
      }
      changed();
    },
    async abort() {
      await stream.abort().catch(() => {});
      await parent.removeEntry(id, { recursive: true }).catch(() => {});
    },
  };
}

export function parseRecording(value: unknown, id: string): RecordingInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Partial<RecordingInfo>;
  if (r.version !== 1 || r.id !== id || typeof r.title !== 'string'
    || typeof r.channelName !== 'string' || typeof r.incompleteReason !== 'string'
    || !Number.isInteger(r.serviceId) || (r.serviceId ?? 0) <= 0
    || (r.wave !== undefined && r.wave !== 'GR' && r.wave !== 'BS' && r.wave !== 'CS')
    || !Number.isFinite(r.createdAt) || !Number.isFinite(r.durationMs)
    || (r.durationMs ?? -1) < 0 || !Number.isSafeInteger(r.bytes) || (r.bytes ?? 0) <= 0) return null;
  return r as RecordingInfo;
}

export async function listRecordings(): Promise<RecordingInfo[]> {
  const parent = await root();
  const recordings: RecordingInfo[] = [];
  // FileSystemDirectoryHandle の async iterator は一部の DOM 型定義にまだ無い。
  const iterable = parent as FileSystemDirectoryHandle & {
    values(): AsyncIterableIterator<FileSystemHandle>;
  };
  for await (const entry of iterable.values()) {
    if (entry.kind !== 'directory') continue;
    const directory = await parent.getDirectoryHandle(entry.name);
    try {
      const file = await (await directory.getFileHandle('recording.json')).getFile();
      const info = parseRecording(JSON.parse(await file.text()), entry.name);
      if (info === null) continue;
      const data = await (await directory.getFileHandle('stream.ts')).getFile();
      if (data.size === info.bytes) recordings.push(info);
    } catch (error) {
      // 強制終了で manifest 未確定、または他タブで削除されたものは一覧に出さない。
      if (error instanceof SyntaxError || (error instanceof DOMException && error.name === 'NotFoundError')) continue;
      throw error;
    }
  }
  return recordings.sort((a, b) => b.createdAt - a.createdAt);
}

export async function recordingFile(id: string): Promise<File> {
  validId(id);
  const directory = await (await root()).getDirectoryHandle(id);
  return (await directory.getFileHandle('stream.ts')).getFile();
}

export async function deleteRecording(id: string): Promise<void> {
  validId(id);
  await (await root()).removeEntry(id, { recursive: true });
  changed();
}

export function recordingError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return '保存容量が足りません。不要な録画を削除してから、もう一度お試しください。';
  }
  return error instanceof Error ? error.message : String(error);
}
