// 映像を出す Worker。TS の断片を受け取り、分離して復号し、canvas へ描く。
//
// 描画まで Worker で完結させる。OffscreenCanvas を渡してもらえば VideoFrame を
// スレッド間で渡す必要がなく、main thread は UI と（live では）チューナーの
// 取り出しだけを見ていればよい。
//
// **流し込み式である。**ファイル再生でも live でも入口は同じで、違うのは
// 誰が chunk を送ってくるかだけ。live では ES を溜め続けるわけにいかないので、
// 溜めるのをやめて「消費したら次をくれ」と言う形にした。自分で時計を刻むより
// 消費に同期するほうが、タイマーが絞られても流れが止まらない。
//
// 復号は実時間の6倍以上出る（docs/FINDINGS.md 17章）ので、律速は復号ではなく
// 表示の間隔である。刻みは sequence の frame_period から取る。ずれが大きく
// なったら刻み直す: live では受信の途切れや起動直後のばらつきで必ずずれる。
//
// **刻みは滞留量で微調整する。**放送の時計とこちらの時計は独立なので、
// frame_period をそのまま刻むと必ずどちらかへずれていく。実測では60秒で
// 1.2 MiB ぶん（約0.6秒）滞留が増えた。滞留を見て±5%まで刻みを伸縮させれば、
// 目に見えない範囲で吸収できる。PCR から時計を復元するのが本筋だが、
// 滞留を見るほうが仕組みが少なく、入力が途切れても壊れない。

import type { ResponseMessage } from 'web-bml/protocol';
import { STREAM_TYPE, TsDemuxer, type Program } from '../ts/demux';
import { Mpeg2Decoder, PICTURE_TAGS, STEP, type Mpeg2Sequence } from './mpeg2';

export interface PlayerStarted {
  readonly kind: 'started';
  readonly programNumber: number;
  readonly videoPid: number;
  readonly audioPids: readonly number[];
  readonly captionPids: readonly number[];
}

export interface PlayerProgress {
  readonly kind: 'progress';
  readonly frames: number;
  readonly decodeMs: number;
  readonly resyncs: number;
  /** まだ復号していない映像 ES。live ではこれが遅延の一部。 */
  readonly pendingEsBytes: number;
  /** いま適用している刻みの伸縮率。正なら速め、負なら遅め。 */
  readonly rateTrim: number;
  /** 音声の時計に対する映像のずれ (ms)。正なら映像が先行。時計が無ければ null。 */
  readonly avSkewMs: number | null;
  readonly sequence: Mpeg2Sequence | null;
  readonly counters: Record<string, number>;
  /** 前回の報告からの、描いたフレームどうしの間隔の最大 (ms)。カクつきの目安。 */
  readonly maxFrameGapMs: number;
  /** 前回の報告からの、データ放送の解読1回あたりの最大と合計 (ms)。映像と同じ Worker で動く。 */
  readonly bmlMaxMs: number;
  readonly bmlTotalMs: number;
}

/** 音声は main でしか鳴らせないので、ADTS をそのまま渡す。 */
export interface PlayerAudio {
  readonly kind: 'audio';
  readonly pts: number;
  readonly bytes: ArrayBuffer;
}

/** 字幕は解釈も描画も main の aribb24.js に任せるので、そのまま渡す。 */
export interface PlayerCaption {
  readonly kind: 'caption';
  readonly pts: number;
  readonly bytes: ArrayBuffer;
}

/**
 * データ放送。web-bml の `decodeTS()` が出したものを、chunk ごとにまとめて渡す。
 * BML ブラウザは DOM に描くので main に置くしかない。
 */
export interface PlayerBml {
  readonly kind: 'bml';
  readonly messages: readonly ResponseMessage[];
}

/** データ放送の解読が止まった。映像は止めない。 */
export interface PlayerBmlFailed { readonly kind: 'bml-failed'; readonly message: string }

export interface PlayerWant { readonly kind: 'want' }
export interface PlayerDone { readonly kind: 'done'; readonly frames: number }
export interface PlayerFailed { readonly kind: 'failed'; readonly message: string }

export type PlayerMessage =
  PlayerStarted | PlayerProgress | PlayerAudio | PlayerCaption | PlayerBml | PlayerBmlFailed
  | PlayerWant | PlayerDone | PlayerFailed;

