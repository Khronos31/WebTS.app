// チャンネルスキャンの進行。C 側が選局と受信を、こちらが SDT/NIT の解釈を持つ。
//
// 1チャンネルぶんの TS を読み、必要な section が揃った時点で「次へ」と伝える。
// 固定時間を待つより速く終わり、待ち足りずに取りこぼすこともない。
//
// **セッションは C 側で開いたまま巡回する。**選局のたびに開き直す形は実機で
// 事故を起こしている（docs/FINDINGS.md 12章）。
//
// **チャンネルを見終えたら C へ応答を返す。**返すまで C は次へ進まない。
// ここを「ポーリングで切り替わりを見る」だけにすると、ブラウザにタイマーを
// 絞られたときにチャンネルを丸ごと取りこぼす。実測で 50局の走査のうち
// ch16/17/19 を含む多くを一度も見ずに終えたことがある（18章と同じ問題）。

import { ServiceInfoReader, type NetworkEntry, type ServiceEntry } from '../ts/service-info';
import { EitReader } from '../ts/eit';
import { serviceKey } from '../ts/eit-schedule-state';
import { decodeAribText } from '../ts/arib-text';
import { loadFirmware } from '../usb/firmware';
import { toProgramItem } from './program-item';
import { grTunings, tuningKey, type Tuning } from './tuning';
import { ensureTunerAvailable, loadQ3U4Module } from './q3u4-module';
import { stageLabel } from './stage-label';
import { sleepUnthrottled } from './tick';
import type { ChannelItem, ProgramItem } from './types';

const DRAIN_BYTES = 512 * 1024;
/** state, stage, error, cursor, workers, entries。 */
const POLL_BASE_WORDS = 6;
/** 作業者ごとに index, waiting, pending。 */
const WORKER_WORDS = 3;
const WAVE_TERRESTRIAL = 0;
const WAVE_SATELLITE = 1;
/** C 側が立てられる作業者の上限。 */
const MAX_WORKERS = 4;
/**
 * 受信機は C 側に選ばせる（q3u4-descramble-probe.cpp の claim_receiver）。
 * どの受信機がどの波を受けられるかは機種によるので、JS には番号を持たせない。
 */
const ANY_RECEIVER = -1;

interface WorkerState {
  index: number;
  reader: ServiceInfoReader | null;
  eit: EitReader | null;
  services: ServiceEntry[];
  network: NetworkEntry | null;
  acknowledged: number;
  /** いまの中継器に移った時刻。番組表の最短待ちに使う。 */
  since: number;
}

/**
 * 開発ビルドだけ、番組表の揃い具合をページから読めるようにする。
 * `globalThis.__webtsSchedule` を JS コンソールで見る。配信物には入らない。
 */
const debugPublishedAt = new Map<string, number>();

function publishScheduleDebug(worker: string, slot: WorkerState, label: string): void {
  const completeness = slot.eit?.completeness;
  if (completeness === undefined) return;
  // 毎回数え直すと重い。1秒に1回で足りる。
  const now = Date.now();
  if (now - (debugPublishedAt.get(worker) ?? 0) < 1000) return;
  debugPublishedAt.set(worker, now);
  const holder = globalThis as { __webtsSchedule?: Record<string, unknown> };
  holder.__webtsSchedule ??= {};
  const events = new Map<number, number>();
  for (const event of slot.eit?.events ?? []) {
    const key = event.networkId * 100_000 + event.serviceId;
    events.set(key, (events.get(key) ?? 0) + 1);
  }
  holder.__webtsSchedule[worker] = {
    label,
    elapsedSeconds: Math.round((Date.now() - slot.since) / 1000),
    seen: completeness.seen.length,
    complete: completeness.completeKeys().length,
    services: completeness.seen.map((key) => ({
      key, missing: completeness.missing(key), events: events.get(key) ?? 0,
      tables: completeness.missingByTable(key),
    })),
  };
}

/**
 * 番組表を待つ最短時間。**知っている局がまだ1つも届いていないうちは
 * 「揃った」にしない。**届いた局だけで判定するので、始まってすぐは
 * 1局ぶんが揃っただけで終わりうる。知っている局が全部届くか、これだけ
 * 待てば、届いた局だけで判定してよい（臨時サービスは番組表を送らない）。
 * 以前の固定の滞在時間と同じ長さにした。
 */
