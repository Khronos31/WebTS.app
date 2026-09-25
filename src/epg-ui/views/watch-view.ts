// EPGStationスタイルの「視聴 (Watch)」ビュー
// 16:9動画プレイヤー、リアルタイム字幕、番組メタデータ、電波モニター

import type { ChannelItem, ProgramItem } from '../types';
import { channelsSync, findChannelSync, programsSync } from '../channel-source';
import { VideoPlayer } from '../components/video-player';
import { LiveSession, type LiveStats } from '../live-session';
import { tuningForChannel } from '../tuning';
import { isDataBroadcastVisible, sendDataBroadcastKey } from '../data-broadcast';

export interface WatchViewOptions {
  channelId: number;
  onNavigateBack: () => void;
  onSwitchChannel: (channelId: number) => void;
}

export class WatchView {
  public readonly element: HTMLElement;
  private player: VideoPlayer;
  private session: LiveSession | null = null;
  private progressTimer: number | null = null;
  private channel: ChannelItem;
  private currentProgram: ProgramItem | null = null;
  private nextProgram: ProgramItem | null = null;
  /** 番組情報のパネル。番組が替わったら中の番組情報だけを作り直す。 */
  private detailsSection!: HTMLElement;

  constructor(options: WatchViewOptions) {
    this.element = document.createElement('div');
    this.element.className = 'watch-container';

    // チャンネルと番組情報の特定
    // 番組情報は EIT を読むようにするまで空。作り物を出さない。
    const known = channelsSync(false);
    const foundChannel = findChannelSync(options.channelId) ?? known[0] ?? null;
    if (foundChannel === null) {
      throw new Error('チャンネルがありません。設定からスキャンしてください。');
    }
    this.channel = foundChannel;
    this.currentProgram = currentProgramFor(this.channel);
    this.nextProgram = nextProgramFor(this.channel);

    // 1. トップナビゲーション（戻るボタン ＆ チャンネル情報）
    const topBar = document.createElement('div');
    topBar.className = 'watch-top-bar';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn-small watch-back-btn';
    backBtn.innerHTML = `
      <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
        <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
      </svg>
      <span>放映中一覧へ戻る</span>
    `;
    backBtn.addEventListener('click', () => {
      options.onNavigateBack();
    });

    // PC表示用データ放送操作バー（放映中一覧へ戻る と 局情報 の間）
    const bmlBar = document.createElement('div');
    bmlBar.className = 'watch-bml-bar';
    bmlBar.innerHTML = `
      <button type="button" class="btn-bml btn-bml-d" data-bml-key="d" title="データ放送表示切替 (d)">
        <span class="bml-d-icon">d</span>
        <span>データ</span>
        <kbd class="bml-kbd">d</kbd>
      </button>
      <div class="bml-color-group">
        <button type="button" class="btn-bml btn-bml-blue" data-bml-key="blue" title="青 (h)">
          <span class="color-dot blue"></span>
          <span>青</span>
          <kbd class="bml-kbd">h</kbd>
        </button>
        <button type="button" class="btn-bml btn-bml-red" data-bml-key="red" title="赤 (j)">
          <span class="color-dot red"></span>
          <span>赤</span>
          <kbd class="bml-kbd">j</kbd>
        </button>
        <button type="button" class="btn-bml btn-bml-green" data-bml-key="green" title="緑 (k)">
          <span class="color-dot green"></span>
          <span>緑</span>
          <kbd class="bml-kbd">k</kbd>
        </button>
        <button type="button" class="btn-bml btn-bml-yellow" data-bml-key="yellow" title="黄 (l)">
          <span class="color-dot yellow"></span>
          <span>黄</span>
          <kbd class="bml-kbd">l</kbd>
        </button>
      </div>
    `;

    const channelBadgeRow = document.createElement('div');
    channelBadgeRow.className = 'watch-channel-badge-row';
    channelBadgeRow.innerHTML = `
      <span class="channel-type-badge ${this.channel.channelType}">${this.channel.channelType}</span>
      <span style="font-weight: 700; font-size: 0.9375rem;">${escapeHtml(this.channel.name)}</span>
      ${this.channel.remoteControlKeyId ? `<span class="channel-key-badge">${this.channel.remoteControlKeyId}ch</span>` : ''}
    `;

    topBar.append(backBtn, bmlBar, channelBadgeRow);
    this.element.append(topBar);

    // 2. 動画プレイヤーコンポーネント
    const playerWrapper = document.createElement('div');
    playerWrapper.className = 'watch-player-wrapper';

    this.player = new VideoPlayer({
      autoplay: true,
      programTitle: this.currentProgram?.name,
      onPlayPause: (playing) => {
        // **一時停止でも受信は手放さない。**手放すと再生のたびに選局と
        // 復調ロックをやり直すことになり、復帰まで数秒待たされる。
        // 受信が無いとき（開始に失敗した後など）だけ開き直す。
        if (this.session !== null) this.session.setPaused(!playing);
        else if (playing) void this.startLive();
      },
      onVolumeChange: (volume, muted) => {
        this.session?.setVolume(volume);
        this.session?.setMuted(muted);
      },
      onSubtitleToggle: (enabled) => {
        if (!enabled) this.player.setSubtitleText('');
      },
    });

    playerWrapper.append(this.player.element);
    this.element.append(playerWrapper);

    void this.startLive();

    // 3. タブバー（番組情報 ＆ リモコン）
    const tabBar = document.createElement('div');
    tabBar.className = 'watch-tab-bar';
    tabBar.innerHTML = `
      <button type="button" class="watch-tab-btn active" data-tab="details">
        <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
          <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
        </svg>
        <span>番組情報</span>
      </button>
      <button type="button" class="watch-tab-btn" data-tab="remote">
        <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
          <path d="M9 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2H9zm3 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm-2 5h4v2h-4V9zm0 3h4v2h-4v-2zm0 3h4v2h-4v-2z"/>
        </svg>
        <span>リモコン</span>
        <span class="watch-tab-bml-badge" title="データ放送表示中">d</span>
      </button>
    `;
    this.element.append(tabBar);

    // 4. パネルコンテナ
    const panelsContainer = document.createElement('div');
    panelsContainer.className = 'watch-panels-container';

    // 4-1. 番組情報 & メタデータエリア
    const detailsSection = document.createElement('div');
    detailsSection.className = 'watch-tab-panel watch-details-section active';

    this.detailsSection = detailsSection;

    detailsSection.innerHTML = `
      ${this.programInfoHtml()}

      <!-- クイック選局（有効な他チャンネル） -->
      <div class="watch-channel-selector-box">
        <div style="font-size: 0.8125rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">
          クイック選局
        </div>
        <div class="watch-channel-chips">
          ${channelsSync().length > 0
            ? channelsSync()
                .map((c) => `
                  <button type="button" class="channel-chip ${c.id === this.channel.id ? 'current' : ''}" data-channel-id="${c.id}">
                    <span class="channel-type-badge ${c.channelType}" style="font-size: 0.625rem; padding: 1px 4px;">${c.channelType}</span>
                    <span>${escapeHtml(c.halfWidthName)}</span>
                  </button>
                `).join('')
            : ''}
        </div>
      </div>

      <!-- チューナー・受信状態ステータス -->
      <div class="watch-signal-card">
        <div style="font-size: 0.8125rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">
          受信・デコード状態 (Signal & Decode Monitor)
        </div>
        <div class="watch-signal-grid">
          <div class="signal-item">
            <span class="signal-label">CNR (搬送波対雑音比)</span>
            <span class="signal-val" id="watch-signal-cnr">—</span>
          </div>
          <div class="signal-item">
            <span class="signal-label">BER (ビットエラー)</span>
            <span class="signal-val" id="watch-signal-ber">—</span>
          </div>
          <div class="signal-item">
            <span class="signal-label">TS ドロップ</span>
            <span class="signal-val" id="watch-signal-drop">—</span>
          </div>
          <div class="signal-item">
            <span class="signal-label">デコーダ</span>
            <span class="signal-val">WebCodecs / WASM</span>
          </div>
        </div>
      </div>
    `;

    // クイック選局ボタンのイベント
    const chips = detailsSection.querySelectorAll<HTMLButtonElement>('.channel-chip');
    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = Number(chip.dataset.channelId);
        if (id && id !== this.channel.id) {
          options.onSwitchChannel(id);
        }
      });
    });

    // 4-2. リモコンエリア (スマホ・タッチ・画面上操作)
    const remoteSection = document.createElement('div');
    remoteSection.className = 'watch-tab-panel watch-remote-section';
    remoteSection.innerHTML = `
      <div class="watch-remote-card">
        <!-- 上段: dデータ & 4色カラーボタン -->
        <div class="remote-group remote-top-row">
          <button type="button" class="remote-btn remote-btn-d" data-bml-key="d" title="データ放送表示切替 (d)">
            <span class="bml-d-icon">d</span>
            <span>データ</span>
          </button>
          <div class="remote-color-group">
            <button type="button" class="remote-color-btn blue" data-bml-key="blue" title="青 (h)">
              <span class="color-dot blue"></span>
              <span>青</span>
            </button>
            <button type="button" class="remote-color-btn red" data-bml-key="red" title="赤 (j)">
              <span class="color-dot red"></span>
              <span>赤</span>
            </button>
            <button type="button" class="remote-color-btn green" data-bml-key="green" title="緑 (k)">
              <span class="color-dot green"></span>
              <span>緑</span>
            </button>
            <button type="button" class="remote-color-btn yellow" data-bml-key="yellow" title="黄 (l)">
              <span class="color-dot yellow"></span>
              <span>黄</span>
            </button>
          </div>
        </div>

        <!-- 中段: 十字キー (DPAD) と 決定 / 戻る -->
        <div class="remote-group remote-dpad-row">
          <div class="dpad-container">
            <div class="dpad-cross">
              <button type="button" class="dpad-btn dpad-up" data-bml-key="up" aria-label="上 (↑)">
                <svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg>
              </button>
              <button type="button" class="dpad-btn dpad-left" data-bml-key="left" aria-label="左 (←)">
                <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
              </button>
              <button type="button" class="dpad-btn dpad-ok" data-bml-key="enter" aria-label="決定 (Enter)">
                <span>決定</span>
              </button>
              <button type="button" class="dpad-btn dpad-right" data-bml-key="right" aria-label="右 (→)">
                <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
              </button>
              <button type="button" class="dpad-btn dpad-down" data-bml-key="down" aria-label="下 (↓)">
                <svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
              </button>
            </div>
          </div>
          <button type="button" class="remote-btn remote-btn-back" data-bml-key="back" title="戻る (Esc/BS)">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
            </svg>
            <span>戻る</span>
          </button>
        </div>

        <!-- 下段: テンキー (数字キー 1〜12 & 0) -->
        <div class="remote-group remote-keypad-row">
          <div class="remote-keypad-label">数字キー</div>
          <div class="remote-keypad-grid">
            <button type="button" class="remote-num-btn" data-bml-key="1">1</button>
            <button type="button" class="remote-num-btn" data-bml-key="2">2</button>
            <button type="button" class="remote-num-btn" data-bml-key="3">3</button>
            <button type="button" class="remote-num-btn" data-bml-key="4">4</button>
            <button type="button" class="remote-num-btn" data-bml-key="5">5</button>
            <button type="button" class="remote-num-btn" data-bml-key="6">6</button>
            <button type="button" class="remote-num-btn" data-bml-key="7">7</button>
            <button type="button" class="remote-num-btn" data-bml-key="8">8</button>
            <button type="button" class="remote-num-btn" data-bml-key="9">9</button>
            <button type="button" class="remote-num-btn" data-bml-key="10">10</button>
            <button type="button" class="remote-num-btn" data-bml-key="11">11</button>
            <button type="button" class="remote-num-btn" data-bml-key="12">12</button>
            <button type="button" class="remote-num-btn remote-num-zero" data-bml-key="0">0</button>
          </div>
        </div>
      </div>
    `;

    panelsContainer.append(detailsSection, remoteSection);
    this.element.append(panelsContainer);

    // タブ切替イベント
    tabBar.querySelectorAll<HTMLButtonElement>('.watch-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        tabBar.querySelectorAll('.watch-tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        detailsSection.classList.toggle('active', tab === 'details');
        remoteSection.classList.toggle('active', tab === 'remote');
      });
    });

    // リモコン・データ放送ボタンのクリックイベント
    this.element.querySelectorAll<HTMLButtonElement>('[data-bml-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.bmlKey;
        if (key) {
          this.triggerBmlKey(key);
        }
      });
    });

    // キーボードショートカット & BML表示状態の監視
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('webts-bml-visibility', this.handleBmlVisibility);
    this.updateBmlVisibility(isDataBroadcastVisible());

    // プログレスバーの更新タイマー (5秒ごと)
    this.progressTimer = window.setInterval(() => {
      this.refreshProgramInfo();
      if (!this.currentProgram) return;
      const now = Date.now();
      const total = this.currentProgram.endAt - this.currentProgram.startAt;
      const elapsed = now - this.currentProgram.startAt;
      const pct = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
      const fill = this.element.querySelector<HTMLElement>('#watch-progress-fill');
      if (fill) fill.style.width = `${pct}%`;
    }, 5000);
  }

  /**
   * 番組情報（番組名・時刻・説明・拡張情報・次の番組）の HTML。
   * 番組が替わったら refreshProgramInfo() がこれで作り直す。
   */
  private programInfoHtml(): string {
    const timeRange = this.currentProgram
      ? `${formatTime(this.currentProgram.startAt)} 〜 ${formatTime(this.currentProgram.endAt)}`
      : '--:-- 〜 --:--';

    return `
      <div class="watch-program-header">
        <div class="watch-time-row">
          <span class="watch-live-tag">🔴 放送中</span>
          <span class="watch-time-text">${timeRange}</span>
          ${this.currentProgram?.genre ? `<span class="genre-tag">${escapeHtml(this.currentProgram.genre)}</span>` : ''}
        </div>

        <h2 class="watch-program-title">${escapeHtml(this.currentProgram?.name || '番組情報なし')}</h2>

        <div class="progress-track" style="margin-top: 8px; margin-bottom: 16px;">
          <div class="progress-fill" id="watch-progress-fill" style="width: 0%;"></div>
        </div>

        <p class="watch-program-desc">${escapeHtml(this.currentProgram?.description || '詳細情報はありません。')}</p>
      </div>

      <!-- 拡張情報 (あれば表示) -->
      ${this.currentProgram?.extended ? `
        <div class="watch-extended-info">
          ${Object.entries(this.currentProgram.extended).map(([key, val]) => `
            <div class="extended-item">
              <span class="extended-key">${escapeHtml(key)}:</span>
              <span class="extended-val">${escapeHtml(val)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <!-- 次の番組 -->
      ${this.nextProgram ? `
        <div class="watch-next-card">
          <span class="next-label">次の番組:</span>
          <span class="next-time">${formatTime(this.nextProgram.startAt)}</span>
          <span class="next-title">${escapeHtml(this.nextProgram.name)}</span>
        </div>
      ` : ''}
    `;
  }

  /**
   * 番組が替わっていたら番組情報を作り直す。5秒ごとに呼ぶ。
   *
   * **以前は画面を開いたときに一度決めるだけだった。**番組が終わっても
   * 前の番組のまま残り、進み具合のバーも 100% で止まっていた（実機、
   * 2026-09-25）。番組表の取得が後から終わった場合も、ここで拾う。
   * クイック選局と受信状態の欄は作り直さない（ボタンと数字を保つ）。
   */
  private refreshProgramInfo(): void {
    const current = currentProgramFor(this.channel);
    const next = nextProgramFor(this.channel);
    if (current?.id === this.currentProgram?.id && next?.id === this.nextProgram?.id) return;
    this.currentProgram = current;
    this.nextProgram = next;

    this.detailsSection
      .querySelectorAll('.watch-program-header, .watch-extended-info, .watch-next-card')
      .forEach((element) => { element.remove(); });
    const template = document.createElement('template');
    template.innerHTML = this.programInfoHtml();
    this.detailsSection.prepend(template.content);
  }

  /**
   * 受信を開始する。canvas の制御は Worker へ移るので、開き直すときは
   * 描画先を作り直す必要がある。
   */
  private async startLive(): Promise<void> {
    this.stopLive();
    // 走査は止めない。各系統の1本目は視聴のために空けてある（channel-scan.ts）。
    const tuning = tuningForChannel(this.channel);
    if (tuning === null) {
      this.showStatus('このチャンネルの選局先が分かりません。スキャンし直してください。');
      return;
    }
    try {
      const canvas = this.player.takeOffscreen();
      this.session = await LiveSession.start({
        canvas,
        tuning,
        serviceId: this.channel.serviceId,
        onStatus: (text) => { this.showStatus(text); },
        onStats: (stats) => { this.showStats(stats); },
        onCaption: (text) => { this.player.setSubtitleText(text); },
        onEnded: (reason) => { if (reason !== '') this.showStatus(reason); },
        dataBroadcast: {
          container: this.player.element,
          setVideoRect: (rect) => { this.player.setVideoRect(rect); },
        },
      });
      // 開き直したときは音量が既定へ戻る。つまみの位置と鳴り方がずれるので、
      // いま表示されている値をそのまま入れ直す。
      const audio = this.player.audioState;
      this.session.setVolume(audio.volume);
      this.session.setMuted(audio.muted);
    } catch (error) {
      this.showStatus(error instanceof Error ? error.message : String(error));
    }
  }

  private stopLive(): void {
    this.session?.stop();
    this.session = null;
    this.player.setSubtitleText('');
    this.player.setStatusText('');
  }

  /**
   * 受信・デコード状態へ実測値を入れる。
   *
   * CNR と BER は**この経路では測っていない**。復調器のレジスタから読む値で、
   * 上流の API を通していない。出せない数字を埋めると嘘になるので「—」のままにする。
   */
  private showStats(stats: LiveStats): void {
    // 受け入れ条件（A/V ずれ、滞留、音声の落ち）は画面に出していない項目まで
    // 含む。長時間の測定でそれらを読めるよう、最新の値を要素に添えておく。
    // 表示には影響しない。
    this.element.dataset['liveStats'] = JSON.stringify(stats);
    const drop = this.element.querySelector<HTMLElement>('#watch-signal-drop');
    if (drop) {
      const continuity = stats.demux['continuityErrors'] ?? 0;
      const dropped = Math.round(stats.droppedTsBytes / 188);
      drop.textContent = `${continuity + dropped} packets`;
      drop.classList.toggle('ok', continuity + dropped === 0);
    }
  }

  /**
   * 受信の状況とエラーを出す。
   *
   * 以前は字幕の枠へ流していたが、選局の失敗が放送の字幕のような見た目で
   * 出てしまった。プレイヤー側に別の表示先を持たせてそちらへ出す。
   */
  private showStatus(text: string): void {
    this.player.setStatusText(text);
  }

  private triggerBmlKey(name: string): void {
    sendDataBroadcastKey(name);
    this.pulseButton(name);
  }

  private pulseButton(name: string): void {
    const key = name.toLowerCase();
    const buttons = this.element.querySelectorAll<HTMLElement>(`[data-bml-key="${key}"]`);
    buttons.forEach((btn) => {
      btn.classList.add('pulse-press');
      window.setTimeout(() => {
        btn.classList.remove('pulse-press');
      }, 150);
    });
  }

  private handleBmlVisibility = (e: Event): void => {
    const custom = e as CustomEvent<{ visible: boolean }>;
    this.updateBmlVisibility(custom.detail?.visible ?? isDataBroadcastVisible());
  };

  private updateBmlVisibility(visible: boolean): void {
    const dButtons = this.element.querySelectorAll<HTMLElement>('[data-bml-key="d"]');
    dButtons.forEach((btn) => {
      btn.classList.toggle('active', visible);
    });
    const bmlBadge = this.element.querySelector<HTMLElement>('.watch-tab-bml-badge');
    if (bmlBadge) {
      bmlBadge.classList.toggle('visible', visible);
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const active = document.activeElement;
    if (active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      (active as HTMLElement).isContentEditable
    )) {
      return;
    }

    let keyName: string | null = null;
    switch (e.key) {
      case 'd':
      case 'D':
        keyName = 'd';
        break;
      case 'h':
      case 'H':
      case 'b':
      case 'B':
        keyName = 'blue';
        break;
      case 'j':
      case 'J':
      case 'r':
      case 'R':
        keyName = 'red';
        break;
      case 'k':
      case 'K':
      case 'g':
      case 'G':
        keyName = 'green';
        break;
      case 'l':
      case 'L':
      case 'y':
      case 'Y':
        keyName = 'yellow';
        break;
      case 'ArrowUp':
        keyName = 'up';
        break;
      case 'ArrowDown':
        keyName = 'down';
        break;
      case 'ArrowLeft':
        keyName = 'left';
        break;
      case 'ArrowRight':
        keyName = 'right';
        break;
      case 'Enter':
      case ' ':
        keyName = 'enter';
        break;
      case 'Backspace':
      case 'Escape':
        keyName = 'back';
        break;
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        keyName = e.key;
        break;
      default:
        return;
    }

    if (keyName !== null) {
      e.preventDefault();
      this.triggerBmlKey(keyName);
    }
  };

  public destroy(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('webts-bml-visibility', this.handleBmlVisibility);
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    this.stopLive();
    this.player.destroy();
  }
}

/**
 * スキャン時に取った EIT[p/f] から、いまの番組と次の番組を選ぶ。
 * 取れていなければ空。作り物は混ぜない。
 */
function currentProgramFor(channel: ChannelItem): ProgramItem | null {
  const now = Date.now();
  return programsSync(channel.id).find(
    (program) => program.startAt <= now && program.endAt > now) ?? null;
}

function nextProgramFor(channel: ChannelItem): ProgramItem | null {
  const now = Date.now();
  return programsSync(channel.id).find((program) => program.startAt > now) ?? null;
}

/** 時:分。 */
function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