export type PlayerRequest =
  /**
   * programNumber を指定すると、その番組だけを選ぶ。1つの物理チャンネルに
   * 複数サービスが多重化されているので、指定が無いと最初に見つかった
   * 映像付きの番組になる。
   */
  | {
      readonly kind: 'init';
      readonly canvas: OffscreenCanvas;
      readonly programNumber?: number;
    }
  /** backlogBytes は送り手側にまだ残っている TS。live の遅延の一部である。 */
  | { readonly kind: 'chunk'; readonly bytes: ArrayBuffer; readonly backlogBytes?: number }
  /** 音声の時計。これが来ている間は映像はこれに追随する。 */
  | { readonly kind: 'clock'; readonly pts: number }
  | { readonly kind: 'paused'; readonly value: boolean }
  /** データ放送の解読を始める・やめる。既定ではしない。 */
  | { readonly kind: 'bml'; readonly enabled: boolean }
  | { readonly kind: 'end' };

const post = (message: PlayerMessage): void => { self.postMessage(message); };

/** データ放送の解読にかかった時間。進み具合の報告のたびに読んで戻す。 */
const bmlTiming = { maxMs: 0, totalMs: 0 };

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

/** 標本比を掛けた、実際に見せるべき寸法。 */
function displaySize(sequence: Mpeg2Sequence): { width: number; height: number } {
  const width = Math.round(
    sequence.pictureWidth * (sequence.pixelWidth || 1) / (sequence.pixelHeight || 1));
  return { width: width > 0 ? width : sequence.pictureWidth, height: sequence.pictureHeight };
}

/** ずれがこれを超えたら刻み直す。受信が途切れれば必ず超える。 */
const RESYNC_MS = 500;
/**
 * 補充を頼む水位。消費のたびに頼んではいけない: 1回の要求で返ってくるのは
 * TS の塊（MiB 単位）で、1回に消費するのは PES ひとつ（数十 KiB）なので、
 * 消費と要求を 1:1 にすると供給が2桁過剰になり、溜まった ES を早送りで
 * 吐き出す羽目になる。水位で頼めば、要求の粒度と消費の粒度が揃わなくてよい。
 */
const LOW_WATER_BYTES = 1024 * 1024;
/** 供給が表示を追い越している。遅れているので待たずに追いつく。 */
const HIGH_WATER_BYTES = 3 * 1024 * 1024;
/** 刻みの伸縮でここへ寄せる。低水位と同じにしておけばファイル再生では効かない。 */
const TARGET_BACKLOG_BYTES = LOW_WATER_BYTES;
/** 伸縮の上限。これ以上動かすと目に見える。 */
const MAX_RATE_TRIM = 0.05;

class Player {
  readonly #canvas: OffscreenCanvas;
  readonly #context: OffscreenCanvasRenderingContext2D;
  readonly #es: { bytes: Uint8Array; pts: number | null }[] = [];
  #esBytes = 0;
  #ended = false;
  #wantOutstanding = false;
  #wake: (() => void) | null = null;
  readonly #wantedProgram: number | null;
  #videoPid: number | null = null;
  #audioPid: number | null = null;
  #captionPid: number | null = null;
  #demuxer: TsDemuxer;

  /** main から届く音声の時計。届いた時刻とともに覚えて、間を補間する。 */
  #clockPts: number | null = null;
  #clockAt = 0;
  #avSkewMs: number | null = null;

  #upstreamBacklog = 0;
  #frames = 0;
  #decodeMs = 0;
  #resyncs = 0;
  #nextDue = 0;
  #periodMs = 1000 / 29.97;
  #trim = 0;
  #sequence: Mpeg2Sequence | null = null;
  #sized = false;
  #lastDrawAt = 0;
  #maxFrameGapMs = 0;
  /** 一時停止。描画だけを止める。受信と復号は続ける。 */
  #paused = false;

