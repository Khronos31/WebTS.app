// データ放送（BML）。web-bml の BML ブラウザを映像の上に重ねる。
//
// 視聴を始めると自動で動く（テレビと同じ）。**キーの UI はまだ無く、**
// JS コンソールから `webts.bml` で操作する。
//
//   webts.bml.key('d')     リモコンのキー（keys() で一覧）
//   webts.bml.state()      受け取ったもの、表示中の文書
//   webts.bml.stop()       このページのあいだ止める
//   webts.bml.start()      止めたものを再開する
//
// TS の解読は再生 Worker が行い（player-worker.ts の BmlDecoder）、ここへは
// 解読済みのメッセージだけが届く。
//
// **放送で届く分だけを扱う。双方向（通信）は恒久的に非対応。**BMLBrowser に
// `ip` を渡さないので、局のサーバーへは何も送らない（2026-09-25 に決定）。
// 実測では、通信の宛先は http のみのもの・CORS を返さないもの・SHA-1 証明書の
// ものばかりでブラウザから直接はつなげず、しかも4つのうち3つは視聴データの
// 送信（ビーコン・視聴 ID）だった。選局の要求（epg.tune）はまだ受けない。

import type { BMLBrowser, Indicator } from 'web-bml';
import type { ResponseMessage } from 'web-bml/protocol';
import {
  BML_BROADCASTER_DB_PREFIX, BML_NVRAM_PREFIX, BML_STORAGE_PREFIX, getZipcode, migrateBmlStorage,
  setZipcode,
} from './bml-receiver-info';
// フォントは web-bml-fonts（Apache-2.0）。配信物へは別ファイルとして入り、
// 使うときだけ読まれる。
import roundGothicUrl from 'web-bml-fonts/KosugiMaru-Regular.woff2?url';
import boldRoundGothicUrl from 'web-bml-fonts/KosugiMaru-Bold.woff2?url';
import squareGothicUrl from 'web-bml-fonts/Kosugi-Regular.woff2?url';

/** 映像の置き場所。BML の座標系に対する割合（0〜1）。null なら全面。 */
export interface VideoRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** データ放送を重ねる先。視聴画面が用意する。 */
export interface DataBroadcastHost {
  /** 映像を描いている箱。この上に重ねる。 */
  readonly container: HTMLElement;
  /** BML が指定した映像の位置へ映像を動かす。 */
  setVideoRect(rect: VideoRect | null): void;
}

/**
 * リモコンのキー。値は web-bml の `AribKeyCode`（client/content.ts）。
 * `AribKeyCode` は型としてしか公開されていないので、値をここに写す。
 */
const KEYS: Readonly<Record<string, number>> = {
  up: 1, down: 2, left: 3, right: 4,
  0: 5, 1: 6, 2: 7, 3: 8, 4: 9, 5: 10, 6: 11, 7: 12, 8: 13, 9: 14, 10: 15, 11: 16, 12: 17,
  enter: 18, ok: 18, back: 19, return: 19, d: 20, data: 20,
  blue: 21, red: 22, green: 23, yellow: 24,
  b: 21, r: 22, g: 23, y: 24,
  h: 21, j: 22, k: 23, l: 24,
};

/**
 * 視聴を始めたらデータ放送も動かすか。**既定で動かす。**
 *
 * テレビと同じにする。データ放送は裏で受信して起動文書まで走らせておき、
 * 見る人は d を押せばよい。使うたびに開始の操作を要求しない。
 * `webts.bml.stop()` でこのページのあいだだけ止められる。
 */
let wanted = true;

/**
 * 局の識別子（original_network_id と transport_stream_id）が届くまで、
 * BML ブラウザへ渡さずに待たせるもの。
 *
 * **識別子は SDT で届き、起動文書のモジュールより遅れることがある。**
 * web-bml は起動文書が届いた時点で起動するので、そのままだと識別子が
 * 不明（-1）のまま局のスクリプトが走る。Eテレの起動文書は初期化で
 * ネットワーク ID を読み、そこで例外になって d ボタンが効かなくなった
 * （実機、2026-09-24）。受信機は選局した時点で局を知っているので、
 * 揃うまで待つのが本来の順序に近い。
 */
