// 音声の再生と、A/V 同期の基準になる時計。
//
// 音声は main thread でしか鳴らせない。Web Audio は Worker に無く、
// AudioWorklet も main から作る必要がある。したがって復号済み ADTS を
// Worker から受け取り、ここで WebCodecs の AudioDecoder に通して
// AudioContext へ並べる。地デジの音声は AAC-LC で、WebCodecs が受ける
// （docs/FINDINGS.md 7章）。
//
// **時計は音声が持つ。**映像を落とすのは気付かれにくいが、音声が途切れる
// のはすぐ分かる。だから音声は PTS どおりに並べ、映像がそれを追う。
//
// 放送の時計とサウンドカードの時計は独立なので、長く見ていれば必ずずれる。
// ずれが許容を超えたら置き直す。置き直しは音が飛ぶので、回数を数えて出す。

const SAMPLE_RATE = 48_000;
/** 最初の音を今からどれだけ先に置くか。詰め込みの余裕。 */
const LEAD_SECONDS = 0.3;
/** これより過去に置くことになったら置き直す。 */
const LATE_LIMIT_SECONDS = 0.05;
/** これより未来に積み上がったら置き直す。溜め込み続けない。 */
const AHEAD_LIMIT_SECONDS = 1.5;

export interface AudioFrame {
  /** 90kHz 単位。映像と同じ基準。 */
  readonly pts: number;
  readonly bytes: Uint8Array;
}

export interface AudioStats {
  readonly playing: boolean;
  readonly decoded: number;
  readonly dropped: number;
  readonly reanchors: number;
  readonly errors: number;
  /** いま鳴っている位置と、並べ終わっている位置の差。 */
  readonly bufferedSeconds: number;
}

const ADTS_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050,
  16_000, 12_000, 11_025, 8_000, 7_350,
];

/** AAC の1フレームは 1024 標本。 */
const SAMPLES_PER_FRAME = 1024;

export interface AdtsFrame {
  readonly sampleRate: number;
  readonly channels: number;
  /** `mp4a.40.x`。ADTS の profile から決める。 */
  readonly codec: string;
  /** このフレームに入っている raw data block の数。ふつう 1。 */
  readonly blocks: number;
  readonly bytes: Uint8Array;
}

/**
 * ADTS ヘッダを1つ読む。フレーム全体が揃っていなければ null。
 *
 * **PES のペイロードを丸ごと1チャンクとして渡してはいけない。**PES の切れ目と
 * ADTS フレームの境界は一致せず、1つの PES に複数フレームが入ることも、
 * 途中で切れることもある。境界を無視して渡すと、局によってデコーダが
 * `EncodingError` を出して止まる（実測: NHK では 1 PES = 1 フレームで通るが、
 * TOKYO MX では最初の1フレームで死んだ）。
 */
