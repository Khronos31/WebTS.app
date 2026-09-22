// 一覧に出す局の選択。
//
// **既定は走査で見つかった代表局。**枝番（マルチ編成の 2, 3）は外しておく。
// 一度も選択していないときに何を出すかは、保存された局から決める。
// 作り物の一覧を既定にすると、受信できない局が最初から並ぶ。
//
// 保存が空のときは「全部」として扱う。選択が消えたときに一覧まで
// 空になるのを避ける。

import type { ChannelItem } from './types';

const KEY = 'webts_enabled_channels';

/** 走査済みの局から既定を作る。代表局だけを有効にする。 */
export function defaultEnabledChannelIds(channels: readonly ChannelItem[]): Set<number> {
  const ids = new Set<number>();
  for (const channel of channels) {
    if (channel.isPrimary !== false) ids.add(channel.id);
  }
  return ids;
}

export function getEnabledChannelIds(): Set<number> {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === null) return new Set<number>();
    const parsed: unknown = JSON.parse(saved);
    if (Array.isArray(parsed)) return new Set<number>(parsed as number[]);
  } catch {
    // 読めないときは絞り込まない。
  }
  return new Set<number>();
}

export function saveEnabledChannelIds(ids: number[] | Set<number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // 保存できなくても一覧は出る。
  }
}
