// 視聴画面のためのライブ受信。UI からはこれ1つを開け閉めすれば足りる。
//
// 中身は既に実機で通っている経路をそのまま束ねたもので、新しいことはしていない
// （docs/FINDINGS.md 18〜20章）。
//
//   WASM（page main thread）  USB → B25 復号 → 復号済み TS を溜める
//        ↓ drain（消費したぶんだけ）
//   Player Worker             分離 → MPEG-2 復号 → OffscreenCanvas へ描画
//        ↓ 音声 PES / 字幕 PES
//   main                      WebCodecs で音声、aribb24.js で字幕
//
// WASM をページの main thread に置くのは、その中の pthread が WebUSB の Promise を
// main へ委譲して待つからである（12章）。main がやるのは memcpy と postMessage だけ。
//
// 補充は Worker が要求したときだけ行う。main が自分の周期で押し込むと、表示より
// 速く送って遅延が積み上がる。この要求駆動なら背面タブでも止まらない（18章）。

import { AudioPlayer } from '../video/audio';
import type { PlayerMessage, PlayerRequest } from '../video/player-worker';
import { readCachedFirmware } from '../usb/firmware';
import { CaptionText } from './caption-text';

const MODULE_URL = '/build/q3u4-descramble/q3u4-descramble.mjs';
const POLL_WORDS = 17;
/** 1回の drain で取り出す上限。live は 2 MB/s 程度なので十分余る。 */
const DRAIN_BYTES = 1024 * 1024;

// 地上デジタルの物理チャンネル: ch13 = 473143 kHz、以降 6 MHz 間隔。
const CHANNEL_BASE_KHZ = 473_143;
const CHANNEL_STEP_KHZ = 6_000;
const MIN_PHYSICAL_CHANNEL = 13;

/** 上流の global 受信機番号。地上波は 2, 3（dev1）と 6, 7（dev2）。 */
const TERRESTRIAL_RECEIVERS = [2, 3, 6, 7] as const;

const STAGE_LABEL = [
  '開始', 'ファームウェア', 'デバイスを開く', '初期化', 'カード', 'B25',
  '受信機を開く', '選局', 'ロック待ち', 'データプレーン', '接続', '受信中',
  '後始末', '後始末', '完了',
];

export function frequencyKhzForPhysicalChannel(channel: number): number {
  return CHANNEL_BASE_KHZ + (channel - MIN_PHYSICAL_CHANNEL) * CHANNEL_STEP_KHZ;
}

export interface LiveStats {
  readonly frames: number;
  readonly decodeMs: number;
  readonly avSkewMs: number | null;
  readonly pendingEsBytes: number;
  readonly pendingTsBytes: number;
  readonly droppedTsBytes: number;
  readonly audioFrames: number;
  readonly audioDropped: number;
  readonly captions: number;
  readonly demux: Record<string, number>;
}

export interface LiveSessionOptions {
  /** 描画先。制御は Worker へ移るので、呼び出し側でこの canvas へ描かないこと。 */
  readonly canvas: OffscreenCanvas;
  /** 地上デジタルの物理チャンネル番号。 */
  readonly physicalChannel: number;
  /** 見たいサービス。多重化されたチャンネルから1つ選ぶ。 */
  readonly serviceId?: number | undefined;
  readonly onStatus?: ((text: string) => void) | undefined;
  readonly onCaption?: ((text: string) => void) | undefined;
  readonly onStats?: ((stats: LiveStats) => void) | undefined;
  readonly onEnded?: ((reason: string) => void) | undefined;
}

interface DescrambleModule {
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

let modulePromise: Promise<DescrambleModule> | null = null;
async function loadModule(): Promise<DescrambleModule> {
  modulePromise ??= (async () => {
    const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
      default: () => Promise<DescrambleModule>;
    };
    return factory.default();
  })();
  return modulePromise;
}

/**
 * 受信機が1本しかない前提で、同時に開けるのは1つだけにする。前のセッションを
 * 止めずに次を開くと、上流が BUSY を返すか、悪くすると片方のデバイスが
 * 列挙から消える（FINDINGS 12章の事故）。
 */
let active: LiveSession | null = null;

export class LiveSession {
  readonly #module: DescrambleModule;
  readonly #worker: Worker;
  readonly #audio: AudioPlayer;
  readonly #captions: CaptionText;
  readonly #options: LiveSessionOptions;
  readonly #drainPointer: number;
  readonly #pollPointer: number;
  readonly #firmwarePointer: number;
  readonly #firmwareLength: number;