const SCHEDULE_MIN_WAIT_MS = 60_000;

/**
 * 衛星は中継器に複数の TS が載る。**どれを掴んだかは SDT が知っている。**
 * 復調器から読む口がエンクロージャに無く、放送側の申告のほうが正である。
 */
function withDiscoveredTsid(tuning: Tuning, services: readonly ServiceEntry[]): Tuning {
  if (tuning.wave === 'GR') return tuning;
  const discovered = services[0]?.transportStreamId;
  return discovered === undefined ? tuning : { ...tuning, tsid: discovered };
}

/**
 * サービス形式種別のうち、この再生経路で映せるものだけを残す。
 *
 * Mirakurun は走査で `[0x01, 0x02, 0xA1, 0xA4, 0xA5, 0xAD, 0xC0]` を残す。
 * こちらはそれより狭く、**映像が MPEG-2、音声が AAC のものだけ**にする。
 *
 *   0x01 デジタルTV        映せる
 *   0xA1 臨時映像          映せる
 *   0xA5 プロモーション映像 映せる
 *
 * 外すもの:
 *   0x02 デジタル音声    映像が無い。音声だけの画面を用意していない
 *   0xAD 超高精細度4K    HEVC。libmpeg2 でも WebCodecs でも復号できない
 *   0xC0 データ          データ放送は 0.1.0 の対象外
 *   0xA4 エンジニアリング 視聴対象ではない
 */
function isWatchable(service: ServiceEntry): boolean {
  return service.serviceType === 0x01
    || service.serviceType === 0xa1
    || service.serviceType === 0xa5;
}

export interface ScanProgress {
  /** いま見ている中継器。 */
  readonly tuning: Tuning;
  /** 表示用の短い名前。"27" や "BS15"。 */
  readonly label: string;
  /** 衛星で実際に掴んだ TS 識別子。地上波と未取得は null。 */
  readonly tsid: number | null;
  readonly index: number;
  readonly total: number;
  /** 直前のチャンネルでロックしたか。まだなら null。 */
  readonly locked: boolean | null;
  readonly found: number;
  readonly message: string;
}

export interface ScanOptions {
  /** 回る中継器。省略すると地上デジタルの全物理チャンネル。 */
  readonly tunings?: readonly Tuning[] | undefined;
  /**
   * LNB へ 15V を出してよいか。既定は出さない。
   * 別の機器が給電している線へ重ねて出すと競合する。
   */
  readonly allowLnb15v?: boolean | undefined;
  /**
   * 番組表（EIT[schedule]）も読むか。既定は読まない。
   * 読むと1中継器あたりの滞在が桁で伸びる。
   */
  readonly schedule?: boolean | undefined;
  /**
   * 1中継器に留まる上限 (ms)。省略すると C 側の既定（8 秒）。
   * 番組表は必要な section が揃うまで待てないので、時間で切る。
   */
  readonly dwellMs?: number | undefined;
  /**
   * 番組表で other (0x60〜0x6F) も読むか。BS と CS はネットワークの全局が
   * 1つの TS に載るので、これを使えばネットワークごとに1回の選局で済む。
   */
  readonly scheduleOther?: boolean | undefined;
  /**
   * 中継器ごとに、番組表が届くはずの局（局の id）。鍵は `tuningKey`。
   * 全部が届くまでは、届いた局だけで「揃った」にしない。
   */
  readonly scheduleExpect?: ReadonlyMap<string, readonly number[]> | undefined;
  /**
   * 選局した TS の外の局でも、番組を受け取る局（局の id）。other を
   * 読むときに使う。省略すると選局した TS の局だけ。
   */
  readonly acceptChannels?: ReadonlySet<number> | undefined;
  readonly onProgress?: ((progress: ScanProgress) => void) | undefined;
  /**
   * 選局に入るまでの段階。**ここを出さないと無言で固まって見える。**
   * ファームウェアの投入やデバイスを開くところで詰まると、中継器ごとの
   * 進捗は一度も来ないまま何も表示されない。
   */
  readonly onStage?: ((label: string, stage: number, elapsedMs: number) => void) | undefined;
}