const HELD_UNTIL_IDENTIFIED: ReadonlySet<ResponseMessage['type']> = new Set([
  'pmt', 'moduleListUpdated', 'moduleDownloaded', 'esEventUpdated',
]);
/** SDT は少なくとも数秒おきに来る。これだけ待っても来なければ諦めて渡す。 */
const IDENTIFY_TIMEOUT_MS = 10_000;

/** 次に始まる視聴でデータ放送を出すか。 */
export function dataBroadcastWanted(): boolean {
  return wanted;
}

interface Received {
  readonly byType: Record<string, number>;
  modules: number;
  lastError: string | null;
}

/** ページを開いてから作った BML ブラウザの数。ログの印と state() に出す。 */
let created = 0;

/** web-bml のログを、BML ブラウザごとに直近のぶんだけ持っておく。 */
const LOG_LINES = 40;
/** BML のスクリプトが数百 ms ごとに呼ぶもの。控えると他が押し出される。 */
const NOISY = /\]\[browser\] (setInterval|setTimeout|clearTimer|detectComponent|getBrowserStatus)/;
const logSinks = new Map<number, (line: string) => void>();
let consoleTapped = false;

/**
 * web-bml のログを控える。**試験用の診断。**
 *
 * web-bml のロガーは作られた時点の `console.log` などを bind するので、
 * 最初の BML ブラウザを作る前に包んでおけば全部こちらを通る。表示は
 * そのまま console へ流し、先頭が `[bml#n]` のものだけを控える。
 */
