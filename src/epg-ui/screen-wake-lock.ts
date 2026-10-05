// 視聴中と録画の再生中は、画面を点けたままにする（Screen Wake Lock）。
//
// **映像は <video> ではなく自前で描いている**（OffscreenCanvas）。ブラウザは
// <video> の再生中なら画面を点けておくが、こちらには何もしてくれない。端末の
// 消灯までの時間が短いと、見ている途中で画面が消え、ページが非表示になる。
// 録画はページが非表示になると途中で終わる作りなので、録画も巻き込まれる。
//
// ロックはページが非表示になるとブラウザが外す。表示に戻ったら取り直す。
// 取れない環境（API が無い、省電力で断られる）では何もしない。視聴は続ける。

export class ScreenWakeLock {
  #wanted = false;
  #requesting = false;
  #sentinel: WakeLockSentinel | null = null;

  constructor() {
    document.addEventListener('visibilitychange', this.#onVisibility);
  }

  /** 点けたままにしたい。表示中なら取り、非表示なら表示に戻ったときに取る。 */
  acquire(): void {
    this.#wanted = true;
    void this.#request();
  }

  /** もう要らない。 */
  release(): void {
    this.#wanted = false;
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    void sentinel?.release().catch(() => undefined);
  }

  destroy(): void {
    this.release();
    document.removeEventListener('visibilitychange', this.#onVisibility);
  }

  async #request(): Promise<void> {
    if (!this.#wanted || this.#sentinel !== null || this.#requesting) return;
    if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    this.#requesting = true;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!this.#wanted) {
        void sentinel.release().catch(() => undefined);
        return;
      }
      this.#sentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (this.#sentinel === sentinel) this.#sentinel = null;
      });
    } catch {
      // 省電力モードなどで断られる。点けておけないだけで、視聴は続ける。
    } finally {
      this.#requesting = false;
    }
  }

  readonly #onVisibility = (): void => {
    if (document.visibilityState === 'visible') void this.#request();
  };
}
