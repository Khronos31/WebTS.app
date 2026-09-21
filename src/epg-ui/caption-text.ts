// ARIB STD-B24 字幕を「文字列」として取り出す。
//
// 解釈は `aribb24.js`（MIT、monyone 版）に任せる。B24 は8単位符号系に
// JIS X 0201/0208、外字、DRCS、制御符号による画面座標指定まで含む仕様で、
// 自前で書き直すところではない。
//
// **描画はしない。**この UI は字幕を自前のオーバーレイ要素に文字として出す
// 作りになっており、上流の canvas レンダラを重ねると、そこの見た目を
// 置き換えてしまう。上流には文字だけを返す `TextRenderer` があるので、
// それを使って文字列を取り、表示は UI 側に任せる。
//
// 字幕の中身は放送内容である。保存も送信もしない。

import { MPEGTSFeeder, TextRenderer } from 'aribb24.js';

export interface CaptionTextStats {
  readonly fed: number;
  readonly rendered: number;
  readonly errors: number;
}

/**
 * `TextRenderer` は組み立てた文字列を `text` フィールドに持つが、型定義では
 * `private` になっていて外から読めない。公開の取り出し口が無いので、
 * このフィールドだけを読むために絞った形へ変換する。
 */
interface TextRendererInternals {
  text: string | null;
}

export class CaptionText {
  readonly #feeder: MPEGTSFeeder;
  readonly #renderer: TextRenderer;
  readonly #onText: (text: string) => void;
  #fed = 0;
  #rendered = 0;
  #errors = 0;
  #lastPts: number | null = null;
  #lastText = '';
  #destroyed = false;

  constructor(onText: (text: string) => void = () => {}) {
    // PartialFeederOption は3つの枝すべてを要求する（中身は任意）。
    this.#feeder = new MPEGTSFeeder({
      recieve: { type: 'Caption', language: 0 },
      tokenizer: {},
      offset: {},
    });
    this.#renderer = new TextRenderer();
    this.#onText = onText;
  }

  /** 字幕 PES をそのまま渡す。pts は 90kHz。 */
  push(pts: number, bytes: Uint8Array): void {
    if (this.#destroyed) return;
    this.#fed += 1;
    try {
      this.#feeder.feedB24(bytes, pts / 90_000);
    } catch {
      this.#errors += 1;
    }
  }

  /**
   * いまの時刻に出すべき字幕を取り出す。pts は 90kHz で、音声の時計と同じ基準。
   *
   * `prepare()` は呼ばない。あれは開始点を置き直すもので、`content()` と同じ
   * 時刻で呼ぶと取り出し範囲が空になり、何も出てこなくなる。時刻の管理は
   * `content()` 自身がやる。
   */
  tick(pts: number): void {
    if (this.#destroyed) return;
    try {
      const content = this.#feeder.content(pts / 90_000);
      if (content === null) {
        this.#emit('');
        this.#lastPts = null;
        return;
      }
      if (content.pts === this.#lastPts) return;
      this.#lastPts = content.pts;
      this.#renderer.render(content.state, content.data, content.info);
      const text = (this.#renderer as unknown as TextRendererInternals).text ?? '';
      this.#rendered += 1;
      this.#emit(text);
    } catch {
      this.#errors += 1;
    }
  }

  stats(): CaptionTextStats {
    return { fed: this.#fed, rendered: this.#rendered, errors: this.#errors };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#feeder.destroy();
    this.#renderer.destroy();
  }

  #emit(text: string): void {
    if (text === this.#lastText) return;
    this.#lastText = text;
    this.#onText(text);
  }
}
