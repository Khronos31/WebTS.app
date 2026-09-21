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
import { EitReader, type EventEntry } from '../ts/eit';
import { decodeAribText } from '../ts/arib-text';
import { readCachedFirmware } from '../usb/firmware';
import type { ChannelItem, ProgramItem } from './types';

const MODULE_URL = '/build/q3u4-scan/q3u4-scan.mjs';
const DRAIN_BYTES = 512 * 1024;
const POLL_BASE_WORDS = 7;

const CHANNEL_BASE_KHZ = 473_143;
const CHANNEL_STEP_KHZ = 6_000;
/** 地上デジタルの UHF は ch13〜ch62。 */
export const MIN_PHYSICAL_CHANNEL = 13;
export const MAX_PHYSICAL_CHANNEL = 62;

export function physicalChannels(): number[] {
  const channels: number[] = [];
  for (let channel = MIN_PHYSICAL_CHANNEL; channel <= MAX_PHYSICAL_CHANNEL; channel += 1) {
    channels.push(channel);
  }
  return channels;
}

function frequencyKhz(channel: number): number {
  return CHANNEL_BASE_KHZ + (channel - MIN_PHYSICAL_CHANNEL) * CHANNEL_STEP_KHZ;
}

/**
 * サービス形式種別のうち、視聴できるものだけを残す。
 * 0x01 がデジタルTV、0xA5 が臨時映像。データ放送とワンセグは対象外。
 */
function isWatchable(service: ServiceEntry): boolean {
  return service.serviceType === 0x01 || service.serviceType === 0xa5;
}

export interface ScanProgress {
  /** いま見ている物理チャンネル。 */
  readonly channel: number;
  readonly index: number;
  readonly total: number;
  /** 直前のチャンネルでロックしたか。まだなら null。 */
  readonly locked: boolean | null;
  readonly found: number;
  readonly message: string;
}

export interface ScanOptions {
  readonly channels?: readonly number[] | undefined;
  readonly onProgress?: ((progress: ScanProgress) => void) | undefined;
}

export interface ScanResult {
  readonly channels: readonly ChannelItem[];
  readonly programs: readonly ProgramItem[];
}

/** EIT[p/f] のイベントを UI が使う形に直す。 */
function toProgramItem(event: EventEntry): ProgramItem {
  return {
    id: event.networkId * 100_000_000 + event.serviceId * 100_000 + event.eventId,
    channelId: event.networkId * 100_000 + event.serviceId,
    startAt: event.startAt,
    endAt: event.startAt + event.duration,
    name: event.name,
    description: event.description,
    extended: Object.keys(event.extended).length > 0 ? event.extended : undefined,
    genre: event.genre === null ? undefined : String(event.genre),
    subGenre: event.subGenre === null ? undefined : String(event.subGenre),
  };
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
  physical: number,
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
    channelType: 'GR',
    channel: String(physical),
    remoteControlKeyId: network.remoteControlKeyId ?? undefined,
    hasLogoData: false,
    isPrimary: primary,
    isSubChannel: !primary,
  };
}

export class ChannelScan {
  #stopped = false;

  stop(): void {
    this.#stopped = true;
  }

  async run(options: ScanOptions = {}): Promise<ScanResult> {
    const channels = options.channels ?? physicalChannels();
    const firmware = await readCachedFirmware();
    if (firmware === null) {
      throw new Error('ファームウェアが設定されていません。設定から取得してください。');
    }
    const module = await loadModule();

    const firmwarePointer = module._malloc(firmware.length);
    module.HEAPU8.set(firmware, firmwarePointer);
    const listPointer = module._malloc(channels.length * 4);
    module.HEAP32.set(channels.map(frequencyKhz), listPointer / 4);
    const drainPointer = module._malloc(DRAIN_BYTES);
    const pollWords = POLL_BASE_WORDS + channels.length;
    const pollPointer = module._malloc(pollWords * 4);

    const found: ChannelItem[] = [];
    const programs: ProgramItem[] = [];
    try {
      // 受信機 2 は dev1 の地上波。スキャン中は1本しか使わない。
      const started = module.ccall('webts_q3u4_scan_start', 'number',
        ['number', 'number', 'number', 'number', 'number'],
        [firmwarePointer, firmware.length, 2, listPointer, channels.length]) as number;
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
          if (network !== null) {
            this.#collect(found, programs, services, network, eit, channels[index] ?? 0);
          }
          const locked = lockedAt(index) === 1;
          options.onProgress?.({
            channel: channels[index] ?? 0,
            index,
            total: channels.length,
            locked,
            found: found.length,
            message: locked
              ? `ch${channels[index] ?? '?'} ロック成功`
              : `ch${channels[index] ?? '?'} 信号なし`,
          });
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
            throw new Error(
              `スキャンが止まりました: ${name} (${code}) 段階 ${stage} ch${channels[current] ?? '?'}`);
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
      if (network !== null && acknowledged < index) {
        this.#collect(found, programs, services, network, eit, channels[index] ?? 0);
      }

      module.ccall('webts_q3u4_scan_join', 'number', [], []);
    } finally {
      module.HEAPU8.fill(0, firmwarePointer, firmwarePointer + firmware.length);
      module._free(firmwarePointer);
      module._free(listPointer);
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
    physical: number,
  ): void {
    // 選局した物理チャンネルをそのまま使う。放送側の申告を読み直す必要は無い。
    const channel = physical;
    const watchable = services.filter(isWatchable);
    watchable.forEach((service, position) => {
      found.push(toChannelItem(service, network, channel, position === 0));
    });
    const wanted = new Set(watchable.map((service) => service.serviceId));
    for (const event of eit?.events ?? []) {
      if (wanted.has(event.serviceId)) programs.push(toProgramItem(event));
    }
  }
}
