// libmpeg2 の WASM モジュールを型のある形で包む。
//
// 地デジのフルセグは MPEG-2 Video で、ブラウザ内蔵のデコーダは受け付けない
// （docs/FINDINGS.md 7章）。サーバーを持たない以上、ここが映像経路の唯一の
// 復号手段になる。
//
// 復号ロジックは一切ここにない。上流の状態機械をそのまま呼ぶ。

const MODULE_URL = '/build/mpeg2-decoder/mpeg2-decoder.mjs';

export const STEP = Object.freeze({
  needData: 0,
  frame: 1,
  sequence: 2,
  end: 3,
  invalid: -1,
  closed: -2,
});

// 上流 mpeg2.h の picture flags のうち、表示に要るものだけ。
export const PICTURE_CODING_TYPE_MASK = 7;
export const PICTURE_TOP_FIELD_FIRST = 8;
export const PICTURE_PROGRESSIVE_FRAME = 16;
/** これが立っているときだけ tag が意味を持つ。 */
export const PICTURE_TAGS = 128;

export interface Mpeg2Sequence {
  /** 符号化されている大きさ。マクロブロック境界まで切り上げられている。 */
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly chromaWidth: number;
  readonly chromaHeight: number;
  /** 実際に見せるべき大きさ。1440x1088 符号化なら 1440x1080。 */
  readonly pictureWidth: number;
  readonly pictureHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** 標本アスペクト。1440x1080 を 16:9 にするのはこれ。 */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** 1フレームの長さ。単位は 1/27000000 秒（上流のクロック）。 */
  readonly framePeriod: number;
  readonly flags: number;
}

export interface Mpeg2Frame {
  /** WASM ヒープへの view。次の step() まで**しか**有効でない。 */
  readonly y: Uint8Array;
  readonly u: Uint8Array;
  readonly v: Uint8Array;
  readonly flags: number;
  readonly fields: number;
  /**
   * feed の前に tag() で付けた値。B ピクチャがあると符号化順と表示順が
   * 食い違うので、PTS はこれで運ぶ。flags に PICTURE_TAGS が立っていなければ
   * 無効。
   */
  readonly tag: number;
  readonly tag2: number;
}

interface DecoderModule {
  ccall(
    name: string,
    returnType: string | null,
    argumentTypes: string[],
    args: unknown[],
  ): number;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

let modulePromise: Promise<DecoderModule> | null = null;

async function loadModule(): Promise<DecoderModule> {
  modulePromise ??= (async () => {
    const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
      default: () => Promise<DecoderModule>;
    };
    return factory.default();
  })();
  return modulePromise;
}

export class Mpeg2Decoder {
  readonly #wasm: DecoderModule;
  readonly #handle: number;
  readonly #sequenceWords: number;
  readonly #frameWords: number;
  readonly #sequencePointer: number;
  readonly #framePointer: number;
  #chunkPointer = 0;
  #chunkCapacity = 0;
  #sequence: Mpeg2Sequence | null = null;
  #closed = false;

  private constructor(wasm: DecoderModule, handle: number) {
    this.#wasm = wasm;
    this.#handle = handle;
    this.#sequenceWords = wasm.ccall('webts_mpeg2_sequence_words', 'number', [], []);
    this.#frameWords = wasm.ccall('webts_mpeg2_frame_words', 'number', [], []);
    this.#sequencePointer = wasm._malloc(this.#sequenceWords * 4);
    this.#framePointer = wasm._malloc(this.#frameWords * 4);
  }

  static async create(): Promise<Mpeg2Decoder> {
    const wasm = await loadModule();
    const handle = wasm.ccall('webts_mpeg2_open', 'number', [], []);
    if (handle === 0) throw new Error('webts_mpeg2_open failed');
    return new Mpeg2Decoder(wasm, handle);
  }

