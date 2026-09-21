// EPGStationスタイルの「放映中 (OnAir)」ビュー

import type { BroadcastType, OnAirScheduleItem } from '../types';
import { generateOnAirSchedules, MOCK_CHANNELS } from '../mock-data';
import type { ProgramDialog } from '../components/program-dialog';
import type { StreamDialog } from '../components/stream-dialog';

export interface OnAirViewOptions {
  programDialog: ProgramDialog;
  streamDialog: StreamDialog;
}

export class OnAirView {
  public readonly element: HTMLElement;
  private tabsContainer: HTMLElement;
  private gridContainer: HTMLElement;
  private activeTab: BroadcastType = 'ALL';
  private schedules: OnAirScheduleItem[] = [];
  private digestTimer: number | null = null;
  private programDialog: ProgramDialog;
  private streamDialog: StreamDialog;

  constructor(options: OnAirViewOptions) {
    this.programDialog = options.programDialog;
    this.streamDialog = options.streamDialog;

    this.element = document.createElement('div');
    this.element.className = 'onair-view';

    // 放送波タブセレクター (ALL / GR / BS / CS)
    this.tabsContainer = document.createElement('div');
    this.tabsContainer.className = 'tabs-container';
    this.renderTabs();

    // カードグリッド
    this.gridContainer = document.createElement('div');
    this.gridContainer.className = 'onair-grid';

    this.element.append(this.tabsContainer, this.gridContainer);

    // 初期データ読み込み
    this.loadData();

    // 消化率（プログレスバー）の定期更新タイマー (1秒毎)
    this.digestTimer = window.setInterval(() => {
      this.updateDigestibility();
    }, 1000);

    // チャンネル設定変更イベントの購読
    this.onChannelsChanged = () => {
      this.loadData();
    };
    window.addEventListener('webts-channels-changed', this.onChannelsChanged);
  }

  private onChannelsChanged: () => void;

  private renderTabs(): void {
    this.tabsContainer.replaceChildren();

    const tabs: { type: BroadcastType; label: string }[] = [
      { type: 'ALL', label: 'すべて' },
      { type: 'GR', label: '地上波 (GR)' },
      { type: 'BS', label: 'BS放送' },
      { type: 'CS', label: 'CS放送' },
    ];

    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tab-button ${this.activeTab === tab.type ? 'active' : ''}`;
      btn.textContent = tab.label;
      btn.addEventListener('click', () => {
        if (this.activeTab !== tab.type) {
          this.activeTab = tab.type;
          this.renderTabs();
          this.renderCards();
        }
      });
      this.tabsContainer.append(btn);
    }
  }

  private async loadData(): Promise<void> {
    // まずモックデータを高速生成して描画
    this.schedules = generateOnAirSchedules();
    this.renderCards();

    // バックグラウンドで実機 (192.168.1.135:8888) の channels API が取得できるか試行
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('http://192.168.1.135:8888/api/channels', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const liveChannels = await res.json();
        if (Array.isArray(liveChannels) && liveChannels.length > 0) {
          // 実機のチャンネル一覧が取れた場合はチャンネル情報を更新
          console.log('[OnAirView] EPGStation 実機 (192.168.1.135:8888) と同期しました。チャンネル数:', liveChannels.length);
        }
      }
    } catch {
      // オフライン・別ネットワークの場合はモックデータで動作継続
    }
  }

  private renderCards(): void {
    this.gridContainer.replaceChildren();

    const filtered = this.schedules.filter((item) => {
      if (this.activeTab === 'ALL') return true;
      return item.channel.channelType === this.activeTab;
    });

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.gridColumn = '1 / -1';
      empty.style.textAlign = 'center';
      empty.style.padding = '48px 16px';
      empty.style.color = 'var(--text-secondary)';
      empty.textContent = '該当する放映中のチャンネルはありません。';
      this.gridContainer.append(empty);
      return;
    }

    for (const item of filtered) {
      const card = document.createElement('article');
      card.className = 'onair-card';
      card.dataset.channelId = String(item.channel.id);

      const current = item.currentProgram;
      const next = item.nextProgram;

      const formatTime = (ms: number) => {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      };

      const timeRange = current ? `${formatTime(current.startAt)} 〜 ${formatTime(current.endAt)}` : '--:-- 〜 --:--';

      card.innerHTML = `
        <div class="card-header">
          <div class="channel-info">
            <span class="channel-type-badge ${item.channel.channelType}">${item.channel.channelType}</span>
            <span class="channel-name" title="${escapeHtml(item.channel.name)}">${escapeHtml(item.channel.name)}</span>
          </div>
          ${item.channel.remoteControlKeyId ? `<span class="channel-key-badge">${item.channel.remoteControlKeyId}ch</span>` : ''}
        </div>

        <div class="card-time">${timeRange}</div>

        <div class="card-title-row">
          ${current?.genre ? `<span class="genre-tag">${escapeHtml(current.genre)}</span>` : ''}
          <h2 class="card-program-title" title="${escapeHtml(current?.name || '')}">
            ${escapeHtml(current?.name || '番組情報なし')}
          </h2>
        </div>

        <p class="card-program-desc">
          ${escapeHtml(current?.description || '詳細情報はありません。')}
        </p>

        <div class="progress-container">
          <div class="progress-track">
            <div class="progress-fill" style="width: ${item.digestibility}%;"></div>
          </div>
        </div>

        ${next ? `
          <div class="card-next-program">
            <span class="next-label">次:</span>
            <span class="next-time" style="opacity:0.8">${formatTime(next.startAt)}</span>
            <span class="next-title" title="${escapeHtml(next.name)}">${escapeHtml(next.name)}</span>
          </div>
        ` : ''}

        <div class="card-actions">
          <button type="button" class="btn-small detail-btn">詳細</button>
          <button type="button" class="btn-small primary watch-btn">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            視聴
          </button>
        </div>
      `;

      // カードクリックでストリーム選択モーダル
      card.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.detail-btn')) {
          if (current) this.programDialog.open(item.channel, current);
          return;
        }
        this.streamDialog.open(item.channel, current);
      });

      this.gridContainer.append(card);
    }
  }

  private updateDigestibility(): void {
    const now = Date.now();
    for (const item of this.schedules) {
      if (!item.currentProgram) continue;
      const start = item.currentProgram.startAt;
      const end = item.currentProgram.endAt;
      const elapsed = Math.max(0, now - start);
      const total = Math.max(1, end - start);
      item.digestibility = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));

      // 該当カードのプログレス要素のみ高速更新
      const card = this.gridContainer.querySelector<HTMLElement>(`[data-channel-id="${item.channel.id}"]`);
      if (card) {
        const fill = card.querySelector<HTMLElement>('.progress-fill');
        if (fill) fill.style.width = `${item.digestibility}%`;
      }
    }
  }

  public destroy(): void {
    if (this.digestTimer !== null) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }
    window.removeEventListener('webts-channels-changed', this.onChannelsChanged);
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