export function readAdtsFrame(bytes: Uint8Array, offset: number): AdtsFrame | null {
  if (offset + 7 > bytes.length) return null;
  if (bytes[offset] !== 0xff || ((bytes[offset + 1] ?? 0) & 0xf0) !== 0xf0) return null;
  const protectionAbsent = ((bytes[offset + 1] ?? 0) & 0x01) === 1;
  const profile = ((bytes[offset + 2] ?? 0) >> 6) & 0x03;
  const rateIndex = ((bytes[offset + 2] ?? 0) >> 2) & 0x0f;
  const channels = (((bytes[offset + 2] ?? 0) & 0x01) << 2)
    | (((bytes[offset + 3] ?? 0) >> 6) & 0x03);
  const frameLength = (((bytes[offset + 3] ?? 0) & 0x03) << 11)
    | ((bytes[offset + 4] ?? 0) << 3)
    | (((bytes[offset + 5] ?? 0) >> 5) & 0x07);
  const sampleRate = ADTS_RATES[rateIndex];
  if (sampleRate === undefined || channels === 0) return null;
  if (frameLength < (protectionAbsent ? 7 : 9)) return null;
  if (offset + frameLength > bytes.length) return null;
  const blocks = (((bytes[offset + 6] ?? 0) & 0x03) + 1);
  return {
    sampleRate,
    channels,
    // profile は 0=Main, 1=LC, 2=SSR, 3=LTP。object type はこれに 1 を足したもの。
    codec: `mp4a.40.${profile + 1}`,
    blocks,
    bytes: bytes.subarray(offset, offset + frameLength),
  };
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

export class AudioPlayer {
  #context: AudioContext | null = null;
  /**
   * 音量は GainNode で効かせる。`<video>` を使わないので `video.volume` が
   * 無く、UI の音量操作の宛先がここになる。
   */
  #gain: GainNode | null = null;
  #volume = 1;
  #muted = false;
  /** 一時停止による無音。利用者のミュートとは別に持つ。 */
  #paused = false;
  #decoder: AudioDecoder | null = null;
  #configured = false;
  /** ctx.currentTime と PTS を結び付ける点。 */
  #anchorTime = 0;
  #anchorPts = 0;
  #anchored = false;
  /** 次に音を置く位置。連続再生のために PTS ではなくこちらを積む。 */
  #scheduled = 0;
  #decodedFrames = 0;
  #dropped = 0;
  #reanchors = 0;
  #errors = 0;
  #closed = false;
  /** 直前の設定。変わったときだけ configure し直す。 */
  #codec = '';
  #sampleRate = 0;
  #channels = 0;
  /** PES を跨いで切れた ADTS フレームの前半。 */
  #pending = new Uint8Array(0);
  /** 次のフレームに与える PTS。PES の PTS はフレーム単位ではないため。 */
  #nextPts: number | null = null;

  /**
   * AudioContext を用意する。利用者の操作の中から呼ぶこと。
   *
   * resume() は待たない。操作から来ていなければブラウザが自動再生を
   * 許すまで解決しないので、待つと呼び出し側ごと止まる。解決しないうちは
   * currentTime が進まず、時計も出ない。それは「まだ鳴っていない」という
   * 正しい状態である。
   */
  start(): void {
    if (this.#context !== null) return;
    const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
    void context.resume();
    const gain = context.createGain();
    gain.gain.value = this.#level();
    gain.connect(context.destination);
    this.#gain = gain;
    this.#context = context;
    this.#decoder = new AudioDecoder({
      output: (data) => this.#play(data),
      error: () => { this.#recover(); },
    });
  }

  /**
   * 音声 PES のペイロードを受ける。中の ADTS フレームを切り出し、1つずつ
   * 渡す。フレームが PES を跨いで切れていれば次まで持ち越す。
   */
  push(frame: AudioFrame): void {
    if (this.#closed || this.#decoder === null) return;

    const data = this.#pending.length === 0 ? frame.bytes : concat(this.#pending, frame.bytes);
    this.#pending = new Uint8Array(0);

    // PES の先頭から同期語を探す。境界がずれていても拾い直せる。
    let offset = 0;
    while (offset + 2 <= data.length
      && !(data[offset] === 0xff && ((data[offset + 1] ?? 0) & 0xf0) === 0xf0)) {
      offset += 1;
    }

    let pts = this.#nextPts ?? frame.pts;
    // PES の PTS は先頭フレームのもの。飛んでいたら合わせ直す。
    if (this.#nextPts === null || Math.abs(frame.pts - pts) > 90_000) pts = frame.pts;

    while (offset < data.length) {
      const adts = readAdtsFrame(data, offset);
      if (adts === null) {
        // 途中で切れている。次の PES と繋いでから読み直す。
        this.#pending = data.slice(offset);
        break;
      }
      this.#configure(adts);
      try {
        this.#decoder.decode(new EncodedAudioChunk({
          type: 'key',
          // WebCodecs はマイクロ秒。PTS は 90kHz。
          timestamp: Math.round((pts / 90_000) * 1_000_000),
          data: adts.bytes,
        }));
      } catch {
        this.#errors += 1;
      }
      const samples = SAMPLES_PER_FRAME * adts.blocks;
      pts += (samples / adts.sampleRate) * 90_000;
      offset += adts.bytes.length;
    }
    this.#nextPts = pts;
  }

  /** 設定が変わったときだけ configure する。毎回呼ぶと復号が途切れる。 */
  #configure(frame: AdtsFrame): void {
    if (this.#decoder === null) return;
    if (this.#codec === frame.codec && this.#sampleRate === frame.sampleRate
      && this.#channels === frame.channels) {
      return;
    }
    this.#codec = frame.codec;
    this.#sampleRate = frame.sampleRate;
    this.#channels = frame.channels;
    try {
      this.#decoder.configure({
        codec: frame.codec,
        sampleRate: frame.sampleRate,
        numberOfChannels: frame.channels,
      });
    } catch {
      this.#errors += 1;
    }
  }

  /**
   * デコーダが壊れたら作り直す。WebCodecs のデコーダは一度 error を出すと
   * 閉じたままになるので、放っておくと以後ずっと無音になる。
   */
  #recover(): void {
    if (this.#closed || this.#context === null) return;
    this.#errors += 1;
    try { this.#decoder?.close(); } catch { /* 既に閉じている */ }
    this.#codec = '';
    this.#sampleRate = 0;
    this.#channels = 0;
    this.#pending = new Uint8Array(0);
    this.#decoder = new AudioDecoder({
      output: (data) => this.#play(data),
      error: () => { this.#recover(); },
    });
  }

  setVolume(volume: number): void {
    this.#volume = Math.max(0, Math.min(1, volume));
    this.#applyLevel();
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#applyLevel();
  }

  /**
   * 一時停止中の無音。**復号も再生の予約も止めない。**止めるとクロックが
   * 進まなくなり、映像の歩調を合わせる相手が消える。復帰したときに
   * ライブの位置へ戻すための作り直しも要らなくなる。
   */
  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.#applyLevel();
  }

  #level(): number {
    return this.#muted || this.#paused ? 0 : this.#volume;
  }

  #applyLevel(): void {
    if (this.#gain !== null) this.#gain.gain.value = this.#level();
  }

  /** いま鳴っている位置を PTS で返す。未再生なら null。 */
  clockPts(): number | null {
    if (!this.#anchored || this.#context === null) return null;
    return this.#anchorPts + (this.#context.currentTime - this.#anchorTime) * 90_000;
  }

  stats(): AudioStats {
    return {
      playing: this.#context !== null,
      decoded: this.#decodedFrames,
      dropped: this.#dropped,
      reanchors: this.#reanchors,
      errors: this.#errors,
      bufferedSeconds: this.#context === null
        ? 0
        : Math.max(0, this.#scheduled - this.#context.currentTime),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#decoder?.close(); } catch { /* 既に閉じている */ }
    this.#decoder = null;
    this.#gain = null;
    const context = this.#context;
    this.#context = null;
    if (context !== null) await context.close();
  }

  #play(data: AudioData): void {
    const context = this.#context;
    if (context === null || this.#closed) { data.close(); return; }
    try {
      const pts = (data.timestamp / 1_000_000) * 90_000;
      const seconds = data.numberOfFrames / data.sampleRate;

      if (!this.#anchored) this.#anchor(context.currentTime + LEAD_SECONDS, pts);

      // 置くべき位置。PTS から引くので、入力が飛んでも追随する。
      let at = this.#anchorTime + (pts - this.#anchorPts) / 90_000;
      if (at < context.currentTime - LATE_LIMIT_SECONDS
        || at > context.currentTime + AHEAD_LIMIT_SECONDS) {
        this.#anchor(context.currentTime + LEAD_SECONDS, pts);
        this.#reanchors += 1;
        at = this.#anchorTime;
      }

      const buffer = context.createBuffer(
        data.numberOfChannels, data.numberOfFrames, data.sampleRate);
      for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
        const plane = new Float32Array(data.numberOfFrames);
        data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
        buffer.copyToChannel(plane, channel);
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.#gain ?? context.destination);
      source.start(at);
      this.#scheduled = Math.max(this.#scheduled, at + seconds);
      this.#decodedFrames += 1;
    } catch {
      this.#dropped += 1;
    } finally {
      data.close();
    }
  }

  #anchor(time: number, pts: number): void {
    this.#anchorTime = time;
    this.#anchorPts = pts;
    this.#anchored = true;
  }
}
