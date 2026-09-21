// EPGStationスタイルの「視聴 (Watch)」ビュー
// 16:9動画プレイヤー、リアルタイム字幕、番組メタデータ、電波モニター

import type { ChannelItem, ProgramItem } from '../types';
import { MOCK_CHANNELS, generateOnAirSchedules, getEnabledChannelIds } from '../mock-data';
import { VideoPlayer } from '../components/video-player';

export interface WatchViewOptions {
  channelId: number;
  onNavigateBack: () => void;
  onSwitchChannel: (channelId: number) => void;
}

export class WatchView {
  public readonly element: HTMLElement;
  private player: VideoPlayer;
  private progressTimer: number | null = null;
  private channel: ChannelItem;
  private currentProgram: ProgramItem | null = null;
  private nextProgram: ProgramItem | null = null;

  constructor(options: WatchViewOptions) {
    this.element = document.createElement('div');
    this.element.className = 'watch-container';

    // チャンネルと番組情報の特定
    const foundChannel = MOCK_CHANNELS.find((c) => c.id === options.channelId) || MOCK_CHANNELS[0]!;
    this.channel = foundChannel;

    const schedules = generateOnAirSchedules();
    const schedule = schedules.find((s) => s.channel.id === this.channel.id);
    this.currentProgram = schedule?.currentProgram ?? null;
    this.nextProgram = schedule?.nextProgram ?? null;

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
      videoSrc: '/mock-stream.mp4',
      autoplay: true,
      programTitle: this.currentProgram?.name,
    });

    playerWrapper.append(this.player.element);
    this.element.append(playerWrapper);

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
          <div class="progress-fill" id="watch-progress-fill" style="width: ${schedule?.digestibility ?? 0}%;"></div>
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
          ${getEnabledChannelIds().size > 0
            ? MOCK_CHANNELS
                .filter((c) => getEnabledChannelIds().has(c.id))
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
            <span class="signal-val ok">29.4 dB (良好)</span>
          </div>
          <div class="signal-item">
            <span class="signal-label">BER (ビットエラー)</span>
            <span class="signal-val">0.00e+0</span>
          </div>
          <div class="signal-item">
            <span class="signal-label">TS ドロップ</span>
            <span class="signal-val">0 packets</span>
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

  public destroy(): void {
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    this.player.destroy();
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