  #wantPending = false;
  #retry = 0;
  #poll = 0;
  #clock = 0;
  #ended = false;
  #stopped = false;
  #frames = 0;
  #stats: LiveStats | null = null;

  private constructor(
    module: DescrambleModule,
    worker: Worker,
    options: LiveSessionOptions,
    firmwarePointer: number,
    firmwareLength: number,
  ) {
    this.#module = module;
    this.#worker = worker;
    this.#options = options;
    this.#firmwarePointer = firmwarePointer;
    this.#firmwareLength = firmwareLength;
    this.#drainPointer = module._malloc(DRAIN_BYTES);
    this.#pollPointer = module._malloc(POLL_WORDS * 4);
    this.#audio = new AudioPlayer();
    this.#captions = new CaptionText((text) => { options.onCaption?.(text); });
  }

  static isActive(): boolean {
    return active !== null;
  }

  /**
   * 受信を始める。物理操作は要求しない。ファームウェアが未取得、あるいは
   * チューナーが未許可なら例外を投げる。
   */
  static async start(options: LiveSessionOptions): Promise<LiveSession> {
    active?.stop();

    const firmware = await readCachedFirmware();
    if (firmware === null) {
      throw new Error('ファームウェアが設定されていません。設定から取得してください。');
    }
    options.onStatus?.('モジュールを読み込んでいます…');
    const module = await loadModule();

    const firmwarePointer = module._malloc(firmware.length);
    module.HEAPU8.set(firmware, firmwarePointer);

    const worker = new Worker(new URL('../video/player-worker.ts', import.meta.url),
      { type: 'module' });
    const session = new LiveSession(module, worker, options, firmwarePointer, firmware.length);
    active = session;
    session.#begin(firmware.length);
    return session;
  }

  /** 音量。0 で無音。Web Audio 側に効かせる。 */
  setVolume(volume: number): void {
    this.#audio.setVolume(volume);
  }

  setMuted(muted: boolean): void {
    this.#audio.setMuted(muted);
  }

