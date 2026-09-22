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
import type { ChannelItem, ProgramItem } from './types';

const MODULE_URL = '/build/q3u4-scan/q3u4-scan.mjs';
const DRAIN_BYTES = 512 * 1024;
const POLL_BASE_WORDS = 7;
/** 基本の 7 語のあと、locked[] と tsid[] が件数ぶんずつ並ぶ。 */
const POLL_ARRAYS = 2;
const WAVE_TERRESTRIAL = 0;
const WAVE_SATELLITE = 1;

/**
 * サービス形式種別のうち、視聴できるものだけを残す。
 * 0x01 がデジタルTV、0xA5 が臨時映像。データ放送とワンセグは対象外。
 */
function isWatchable(service: ServiceEntry): boolean {
  return service.serviceType === 0x01 || service.serviceType === 0xa5;
}

export interface ScanProgress {
  /** いま見ている中継器。 */
  readonly tuning: Tuning;
  /** 表示用の短い名前。"27" や "BS15"。 */
  readonly label: string;
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
  readonly onProgress?: ((progress: ScanProgress) => void) | undefined;
}

export interface ScanResult {
  readonly channels: readonly ChannelItem[];
  readonly programs: readonly ProgramItem[];
}

interface ScanModule {
  ccall(
    name: string,
    returnType: string | null,
    argumentTypes: string[],
    args: unknown[],
  ): number | string;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

let modulePromise: Promise<ScanModule> | null = null;
async function loadModule(): Promise<ScanModule> {
  modulePromise ??= (async () => {
    const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
      default: () => Promise<ScanModule>;
    };
    return factory.default();
  })();
  return modulePromise;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

/** サービスと局情報から、UI が使う形の1行を作る。 */
function toChannelItem(
  service: ServiceEntry,
  network: NetworkEntry,
  tuning: Tuning,
  primary: boolean,
): ChannelItem {
  const name = service.serviceName !== '' ? service.serviceName : network.tsName;
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
    remoteControlKeyId: network.remoteControlKeyId ?? undefined,
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
    const firmware = await readCachedFirmware();
    if (firmware === null) {
      throw new Error('ファームウェアが設定されていません。設定から取得してください。');
    }
    const module = await loadModule();

    const firmwarePointer = module._malloc(firmware.length);
    module.HEAPU8.set(firmware, firmwarePointer);
    const listPointer = module._malloc(tunings.length * 4);
    module.HEAP32.set(tunings.map((tuning) => tuning.frequencyKhz), listPointer / 4);
    const slotPointer = module._malloc(tunings.length * 4);
    module.HEAP32.set(tunings.map((tuning) => tuning.slot ?? 0), slotPointer / 4);
    const drainPointer = module._malloc(DRAIN_BYTES);
    const pollWords = POLL_BASE_WORDS + tunings.length * POLL_ARRAYS;
    const pollPointer = module._malloc(pollWords * 4);

    const found: ChannelItem[] = [];
    const programs: ProgramItem[] = [];
    try {
      // 受信機は波で決まる。dev1 の local 0 が ISDB-S、2 が ISDB-T。
      // スキャン中は1本しか使わない。
      const started = module.ccall('webts_q3u4_scan_start', 'number',
        ['number', 'number', 'number', 'number', 'number',
          'number', 'number', 'number'],
        [firmwarePointer, firmware.length, satellite ? 0 : 2, listPointer, tunings.length,
          satellite ? WAVE_SATELLITE : WAVE_TERRESTRIAL, slotPointer,
          options.allowLnb15v === true ? 1 : 0]) as number;
      if (started !== 0) {
        const name = String(module.ccall(
          'webts_q3u4_scan_error_name', 'string', ['number'], [started]));
        throw new Error(`スキャンを開始できません: ${name} (${started})`);
      }

      let index = -1;
      let reader: ServiceInfoReader | null = null;
      let eit: EitReader | null = null;
      let services: ServiceEntry[] = [];
      let network: NetworkEntry | null = null;
      let acknowledged = -1;

      for (;;) {
        if (this.#stopped) {
          module.ccall('webts_q3u4_scan_stop', null, [], []);
        }
        module.ccall('webts_q3u4_scan_poll', 'number', ['number', 'number'],
          [pollPointer, pollWords]);
        const words = module.HEAP32.subarray(pollPointer / 4, pollPointer / 4 + pollWords);
        const state = words[0] ?? 0;
        const current = words[3] ?? 0;
        const waiting = (words[6] ?? 0) === 1;
        const lockedAt = (at: number): number => words[POLL_BASE_WORDS + at] ?? -1;
        const tsidAt = (at: number): number =>
          words[POLL_BASE_WORDS + tunings.length + at] ?? -1;

        if (current !== index) {
          index = current;
          services = [];
          network = null;
          reader = new ServiceInfoReader({
            decodeText: decodeAribText,
            onServices: (list) => { services = [...list]; },
            onNetwork: (entry) => { network = entry; },
          });
          eit = new EitReader({ decodeText: decodeAribText });
        }

        // 溜まっているぶんを読む。
        for (;;) {
          const size = module.ccall('webts_q3u4_scan_drain', 'number', ['number', 'number'],
            [drainPointer, DRAIN_BYTES]) as number;
          if (size <= 0) break;
          const bytes = module.HEAPU8.subarray(drainPointer, drainPointer + size);
          reader?.push(bytes);
          eit?.push(bytes);
        }

        // SDT/NIT に加えて、見つかったサービスぶんの EIT[p/f] が揃うまで待つ。
        // p/f は数秒周期で繰り返されるので、待ち切れなければ C 側の上限で
        // 打ち切られる。番組情報が無いチャンネルでも止まらない。
        const wantServices = services.filter(isWatchable).length;
        const haveEvents = eit?.serviceCount ?? 0;
        const satisfied = reader !== null && reader.complete
          && (wantServices === 0 || haveEvents >= wantServices);
        if (satisfied) module.ccall('webts_q3u4_scan_advance', null, [], []);

        // C が応答待ちに入っていれば、このチャンネルは読み切っている。
        // 結果を確定させて応答を返す。返すまで C は次へ進まない。
        if (waiting && acknowledged < index) {
          const base = tunings[index];
          // 実際に掴んだ TS を控える。**スロットではなく TSID で保存する。**
          // 次に視聴するときはこれを指定して選び直す。
          const discovered = tsidAt(index);
          const tuning = base === undefined ? undefined
            : discovered >= 0 ? { ...base, tsid: discovered } : base;
          if (network !== null && tuning !== undefined) {
            this.#collect(found, programs, services, network, eit, tuning);
          }
          const locked = lockedAt(index) === 1;
          const label = tuning?.label ?? '?';
          if (tuning !== undefined) {
            options.onProgress?.({
              tuning,
              label,
              index,
              total: tunings.length,
              locked,
              found: found.length,
              message: locked ? `${label} ロック成功` : `${label} 信号なし`,
            });
          }
          acknowledged = index;
          module.ccall('webts_q3u4_scan_acknowledge', null, ['number'], [index]);
          network = null;
        }

        if (state !== 1) {
          // 失敗をそのまま握り潰すと、途中で止まったスキャンが成功に見える。
          if (state === 3) {
            const code = words[2] ?? 0;
            const name = String(module.ccall(
              'webts_q3u4_scan_error_name', 'string', ['number'], [code]));
            const stage = words[1] ?? 0;
            throw new Error(`スキャンが止まりました: ${name} (${code}) 段階 ${stage} `
              + `${tunings[current]?.label ?? '?'}`);
          }
          break;
        }
        await sleep(100);
      }

      // 走査が終わった時点でまだ読み残しがあることがある。最後のチャンネルの
      // SI がそこに入っていると、そのチャンネルだけ丸ごと落ちる。
      for (;;) {
        const size = module.ccall('webts_q3u4_scan_drain', 'number', ['number', 'number'],
          [drainPointer, DRAIN_BYTES]) as number;
        if (size <= 0) break;
        const bytes = module.HEAPU8.subarray(drainPointer, drainPointer + size);
        reader?.push(bytes);
        eit?.push(bytes);
      }
      const last = tunings[index];
      if (network !== null && acknowledged < index && last !== undefined) {
        this.#collect(found, programs, services, network, eit, last);
      }

      module.ccall('webts_q3u4_scan_join', 'number', [], []);
    } finally {
      module.HEAPU8.fill(0, firmwarePointer, firmwarePointer + firmware.length);
      module._free(firmwarePointer);
      module._free(listPointer);
      module._free(slotPointer);
      module._free(drainPointer);
      module._free(pollPointer);
    }
    return { channels: found, programs };
  }

  #collect(
    found: ChannelItem[],
    programs: ProgramItem[],
    services: readonly ServiceEntry[],
    network: NetworkEntry,
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
