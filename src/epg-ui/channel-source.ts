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
import { getEnabledChannelIds } from './enabled-channels';

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

/** 波の並び順。リモコンの順に合わせるのは波の中だけなので、先に分ける。 */
const WAVE_ORDER: Record<string, number> = { GR: 0, BS: 1, CS: 2 };

/**
 * リモコンの物理ボタンの順に並べる。
 *
 * 保存されている順は走査した順、つまり周波数の低い物理チャンネル順で、
 * 手元のリモコンの並びとは関係が無い。関東なら 1 NHK総合 / 2 Eテレ /
 * 4 日テレ / 5 テレ朝 / 6 TBS / 7 テレ東 / 8 フジ / 9 MX の順になる。
 *
 * リモコン番号を持たない局（番号の無いサービスや衛星）は後ろに回す。
 * 同じ番号の中はサービス番号順。NHK E の枝番のような枝はこれで並ぶ。
 */
export function sortChannels(channels: readonly ChannelItem[]): ChannelItem[] {
  return [...channels].sort((left, right) => {
    const wave = (WAVE_ORDER[left.channelType] ?? 9) - (WAVE_ORDER[right.channelType] ?? 9);
    if (wave !== 0) return wave;
    const key = (left.remoteControlKeyId ?? Number.MAX_SAFE_INTEGER)
      - (right.remoteControlKeyId ?? Number.MAX_SAFE_INTEGER);
    if (key !== 0) return key;
    return left.serviceId - right.serviceId;
  });
}

function applyEnabled(channels: readonly ChannelItem[], onlyEnabled: boolean): ChannelItem[] {
  if (!onlyEnabled) return sortChannels(channels);
  const enabled = getEnabledChannelIds();
  // 選択が無いときは絞り込まない。選択が消えたときに一覧まで空にしない。
  if (enabled.size === 0) return sortChannels(channels);
  const filtered = channels.filter((channel) => enabled.has(channel.id));
  return sortChannels(filtered.length > 0 ? filtered : channels);
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
    // **終わった番組を「次」として出さない。**現在が分からないときに一覧の
    // 先頭へ落としていたため、5時間前に終わった番組が「次: 16:00」として
    // 出ていた。将来の番組が無ければ空にする。
    const next = list.find((program) => program.startAt > now) ?? null;
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


export interface ChannelSchedule {
  readonly channel: ChannelItem;
  readonly programs: readonly ProgramItem[];
}

/**
 * 番組表のための読み出し。局ごとに、指定した範囲にかかる番組を時刻順で返す。
 *
 * **範囲に「かかる」ものを返す。**始まりが範囲より前でも、終わりが範囲に
 * 入っていれば番組表の左端に出したい。終了時刻が未定 (endAt === startAt) の
 * ものは、始まりが範囲内なら入れる。
 */
export async function loadScheduleRange(
  from: number,
  to: number,
  onlyEnabled = true,
): Promise<ChannelSchedule[]> {
  const channels = await loadChannels(onlyEnabled);
  const programs = await readPrograms();
  const byChannel = new Map<number, ProgramItem[]>();
  for (const program of programs) {
    const overlaps = program.endAt === program.startAt
      ? program.startAt >= from && program.startAt < to
      : program.startAt < to && program.endAt > from;
    if (!overlaps) continue;
    const list = byChannel.get(program.channelId);
    if (list === undefined) byChannel.set(program.channelId, [program]);
    else list.push(program);
  }
  return channels.map((channel) => ({
    channel,
    programs: (byChannel.get(channel.id) ?? [])
      .sort((left, right) => left.startAt - right.startAt),
  }));
}

/** 保存している番組情報が何時から何時までを覆っているか。番組表の範囲決めに使う。 */
export async function programCoverage(): Promise<{ from: number; to: number } | null> {
  const programs = await readPrograms();
  if (programs.length === 0) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const program of programs) {
    if (program.startAt < from) from = program.startAt;
    if (program.endAt > to) to = program.endAt;
  }
  return { from, to };
}
