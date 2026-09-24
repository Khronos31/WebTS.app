// スキャンで見つけたチャンネルの保存。
//
// 保存先は IndexedDB。**放送 TS そのものは保存しない。**残すのは局の識別と
// 名前、物理チャンネルだけである。
//
// 形は UI が既に使っている `ChannelItem` に合わせる。モックと同じ形にして
// おけば、差し替えても一覧側を書き換えずに済む。

import type { ChannelItem, ProgramItem } from './types';
import { mergeSchedule } from './schedule-merge';

const DATABASE = 'webts-channels';
const STORE = 'channels';
const PROGRAMS = 'programs';
const META = 'meta';

export interface ScannedChannels {
  readonly channels: readonly ChannelItem[];
  /** 取得時刻。陳腐化は防げないので、いつのものかを出せるようにする。 */
  readonly scannedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      if (!database.objectStoreNames.contains(PROGRAMS)) database.createObjectStore(PROGRAMS);
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

export async function saveChannels(
  channels: readonly ChannelItem[],
  programs: readonly ProgramItem[] = [],
): Promise<void> {
  await transact(STORE, 'readwrite', (store) => store.put([...channels], 'list'));
  // 「サービスごとのイベント列」として持つ。EIT[p/f] と EIT[schedule] が
  // 同じ形で入るので、番組表を足すときに UI 側の契約を変えずに済む。
  await transact(PROGRAMS, 'readwrite', (store) => store.put([...programs], 'list'));
  await transact(META, 'readwrite', (store) => store.put(Date.now(), 'scannedAt'));
}

/**
 * 番組情報だけを入れ直す。
 *
 * **局の一覧には触らない。**番組情報の更新で局が消えたり、利用者が外した
 * 局のチェックが戻ったりしないようにする。
 */
export async function savePrograms(programs: readonly ProgramItem[]): Promise<void> {
  await transact(PROGRAMS, 'readwrite', (store) => store.put([...programs], 'list'));
}

/**
 * 届いたぶんだけを入れ替える。id が同じものは新しいほうで置き換え、
 * 触れなかった局の番組はそのまま残す。
 *
 * 視聴中の更新は**選局しているチャンネルの番組しか届かない**ので、
 * 丸ごと書き換えると他局の番組が消える。
 */
export async function mergePrograms(programs: readonly ProgramItem[]): Promise<ProgramItem[]> {
  const existing = await readPrograms();
  const merged = new Map(existing.map((program) => [program.id, program]));
  for (const program of programs) merged.set(program.id, program);
  // 終わった番組をいつまでも抱えない。更新のたびに積むと際限なく増える。
  // 終了時刻が未定 (endAt === startAt) のものは残す。特番で実際に起きる。
  const stale = Date.now() - 6 * 60 * 60 * 1000;
  const list = [...merged.values()].filter(
    (program) => program.endAt === program.startAt || program.endAt > stale);
  await savePrograms(list);
  return list;
}

/**
 * 番組表を重ねる。揃った局については差し替える（schedule-merge.ts）。
 */
export async function applySchedule(
  programs: readonly ProgramItem[],
  completeChannels: ReadonlySet<number>,
  since: number,
): Promise<ProgramItem[]> {
  const list = mergeSchedule(await readPrograms(), programs, completeChannels, since, Date.now());
  await savePrograms(list);
  return list;
}

/**
 * 番組表を最後に取り終えた時刻。無ければ 0。
 *
 * **失敗した取得では更新しない。**更新すると、失敗が続いても「新しい」と
 * みなされ、次の取得が30分先まで延びる。
 */
export async function readScheduleFetchedAt(): Promise<number> {
  try {
    return (await transact<number | undefined>(
      META, 'readonly', (store) => store.get('scheduleFetchedAt'))) ?? 0;
  } catch {
    return 0;
  }
}

export async function writeScheduleFetchedAt(at: number): Promise<void> {
  await transact(META, 'readwrite', (store) => store.put(at, 'scheduleFetchedAt'));
}

/**
 * 見つかった局だけを入れ替える。
 *
 * **波ごとに走査するので、丸ごと書き換えてはいけない。**BS を走査したときに
 * 地上波の局が消える。id が同じものは新しいほうで置き換え、触れなかった
 * 局はそのまま残す。
 */
export async function mergeChannels(
  channels: readonly ChannelItem[],
): Promise<ChannelItem[]> {
  const existing = (await readChannels())?.channels ?? [];
  const merged = new Map(existing.map((channel) => [channel.id, channel]));
  for (const channel of channels) merged.set(channel.id, channel);
  const list = [...merged.values()];
  await transact(STORE, 'readwrite', (store) => store.put(list, 'list'));
  await transact(META, 'readwrite', (store) => store.put(Date.now(), 'scannedAt'));
  return list;
}

export async function readPrograms(): Promise<ProgramItem[]> {
  try {
    const programs = await transact<ProgramItem[] | undefined>(
      PROGRAMS, 'readonly', (store) => store.get('list'));
    return programs ?? [];
  } catch {
    return [];
  }
}

export async function readChannels(): Promise<ScannedChannels | null> {
  try {
    const channels = await transact<ChannelItem[] | undefined>(
      STORE, 'readonly', (store) => store.get('list'));
    if (channels === undefined || channels.length === 0) return null;
    const scannedAt = await transact<number | undefined>(
      META, 'readonly', (store) => store.get('scannedAt'));
    // **同じ局が何度も保存されていることがある。**衛星の走査で CS の局を
    // 相対 TS ごとに数えていた版の保存が残っている。読むときに1つにする。
    const seen = new Set<number>();
    const unique = channels.filter((channel) => {
      if (seen.has(channel.id)) return false;
      seen.add(channel.id);
      return true;
    });
    return { channels: unique, scannedAt: scannedAt ?? 0 };
  } catch {
    return null;
  }
}

export async function clearChannels(): Promise<void> {
  await transact(STORE, 'readwrite', (store) => store.delete('list'));
  await transact(PROGRAMS, 'readwrite', (store) => store.delete('list'));
  await transact(META, 'readwrite', (store) => store.delete('scannedAt'));
}
