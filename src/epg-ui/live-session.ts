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
import { ensureTunerAvailable, loadQ3U4Module, type Q3U4Module } from './q3u4-module';
import { CaptionText } from './caption-text';
import type { Tuning } from './tuning';
import { STAGE_LABEL } from './stage-label';
import { allowLnb15v } from './lnb-setting';

const POLL_WORDS = 17;
/** 1回の drain で取り出す上限。live は 2 MB/s 程度なので十分余る。 */
const DRAIN_BYTES = 1024 * 1024;

/** 上流の global 受信機番号。地上波は 2, 3（dev1）と 6, 7（dev2）。 */
const TERRESTRIAL_RECEIVERS = [2, 3, 6, 7] as const;
/** 衛星は各ブリッジの下2つ。0, 1（dev1）と 4, 5（dev2）。 */
const SATELLITE_RECEIVERS = [0, 1, 4, 5] as const;
const WAVE_TERRESTRIAL = 0;
const WAVE_SATELLITE = 1;

/**
 * 復号の失敗を人に分かる形にする。
 *
 * `PROTOCOL_ERROR` は B25 の `put()` / `get()` が非 0 を返したという意味しか
 * 持たない。実際の理由は libaribb25 の戻り値と、カードが返した ECM の状況に
 * ある。**契約が無い場合は ECM が「未購入」を返す**ので、そこを名指しできる。
 */
function describeB25(b25Error: number, unpurchased: number, lastEcmError: number): string {
  const parts: string[] = [];
  if (b25Error !== 0) parts.push(`B25 ${b25Error}`);
  if (unpurchased > 0) {
    parts.push(`未契約の ECM ${unpurchased} 件`);
  }
  if (lastEcmError > 0) parts.push(`ECM 応答 0x${lastEcmError.toString(16)}`);
  if (parts.length === 0) return '';
  const detail = ` [${parts.join(' / ')}]`;
  // 未購入が立っていれば、それが理由である可能性が高い。言い切らない。
  return unpurchased > 0
    ? `${detail} この局は契約されていない可能性があります。`
    : detail;
}

/** 受信に入ってから、絵が出ないことを問題として扱うまでの時間。 */
const kSilentMs = 8000;


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
  /** どこへ合わせるか。地上波は周波数だけ、衛星は TSID も要る。 */
  readonly tuning: Tuning;
  /** 見たいサービス。多重化されたチャンネルから1つ選ぶ。 */
  readonly serviceId?: number | undefined;
  readonly onStatus?: ((text: string) => void) | undefined;
  readonly onCaption?: ((text: string) => void) | undefined;
  readonly onStats?: ((stats: LiveStats) => void) | undefined;
  readonly onEnded?: ((reason: string) => void) | undefined;
}

/**
 * 視聴は同時に1つだけ。カードが1枚しかないので、復号できるのも1つである。
 * **走査とは同時に走ってよい。**別の受信機を使い、同じセッションを共有する。
 */
let active: LiveSession | null = null;

export class LiveSession {
  readonly #module: Q3U4Module;
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
  #paused = false;
  #frames = 0;
  #stats: LiveStats | null = null;

  private constructor(
    module: Q3U4Module,
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
    // 一時停止中は字幕も更新しない。絵が止まっているのに字幕だけ進むと、
    // 画面の中で言っていることと出ている字が合わなくなる。
    this.#captions = new CaptionText((text) => {
      if (!this.#paused) options.onCaption?.(text);
    });
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

    await ensureTunerAvailable();
    const firmware = await readCachedFirmware();
    if (firmware === null) {
      throw new Error('ファームウェアが設定されていません。設定から取得してください。');
    }
    options.onStatus?.('モジュールを読み込んでいます…');
    const module = await loadQ3U4Module();

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

  get paused(): boolean {
    return this.#paused;
  }

  /**
   * 一時停止。**受信は止めない。**
   *
   * 止めてしまうと次に再生するとき選局からやり直しになり、復調ロックを
   * 数秒待たされる。live で数秒の間が空くのは一時停止として使い物にならない。
   * 代わりに、描画と音だけを止める。音声は無音のまま鳴らし続けるので
   * 時計が進み続け、復帰した瞬間からライブの位置で再生が続く。滞留も
   * 増えない（消費を止めないため）。
   */
  setPaused(paused: boolean): void {
    if (this.#stopped || this.#paused === paused) return;
    this.#paused = paused;
    this.#audio.setPaused(paused);
    const request: PlayerRequest = { kind: 'paused', value: paused };
    this.#worker.postMessage(request);
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

    // 衛星は TSID を指定しないと、中継器のどの TS が出るか決まらない。
    // 走査で控えていない局は、周波数だけで合わせに行かない。
    const satellite = options.tuning.wave !== 'GR';
    if (satellite && (options.tuning.tsid === null || options.tuning.tsid <= 0)) {
      this.stop();
      options.onEnded?.('この局の TS 識別子が分かりません。スキャンし直してください。');
      return;
    }
    options.onStatus?.('選局しています…');
    // duration 0 は「止めるまで」、collect 2 は「溜めては渡す」。
    const started = this.#module.ccall('webts_q3u4_descramble_start', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number',
        'number', 'number', 'number'],
      [this.#firmwarePointer, firmwareLength,
        satellite ? SATELLITE_RECEIVERS[0] : TERRESTRIAL_RECEIVERS[0],
        options.tuning.frequencyKhz, 0, 2,
        satellite ? WAVE_SATELLITE : WAVE_TERRESTRIAL,
        options.tuning.tsid ?? 0,
        allowLnb15v() ? 1 : 0]) as number;
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
    // 受信まで進んでいるのに絵が1枚も出ないときだけ、分かっていることを出す。
    //
    // **「この局は復号できない」とは言えない。**未契約の ECM の数は TS 全体の
    // 集計で、こちらは TS を丸ごと B25 に渡しているので、同じ中継器に載って
    // いる別の番組の ECM も数に入る。見ている局が問題なく映っていても上がる。
    // 無料放送はカードに既定の視聴権があり、契約が無くても映る。
    const unpurchased = words[14] ?? -1;
    const reading = words[5] ?? 0;
    if (state === 1 && stage >= 11 && this.#frames === 0 && reading > kSilentMs) {
      this.#options.onStatus?.(unpurchased > 0
        ? `映像が出ません。この TS には契約対象外の番組が含まれます`
          + `（未契約の ECM ${unpurchased} 件）。`
        : '映像が出ません。受信は続いています。');
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
      if (state === 3) {
        // **復号の失敗は番号だけでは何も分からない。**C 側は B25 の戻り値と
        // ECM の状況を持っているのに、ここで読まずに捨てていた。
        this.#options.onEnded?.(`受信が止まりました: ${name} (${error})`
          + describeB25(words[3] ?? 0, words[14] ?? -1, words[15] ?? -1));
      }
    }
  }
}