  constructor(canvas: OffscreenCanvas, wantedProgram: number | null) {
    this.#canvas = canvas;
    this.#wantedProgram = wantedProgram;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d コンテキストを取れません');
    this.#context = context;
    this.#demuxer = new TsDemuxer({
      onPrograms: (programs) => this.#choose(programs),
      onPes: (packet) => {
        if (packet.data.length === 0) return;
        if (packet.pid === this.#audioPid || packet.pid === this.#captionPid) {
          // 音声も字幕も main 側で扱う。Web Audio も aribb24.js の描画も
          // Worker には置けない。ここでは触らずそのまま渡す。
          if (packet.pts === null) return;
          const copy = packet.data.slice();
          const message: PlayerAudio | PlayerCaption = {
            kind: packet.pid === this.#audioPid ? 'audio' : 'caption',
            pts: packet.pts,
            bytes: copy.buffer,
          };
          self.postMessage(message, [copy.buffer]);
          return;
        }
        this.#es.push({ bytes: packet.data, pts: packet.pts });
        this.#esBytes += packet.data.length;
        this.#wake?.();
      },
    });
  }

  /** main が鳴らしている位置。これが来ている間は映像がこれに追随する。 */
  clock(pts: number): void {
    this.#clockPts = pts;
    this.#clockAt = performance.now();
  }

  push(bytes: Uint8Array, backlogBytes: number): void {
    this.#wantOutstanding = false;
    this.#upstreamBacklog = backlogBytes;
    this.#demuxer.push(bytes);
    this.#maybeWant();
    this.#wake?.();
  }

  /** 水位を割っていて、まだ頼んでいなければ頼む。 */
  #maybeWant(): void {
    if (this.#ended || this.#wantOutstanding) return;
    if (this.#esBytes >= LOW_WATER_BYTES) return;
    this.#wantOutstanding = true;
    post({ kind: 'want' });
  }

  end(): void {
    this.#demuxer.flush();
    this.#ended = true;
    this.#wake?.();
  }

  /** 最初に MPEG-2 映像を持つ番組を選ぶ。ワンセグ (H.264) は扱わない。 */
  #choose(programs: readonly Program[]): void {
    if (this.#videoPid !== null) return;
    for (const program of programs) {
      if (this.#wantedProgram !== null && program.programNumber !== this.#wantedProgram) continue;
      const video = program.streams.find(
        (stream) => stream.streamType === STREAM_TYPE.mpeg2Video);
      if (video === undefined) continue;
      this.#videoPid = video.pid;
      const audio = program.streams.find(
        (stream) => stream.streamType === STREAM_TYPE.adtsAac);
      // component_tag 0x30 が主字幕、0x38 が文字スーパー。字幕だけを取る。
      const caption = program.streams.find(
        (stream) => stream.streamType === STREAM_TYPE.privateData
          && stream.componentTag === 0x30);
      this.#audioPid = audio?.pid ?? null;
      this.#captionPid = caption?.pid ?? null;
      this.#demuxer.select([video.pid, audio?.pid, caption?.pid]
        .filter((pid): pid is number => pid !== undefined));
      post({
        kind: 'started',
        programNumber: program.programNumber,
        videoPid: video.pid,
        audioPids: program.streams.filter((s) => s.streamType === STREAM_TYPE.adtsAac)
          .map((s) => s.pid),
        captionPids: program.streams.filter((s) => s.streamType === STREAM_TYPE.privateData)
          .map((s) => s.pid),
      });
      return;
    }
  }

  #waitForData(): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = () => { this.#wake = null; resolve(); };
    });
  }

  async run(): Promise<void> {
    const decoder = await Mpeg2Decoder.create();
    let flushed = false;
    try {
      for (;;) {
        const started = performance.now();
        const step = decoder.step();
        this.#decodeMs += performance.now() - started;

        if (step === STEP.end) break;
        if (step < 0) throw new Error(`デコーダが ${step} を返しました`);
        if (step === STEP.sequence) { this.#onSequence(decoder); continue; }
        if (step === STEP.frame) { await this.#onFrame(decoder); continue; }

        // needData
        const chunk = this.#es.shift();
        if (chunk !== undefined) {
          this.#esBytes -= chunk.bytes.length;
          decoder.feed(chunk.bytes);
          // PTS はピクチャの印として運ぶ。B ピクチャがあると符号化順と
          // 表示順が食い違うので、chunk と一緒には持てない。
          if (chunk.pts !== null) {
            decoder.tag(chunk.pts >>> 0, Math.floor(chunk.pts / 2 ** 32));
          }
          this.#maybeWant();
          continue;
        }
        if (this.#ended) {
          if (flushed) break;
          // 「次の start code を見て」初めて直前の picture が出るので、
          // 終端では sequence_end_code を流す。
          decoder.feed(Uint8Array.of(0x00, 0x00, 0x01, 0xb7));
          flushed = true;
          continue;
        }
        this.#maybeWant();
        await this.#waitForData();
      }
    } finally {
      decoder.close();
    }
    post({ kind: 'done', frames: this.#frames });
  }

  #onSequence(decoder: Mpeg2Decoder): void {
    const sequence = decoder.sequence;
    if (sequence === null) return;
    this.#sequence = sequence;
    this.#periodMs = sequence.framePeriod / 27_000;
    if (!this.#sized) {
      // **標本比を掛けた寸法で作る。**地デジは 1440x1080 を標本比 4:3 で
      // 送っており、符号化寸法のまま canvas を作ると 4:3 の絵になる。
      // `object-fit: contain` の箱が 16:9 でも、中身が 4:3 のままでは
      // 横が詰まって表示される。
      this.#canvas.width = displaySize(sequence).width;
      this.#canvas.height = displaySize(sequence).height;
      this.#sized = true;
    }
  }

  async #onFrame(decoder: Mpeg2Decoder): Promise<void> {
    const sequence = decoder.sequence;
    const frame = decoder.frame();
    if (sequence === null || frame === null) return;

    const lumaSize = sequence.codedWidth * sequence.codedHeight;
    const chromaSize = sequence.chromaWidth * sequence.chromaHeight;

    // 一時停止中は描かない。**分離も復号も歩調合わせも止めない。**止めると
    // 受信を手放すことになり、復帰のたびに復調ロックを待つことになる。
    // 描かないぶん、止めているあいだは表示経路のコピーも起きない。
    let planes: Uint8Array | null = null;
    if (!this.#paused) {
      // VideoFrame は1本の連続したバッファを要求するので、3面をまとめて
      // 1回だけ写す。ここが表示経路で唯一のコピーである。
      // **待つ前に写す。**待っているあいだに復号が進むと、frame の指す先は
      // WASM の同じ場所で書き換わる。
      planes = new Uint8Array(lumaSize + chromaSize * 2);
      planes.set(frame.y.subarray(0, lumaSize), 0);
      planes.set(frame.u.subarray(0, chromaSize), lumaSize);
      planes.set(frame.v.subarray(0, chromaSize), lumaSize + chromaSize);
    }

    const wait = this.#schedule(frame);
    if (wait > 1 && this.#esBytes < HIGH_WATER_BYTES) await sleep(wait);

    if (planes !== null) {
      const picture = new VideoFrame(planes, {
        format: 'I420',
        codedWidth: sequence.codedWidth,
        codedHeight: sequence.codedHeight,
        layout: [
          { offset: 0, stride: sequence.codedWidth },
          { offset: lumaSize, stride: sequence.chromaWidth },
          { offset: lumaSize + chromaSize, stride: sequence.chromaWidth },
        ],
        // 符号化は 1440x1088 でも見せるのは 1440x1080。
        visibleRect: {
          x: 0, y: 0, width: sequence.pictureWidth, height: sequence.pictureHeight,
        },
        // 標本比 4:3 の 1440x1080 は 1920x1080 として見せる。
        displayWidth: displaySize(sequence).width,
        displayHeight: displaySize(sequence).height,
        timestamp: Math.round(this.#frames * this.#periodMs * 1000),
      });
      this.#context.drawImage(picture, 0, 0, this.#canvas.width, this.#canvas.height);
      picture.close();
      const drawnAt = performance.now();
      if (this.#lastDrawAt !== 0) {
        this.#maxFrameGapMs = Math.max(this.#maxFrameGapMs, drawnAt - this.#lastDrawAt);
      }
      this.#lastDrawAt = drawnAt;
    }

    this.#frames += 1;
    if (this.#frames % 30 === 0) {
      post({
        kind: 'progress',
        frames: this.#frames,
        decodeMs: this.#decodeMs,
        resyncs: this.#resyncs,
        pendingEsBytes: this.#esBytes,
        rateTrim: this.#trim,
        avSkewMs: this.#avSkewMs,
        sequence: this.#sequence,
        counters: { ...this.#demuxer.counters },
        maxFrameGapMs: this.#maxFrameGapMs,
        bmlMaxMs: bmlTiming.maxMs,
        bmlTotalMs: bmlTiming.totalMs,
      });
      this.#maxFrameGapMs = 0;
      bmlTiming.maxMs = 0;
      bmlTiming.totalMs = 0;
    }
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  /**
   * このフレームを出すまで何 ms 待つかを決める。
   *
   * 音声の時計が来ていればそれに合わせる。音声を落とすのはすぐ気付かれるが
   * 映像のずれは気付かれにくいので、合わせるのは映像の側である。時計が
   * 無ければ（音声の無い番組、まだ鳴り始めていない間）自分で刻み、
   * 滞留を見て伸縮させる。
   */
  #schedule(frame: { flags: number; tag: number; tag2: number }): number {
    const clock = this.#interpolatedClock();
    const pts = (frame.flags & PICTURE_TAGS) !== 0
      ? frame.tag2 * 2 ** 32 + frame.tag
      : null;

    if (clock !== null && pts !== null) {
      const skewMs = ((pts - clock) / 90_000) * 1000;
      this.#avSkewMs = skewMs;
      // 大きく外れていれば合わせようがない。すぐ出して次に賭ける。
      if (skewMs < -RESYNC_MS || skewMs > RESYNC_MS * 4) {
        this.#resyncs += 1;
        this.#nextDue = 0;
        return 0;
      }
      return skewMs;
    }

    this.#avSkewMs = null;
    if (this.#nextDue === 0) this.#resync();
    const wait = this.#nextDue - performance.now();
    if (wait < -RESYNC_MS) this.#resync();
    this.#nextDue += this.#periodMs * (1 - this.#rateTrim());
    return wait;
  }

  /** 時計は 100 ms おきにしか来ないので、間は経過時間で補う。 */
  #interpolatedClock(): number | null {
    if (this.#clockPts === null) return null;
    return this.#clockPts + ((performance.now() - this.#clockAt) / 1000) * 90_000;
  }

  /**
   * 滞留が目標より多ければ刻みを詰め、少なければ緩める。戻り値は比率で、
   * 正なら速く、負なら遅く。±MAX_RATE_TRIM に収める。
   */
  #rateTrim(): number {
    const backlog = this.#esBytes + this.#upstreamBacklog;
    const deviation = (backlog - TARGET_BACKLOG_BYTES) / (2 * TARGET_BACKLOG_BYTES);
    this.#trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, deviation));
    return this.#trim;
  }

  #resync(): void {
    if (this.#nextDue !== 0) this.#resyncs += 1;
    this.#nextDue = performance.now() + this.#periodMs;
  }
}

/**
 * データ放送の解読。**映像とは別に TS を丸ごと読む。**映像の分離器は選んだ
 * PID しか通さないが、データ放送はカルーセル（DSM-CC）、BIT、TOT など
 * 別の PID に載っている。web-bml の `decodeTS()` に TS をそのまま流す。
 *
 * web-bml は使うときだけ読む。使わない視聴では Worker の起動を重くしない。
 * 読み終わる前に来た chunk は捨てる。カルーセルは繰り返し送られてくる。
 */
class BmlDecoder {
  #reader: { push(block: Uint8Array): void; close(): void } | null = null;
  #pending: ResponseMessage[] = [];
  #closed = false;

  constructor(serviceId: number | null) {
    import('web-bml/ts').then(({ decodeTS }) => {
      if (this.#closed) return;
      const send = (message: ResponseMessage): void => { this.#pending.push(message); };
      this.#reader = serviceId === null
        ? decodeTS({ sendCallback: send })
        : decodeTS({ sendCallback: send, serviceId });
    }).catch((error: unknown) => { this.#fail(error); });
  }

  push(bytes: Uint8Array): void {
    if (this.#reader === null) return;
    const started = performance.now();
    try {
      this.#reader.push(bytes);
    } catch (error) {
      this.#fail(error);
      return;
    }
    this.#flush();
    const elapsed = performance.now() - started;
    bmlTiming.maxMs = Math.max(bmlTiming.maxMs, elapsed);
    bmlTiming.totalMs += elapsed;
  }

  close(): void {
    this.#closed = true;
    this.#reader?.close();
    this.#reader = null;
    this.#pending = [];
  }

  /**
   * chunk 1つぶんをまとめて送る。**PCR は最後の1つだけ残す。**chunk は
   * 数百 ms ぶんの TS なので PCR が何十個も入っているが、BML 側が使うのは
   * 今の時刻だけである。
   */
  #flush(): void {
    if (this.#pending.length === 0) return;
    let lastPcr = -1;
    this.#pending.forEach((message, index) => { if (message.type === 'pcr') lastPcr = index; });
    const messages = this.#pending.filter(
      (message, index) => message.type !== 'pcr' || index === lastPcr);
    this.#pending = [];
    post({ kind: 'bml', messages });
  }

  #fail(error: unknown): void {
    this.close();
    post({ kind: 'bml-failed', message: error instanceof Error ? error.message : String(error) });
  }
}

let player: Player | null = null;
let wantedProgram: number | null = null;
let bml: BmlDecoder | null = null;

self.addEventListener('message', (event: MessageEvent<PlayerRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'bml') {
      bml?.close();
      bml = request.enabled ? new BmlDecoder(wantedProgram) : null;
      return;
    }
    if (request.kind === 'chunk') {
      const bytes = new Uint8Array(request.bytes);
      // どちらも bytes を読むだけで書き換えない。
      bml?.push(bytes);
      player?.push(bytes, request.backlogBytes ?? 0);
      return;
    }
    if (request.kind === 'init') {
      wantedProgram = request.programNumber ?? null;
      player = new Player(request.canvas, request.programNumber ?? null);
      player.run().catch((error: unknown) => {
        post({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (request.kind === 'clock') { player?.clock(request.pts); return; }
    if (request.kind === 'paused') { player?.setPaused(request.value); return; }
    player?.end();
  } catch (error) {
    post({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
  }
});
