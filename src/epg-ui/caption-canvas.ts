// ARIB STD-B24 字幕を、放送の指定どおりに映像の上へ描く。
//
// 解釈も描画も `aribb24.js`（MIT、monyone 版）に任せる。**位置・大きさ・色・
// ルビ・外字・表示時間は放送が決める。**放送局は映像のテロップと重ならない
// ように字幕の位置を動かし、テロップに譲るときは「N 秒後に消去」と送る。
// 文字だけを取り出して決まった場所に出す作りでは、どちらも再現できない
// （作者の決定、2026-09-26。KonomiTV・EPGStation も aribb24.js の canvas
// 描画を映像に重ねている）。
//
// 出す・消すの判断は、aribb24.js の `Controller.paint()` と同じにする。
// Controller は `<video>` の時刻で動くが、ここの映像は Worker の中の
// OffscreenCanvas なので、再生の時計（音声の PTS）で `tick()` を呼んでもらう。
//
// - 字幕が無い → 消す。
// - 表示時間（duration）を過ぎた → 消す。放送が「N 秒後に消去」と送った字幕は
//   有限、それ以外は次の字幕か消去が来るまで。
// - 新しい字幕 → 描く。
//
// 字幕の中身は放送内容である。保存も送信もしない。

import { CanvasMainThreadRenderer, MPEGTSFeeder } from 'aribb24.js';
import roundGothicUrl from 'web-bml-fonts/KosugiMaru-Regular.woff2?url';
import { installAribDictionaries } from '../ts/arib-dictionary';

export interface CaptionStats {
  readonly fed: number;
  readonly rendered: number;
  readonly errors: number;
}

/** `MPEGTSFeeder.content()` の結果。型定義から使うところだけ取る。 */
type Presentation = NonNullable<ReturnType<MPEGTSFeeder['content']>>;

/**
 * 字幕の書体。データ放送と同じ丸ゴシック（web-bml-fonts、Apache-2.0）を
 * 文書に一度だけ登録する。読めなければ端末の書体で描く。
 */
const FONT_FAMILY = 'WebTS Caption Round Gothic';
let fontReady: Promise<void> | null = null;

function loadCaptionFont(): Promise<void> {
  fontReady ??= (async () => {
    try {
      const face = new FontFace(FONT_FAMILY, `url(${roundGothicUrl})`);
      document.fonts.add(face);
      await face.load();
    } catch {
      // 読めなくても、下の予備の書体で描く。
    }
  })();
  return fontReady;
}

export class CaptionCanvas {
  readonly #feeder: MPEGTSFeeder;
  readonly #host: HTMLElement;
  #renderer: CanvasMainThreadRenderer | null = null;
  #observer: ResizeObserver | null = null;
  /** いま画面にあるもの。字幕の pts、表示時間切れならその終わり、無ければ null。 */
  #previous: number | null = null;
  #current: Presentation | null = null;
  #now = 0;
  #visible = true;
  #fed = 0;
  #rendered = 0;
  #errors = 0;
  #destroyed = false;

  /** host は字幕を重ねる要素。**映像と同じ位置・大きさ**にしておくこと。 */
  constructor(host: HTMLElement) {
    // 字幕も SI と同じ文字集合の穴を踏む。作る前に埋める。
    installAribDictionaries();
    // PartialFeederOption は3つの枝すべてを要求する（中身は任意）。
    this.#feeder = new MPEGTSFeeder({
      recieve: { type: 'Caption', language: 0 },
      tokenizer: {},
      offset: {},
    });
    this.#host = host;
    void this.#setUp();
  }

  /**
   * 書体と追加記号（ARIB の [字] や ♪ など）をそろえてから描き始める。
   * 追加記号の形は大きい（約 450 KB）ので、字幕を出すときにだけ読む。
   */
  async #setUp(): Promise<void> {
    try {
      const [, glyph] = await Promise.all([
        loadCaptionFont(),
        import('aribb24.js/glyph').then((loaded) => loaded.default).catch(() => undefined),
      ]);
      if (this.#destroyed) return;
      const renderer = new CanvasMainThreadRenderer({
        font: { normal: `"${FONT_FAMILY}", "Hiragino Maru Gothic Pro", "BIZ UDGothic", sans-serif` },
        ...(glyph === undefined ? {} : { replace: { glyph } }),
      });
      renderer.onAttach(this.#host);
      if (!this.#visible) renderer.hide();
      this.#renderer = renderer;
      // 画面の大きさに合わせて描き直す。高精細な画面でもにじまないよう、
      // 実際の画素数で描く。
      this.#observer = new ResizeObserver(() => { this.#resize(); });
      this.#observer.observe(this.#host);
      this.#resize();
    } catch {
      this.#errors += 1;
    }
  }

  #resize(): void {
    const renderer = this.#renderer;
    if (renderer === null) return;
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(this.#host.clientWidth * scale);
    const height = Math.round(this.#host.clientHeight * scale);
    renderer.onContainerResize(width, height);
    this.#repaint();
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
   * いまの時刻に合わせて出す・消す。pts は 90kHz で、音声の時計と同じ基準。
   * aribb24.js の `Controller.paint(false)` と同じ判断。
   *
   * `prepare()` は呼ばない。あれは開始点を置き直すもので、`content()` と同じ
   * 時刻で呼ぶと取り出し範囲が空になり、何も出てこなくなる。
   */
  tick(pts: number): void {
    if (this.#destroyed) return;
    const now = pts / 90_000;
    try {
      this.#now = now;
      this.#current = this.#feeder.content(now);
      const renderer = this.#renderer;
      if (renderer === null) return;
      const current = this.#current;
      if (current === null) {
        if (this.#previous === null) return;
        renderer.clear();
        this.#previous = null;
        return;
      }
      const end = current.pts + current.duration;
      if (now >= end) {
        if (this.#previous === end) return;
        renderer.clear();
        this.#previous = end;
        return;
      }
      if (this.#previous === current.pts) return;
      this.#paint(renderer, current);
      this.#previous = current.pts;
    } catch {
      this.#errors += 1;
    }
  }

  /** 大きさが変わったときなど、いまのものを描き直す。 */
  #repaint(): void {
    const renderer = this.#renderer;
    const current = this.#current;
    if (renderer === null) return;
    try {
      if (current === null || this.#now >= current.pts + current.duration) {
        renderer.clear();
      } else {
        this.#paint(renderer, current);
      }
    } catch {
      this.#errors += 1;
    }
  }

  #paint(renderer: CanvasMainThreadRenderer, current: Presentation): void {
    // 描画側が中身を書き換えるので、控えを渡す（Controller と同じ）。
    renderer.render(structuredClone(current.state), structuredClone(current.data),
      structuredClone(current.info));
    this.#rendered += 1;
  }

  /** 一時停止中や字幕 OFF のときは隠す。受け取りと時刻の追従は続ける。 */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (visible) this.#renderer?.show();
    else this.#renderer?.hide();
  }

  stats(): CaptionStats {
    return { fed: this.#fed, rendered: this.#rendered, errors: this.#errors };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#observer?.disconnect();
    this.#renderer?.onDetach();
    this.#renderer?.destroy();
    this.#feeder.destroy();
  }
}
