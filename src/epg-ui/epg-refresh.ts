// 局と番組情報の取得をまとめる。手押しの更新も自動更新も局の走査もここを通る。
//
// **EIT[p/f] は選局した TS の局しか載っていない。**全局の「いま放送中」を
// 知るには、局のある物理チャンネルへ順に合わせ直すしかない。EIT[p/f] は
// 数秒周期で繰り返されるので1波あたりは短く、既知の波だけなら関東で10波
// 前後、全帯域の走査に比べれば桁で速い。
//
// 取れるのは「現在」と「次」の2つである。次が保存してあるので、現在の番組が
// 終わっても**選局し直さずに1番組ぶんは追随できる**。ここを呼ぶのは、その
// 先まで尽きたときだけでよい。

import { ChannelScan, type ScanProgress } from './channel-scan';
import type { ChannelItem, ProgramItem } from './types';
import { mergeChannels, mergePrograms } from './channel-store';
import { channelsSync, primeChannels, programsSync } from './channel-source';
import {
  bsTunings, csTunings, grTunings, satelliteScanTunings, tuningForChannel, tuningKey,
  type Tuning, type WaveType,
} from './tuning';
import { LiveSession } from './live-session';
import { allowLnb15v } from './lnb-setting';

/** 自動更新の間隔の下限。失敗しても次の試行まではこれだけ空ける。 */
const COOLDOWN_MS = 10 * 60 * 1000;

let running: ChannelScan | null = null;
let lastAttempt = 0;

export function isRefreshing(): boolean {
  return running !== null;
}

/** 視聴を始めるときなど、受信機を明け渡す必要があるときに呼ぶ。 */
export function stopRefresh(): void {
  running?.stop();
}

/** 登録済みの局が乗っている中継器。同じ TS を指すものは畳む。 */
export function knownTunings(): Tuning[] {
  // 有効/無効は表示の絞り込みなので、取得は外した局のぶんも回る。
  const unique = new Map<string, Tuning>();
  for (const channel of channelsSync(false)) {
    const tuning = tuningForChannel(channel);
    if (tuning !== null) unique.set(tuningKey(tuning), tuning);
  }
  return [...unique.values()];
}

export async function refreshPrograms(
  onProgress?: (progress: ScanProgress) => void,
): Promise<number> {
  if (running !== null) throw new Error('すでに番組情報を取得しています。');
  const tunings = knownTunings();
  if (tunings.length === 0) {
    throw new Error('局が登録されていません。先にスキャンを実行してください。');
  }
  // **波ごとに分けて回す。**1回の走査に地上波と衛星を混ぜられない。
  // 受信機の割り当ても選局の手順も違う。BS を登録した時点で、混ぜたまま
  // 渡していた番組情報の更新が丸ごと失敗するようになっていた。
  const byWave = new Map<WaveType, Tuning[]>();
  for (const tuning of tunings) {
    const list = byWave.get(tuning.wave);
    if (list === undefined) byWave.set(tuning.wave, [tuning]);
    else list.push(tuning);
  }

  lastAttempt = Date.now();
  const programs: ProgramItem[] = [];
  try {
    for (const [, waveTunings] of byWave) {
      const scan = new ChannelScan();
      running = scan;
      const result = await scan.run(
        onProgress === undefined
          ? { tunings: waveTunings, allowLnb15v: allowLnb15v() }
          : { tunings: waveTunings, allowLnb15v: allowLnb15v(), onProgress });
      programs.push(...result.programs);
      running = null;
    }
    // **届いたぶんだけを入れ替える。**回らなかった局の番組を消さない。
    await mergePrograms(programs);
    await primeChannels();
    return programs.length;
  } finally {
    running = null;
  }
}

export interface AutoRefreshResult {
  /** 実際に受信機を使ったか。条件を満たさなければ false。 */
  readonly ran: boolean;
  readonly programs?: number;
  readonly error?: string;
}