export interface ScanResult {
  readonly channels: readonly ChannelItem[];
  readonly programs: readonly ProgramItem[];
  /**
   * 番組表が揃った局（局の id）。**差し替えてよいのはこの局だけ。**
   * 揃わずに時間切れになった局は、届いたぶんを足すだけにする。
   */
  readonly scheduleComplete: readonly number[];
}

/**
 * 名前を持たない局か。放送側が名前の代わりに「－」だけを送ってくる局がある
 * （CS の 600001、700100、BS の 400103 など）。
 */
export function isUnnamed(name: string): boolean {
  return /^[\s\-－ー―‐−]*$/u.test(name);
}

/**
 * TS の中の代表局。**名前を持つ最初の局**にする。
 *
 * 以前は単に先頭の局にしていた。CS では名前の無い局が先頭に来るので、
 * それが代表局になり、既定で一覧に出ていた。名前を持つ局が1つも無ければ
 * 代表局は無い（-1）。
 */
export function primaryIndex(names: readonly string[]): number {
  return names.findIndex((name) => !isUnnamed(name));
}

/** サービスと局情報から、UI が使う形の1行を作る。 */
function toChannelItem(
  service: ServiceEntry,
  network: NetworkEntry | null,
  tuning: Tuning,
  primary: boolean,
): ChannelItem {
  const name = service.serviceName !== '' ? service.serviceName : (network?.tsName ?? '');
  return {
    // EPGStation と同じ組み立て方。networkId と serviceId から一意に決まる。
    id: service.networkId * 100_000 + service.serviceId,
    serviceId: service.serviceId,
    networkId: service.networkId,
    name,
    halfWidthName: name,
    channelType: tuning.wave,
    channel: tuning.label,
    // **選局に要るものをそのまま持たせる。**衛星は周波数だけでは
    // TS が決まらず、名前から組み立て直すこともできない。
    tuning,
    remoteControlKeyId: network?.remoteControlKeyId ?? undefined,
    hasLogoData: false,
    isPrimary: primary,
    isSubChannel: !primary,
  };
}

/**
 * 走査は**系統ごとに**同時に1つだけ。同じ受信機を2つの走査が取りに行くと
 * 上流が BUSY を返す（FINDINGS 12章）。地上波と衛星は受信機が別なので、
 * 同時に回してよい（C 側も系統ごとにジョブを持つ）。
 */
const active: { terrestrial: ChannelScan | null; satellite: ChannelScan | null } = {
  terrestrial: null, satellite: null,
};

function isSatellite(options: ScanOptions): boolean {
  return (options.tunings ?? grTunings())[0]?.wave !== 'GR';
}

export class ChannelScan {
  #stopped = false;

  /** どちらかの系統で走査が動いているか。 */
  static isActive(): boolean {
    return active.terrestrial !== null || active.satellite !== null;
  }

  stop(): void {
    this.#stopped = true;
  }

  /** 途中で止められたか。止められても、そこまでの結果は返る。 */
  get stopped(): boolean {
    return this.#stopped;
  }

  async run(options: ScanOptions = {}): Promise<ScanResult> {
    const receiverClass = isSatellite(options) ? 'satellite' : 'terrestrial';
    if (active[receiverClass] !== null) throw new Error('ほかの走査が動いています。');
    active[receiverClass] = this;
    try {
      return await this.#run(options);
    } finally {
      if (active[receiverClass] === this) active[receiverClass] = null;
    }
  }

  async #run(options: ScanOptions): Promise<ScanResult> {
    const tunings = options.tunings ?? grTunings();
    // **1回の走査で波は混ぜない。**受信機の割り当ても、周波数の意味も、
    // 選局の手順も波ごとに違う。
    const satellite = tunings[0]?.wave !== 'GR';
    if (tunings.some((tuning) => (tuning.wave !== 'GR') !== satellite)) {
      throw new Error('地上波と衛星は同時に走査できません。');
    }
    if (satellite && tunings.some((tuning) => tuning.slot === null)) {
      throw new Error('衛星の走査には相対 TS 番号が要ります。');
    }
    await ensureTunerAvailable();
    const firmware = await loadFirmware();
    const module = await loadQ3U4Module();

