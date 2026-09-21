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

/**
 * ADTS ヘッダから WebCodecs の設定を読む。ADTS のままでも
 * `mp4a.40.2` として受けるので、要るのは標本化周波数とチャンネル数だけ。
 */
export function readAdtsHeader(
  bytes: Uint8Array,
): { sampleRate: number; channels: number } | null {
  if (bytes.length < 7) return null;
  if (bytes[0] !== 0xff || ((bytes[1] ?? 0) & 0xf0) !== 0xf0) return null;
  const RATES = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050,
    16_000, 12_000, 11_025, 8_000, 7_350,
  ];
  const rateIndex = ((bytes[2] ?? 0) >> 2) & 0x0f;
  const channels = (((bytes[2] ?? 0) & 0x01) << 2) | (((bytes[3] ?? 0) >> 6) & 0x03);
  const sampleRate = RATES[rateIndex];
  if (sampleRate === undefined || channels === 0) return null;
  return { sampleRate, channels };
}

export class AudioPlayer {
  #context: AudioContext | null = null;
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
    this.#context = context;
    this.#decoder = new AudioDecoder({
      output: (data) => this.#play(data),
      error: () => { this.#errors += 1; },
    });
  }

  /** Worker から来た ADTS フレームを1つ受ける。 */
  push(frame: AudioFrame): void {
    if (this.#closed || this.#decoder === null) return;
    if (!this.#configured) {
      const header = readAdtsHeader(frame.bytes);
      if (header === null) return;
      this.#decoder.configure({
        // ADTS をそのまま渡すので description は要らない。
        codec: 'mp4a.40.2',
        sampleRate: header.sampleRate,
        numberOfChannels: header.channels,
      });
      this.#configured = true;
    }
    try {
      this.#decoder.decode(new EncodedAudioChunk({
        type: 'key',
        // WebCodecs はマイクロ秒。PTS は 90kHz。
        timestamp: Math.round((frame.pts / 90_000) * 1_000_000),
        data: frame.bytes,
      }));
    } catch {
      this.#errors += 1;
    }
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
      source.connect(context.destination);
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
