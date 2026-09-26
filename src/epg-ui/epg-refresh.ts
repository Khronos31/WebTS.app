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

import { ChannelScan, WaveUnsupportedError, type ScanProgress } from './channel-scan';
import type { ChannelItem, ProgramItem } from './types';
import {
  applySchedule, mergeChannels, mergePrograms, readScheduleFetchedAt, writeScheduleFetchedAt,
} from './channel-store';
import {
  channelsSync, notifyChannelsChanged, primeChannels, programsSync,
} from './channel-source';
import {
  bsTunings, csTunings, grTunings, satelliteScanTunings, tuningForChannel, tuningKey,
  type Tuning, type WaveType,
} from './tuning';
import { LiveSession } from './live-session';
import { planByNetwork, planRetry, type SchedulePlan } from './schedule-plan';
import { allowLnb15v } from './lnb-setting';
import { LiveBlocksScanError, liveHoldsReceiver } from './receiver-gate';

/** 自動更新の間隔の下限。失敗しても次の試行まではこれだけ空ける。 */
const COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 動いている走査と、それを利用者が始めたか。**地上波と衛星は同時に動く**
 * ので、1つではなく組で持つ（番組表の取得）。
 *
 * **利用者が始めた走査だけを、画面を離れたときに止める。**裏の取得まで
 * 止めると、画面を移るたびに番組表の取得がやり直しになる。
 */
const running = new Map<ChannelScan, boolean>();
let lastAttempt = 0;

export function isRefreshing(): boolean {
  return running.size > 0;
}

/** 利用者が始めた走査だけを止める。画面を離れるときに呼ぶ。 */
export function stopUserScan(): void {
  for (const [scan, byUser] of running) if (byUser) scan.stop();
}

function begin(scan: ChannelScan, byUser: boolean): void {
  running.set(scan, byUser);
}