    // **視聴用の1本は C 側が空けておく。**以前は視聴中のときだけ避けていた
    // ので、先に走査が全部掴むと視聴が始められず、選局のたびに走査を止めて
    // いた。番組表を定期的に取るようになると、それでは選局するたびに取り
    // 直しになる。作業者の数だけ頼み、受信機は C 側が機種に合わせて割り
    // 当てる。回せる受信機が少ない機種では、取れなかった作業者は何もせずに
    // 終わり、残りの作業者が全部の中継器を回す。
    const override = import.meta.env.DEV
      ? (globalThis as { __webtsScanReceivers?: number[] }).__webtsScanReceivers : undefined;
    const receivers = (override ?? Array<number>(MAX_WORKERS).fill(ANY_RECEIVER))
      .slice(0, Math.min(MAX_WORKERS, tunings.length));
    if (receivers.length === 0) {
      throw new Error('空いている受信機がありません。');
    }

    const firmwarePointer = module._malloc(firmware.length);
    module.HEAPU8.set(firmware, firmwarePointer);
    const listPointer = module._malloc(tunings.length * 4);
    module.HEAP32.set(tunings.map((tuning) => tuning.frequencyKhz), listPointer / 4);
    const slotPointer = module._malloc(tunings.length * 4);
    module.HEAP32.set(tunings.map((tuning) => tuning.slot ?? 0), slotPointer / 4);
    const receiverPointer = module._malloc(receivers.length * 4);
    module.HEAP32.set(receivers, receiverPointer / 4);
    const drainPointer = module._malloc(DRAIN_BYTES);
    const pollWords = POLL_BASE_WORDS + receivers.length * WORKER_WORDS + tunings.length;
    const pollPointer = module._malloc(pollWords * 4);