/**
 * 条件が揃っていれば取り直す。揃っていなければ何もしない。
 *
 * ほかの走査が動いていれば見送る。**視聴中は見送らない。**空いている
 * 受信機を使う。
 *
 * 裏のタブでは見送る。タイマーが絞られた状態で選局を始めると、1中継器
 * あたり 6 秒が 30〜60 秒に落ちる（FINDINGS 23章）。
 */
export async function maybeAutoRefresh(
  onProgress?: (progress: ScanProgress) => void,
): Promise<AutoRefreshResult> {
  if (running !== null) return { ran: false };
  // **視聴中でも取りに行く。**受信機は8本あり、走査は視聴が使っているものを
  // 避けて残りを使う。同じセッションを共有するので開き直しも起きない。
  if (ChannelScan.isActive()) return { ran: false };
  if (document.visibilityState !== 'visible') return { ran: false };
  if (Date.now() - lastAttempt < COOLDOWN_MS) return { ran: false };
  if (knownTunings().length === 0) return { ran: false };
  try {
    return { ran: true, programs: await refreshPrograms(onProgress) };
  } catch (error) {
    return { ran: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface WaveScanResult {
  readonly channels: number;
  readonly programs: number;
}

/**
 * 波を1つ走査して、見つかった局と番組を保存する。
 *
 * **波ごとに別の走査になる。**受信機の割り当ても選局の手順も違い、衛星は
 * 中継器の中から TS を選ぶ手順が要る。保存は差し替えではなく併合なので、
 * BS を走査しても地上波の局は残る。
 */
export async function scanWave(
  wave: WaveType,
  onProgress?: (progress: ScanProgress) => void,
): Promise<WaveScanResult> {
  if (running !== null) throw new Error('すでに走査が動いています。');
  const tunings = wave === 'GR' ? grTunings()
    : satelliteScanTunings(wave === 'BS' ? bsTunings() : csTunings());
  const scan = new ChannelScan();
  running = scan;
  lastAttempt = Date.now();
  try {
    const result = await scan.run(
      onProgress === undefined
        ? { tunings, allowLnb15v: allowLnb15v() }
        : { tunings, allowLnb15v: allowLnb15v(), onProgress });
    await mergeChannels(result.channels);
    await mergePrograms(result.programs);
    await primeChannels();
    return { channels: result.channels.length, programs: result.programs.length };
  } finally {
    running = null;
  }
}

/**
 * いま何を放送しているか分からない局が残っているか。
 *
 * **判定は画面ではなくアプリが持つ。**放映中の画面に置いていたころは、
 * 視聴中はその画面が外れていて一度も判定されなかった。受信機は8本あり
 * 視聴中でも取りに行けるのに、取りに行く者がいなかった。
 */
export function needsPrograms(now: number = Date.now()): boolean {
  const channels = channelsSync(false);
  if (channels.length === 0) return false;
  return channels.some((channel) => !programsSync(channel.id).some(
    (program) => program.startAt <= now && program.endAt > now));
}

type RefreshListener = (text: string) => void;
const listeners = new Set<RefreshListener>();

/** 取得の状況を見たい画面が登録する。戻り値を呼ぶと外れる。 */
export function onRefreshStatus(listener: RefreshListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emitStatus(text: string): void {
  for (const listener of listeners) listener(text);
}

/** アプリ本体が回す自動更新。画面がどこにあっても判定する。 */
export async function tickAutoRefresh(): Promise<void> {
  if (!needsPrograms()) return;
  const result = await maybeAutoRefresh((progress) => {
    emitStatus(`番組情報を取得しています… ${progress.label}`
      + ` (${progress.index + 1}/${progress.total})`);
  });
  if (!result.ran) return;
  emitStatus(result.error === undefined ? '' : `番組情報の取得に失敗しました: ${result.error}`);
  if (result.error === undefined) {
    window.dispatchEvent(new CustomEvent('webts-programs-updated'));
  }
}

/** 1中継器に留まる時間。番組表は section が揃うのを待てないので時間で切る。 */
const SCHEDULE_DWELL_MS = 60_000;

/**
 * 番組表を取る。EIT[schedule] を読むので、放映中の更新より桁で時間がかかる。
 *
 * **利用者が明示的に始めたときだけ走らせる。**自動更新の経路には載せない。
 * 1中継器あたり1分留まるので、関東の地上波10波でも受信機4本で3分前後になる。
 */
export interface ScheduleOptions {
  /** 1中継器に留まる時間 (ms)。長いほど取りこぼしが減る。 */
  readonly dwellMs?: number | undefined;
  /** 波を絞る。省略すると登録済みの全部。 */
  readonly wave?: WaveType | undefined;
  readonly onProgress?: ((progress: ScanProgress) => void) | undefined;
}

export async function fetchSchedule(options: ScheduleOptions = {}): Promise<number> {
  if (running !== null) throw new Error('すでに走査が動いています。');
  const onProgress = options.onProgress;
  const dwellMs = options.dwellMs ?? SCHEDULE_DWELL_MS;
  const tunings = knownTunings()
    .filter((tuning) => options.wave === undefined || tuning.wave === options.wave);
  if (tunings.length === 0) {
    throw new Error('局が登録されていません。先にスキャンを実行してください。');
  }
  const byWave = new Map<WaveType, Tuning[]>();
  for (const tuning of tunings) {
    const list = byWave.get(tuning.wave);
    if (list === undefined) byWave.set(tuning.wave, [tuning]);
    else list.push(tuning);
  }

  lastAttempt = Date.now();
  const programs: ProgramItem[] = [];
  try {
    for (const [, waveTunings] of byWave) {
      const scan = new ChannelScan();
      running = scan;
      const result = await scan.run({
        tunings: waveTunings,
        allowLnb15v: allowLnb15v(),
        schedule: true,
        dwellMs,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      programs.push(...result.programs);
      running = null;
    }
    await mergePrograms(programs);
    await primeChannels();
    window.dispatchEvent(new CustomEvent('webts-programs-updated'));
    return programs.length;
  } finally {
    running = null;
  }
}

/** 走査する波の順。地上波が最初なのは、アンテナがある可能性が一番高いため。 */
const ALL_WAVES: readonly WaveType[] = ['GR', 'BS', 'CS'];

export interface FullScanResult {
  readonly channels: readonly ChannelItem[];
  readonly programs: readonly ProgramItem[];
  /** 波ごとの失敗。空なら全部通った。 */
  readonly failures: readonly { wave: WaveType; error: string }[];
}

/**
 * 全部の波を順に走査する。設定の「スキャン開始」がこれを呼ぶ。
 *
 * **1つの波で失敗しても続ける。**衛星アンテナが無い環境では BS/CS が
 * 何も見つからないのが普通で、それを理由に地上波の結果まで捨てるのは
 * おかしい。信号が無いだけなら失敗ですらない（ロックしないまま次へ進む）。
 *
 * 保存は呼び出し側に任せる。全部の波を集め終えてから1回で書きたいため。
 */
export async function scanAllWaves(
  onWave?: (wave: WaveType) => void,
  onProgress?: (progress: ScanProgress) => void,
): Promise<FullScanResult> {
  if (running !== null) throw new Error('すでに走査が動いています。');
  const channels: ChannelItem[] = [];
  const programs: ProgramItem[] = [];
  const failures: { wave: WaveType; error: string }[] = [];

  for (const wave of ALL_WAVES) {
    onWave?.(wave);
    const tunings = wave === 'GR' ? grTunings()
      : satelliteScanTunings(wave === 'BS' ? bsTunings() : csTunings());
    const scan = new ChannelScan();
    running = scan;
    try {
      const result = await scan.run(
        onProgress === undefined
          ? { tunings, allowLnb15v: allowLnb15v() }
          : { tunings, allowLnb15v: allowLnb15v(), onProgress });
      channels.push(...result.channels);
      programs.push(...result.programs);
    } catch (error) {
      failures.push({
        wave, error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = null;
    }
  }
  return { channels, programs, failures };
}
