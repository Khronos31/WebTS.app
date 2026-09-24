// EPGStationスタイルの「視聴 (Watch)」ビュー
// 16:9動画プレイヤー、リアルタイム字幕、番組メタデータ、電波モニター

import type { ChannelItem, ProgramItem } from '../types';
import { channelsSync, findChannelSync, programsSync } from '../channel-source';
import { VideoPlayer } from '../components/video-player';
import { LiveSession, type LiveStats } from '../live-session';
import { tuningForChannel } from '../tuning';

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

    const channelBadgeRow = document.createElement('div');
    channelBadgeRow.className = 'watch-channel-badge-row';
    channelBadgeRow.innerHTML = `
      <span class="channel-type-badge ${this.channel.channelType}">${this.channel.channelType}</span>
      <span style="font-weight: 700; font-size: 0.9375rem;">${escapeHtml(this.channel.name)}</span>
      ${this.channel.remoteControlKeyId ? `<span class="channel-key-badge">${this.channel.remoteControlKeyId}ch</span>` : ''}
    `;

    topBar.append(backBtn, channelBadgeRow);
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

    // 3. 番組情報 & メタデータエリア
    const detailsSection = document.createElement('div');
    detailsSection.className = 'watch-details-section';

    const formatTime = (ms: number) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    const timeRange = this.currentProgram
      ? `${formatTime(this.currentProgram.startAt)} 〜 ${formatTime(this.currentProgram.endAt)}`
      : '--:-- 〜 --:--';

    detailsSection.innerHTML = `
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

    this.element.append(detailsSection);

    // プログレスバーの更新タイマー (5秒ごと)
    this.progressTimer = window.setInterval(() => {
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

  public destroy(): void {
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

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