  get stats(): LiveStats | null {
    return this.#stats;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (active === this) active = null;
    clearInterval(this.#retry);
    clearInterval(this.#poll);
    clearInterval(this.#clock);
    // 先にドライバへ停止を伝える。保留中の bulk 転送のキャンセルを伴う。
    this.#module.ccall('webts_q3u4_descramble_stop', null, [], []);
    this.#worker.terminate();
    void this.#audio.close();
    this.#captions.destroy();
    this.#module.HEAPU8.fill(0, this.#firmwarePointer,
      this.#firmwarePointer + this.#firmwareLength);
    this.#module._free(this.#firmwarePointer);
    this.#module._free(this.#drainPointer);
    this.#module._free(this.#pollPointer);
    this.#module.ccall('webts_q3u4_descramble_discard', null, [], []);
  }

  #begin(firmwareLength: number): void {
    const options = this.#options;
    this.#audio.start();

    this.#worker.addEventListener('message', (event: MessageEvent<PlayerMessage>) => {
      this.#onWorkerMessage(event.data);
    });

    const init: PlayerRequest = options.serviceId === undefined
      ? { kind: 'init', canvas: options.canvas }
      : { kind: 'init', canvas: options.canvas, programNumber: options.serviceId };
    this.#worker.postMessage(init, [options.canvas]);

    options.onStatus?.('選局しています…');
    // duration 0 は「止めるまで」、collect 2 は「溜めては渡す」。
    const started = this.#module.ccall('webts_q3u4_descramble_start', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number'],
      [this.#firmwarePointer, firmwareLength, TERRESTRIAL_RECEIVERS[0],
        frequencyKhzForPhysicalChannel(options.physicalChannel), 0, 2]) as number;
    if (started !== 0) {
      const name = String(this.#module.ccall(
        'webts_q3u4_descramble_error_name', 'string', ['number'], [started]));
      this.stop();
      options.onEnded?.(`受信を開始できません: ${name} (${started})`);
      return;
    }

    // Worker の要求に応えられなかったぶんを拾い直す。
    this.#retry = self.setInterval(() => {
      if (!this.#wantPending) return;
      if (this.#drain()) this.#wantPending = false;
    }, 20);

    // 鳴っている位置を Worker と字幕へ伝える。映像も字幕もこれに合わせる。
    this.#clock = self.setInterval(() => {
      const pts = this.#audio.clockPts();
      if (pts === null) return;
      const clock: PlayerRequest = { kind: 'clock', pts };
      this.#worker.postMessage(clock);
      this.#captions.tick(pts);
    }, 100);

    this.#poll = self.setInterval(() => { this.#pollDriver(); }, 250);
  }

  #onWorkerMessage(message: PlayerMessage): void {
    if (this.#stopped) return;
    switch (message.kind) {
      case 'want':
        if (!this.#drain()) this.#wantPending = true;
        return;
      case 'audio':
        this.#audio.push({ pts: message.pts, bytes: new Uint8Array(message.bytes) });
        return;
      case 'caption':
        this.#captions.push(message.pts, new Uint8Array(message.bytes));
        return;
      case 'started':
        this.#options.onStatus?.('');
        return;
      case 'progress':
        this.#frames = message.frames;
        this.#publishStats(message);
        return;
      case 'failed':
        this.#options.onEnded?.(message.message);
        this.stop();
        return;
      case 'done':
        this.#options.onEnded?.('');
        this.stop();
        return;
    }
  }

  #publishStats(message: Extract<PlayerMessage, { kind: 'progress' }>): void {
    const audio = this.#audio.stats();
    this.#stats = {
      frames: message.frames,
      decodeMs: message.decodeMs,
      avSkewMs: message.avSkewMs,
      pendingEsBytes: message.pendingEsBytes,
      pendingTsBytes: Number(
        this.#module.ccall('webts_q3u4_descramble_pending', 'number', [], [])),
      droppedTsBytes: Number(
        this.#module.ccall('webts_q3u4_descramble_dropped', 'number', [], [])),
      audioFrames: audio.decoded,
      audioDropped: audio.dropped,
      captions: this.#captions.stats().rendered,
      demux: message.counters,
    };
    this.#options.onStats?.(this.#stats);
  }

  /** 溜まっているぶんを取り出して Worker へ渡す。渡せたら true。 */
  #drain(): boolean {
    if (this.#stopped) return false;
    const size = this.#module.ccall('webts_q3u4_descramble_drain', 'number',
      ['number', 'number'], [this.#drainPointer, DRAIN_BYTES]) as number;
    if (size <= 0) return false;
    const copy = this.#module.HEAPU8.slice(this.#drainPointer, this.#drainPointer + size);
    // 取り出したあとの残りを添える。Worker はこれを見て刻みを伸縮させる。
    const backlogBytes = Number(
      this.#module.ccall('webts_q3u4_descramble_pending', 'number', [], []));
    const request: PlayerRequest = { kind: 'chunk', bytes: copy.buffer, backlogBytes };
    this.#worker.postMessage(request, [copy.buffer]);
    return true;
  }

  #pollDriver(): void {
    if (this.#stopped) return;
    this.#module.ccall('webts_q3u4_descramble_poll', 'number', ['number', 'number'],
      [this.#pollPointer, POLL_WORDS]);
    const words = this.#module.HEAP32.subarray(
      this.#pollPointer / 4, this.#pollPointer / 4 + POLL_WORDS);
    const state = words[0] ?? 0;
    const stage = words[1] ?? 0;
    // 受信中に入るまでは、どの段にいるかを出す。映像が出れば黙る。
    // ロック待ちは秒数も出す。黙ったままだと止まって見える。
    if (state === 1 && stage < 11 && this.#frames === 0) {
      const label = STAGE_LABEL[stage] ?? String(stage);
      const waited = words[16] ?? 0;
      this.#options.onStatus?.(stage === 8 && waited > 1000
        ? `${label}… ${(waited / 1000).toFixed(0)} 秒`
        : `${label}…`);
    }
    if (state !== 1 && !this.#ended) {
      this.#ended = true;
      const error = words[2] ?? 0;
      const name = String(this.#module.ccall(
        'webts_q3u4_descramble_error_name', 'string', ['number'], [error]));
      // 取り残しを出し切ってから終端を伝える。
      while (this.#drain()) { /* 全部渡す */ }
      const end: PlayerRequest = { kind: 'end' };
      this.#worker.postMessage(end);
      if (state === 3) this.#options.onEnded?.(`受信が止まりました: ${name} (${error})`);
    }
  }
}