    const found: ChannelItem[] = [];
    /**
     * **同じ局を二度数えない。**衛星は中継器ごとに相対 TS を4つ試すが、CS の
     * 中継器は TS を1つしか載せないので、4つとも同じ局が見つかる。以前は
     * そのまま全部を保存し、ショップチャンネルが4行並んでいた。
     */
    const foundIds = new Set<number>();
    const programs: ProgramItem[] = [];
    const scheduleComplete = new Set<number>();
    /** C 側のジョブを選ぶ番号。系統ごとに1つある。 */
    const wave = satellite ? WAVE_SATELLITE : WAVE_TERRESTRIAL;
    let completed = 0;
    try {
      const started = module.ccall('webts_q3u4_scan_start', 'number',
        ['number', 'number', 'number', 'number', 'number',
          'number', 'number', 'number', 'number', 'number'],
        [firmwarePointer, firmware.length, wave,
          listPointer, slotPointer, tunings.length,
          receiverPointer, receivers.length,
          options.allowLnb15v === true ? 1 : 0,
          options.dwellMs ?? 0]) as number;
      if (started !== 0) {
        const name = String(module.ccall(
          'webts_q3u4_scan_error_name', 'string', ['number'], [started]));
        throw new Error(`スキャンを開始できません: ${name} (${started})`);
      }

      const startedAt = Date.now();
      let reportedStage = -1;
      const workers: WorkerState[] = receivers.map(() => ({
        index: -1, reader: null, eit: null, services: [], network: null, acknowledged: -1,
        since: Date.now(),
      }));

      const drainInto = (worker: number, state: WorkerState): void => {
        for (;;) {
          const size = module.ccall('webts_q3u4_scan_drain', 'number',
            ['number', 'number', 'number', 'number'],
            [wave, worker, drainPointer, DRAIN_BYTES]) as number;
          if (size <= 0) break;
          const bytes = module.HEAPU8.subarray(drainPointer, drainPointer + size);
          state.reader?.push(bytes);
          state.eit?.push(bytes);
        }
      };

      for (;;) {
        if (this.#stopped) module.ccall('webts_q3u4_scan_stop', null, ['number'], [wave]);
        module.ccall('webts_q3u4_scan_poll', 'number', ['number', 'number', 'number'],
          [wave, pollPointer, pollWords]);
        const words = module.HEAP32.subarray(pollPointer / 4, pollPointer / 4 + pollWords);
        const state = words[0] ?? 0;
        // まだどの作業者も中継器に着いていないあいだは、段階を出す。
        const stage = words[1] ?? 0;
        if (stage !== reportedStage) {
          reportedStage = stage;
          options.onStage?.(stageLabel(stage), stage, Date.now() - startedAt);
        }
        const lockedAt = (at: number): number =>
          words[POLL_BASE_WORDS + receivers.length * WORKER_WORDS + at] ?? -1;

        for (let w = 0; w < workers.length; w += 1) {
          const slot = workers[w];
          if (slot === undefined) continue;
          const base = POLL_BASE_WORDS + w * WORKER_WORDS;
          const index = words[base] ?? -1;
          const waiting = (words[base + 1] ?? 0) === 1;

          if (index !== slot.index) {
            slot.index = index;
            slot.services = [];
            slot.network = null;
            slot.since = Date.now();
            slot.reader = new ServiceInfoReader({
              decodeText: decodeAribText,
              // 衛星は NIT actual を待たない。届かないまま時間切れになる。
              requireNetwork: !satellite,
              onServices: (list) => { slot.services = [...list]; },
              onNetwork: (entry) => { slot.network = entry; },
            });
            slot.eit = new EitReader({
              decodeText: decodeAribText,
              schedule: options.schedule === true,
              scheduleOther: options.scheduleOther === true,
            });
          }

          drainInto(w, slot);
          if (import.meta.env.DEV) {
            const key = `${satellite ? 'S' : 'T'}${w}`;
            if (options.schedule === true) publishScheduleDebug(key, slot, tunings[index]?.label ?? '?');
            const holder = globalThis as { __webtsScan?: Record<string, unknown> };
            holder.__webtsScan ??= {};
            holder.__webtsScan[key] = {
              label: tunings[index]?.label ?? '?', services: slot.services.length,
              ...slot.reader?.stats,
            };
          }

          // SDT/NIT に加えて、見つかったサービスぶんの EIT[p/f] が揃うまで待つ。
          // p/f は数秒周期で繰り返されるので、待ち切れなければ C 側の上限で
          // 打ち切られる。番組情報が無いチャンネルでも止まらない。
          // 番組表のときは、届いたセクションで「揃った」を判定する
          // （eit-schedule-state.ts）。揃わなければ滞在の上限で打ち切られる。
          const wantServices = slot.services.filter(isWatchable).length;
          const haveEvents = slot.eit?.serviceCount ?? 0;
          const satisfied = options.schedule === true
            ? this.#scheduleSatisfied(slot, index >= 0 ? tunings[index] : undefined, options)
            : slot.reader !== null && slot.reader.complete
              && (wantServices === 0 || haveEvents >= wantServices);
          if (satisfied) {
            module.ccall('webts_q3u4_scan_advance', null, ['number', 'number'], [wave, w]);
          }

          // C が応答待ちに入っていれば、この中継器は読み切っている。
          // 結果を確定させて応答を返す。返すまで C は次へ進まない。
          if (waiting && index >= 0 && slot.acknowledged < index) {
            const base_tuning = tunings[index];
            const tuning = base_tuning === undefined ? undefined
              : withDiscoveredTsid(base_tuning, slot.services);
            if (tuning !== undefined && (slot.network !== null || satellite)) {
              this.#collect(found, foundIds, programs, slot.services, slot.network, slot.eit, tuning,
                scheduleComplete, options.acceptChannels);
            }
            completed += 1;
            const locked = lockedAt(index) === 1;
            const label = base_tuning?.label ?? '?';
            if (base_tuning !== undefined) {
              options.onProgress?.({
                tuning: tuning ?? base_tuning,
                label,
                // **並列に回るので、添字ではなく終わった件数を出す。**
                index: completed - 1,
                total: tunings.length,
                locked,
                tsid: tuning?.tsid ?? null,
                found: found.length,
                message: locked ? `${label} ロック成功` : `${label} 信号なし`,
              });
            }
            slot.acknowledged = index;
            module.ccall('webts_q3u4_scan_acknowledge', null, ['number', 'number', 'number'],
              [wave, w, index]);
          }
        }

        if (state !== 1) {
          // 失敗をそのまま握り潰すと、途中で止まった走査が成功に見える。
          if (state === 3) {
            const code = words[2] ?? 0;
            const name = String(module.ccall(
              'webts_q3u4_scan_error_name', 'string', ['number'], [code]));
            throw new Error(`スキャンが止まりました: ${name} (${code})`);
          }
          break;
        }
        // 裏のタブでも遅れない待ちを使う（tick.ts）。
        await sleepUnthrottled(100);
      }

      // 走査が終わった時点でまだ読み残しがあることがある。最後の中継器の
      // SI がそこに入っていると、その中継器だけ丸ごと落ちる。
      for (let w = 0; w < workers.length; w += 1) {
        const slot = workers[w];
        if (slot === undefined) continue;
        drainInto(w, slot);
        const base_tuning = slot.index >= 0 ? tunings[slot.index] : undefined;
        if (base_tuning === undefined || slot.acknowledged >= slot.index) continue;
        const tuning = withDiscoveredTsid(base_tuning, slot.services);
        if (slot.network !== null || satellite) {
          this.#collect(found, foundIds, programs, slot.services, slot.network, slot.eit, tuning,
                scheduleComplete, options.acceptChannels);
        }
      }

