// 番組表を保存済みの番組へ重ねる。副作用を持たない。
//
// **揃った局については差し替える。**放送局が番組を差し替えると event_id が
// 変わり、足すだけでは古い番組が終了時刻まで残って番組表で重なる。
// 揃わずに時間切れになった局は届いたぶんを足すだけにする。届かなかった
// 番組が「無くなった」のか「まだ来ていない」のか区別できないため。

import type { ProgramItem } from './types';

/** 終わった番組を抱えておく時間。 */
export const KEEP_ENDED_MS = 6 * 60 * 60 * 1000;
/**
 * 終了時刻が未定 (endAt === startAt) の番組を抱えておく時間。始まってから数える。
 *
 * 未定の番組は特番で実際に起きるので、始まってすぐには消せない。以前は
 * **期限なしで残していた**ため、何日も前の未定の番組が1つ残るだけで、番組表の
 * 日付の選択に過去の日が何日も並んだ（実機、2026-09-25）。1日を超えて続く
 * 未定の番組は考えにくいので、そこで切る。
 */
export const KEEP_UNDETERMINED_MS = 24 * 60 * 60 * 1000;

/** もう抱えておかなくてよい番組か。保存するときも、範囲を測るときも使う。 */
export function isStaleProgram(program: ProgramItem, now: number): boolean {
  if (program.endAt === program.startAt) return program.startAt <= now - KEEP_UNDETERMINED_MS;
  return program.endAt <= now - KEEP_ENDED_MS;
}

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
  return [...merged.values()].filter((program) => !isStaleProgram(program, now));
}
