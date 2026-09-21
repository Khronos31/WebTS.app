// 一覧に出すチャンネルの出どころ。
//
// スキャン済みなら保存されたものを使う。まだなら空を返す。
//
// **番組情報は付けない。**スキャンで読んでいるのは SDT と NIT だけで、
// EIT は読んでいない。実在の局名の横に作り物の番組名を並べると、どれが
// 本物か区別が付かなくなる。番組情報を入れるのは EIT を読むようにしてからで、
// それまでは空にしておく。

import type { ChannelItem, OnAirScheduleItem } from './types';
import { readChannels } from './channel-store';
import { getEnabledChannelIds } from './mock-data';

/**
 * 同期に読みたい画面のための控え。視聴画面は DOM を組み立てる時点で
 * チャンネルが要るので、非同期にすると一度空で描いてから差し替えることになる。
 * 画面を切り替えるたびに `prime()` し直す。
 */
let cache: ChannelItem[] = [];

export async function primeChannels(): Promise<void> {
  cache = (await readChannels())?.channels.slice() ?? [];
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

export async function loadSchedules(onlyEnabled = true): Promise<OnAirScheduleItem[]> {
  const channels = await loadChannels(onlyEnabled);
  return channels.map((channel) => ({
    channel,
    currentProgram: null,
    nextProgram: null,
    digestibility: 0,
  }));
}

