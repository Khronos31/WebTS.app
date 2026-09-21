// 一覧に出すチャンネルの出どころ。
//
// スキャン済みなら保存されたものを使う。まだなら空を返す。
//
// 番組情報はスキャン時に取った EIT[p/f] から出す。**作り物は混ぜない。**
// 取れていないサービスは空のままにする。実在の局名の横に作り物の番組名が
// 並ぶと、どれが本物か区別が付かなくなる。
//
// 取得時刻が古ければ番組は終わっている。それは陳腐化であって不具合ではないので、
// 時刻で選び直すだけにする。

import type { ChannelItem, OnAirScheduleItem, ProgramItem } from './types';
import { readChannels, readPrograms } from './channel-store';
import { getEnabledChannelIds } from './mock-data';

/**
 * 同期に読みたい画面のための控え。視聴画面は DOM を組み立てる時点で
 * チャンネルが要るので、非同期にすると一度空で描いてから差し替えることになる。
 * 画面を切り替えるたびに `prime()` し直す。
 */
let cache: ChannelItem[] = [];

let programCache: ProgramItem[] = [];

export async function primeChannels(): Promise<void> {
  cache = (await readChannels())?.channels.slice() ?? [];
  programCache = await readPrograms();
}

/** 同期に読みたい画面のための控え。視聴画面が DOM を組み立てる時点で要る。 */
export function programsSync(channelId: number): ProgramItem[] {
  return programCache.filter((program) => program.channelId === channelId)
    .sort((left, right) => left.startAt - right.startAt);
}

function applyEnabled(channels: readonly ChannelItem[], onlyEnabled: boolean): ChannelItem[] {
  if (!onlyEnabled) return [...channels];
  const enabled = getEnabledChannelIds();
  const filtered = channels.filter((channel) => enabled.has(channel.id));
  // 有効判定が空なら、絞り込みが効いていないだけなので全部見せる。
  return filtered.length > 0 ? filtered : [...channels];
}

export function channelsSync(onlyEnabled = true): ChannelItem[] {
  return applyEnabled(cache, onlyEnabled);
}

export function findChannelSync(id: number): ChannelItem | null {
  return cache.find((channel) => channel.id === id) ?? null;
}

export async function loadChannels(onlyEnabled = true): Promise<ChannelItem[]> {
  const stored = await readChannels();
  if (stored === null) return [];
  cache = stored.channels.slice();
  return applyEnabled(stored.channels, onlyEnabled);
}

export async function loadSchedules(
  onlyEnabled = true,
  now: number = Date.now(),
): Promise<OnAirScheduleItem[]> {
  const channels = await loadChannels(onlyEnabled);
  const programs = await readPrograms();
  const byChannel = new Map<number, ProgramItem[]>();
  for (const program of programs) {
    const list = byChannel.get(program.channelId);
    if (list === undefined) byChannel.set(program.channelId, [program]);
    else list.push(program);
  }

  return channels.map((channel) => {
    const list = (byChannel.get(channel.id) ?? []).slice()
      .sort((left, right) => left.startAt - right.startAt);
    const current = list.find(
      (program) => program.startAt <= now && (program.endAt > now || program.endAt === program.startAt))
      ?? null;
    const next = list.find((program) => program.startAt > now)
      ?? (current === null ? list[0] ?? null : null);
    const total = current === null ? 0 : Math.max(1, current.endAt - current.startAt);
    const digestibility = current === null
      ? 0
      : Math.min(100, Math.max(0, Math.round(((now - current.startAt) / total) * 100)));
    return { channel, currentProgram: current, nextProgram: next, digestibility };
  });
}

export async function loadProgramsFor(channelId: number): Promise<ProgramItem[]> {
  const programs = await readPrograms();
  return programs.filter((program) => program.channelId === channelId)
    .sort((left, right) => left.startAt - right.startAt);
}

