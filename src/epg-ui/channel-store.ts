// スキャンで見つけたチャンネルの保存。
//
// 保存先は IndexedDB。**放送 TS そのものは保存しない。**残すのは局の識別と
// 名前、物理チャンネルだけである。
//
// 形は UI が既に使っている `ChannelItem` に合わせる。モックと同じ形にして
// おけば、差し替えても一覧側を書き換えずに済む。

import type { ChannelItem } from './types';

const DATABASE = 'webts-channels';
const STORE = 'channels';
const META = 'meta';

export interface ScannedChannels {
  readonly channels: readonly ChannelItem[];
  /** 取得時刻。陳腐化は防げないので、いつのものかを出せるようにする。 */
  readonly scannedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      if (!database.objectStoreNames.contains(META)) database.createObjectStore(META);
    };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error('indexedDB open failed')); };
  });
}

function transact<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const request = run(database.transaction(store, mode).objectStore(store));
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error('indexedDB request failed')); };
  }));
}

export async function saveChannels(channels: readonly ChannelItem[]): Promise<void> {
  await transact(STORE, 'readwrite', (store) => store.put([...channels], 'list'));
  await transact(META, 'readwrite', (store) => store.put(Date.now(), 'scannedAt'));
}

export async function readChannels(): Promise<ScannedChannels | null> {
  try {
    const channels = await transact<ChannelItem[] | undefined>(
      STORE, 'readonly', (store) => store.get('list'));
    if (channels === undefined || channels.length === 0) return null;
    const scannedAt = await transact<number | undefined>(
      META, 'readonly', (store) => store.get('scannedAt'));
    return { channels, scannedAt: scannedAt ?? 0 };
  } catch {
    return null;
  }
}

export async function clearChannels(): Promise<void> {
  await transact(STORE, 'readwrite', (store) => store.delete('list'));
  await transact(META, 'readwrite', (store) => store.delete('scannedAt'));
}