function end(scan: ChannelScan): void {
  running.delete(scan);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

/**
 * 利用者の操作を通すため、裏の取得を止めて終わるのを待つ。**利用者が
 * 始めた走査は止めない。**そちらは「すでに動いています」で断る。
 *
 * ただし**止まりかけている走査は待つ。**画面を移ると前の画面の走査に
 * 止める指示が出るが、終わるまでには少しかかる。その間に次の画面が
 * 走査を始めると、断られていた。
 */
async function takeOver(): Promise<void> {
  if (running.size === 0) return;
  for (const [scan, byUser] of running) {
    if (byUser && !scan.stopped) throw new Error('すでに走査が動いています。');
  }
  for (const scan of running.keys()) scan.stop();
  while (running.size > 0) await sleep(100);
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
  byUser = true,
): Promise<number> {
  if (byUser) await takeOver();
  if (running.size > 0) throw new Error('すでに番組情報を取得しています。');
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
  for (const [, waveTunings] of byWave) {
    const scan = new ChannelScan();
    begin(scan, byUser);
    try {
      const result = await scan.run(
        onProgress === undefined
          ? { tunings: waveTunings, allowLnb15v: allowLnb15v() }
          : { tunings: waveTunings, allowLnb15v: allowLnb15v(), onProgress });
      programs.push(...result.programs);
    } finally {
      end(scan);
    }
  }
  // **届いたぶんだけを入れ替える。**回らなかった局の番組を消さない。
  await mergePrograms(programs);
  await primeChannels();
  return programs.length;
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
 * **裏のタブでも取りに行く。**以前は、絞られたタイマーの上で選局すると
 * 1中継器あたり 6 秒が 30〜60 秒に落ちるので見送っていた（FINDINGS 23章）。
 * 走査の待ちを Worker で数えるようにして解消した（33章）。
 */
export async function maybeAutoRefresh(
  onProgress?: (progress: ScanProgress) => void,
): Promise<AutoRefreshResult> {
  if (running.size > 0) return { ran: false };
  // **視聴中でも取りに行く。**受信機は8本あり、走査は視聴が使っているものを
  // 避けて残りを使う。同じセッションを共有するので開き直しも起きない。
  if (ChannelScan.isActive()) return { ran: false };
  if (Date.now() - lastAttempt < COOLDOWN_MS) return { ran: false };
  if (knownTunings().length === 0) return { ran: false };
  try {
    return { ran: true, programs: await refreshPrograms(onProgress, false) };
  } catch (error) {
    // 視聴に受信機を譲って止まったなら、取りに行かなかったことにする。
    if (error instanceof LiveBlocksScanError) {
      lastAttempt = 0;
      return { ran: false };
    }
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
  await takeOver();
  const tunings = wave === 'GR' ? grTunings()
    : satelliteScanTunings(wave === 'BS' ? bsTunings() : csTunings());
  const scan = new ChannelScan();
  begin(scan, true);
  lastAttempt = Date.now();
  try {
    const result = await scan.run(
      onProgress === undefined
        ? { tunings, allowLnb15v: allowLnb15v() }
        : { tunings, allowLnb15v: allowLnb15v(), onProgress });
    await mergeChannels(result.channels);
    await mergePrograms(result.programs);
    await notifyChannelsChanged();
    return { channels: result.channels.length, programs: result.programs.length };
  } finally {
    end(scan);
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

export function emitStatus(text: string): void {
  for (const listener of listeners) listener(text);
}

let ticking = false;

/**
 * アプリ本体が回す自動更新。画面がどこにあっても判定する。
 *
 * 番組表が古ければ番組表を取る（いま放送中の番組もそこに含まれる）。
 * そうでなければ、いま放送中の番組が分からない局があるときだけ p/f を取る。
 */
export async function tickAutoRefresh(): Promise<void> {
  // タイマーと画面の切り替えから同時に呼ばれうる。判定が非同期なので、
  // 両方が「空いている」と見て走り出さないようにする。
  if (ticking) return;
  ticking = true;
  try {
    await tick();
  } finally {
    ticking = false;
  }
}

async function tick(): Promise<void> {
  if (running.size > 0 || ChannelScan.isActive()) return;
  // 受信機が1本のチューナーで視聴している間は取りに行かない（receiver-gate.ts）。
  if (liveHoldsReceiver()) return;
  // 裏のタブでも回す。走査の待ちは Worker で数えるので絞られない（33章）。
  if (knownTunings().length === 0) return;

  const now = Date.now();
  if (await scheduleIsDue(now)) {
    lastScheduleAttempt = now;
    try {
      const result = await fetchSchedule({
        byUser: false,
        onProgress: (progress) => {
          emitStatus(`番組表を取得しています… ${progress.label}`
            + ` (${progress.index + 1}/${progress.total})`);
        },
      });
      // 利用者の操作に譲って止まったなら、何も言わない。
      emitStatus('');
      if (result.stopped) lastScheduleAttempt = 0;
    } catch (error) {
      // 視聴に受信機を譲って止まったなら、失敗とは言わず、あとでやり直す。
      if (error instanceof LiveBlocksScanError) {
        emitStatus('');
        lastScheduleAttempt = 0;
        return;
      }
      emitStatus(`番組表の取得に失敗しました: ${
        error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

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

/**
 * 1中継器に留まる上限。**揃えば上限を待たずに次へ進む**（eit-schedule-state.ts）。
 *
 * Mirakurun と同じ10分（C 側の kScanEntryTimeoutMaxMs も同じ）。実測で、BS の
 * 1つの TS は5分では揃わなかった。
 */
const SCHEDULE_MAX_DWELL_MS = 600_000;

export interface ScheduleOptions {
  /** 1中継器に留まる上限 (ms)。 */
  readonly dwellMs?: number | undefined;
  /** 波を絞る。省略すると登録済みの全部。 */
  readonly wave?: WaveType | undefined;
  readonly onProgress?: ((progress: ScanProgress) => void) | undefined;
  /** 利用者が始めたか。裏の取得は false。既定は true。 */
  readonly byUser?: boolean | undefined;
}

export interface ScheduleResult {
  /** 届いた番組の数。 */
  readonly programs: number;
  /** 番組表が揃った局の数。 */
  readonly complete: number;
  /** 回った中継器の数。 */
  readonly tunings: number;
  /** 途中で止められたか。 */
  readonly stopped: boolean;
}

/**
 * 番組表を取る。EIT[schedule] を読む。中継器の選び方は schedule-plan.ts。
 *
 * **1つの TS で全局ぶんが揃う前提は、外れても壊れないようにする。**
 * 前提が外れたネットワークがあれば、残りの中継器を回り直す。前提どおり
 * なら2回目は起きない。
 */
export async function fetchSchedule(options: ScheduleOptions = {}): Promise<ScheduleResult> {
  const byUser = options.byUser !== false;
  if (byUser) await takeOver();
  if (running.size > 0) throw new Error('すでに走査が動いています。');
  const onProgress = options.onProgress;
  const dwellMs = options.dwellMs ?? SCHEDULE_MAX_DWELL_MS;
  const channels = channelsSync(false)
    .filter((channel) => options.wave === undefined || channel.channelType === options.wave);
  if (channels.length === 0) {
    throw new Error('局が登録されていません。先にスキャンを実行してください。');
  }
  const accept = new Set(channels.map((channel) => channel.id));
  const since = Date.now();
  lastAttempt = since;
  const programs: ProgramItem[] = [];
  const complete = new Set<number>();
  let tuningCount = 0;
  let stopped = false;
  // **進み具合は全体で数える。**地上波と衛星が同時に進むので、走査ごとの
  // 「3/13」と「1/3」が交互に届くと読めない。
  let total = 0;
  let done = 0;
  const report = onProgress === undefined ? undefined : (progress: ScanProgress): void => {
    done += 1;
    onProgress({ ...progress, index: done - 1, total });
  };

  const runPlan = async (plan: SchedulePlan): Promise<void> => {
    if (stopped) return;
    const scan = new ChannelScan();
    begin(scan, byUser);
    try {
      const result = await scan.run({
        tunings: plan.tunings,
        allowLnb15v: allowLnb15v(),
        schedule: true,
        scheduleOther: true,
        scheduleExpect: plan.expect,
        acceptChannels: accept,
        dwellMs,
        ...(report === undefined ? {} : { onProgress: report }),
      });
      programs.push(...result.programs);
      for (const key of result.scheduleComplete) complete.add(key);
      tuningCount += plan.tunings.length;
      if (scan.stopped) stopped = true;
    } finally {
      end(scan);
    }
  };

  /**
   * **地上波と衛星を同時に回す。**受信機が別で、C 側も系統ごとにジョブを
   * 持つ。以前は地上波（約5分）が終わるまで衛星（3.5〜10分）を始めず、
   * 8本の受信機のうち3本しか使っていなかった。
   *
   * 片方が失敗しても、もう片方の結果は捨てない。失敗は全部が終わってから
   * 投げる。
   */
  const runAll = async (all: Iterable<SchedulePlan>): Promise<void> => {
    const list = [...all];
    total += list.reduce((sum, plan) => sum + plan.tunings.length, 0);
    const results = await Promise.allSettled(list.map(runPlan));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure !== undefined) {
      // 両方が終わるのを待ってから、揃った局だけ重ねて投げる。
      await applySchedule(programs, complete, since);
      await primeChannels();
      window.dispatchEvent(new CustomEvent('webts-programs-updated'));
      throw failure.reason;
    }
  };

  const { plans, visited } = planByNetwork(channels);
  await runAll(plans.values());

  const arrived = new Set(programs.map((program) => program.channelId));
  if (!stopped) await runAll(planRetry(channels, visited, arrived).values());

  // 止められても、揃った局は揃っているので重ねてよい。**取得時刻だけは
  // 書かない。**書くと、途中で止まった取得が30分間「新しい」扱いになる。
  // 波を絞った取得でも書かない。ほかの波まで新しい扱いになる。
  await applySchedule(programs, complete, since);
  if (!stopped && options.wave === undefined) await writeScheduleFetchedAt(Date.now());
  await primeChannels();
  window.dispatchEvent(new CustomEvent('webts-programs-updated'));
  return { programs: programs.length, complete: complete.size, tunings: tuningCount, stopped };
}

/**
 * 番組表を取り直す間隔。Mirakurun は毎時20分と50分に取る（30分おき）。
 * 前回の取得がこれより古ければ、起動時でも取りに行く。
 */
const SCHEDULE_INTERVAL_MS = 30 * 60 * 1000;

/** 番組表の取得に失敗したとき、次に試すまで空ける時間。 */
const SCHEDULE_RETRY_MS = 10 * 60 * 1000;

let lastScheduleAttempt = 0;

async function scheduleIsDue(now: number): Promise<boolean> {
  if (now - lastScheduleAttempt < SCHEDULE_RETRY_MS) return false;
  return now - await readScheduleFetchedAt() >= SCHEDULE_INTERVAL_MS;
}

/** 走査する波の順。地上波が最初なのは、アンテナがある可能性が一番高いため。 */
const ALL_WAVES: readonly WaveType[] = ['GR', 'BS', 'CS'];

export interface FullScanResult {
  readonly channels: readonly ChannelItem[];
  readonly programs: readonly ProgramItem[];
  /** 波ごとの失敗。空なら全部通った。 */
  readonly failures: readonly { wave: WaveType; error: string }[];
  /**
   * このチューナーでは受信できないので飛ばした波（PX-S1UR・DTV03A-1TU の
   * BS・CS）。**失敗ではない。**
   */
  readonly unsupported: readonly WaveType[];
}

function fullScanTunings(wave: WaveType): Tuning[] {
  return wave === 'GR' ? grTunings()
    : satelliteScanTunings(wave === 'BS' ? bsTunings() : csTunings());
}

/**
 * 全部の波を走査する。設定の「スキャン開始」がこれを呼ぶ。
 *
 * **地上波と衛星は同時に回す。**受信機が別で、C 側も系統ごとにジョブを
 * 持つ。衛星の中では BS、CS の順。各系統の1本目は視聴のために空けたまま
 * （channel-scan.ts）。以前は地上波 → BS → CS を直列に回していた。
 *
 * **1つの波で失敗しても続ける。**衛星アンテナが無い環境では BS/CS が
 * 何も見つからないのが普通で、それを理由に地上波の結果まで捨てるのは
 * おかしい。信号が無いだけなら失敗ですらない（ロックしないまま次へ進む）。
 *
 * 進み具合は全体で数える。`index` と `total` は全部の波を通した番号、
 * `found` は全部の波を通した累計。2つの走査が交互に知らせてくるので、
 * 走査ごとの数のままでは画面が読めない。
 *
 * 保存は呼び出し側に任せる。全部の波を集め終えてから1回で書きたいため。
 * 結果は地上波、BS、CS の順に並べる（終わった順ではなく）。
 */
export async function scanAllWaves(
  onWave?: (wave: WaveType) => void,
  onProgress?: (progress: ScanProgress) => void,
  onStage?: (label: string, stage: number, elapsedMs: number) => void,
): Promise<FullScanResult> {
  await takeOver();
  const byWave = new Map<WaveType, { channels: ChannelItem[]; programs: ProgramItem[] }>();
  const failures: { wave: WaveType; error: string }[] = [];
  const unsupported: WaveType[] = [];
  const total = ALL_WAVES.reduce((sum, wave) => sum + fullScanTunings(wave).length, 0);
  let done = 0;
  let found = 0;

  const runWave = async (wave: WaveType): Promise<void> => {
    onWave?.(wave);
    const scan = new ChannelScan();
    begin(scan, true);
    let foundHere = 0;
    const report = onProgress === undefined ? undefined : (progress: ScanProgress): void => {
      done += 1;
      found += progress.found - foundHere;
      foundHere = progress.found;
      onProgress({ ...progress, index: done - 1, total, found });
    };
    try {
      const result = await scan.run({
        tunings: fullScanTunings(wave),
        allowLnb15v: allowLnb15v(),
        ...(report === undefined ? {} : { onProgress: report }),
        ...(onStage === undefined ? {} : { onStage }),
      });
      byWave.set(wave, { channels: [...result.channels], programs: [...result.programs] });
    } catch (error) {
      if (error instanceof WaveUnsupportedError) {
        unsupported.push(wave);
      } else {
        failures.push({
          wave, error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      end(scan);
    }
  };

  await Promise.all([
    runWave('GR'),
    (async (): Promise<void> => { await runWave('BS'); await runWave('CS'); })(),
  ]);

  const channels: ChannelItem[] = [];
  const programs: ProgramItem[] = [];
  for (const wave of ALL_WAVES) {
    channels.push(...(byWave.get(wave)?.channels ?? []));
    programs.push(...(byWave.get(wave)?.programs ?? []));
  }
  return { channels, programs, failures, unsupported };
}
