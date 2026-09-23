// EPGStationスタイルの「放映中 (OnAir)」ビュー

import type { BroadcastType, OnAirScheduleItem } from '../types';
import { loadSchedules } from '../channel-source';
import { onRefreshStatus, stopRefresh } from '../epg-refresh';
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
  private activeTab: BroadcastType = 'GR';
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

    // 受信の状況を出す場所。番組情報を取り直しているあいだ受信機が塞がるので、
    // 黙って握らない。空のときは何も出さない。
    this.statusLine = document.createElement('div');
    this.statusLine.style.cssText = [
      'padding:4px 2px 8px',
      'font-size:0.8125rem',
      'color:var(--text-secondary)',
      'display:none',
    ].join(';');
    this.element.insertBefore(this.statusLine, this.gridContainer);

    // 消化率（プログレスバー）の定期更新タイマー (1秒毎)
    this.digestTimer = window.setInterval(() => {
      this.updateDigestibility();
      this.keepCurrent();
    }, 1000);

    // チャンネル設定変更イベントの購読
    this.onChannelsChanged = () => {
      this.loadData();
    };
    window.addEventListener('webts-channels-changed', this.onChannelsChanged);

    // 取得の状況はアプリ本体から届く。開いているあいだだけ出す。
    this.unsubscribe = onRefreshStatus((text) => { this.showStatus(text); });

    // 取得が終わったら読み直す。
    this.onProgramsUpdated = () => { void this.reload(); };
    window.addEventListener('webts-programs-updated', this.onProgramsUpdated);
  }

  private onChannelsChanged: () => void;
  private onProgramsUpdated: () => void;
  private unsubscribe: () => void = () => {};
  private statusLine!: HTMLElement;
  /** 自動更新の判定をした時刻。毎秒やる必要は無い。 */
  private reloading = false;
  private lastReload = 0;

  private renderTabs(): void {
    this.tabsContainer.replaceChildren();

    const tabs: { type: BroadcastType; label: string }[] = [
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
    await this.reload();
    this.renderCards();
  }

  /** 保存済みのスキャン結果を読み直す。まだスキャンしていなければ空になる。 */
  private async reload(): Promise<void> {
    // 毎秒の点検から呼ばれる。読み終わるまでに何度も入ると積み上がる。
    if (this.reloading) return;
    this.reloading = true;
    try {
      this.schedules = await loadSchedules();
      this.renderCards();
    } finally {
      this.reloading = false;
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

  /**
   * 表示を「いま」に合わせ続ける。
   *
   * EIT[p/f] は現在と次の2つを持っているので、現在の番組が終わったら
   * **選局し直さずに**次へ繰り上がる。読み直すだけで追随できる。
   * その先まで尽きたときだけ、受信機を使って取り直す。
   */
  private keepCurrent(): void {
    const now = Date.now();

    // **出している番組が終わったときだけ読み直す。**読み直せば保存済みの
    // 「次」が繰り上がる。
    //
    // 番組が分からない局を「繰り上げが要る」と見なしてはいけない。読み直しても
    // 分からないままなので、毎秒読み直し続けたうえ、この下の取り直しに
    // 一度も辿り着かない。実測で、16:00 の番組を「次」として抱えたまま
    // 21:19 まで放置された（受信機は空いていた）。
    const passed = this.schedules.some((item) => {
      const current = item.currentProgram;
      if (current === null) return false;
      // 終了時刻が未定のものは繰り上げの判断に使えない。
      return current.endAt > current.startAt && current.endAt <= now;
    });
    if (passed && now - this.lastReload > 5_000) {
      this.lastReload = now;
      void this.reload();
    }

    // **取りに行く判定はここには置かない。**アプリ本体が持つ。視聴中は
    // この画面が外れており、ここに置くと一度も判定されない。
  }

  private showStatus(text: string): void {
    this.statusLine.textContent = text;
    this.statusLine.style.display = text === '' ? 'none' : '';
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
    // 受信機を掴んだまま画面を離れない。視聴へ移るときはここで明け渡す。
    stopRefresh();
    if (this.digestTimer !== null) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }
    window.removeEventListener('webts-channels-changed', this.onChannelsChanged);
    window.removeEventListener('webts-programs-updated', this.onProgramsUpdated);
    this.unsubscribe();
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
