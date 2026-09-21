// ARIB STD-B24 字幕の表示。
//
// 解釈と描画は `aribb24.js`（MIT、monyone 版）に任せる。B24 は8単位符号系に
// JIS X 0201/0208、外字、DRCS、制御符号による画面座標指定まで含む仕様で、
// 自前で書き直すところではない。KonomiTV が使っているのも同じ実装である。
//
// **npm 依存にしている。**このリポジトリは C のソースを vendor/ に固定して
// 自分でビルドしてきたが、これは自分でビルドしない TypeScript ライブラリで、
// package-lock.json が完全性ハッシュ付きで固定する。npm の配布物には `src`
// も含まれるので、GPL の対応ソースの要件も満たせる。
//
// 時計は音声と共通（PTS）。映像と同じ基準で動くので、音声が鳴っている限り
// 字幕も映像と揃う。
//
// 字幕の中身は放送内容である。保存も送信もしない。

import {
  CanvasMainThreadRenderer,
  MPEGTSFeeder,
} from 'aribb24.js';

export interface CaptionStats {
  /** 受け取った字幕 PES の数。 */
  readonly fed: number;
  /** 実際に描画した回数。 */
  readonly rendered: number;
  /** 解釈に失敗した数。 */
  readonly errors: number;
}

export class CaptionOverlay {
  readonly #feeder: MPEGTSFeeder;
  readonly #renderer: CanvasMainThreadRenderer;
  #fed = 0;
  #rendered = 0;
  #errors = 0;
  /** 直前に描いた内容の PTS。同じものを描き直さないため。 */
  #lastPts: number | null = null;
  #destroyed = false;

  /**
   * container は `position: relative` であること。renderer は自分の canvas を
   * `position: absolute` / 100% で重ねる。
   */
  constructor(container: HTMLElement, width: number, height: number) {
    // PartialFeederOption は3つの枝すべてを要求する（中身は任意）。
    this.#feeder = new MPEGTSFeeder({
      recieve: { type: 'Caption', language: 0 },
      tokenizer: {},
      offset: {},
    });
    this.#renderer = new CanvasMainThreadRenderer();
    this.#renderer.onAttach(container);
    this.#renderer.resize(width, height);
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
   * いまの時刻に出すべき字幕を描く。pts は 90kHz で、音声の時計と同じ基準。
   * 同じ内容を描き直さない。
   */
  tick(pts: number): void {
    if (this.#destroyed) return;
    const seconds = pts / 90_000;
    try {
      // prepare() は開始点を置き直すもので、毎回 content() と同じ時刻で
      // 呼んではいけない。content() は前回の時刻から今回までを取り出すので、
      // 直前に prepare(same) を呼ぶと範囲が空になり、何も出てこなくなる。
      // 時刻の管理は content() 自身がやる。
      const content = this.#feeder.content(seconds);
      if (content === null) {
        if (this.#lastPts !== null) {
          this.#renderer.clear();
          this.#lastPts = null;
        }
        return;
      }
      if (content.pts === this.#lastPts) return;
      this.#lastPts = content.pts;
      this.#renderer.render(content.state, content.data, content.info);
      this.#rendered += 1;
    } catch {
      this.#errors += 1;
    }
  }

  resize(width: number, height: number): void {
    if (this.#destroyed) return;
    this.#renderer.resize(width, height);
    this.#lastPts = null;
  }

  stats(): CaptionStats {
    return { fed: this.#fed, rendered: this.#rendered, errors: this.#errors };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#feeder.destroy();
    this.#renderer.onDetach();
    this.#renderer.destroy();
  }
}
