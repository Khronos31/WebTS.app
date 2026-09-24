// 番組表を保存済みの番組へ重ねる。副作用を持たない。
//
// **揃った局については差し替える。**放送局が番組を差し替えると event_id が
// 変わり、足すだけでは古い番組が終了時刻まで残って番組表で重なる。
// 揃わずに時間切れになった局は届いたぶんを足すだけにする。届かなかった
// 番組が「無くなった」のか「まだ来ていない」のか区別できないため。

import type { ProgramItem } from './types';

/** 終わった番組を抱えておく時間。mergePrograms と同じ。 */
export const KEEP_ENDED_MS = 6 * 60 * 60 * 1000;

export function mergeSchedule(
  existing: readonly ProgramItem[],
  incoming: readonly ProgramItem[],
  completeChannels: ReadonlySet<number>,
  /** 取得を始めた時刻。これより前に始まった番組は差し替えの対象にしない。 */
  since: number,
  now: number,
): ProgramItem[] {
  const arrived = new Set(incoming.map((program) => program.id));
  const merged = new Map<number, ProgramItem>();
  for (const program of existing) {
    const replaced = completeChannels.has(program.channelId)
      && program.startAt >= since
      && !arrived.has(program.id);
    if (!replaced) merged.set(program.id, program);
  }
  for (const program of incoming) merged.set(program.id, program);
  const stale = now - KEEP_ENDED_MS;
  // 終了時刻が未定 (endAt === startAt) のものは残す。特番で実際に起きる。
  return [...merged.values()].filter(
    (program) => program.endAt === program.startAt || program.endAt > stale);
}