  /**
   * 次のチャンクを渡す。上流はコピーせずその場で読むので、バイト列は
   * step() が needData を返すまで WASM ヒープ側に置いたままにする。
   */
  feed(chunk: Uint8Array): void {
    if (this.#closed) throw new Error('decoder is closed');
    if (chunk.length === 0) return;
    if (chunk.length > this.#chunkCapacity) {
      if (this.#chunkPointer !== 0) this.#wasm._free(this.#chunkPointer);
      this.#chunkPointer = this.#wasm._malloc(chunk.length);
      this.#chunkCapacity = chunk.length;
    }
    this.#wasm.HEAPU8.set(chunk, this.#chunkPointer);
    this.#wasm.ccall('webts_mpeg2_feed', null, ['number', 'number', 'number'],
      [this.#handle, this.#chunkPointer, chunk.length]);
  }

  /**
   * 次に渡す chunk が運ぶピクチャに印を付ける。feed と step の間に呼ぶ。
   * 表示されたときに frame() から同じ値が返る。
   */
  tag(tag: number, tag2: number): void {
    if (this.#closed) return;
    this.#wasm.ccall('webts_mpeg2_tag', null, ['number', 'number', 'number'],
      [this.#handle, tag >>> 0, tag2 >>> 0]);
  }

  /** 何か報告できるところまで進める。戻り値は STEP のいずれか。 */
  step(): number {
    if (this.#closed) return STEP.closed;
    const step = this.#wasm.ccall('webts_mpeg2_step', 'number', ['number'], [this.#handle]);
    if (step === STEP.sequence) this.#sequence = this.#readSequence();
    return step;
  }

  /** 直近の sequence。step() が sequence を返したあとに更新される。 */
  get sequence(): Mpeg2Sequence | null {
    return this.#sequence;
  }

  /**
   * 直近の step() が報告したフレームの面を指す。返る view はデコーダが
   * 使い回すバッファを指しており、**次の step() で内容が変わる**。
   */
  frame(): Mpeg2Frame | null {
    if (this.#closed || this.#sequence === null) return null;
    const ok = this.#wasm.ccall('webts_mpeg2_frame', 'number', ['number', 'number', 'number'],
      [this.#handle, this.#framePointer, this.#frameWords]);
    if (ok !== 0) return null;
    const words = this.#wasm.HEAP32.subarray(
      this.#framePointer / 4, this.#framePointer / 4 + this.#frameWords);
    const heap = this.#wasm.HEAPU8;
    const luma = this.#sequence.codedWidth * this.#sequence.codedHeight;
    const chroma = this.#sequence.chromaWidth * this.#sequence.chromaHeight;
    return {
      y: heap.subarray(words[0] ?? 0, (words[0] ?? 0) + luma),
      u: heap.subarray(words[1] ?? 0, (words[1] ?? 0) + chroma),
      v: heap.subarray(words[2] ?? 0, (words[2] ?? 0) + chroma),
      flags: words[3] ?? 0,
      fields: words[4] ?? 0,
      tag: (words[5] ?? 0) >>> 0,
      tag2: (words[6] ?? 0) >>> 0,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#chunkPointer !== 0) this.#wasm._free(this.#chunkPointer);
    this.#wasm._free(this.#framePointer);
    this.#wasm._free(this.#sequencePointer);
    this.#wasm.ccall('webts_mpeg2_close', null, ['number'], [this.#handle]);
  }

  #readSequence(): Mpeg2Sequence | null {
    const ok = this.#wasm.ccall('webts_mpeg2_sequence', 'number', ['number', 'number', 'number'],
      [this.#handle, this.#sequencePointer, this.#sequenceWords]);
    if (ok !== 0) return null;
    const w = this.#wasm.HEAP32.subarray(
      this.#sequencePointer / 4, this.#sequencePointer / 4 + this.#sequenceWords);
    const at = (index: number): number => w[index] ?? 0;
    return {
      codedWidth: at(0), codedHeight: at(1),
      chromaWidth: at(2), chromaHeight: at(3),
      pictureWidth: at(4), pictureHeight: at(5),
      displayWidth: at(6), displayHeight: at(7),
      pixelWidth: at(8), pixelHeight: at(9),
      framePeriod: at(10), flags: at(11),
    };
  }
}

/**
 * sequence_end_code。上流は「次の start code を見て」初めて直前の picture を
 * 出すので、入力を終えたあとこれを流さないと末尾の数フレームが出てこない。
 */
export const SEQUENCE_END_CODE: Readonly<Uint8Array> =
  Uint8Array.of(0x00, 0x00, 0x01, 0xb7);
