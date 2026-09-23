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
import { decodeAribText } from '../ts/arib-text';
import { readCachedFirmware } from '../usb/firmware';
import { toProgramItem } from './program-item';
import { grTunings, type Tuning } from './tuning';
import { ensureTunerAvailable, loadQ3U4Module } from './q3u4-module';
import { LiveSession } from './live-session';
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
/** 上流の global 受信機番号。各ブリッジの下2つが ISDB-S、上2つが ISDB-T。 */
const TERRESTRIAL_RECEIVERS = [2, 3, 6, 7];
const SATELLITE_RECEIVERS = [0, 1, 4, 5];

interface WorkerState {
  index: number;
  reader: ServiceInfoReader | null;
  eit: EitReader | null;
  services: ServiceEntry[];
  network: NetworkEntry | null;
  acknowledged: number;
}

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
  readonly onProgress?: ((progress: ScanProgress) => void) | undefined;
}

export interface ScanResult {
  readonly channels: readonly ChannelItem[];
  readonly programs: readonly ProgramItem[];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
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
 * 走査は同時に1つだけ。受信機を握るので、設定のフルスキャンと番組情報の
 * 自動更新が重なると上流が BUSY を返す（FINDINGS 12章）。
 */
let active: ChannelScan | null = null;

export class ChannelScan {
  #stopped = false;

  static isActive(): boolean {
    return active !== null;
  }

  stop(): void {
    this.#stopped = true;
  }

  async run(options: ScanOptions = {}): Promise<ScanResult> {
    if (active !== null) throw new Error('ほかの走査が動いています。');
    active = this;
    try {
      return await this.#run(options);
    } finally {
      if (active === this) active = null;
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
    const firmware = await readCachedFirmware();
    if (firmware === null) {
      throw new Error('ファームウェアが設定されていません。設定から取得してください。');
    }
    const module = await loadQ3U4Module();

    // **視聴が使っている受信機は避ける。**残りを人数分の作業者へ配る。
    const pool = satellite ? SATELLITE_RECEIVERS : TERRESTRIAL_RECEIVERS;
    const receivers = (LiveSession.isActive() ? pool.slice(1) : [...pool])
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
    const programs: ProgramItem[] = [];
    let completed = 0;
    try {
      const started = module.ccall('webts_q3u4_scan_start', 'number',
        ['number', 'number', 'number', 'number', 'number',
          'number', 'number', 'number', 'number', 'number'],
        [firmwarePointer, firmware.length, satellite ? WAVE_SATELLITE : WAVE_TERRESTRIAL,
          listPointer, slotPointer, tunings.length,
          receiverPointer, receivers.length,
          options.allowLnb15v === true ? 1 : 0,
          options.dwellMs ?? 0]) as number;
      if (started !== 0) {
        const name = String(module.ccall(
          'webts_q3u4_scan_error_name', 'string', ['number'], [started]));
        throw new Error(`スキャンを開始できません: ${name} (${started})`);
      }

      const workers: WorkerState[] = receivers.map(() => ({
        index: -1, reader: null, eit: null, services: [], network: null, acknowledged: -1,
      }));

      const drainInto = (worker: number, state: WorkerState): void => {
        for (;;) {
          const size = module.ccall('webts_q3u4_scan_drain', 'number',
            ['number', 'number', 'number'], [worker, drainPointer, DRAIN_BYTES]) as number;
          if (size <= 0) break;
          const bytes = module.HEAPU8.subarray(drainPointer, drainPointer + size);
          state.reader?.push(bytes);
          state.eit?.push(bytes);
        }
      };

      for (;;) {
        if (this.#stopped) module.ccall('webts_q3u4_scan_stop', null, [], []);
        module.ccall('webts_q3u4_scan_poll', 'number', ['number', 'number'],
          [pollPointer, pollWords]);
        const words = module.HEAP32.subarray(pollPointer / 4, pollPointer / 4 + pollWords);
        const state = words[0] ?? 0;
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
            });
          }

          drainInto(w, slot);

          // SDT/NIT に加えて、見つかったサービスぶんの EIT[p/f] が揃うまで待つ。
          // p/f は数秒周期で繰り返されるので、待ち切れなければ C 側の上限で
          // 打ち切られる。番組情報が無いチャンネルでも止まらない。
          // **番組表を取るときは「揃った」で切り上げない。**EIT[schedule] は
          // 何セクションで完結するか事前に分からないので、滞在時間で区切る。
          const wantServices = slot.services.filter(isWatchable).length;
          const haveEvents = slot.eit?.serviceCount ?? 0;
          const satisfied = options.schedule !== true
            && slot.reader !== null && slot.reader.complete
            && (wantServices === 0 || haveEvents >= wantServices);
          if (satisfied) {
            module.ccall('webts_q3u4_scan_advance', null, ['number'], [w]);
          }

          // C が応答待ちに入っていれば、この中継器は読み切っている。
          // 結果を確定させて応答を返す。返すまで C は次へ進まない。
          if (waiting && index >= 0 && slot.acknowledged < index) {
            const base_tuning = tunings[index];
            const tuning = base_tuning === undefined ? undefined
              : withDiscoveredTsid(base_tuning, slot.services);
            if (tuning !== undefined && (slot.network !== null || satellite)) {
              this.#collect(found, programs, slot.services, slot.network, slot.eit, tuning);
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
            module.ccall('webts_q3u4_scan_acknowledge', null, ['number', 'number'],
              [w, index]);
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
        await sleep(100);
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
          this.#collect(found, programs, slot.services, slot.network, slot.eit, tuning);
        }
      }

      module.ccall('webts_q3u4_scan_join', 'number', [], []);
    } finally {
      module.HEAPU8.fill(0, firmwarePointer, firmwarePointer + firmware.length);
      module._free(firmwarePointer);
      module._free(listPointer);
      module._free(slotPointer);
      module._free(receiverPointer);
      module._free(drainPointer);
      module._free(pollPointer);
    }
    return { channels: found, programs };
  }

  #collect(
    found: ChannelItem[],
    programs: ProgramItem[],
    services: readonly ServiceEntry[],
    network: NetworkEntry | null,
    eit: EitReader | null,
    tuning: Tuning,
  ): void {
    // 合わせた先をそのまま使う。放送側の申告を読み直す必要は無い。
    const watchable = services.filter(isWatchable);
    watchable.forEach((service, position) => {
      found.push(toChannelItem(service, network, tuning, position === 0));
    });
    const wanted = new Set(watchable.map((service) => service.serviceId));
    for (const event of eit?.events ?? []) {
      if (wanted.has(event.serviceId)) programs.push(toProgramItem(event));
    }
  }
}