function tapConsole(): void {
  if (consoleTapped) return;
  consoleTapped = true;
  for (const level of ['error', 'warn', 'info', 'log'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const head = args[0];
      const match = typeof head === 'string' ? /^\[bml#(\d+)\]/.exec(head) : null;
      const sink = match === null ? undefined : logSinks.get(Number(match[1]));
      if (sink !== undefined && typeof head === 'string' && !NOISY.test(head)) {
        const text = args.map((arg) => (typeof arg === 'string' ? arg : safeJson(arg)))
          .join(' ').replaceAll(/%c/g, '').slice(0, 300);
        sink(`${level} ${text}`);
      }
      original(...args);
    };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 視聴1回ぶんの BML ブラウザ。視聴を閉じたら捨てる。 */
export class DataBroadcast {
  readonly #host: DataBroadcastHost;
  readonly #layer: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #resize: ResizeObserver;
  #browser: BMLBrowser | null = null;
  #destroyed = false;
  #resolution = { width: 960, height: 540 };
  #invisible = true;
  #videoRect: VideoRect | null = null;
  #url: string | null = null;
  #eventName: string | null = null;
  readonly #received: Received = { byType: {}, modules: 0, lastError: null };
  readonly #id = ++created;
  /** 起動直後のログ。文書の起動と局の識別子の順番を見るため、最初のぶんは残す。 */
  readonly #earlyLogs: string[] = [];
  readonly #logs: string[] = [];
  #keysSent = 0;
  /** 局の識別子が揃うまで待たせているメッセージ。揃ったら null。 */
  #held: ResponseMessage[] | null = [];
  #releaseTimer = 0;

  private constructor(host: DataBroadcastHost) {
    this.#host = host;
    logSinks.set(this.#id, (line) => { this.#record(line); });

    // 重ねる層。映像の上、字幕と操作バーの下（theme.css で z-index 10 以上）。
    // **ポインタは下へ通す。**キーはまだコンソールからしか送らないので、
    // ここで取ると映像のクリック（再生・一時停止）が効かなくなる。
    this.#layer = document.createElement('div');
    this.#layer.className = 'data-broadcast-layer';
    this.#layer.style.cssText = [
      'position:absolute', 'inset:0', 'z-index:5', 'overflow:hidden',
      'pointer-events:none', 'opacity:0',
    ].join(';');

    // BML は 960x540 などの固定座標で描かれる。その寸法の舞台を作り、
    // 箱の大きさに合わせて拡大縮小する。
    this.#stage = document.createElement('div');
    this.#stage.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0';
    this.#layer.append(this.#stage);
    host.container.append(this.#layer);

    this.#resize = new ResizeObserver(() => { this.#fit(); });
    this.#resize.observe(host.container);
  }

  static async create(host: DataBroadcastHost): Promise<DataBroadcast> {
    tapConsole();
    migrateBmlStorage();
    const overlay = new DataBroadcast(host);
    const { BMLBrowser } = await import('web-bml');
    if (overlay.#destroyed) return overlay;

    const content = document.createElement('div');
    // 映像を入れる要素。**映像そのものはここへ入れない。**canvas の制御は
    // Worker へ移っていて動かせないので、動画像プレーンモードで BML 側の
    // 映像の場所を切り抜いてもらい、下にある canvas をその位置へ合わせる。
    const media = document.createElement('div');
    overlay.#stage.append(content);

    const browser = new BMLBrowser({
      containerElement: content,
      mediaElement: media,
      videoPlaneModeEnabled: true,
      indicator: overlay.#indicator(),
      fonts: {
        roundGothic: { source: `url(${roundGothicUrl})` },
        boldRoundGothic: { source: `url(${boldRoundGothicUrl})` },
        squareGothic: { source: `url(${squareGothicUrl})` },
      },
      // 既定は <dialog> を開く。いまは画面に何も足さない。
      showErrorMessage: (title, message, code) => {
        console.warn('[bml]', title, message, code ?? '');
      },
      epg: {
        tune: (originalNetworkId, transportStreamId, serviceId) => {
          console.info('[bml] 選局の要求（未対応）', { originalNetworkId, transportStreamId, serviceId });
          return false;
        },
      },
      log: { prefix: `[bml#${overlay.#id}]` },
      // web-bml はこれを連結して使う（storagePrefix + nvramPrefix）。
      storagePrefix: BML_STORAGE_PREFIX,
      nvramPrefix: BML_NVRAM_PREFIX,
      broadcasterDatabasePrefix: BML_BROADCASTER_DB_PREFIX,
    });
    overlay.#browser = browser;

    browser.addEventListener('load', (event) => {
      overlay.#resolution = event.detail.resolution;
      overlay.#fit();
    });
    browser.addEventListener('invisible', (event) => {
      overlay.#invisible = event.detail;
      // **display:none にしない。**web-bml は映像の位置を DOM から測るので、
      // 消している間に文書が変わると 0x0 を測り、見せたときに映像が消える。
      // **visibility:hidden も使えない。**web-bml の既定の CSS が
      // `body { visibility: visible !important }` なので、親を hidden にしても
      // BML の本文は見えたままになる。TBS の起動文書は灰色の背景を持っていて、
      // 非表示のはずの間ずっと映像を覆っていた（実機、2026-09-25）。
      // opacity は子から打ち消せず、レイアウトも残る。
      overlay.#layer.style.opacity = event.detail ? '0' : '';
      overlay.#applyVideoRect();
      window.dispatchEvent(new CustomEvent('webts-bml-visibility', {
        detail: { visible: !event.detail },
      }));
    });
    browser.addEventListener('videochanged', (event) => {
      const rect = event.detail.clientRect;
      const { width, height } = overlay.#resolution;
      overlay.#videoRect = {
        left: rect.left / width,
        top: rect.top / height,
        width: (rect.right - rect.left) / width,
        height: (rect.bottom - rect.top) / height,
      };
      overlay.#applyVideoRect();
    });
    return overlay;
  }

  /** Worker から届いた解読済みのメッセージを BML ブラウザへ渡す。 */
  emit(messages: readonly ResponseMessage[]): void {
    for (const message of messages) {
      const byType = this.#received.byType;
      byType[message.type] = (byType[message.type] ?? 0) + 1;
      if (message.type === 'moduleDownloaded') this.#received.modules += 1;
      if (message.type === 'error') this.#received.lastError = JSON.stringify(message);
      // 局の識別子がいつ揃ったかを、web-bml のログと同じ列に並べる。
      if (message.type === 'programInfo') {
        this.#note(`programInfo onid=${message.originalNetworkId} tsid=${message.transportStreamId}`
          + ` sid=${message.serviceId} nid=${message.networkId}`);
      }

      if (this.#held !== null) {
        if (message.type === 'programInfo'
          && message.originalNetworkId !== null && message.transportStreamId !== null) {
          this.#deliver(message);
          this.#release('局の識別子が揃った');
          continue;
        }
        if (HELD_UNTIL_IDENTIFIED.has(message.type)) {
          this.#held.push(message);
          this.#releaseTimer ||= self.setTimeout(() => {
            this.#release('局の識別子が届かないまま待ちきれなかった');
          }, IDENTIFY_TIMEOUT_MS);
          continue;
        }
      }
      this.#deliver(message);
    }
  }

  /**
   * 待たせていたものを順に渡す。以後は待たせない。
   *
   * 一度揃えば、そのあと識別子が変わる（別の局になる）のは選局し直したとき
   * だけで、そのときは視聴ごと作り直している。
   */
  #release(reason: string): void {
    const held = this.#held;
    if (held === null) return;
    this.#held = null;
    clearTimeout(this.#releaseTimer);
    this.#note(`release ${held.length} messages: ${reason}`);
    for (const message of held) this.#deliver(message);
  }

  #deliver(message: ResponseMessage): void {
    // web-bml の中で投げても、映像と音声は止めない。
    try {
      this.#browser?.emitMessage(message);
    } catch (error) {
      this.#received.lastError = error instanceof Error ? error.message : String(error);
      console.warn('[bml]', error);
    }
  }

  failed(message: string): void {
    this.#received.lastError = message;
    console.warn('[bml] 解読が止まりました:', message);
  }

  /** キーを1回押して離す。押せなければ false。 */
  key(name: string): boolean {
    const code = KEYS[name.toLowerCase()];
    if (code === undefined || this.#browser === null) return false;
    this.#keysSent += 1;
    this.#note(`key ${name}`);
    // `AribKeyCode` は数値の enum。値そのものを渡している。
    const key = code as Parameters<BMLBrowser['content']['processKeyDown']>[0];
    this.#browser.content.processKeyDown(key);
    this.#browser.content.processKeyUp(key);
    return true;
  }

  state(): Record<string, unknown> {
    return {
      instance: this.#id,
      destroyed: this.#destroyed,
      keysSent: this.#keysSent,
      loaded: this.#browser !== null,
      invisible: this.#invisible,
      document: this.#url,
      eventName: this.#eventName,
      resolution: this.#resolution,
      videoRect: this.#videoRect,
      modulesDownloaded: this.#received.modules,
      messages: { ...this.#received.byType },
      lastError: this.#received.lastError,
      earlyLogs: [...this.#earlyLogs],
      recentLogs: [...this.#logs],
    };
  }

  /** 画面上に表示されているか（ロード済みかつ不可視でないか）。 */
  isVisible(): boolean {
    return this.#browser !== null && !this.#invisible;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    clearTimeout(this.#releaseTimer);
    this.#held = null;
    logSinks.delete(this.#id);
    this.#resize.disconnect();
    if (this.#browser !== null) {
      // **web-bml の destroy() は BML のスクリプトのタイマーを止めない。**
      // フォント・DRCS・音声しか片付けないので、局のスクリプトが
      // setInterval で回しているもの（300 ms ごとなど）が残り続け、古い
      // BML ブラウザごとメモリに居座る。実測では選局のたびにタイマーが
      // 2つずつ増え、捨てたはずの BML ブラウザがログを出し続けた。
      // 内部のイベントキューを捨てれば、タイマーが全部止まり、以後の
      // イベントも処理されない（event_queue.js の discard）。
      const internals = this.#browser as unknown as { eventQueue?: { discard?: () => void } };
      internals.eventQueue?.discard?.();
      this.#browser.destroy();
    }
    this.#browser = null;
    this.#layer.remove();
    this.#host.setVideoRect(null);
    window.dispatchEvent(new CustomEvent('webts-bml-visibility', {
      detail: { visible: false },
    }));
  }

  #note(text: string): void {
    this.#record(`webts ${text}`);
  }

  #record(line: string): void {
    if (this.#earlyLogs.length < LOG_LINES) {
      this.#earlyLogs.push(line);
      return;
    }
    this.#logs.push(line);
    if (this.#logs.length > LOG_LINES) this.#logs.shift();
  }

  /** 舞台を BML の解像度にして、箱いっぱいへ拡大縮小する。 */
  #fit(): void {
    const { width, height } = this.#resolution;
    const box = this.#host.container.getBoundingClientRect();
    this.#stage.style.width = `${width}px`;
    this.#stage.style.height = `${height}px`;
    this.#stage.style.transform = `scale(${box.width / width}, ${box.height / height})`;
  }

  /** 見えていれば BML の指定した位置へ、見えていなければ全面へ。 */
  #applyVideoRect(): void {
    this.#host.setVideoRect(this.#invisible ? null : this.#videoRect);
  }

  #indicator(): Indicator {
    return {
      setUrl: (name) => { this.#url = name; },
      setReceivingStatus: () => {},
      setNetworkingGetStatus: () => {},
      setNetworkingPostStatus: () => {},
      setEventName: (name) => { this.#eventName = name; },
    };
  }
}

/** いまの視聴のデータ放送を操作する口。視聴側（live-session.ts）が差し出す。 */
export interface DataBroadcastControl {
  overlay(): DataBroadcast | null;
  enable(): Promise<void>;
  disable(): void;
}

let current: DataBroadcastControl | null = null;

export function setCurrentDataBroadcast(control: DataBroadcastControl): void {
  current = control;
}

/** 自分が差し出したものだけを外す。次の視聴が先に差し替えていれば何もしない。 */
export function releaseCurrentDataBroadcast(control: DataBroadcastControl): void {
  if (current === control) current = null;
}

/**
 * JS コンソール用の口。`webts.bml`。
 *
 * **試験用。**UI ができたらそちらから同じものを呼ぶ。
 */
export function installDataBroadcastConsole(): void {
  const api = {
    async start(): Promise<string> {
      wanted = true;
      if (current === null) return '視聴を始めると表示します。';
      await current.enable();
      return '開始しました。カルーセルが届くまで数秒〜数十秒かかります。';
    },
    stop(): string {
      wanted = false;
      current?.disable();
      return '止めました。';
    },
    key(name: string): string {
      const overlay = current?.overlay() ?? null;
      if (overlay === null) return 'データ放送が動いていません。webts.bml.start() を先に。';
      return overlay.key(name) ? `${name} を押しました。` : `知らないキーです: ${name}`;
    },
    keys(): string[] {
      return Object.keys(KEYS);
    },
    state(): Record<string, unknown> {
      return { wanted, ...(current?.overlay()?.state() ?? { running: false }) };
    },
    /** 郵便番号を見る。UI は設定タブ（bml-receiver-info.ts を呼ぶ）。 */
    zipcode(): string | null {
      return getZipcode();
    },
    getZipcode(): string | null {
      return getZipcode();
    },
    /** 郵便番号を設定する。null で消す。 */
    setZipcode(value: string | null): string {
      return setZipcode(value)
        ? `設定しました: ${getZipcode() ?? '（なし）'}`
        : '7桁の郵便番号として読めません。';
    },
  };
  const holder = globalThis as { webts?: Record<string, unknown> };
  holder.webts ??= {};
  holder.webts['bml'] = api;
}

/** いま動いているデータ放送へリモコンのキーを1回送る。 */
export function sendDataBroadcastKey(name: string): boolean {
  const overlay = current?.overlay() ?? null;
  if (overlay === null) return false;
  return overlay.key(name);
}

/** データ放送が表示中（画面に重なって見える状態）か。 */
export function isDataBroadcastVisible(): boolean {
  const overlay = current?.overlay() ?? null;
  if (overlay === null) return false;
  return overlay.isVisible();
}