      module.ccall('webts_q3u4_scan_join', 'number', ['number'], [wave]);
    } finally {
      module.HEAPU8.fill(0, firmwarePointer, firmwarePointer + firmware.length);
      module._free(firmwarePointer);
      module._free(listPointer);
      module._free(slotPointer);
      module._free(receiverPointer);
      module._free(drainPointer);
      module._free(pollPointer);
    }
    return { channels: found, programs, scheduleComplete: [...scheduleComplete] };
  }

  #scheduleSatisfied(slot: WorkerState, tuning: Tuning | undefined, options: ScanOptions): boolean {
    const completeness = slot.eit?.completeness;
    const accept = options.acceptChannels;
    const relevant = accept === undefined ? undefined : (key: number): boolean => accept.has(key);
    if (completeness === undefined || !completeness.allSeenComplete(relevant)) return false;
    if (Date.now() - slot.since >= SCHEDULE_MIN_WAIT_MS) return true;
    const expected = tuning === undefined ? undefined
      : options.scheduleExpect?.get(tuningKey(tuning));
    if (expected === undefined || expected.length === 0) return false;
    const seen = new Set(completeness.seen);
    return expected.every((key) => seen.has(key));
  }

  #collect(
    found: ChannelItem[],
    foundIds: Set<number>,
    programs: ProgramItem[],
    services: readonly ServiceEntry[],
    network: NetworkEntry | null,
    eit: EitReader | null,
    tuning: Tuning,
    scheduleComplete: Set<number>,
    acceptChannels: ReadonlySet<number> | undefined,
  ): void {
    // 合わせた先をそのまま使う。放送側の申告を読み直す必要は無い。
    const watchable = services.filter(isWatchable);
    const items = watchable.map((service) => toChannelItem(service, network, tuning, false));
    const primary = primaryIndex(items.map((item) => item.name));
    items.forEach((item, position) => {
      if (foundIds.has(item.id)) return;
      foundIds.add(item.id);
      found.push(position === primary ? { ...item, isPrimary: true, isSubChannel: false } : item);
    });
    const wanted = new Set(watchable.map(
      (service) => serviceKey(service.networkId, service.serviceId)));
    for (const key of acceptChannels ?? []) wanted.add(key);
    for (const event of eit?.events ?? []) {
      if (wanted.has(serviceKey(event.networkId, event.serviceId))) {
        programs.push(toProgramItem(event));
      }
    }
    for (const key of eit?.completeness.completeKeys() ?? []) {
      if (wanted.has(key)) scheduleComplete.add(key);
    }
  }
}
