import type { ChannelItem, ProgramItem } from '../types';
import { confirmLiveBlocksGuideIfNeeded } from './live-guide-notice-dialog';

export class StreamDialog {
  public readonly overlayElement: HTMLElement;
  private boxElement: HTMLElement;

  constructor() {
    this.overlayElement = document.createElement('div');
    this.overlayElement.className = 'dialog-overlay';

    this.boxElement = document.createElement('div');
    this.boxElement.className = 'dialog-box';

    this.overlayElement.append(this.boxElement);

    this.overlayElement.addEventListener('click', (e) => {
      if (e.target === this.overlayElement) {
        this.close();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });
  }

  public open(channel: ChannelItem, program: ProgramItem | null): void {
    this.boxElement.innerHTML = `
      <div class="dialog-header">
        <div class="dialog-title">${escapeHtml(channel.name)}</div>
        <button type="button" class="dialog-close-btn" aria-label="閉じる">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>
      <div class="dialog-body">
        ${program ? `
          <div style="padding: 12px; background: var(--surface-color-variant); border-radius: 6px; margin-bottom: 16px;">
            <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 4px;">放送中</div>
            <div style="font-weight: 700; font-size: 0.9375rem; color: var(--text-primary); margin-bottom: 4px;">
              ${escapeHtml(program.name)}
            </div>
            <div style="font-size: 0.8125rem; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
              ${escapeHtml(program.description)}
            </div>
          </div>
        ` : ''}

        <div class="form-group">
          <label class="form-label">ストリーミング方式</label>
          <select class="form-select" id="stream-type-select">
            <option value="webcodecs">WebCodecs 超低遅延ライブ (ブラウザ内蔵デコーダ)</option>
            <option value="raw-ts">RAW TS ストリーム (デマルチプレクサ直結)</option>
            <option value="hls">HLS (HTTP Live Streaming - 互換モード)</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">画質 / 解像度設定</label>
          <select class="form-select" id="stream-quality-select">
            <option value="1080p">オリジナル無劣化 (1080i / MPEG-2 15-20Mbps)</option>
            <option value="720p">720p 60fps (H.264 ハードウェアトランスコード)</option>
            <option value="480p">480p 30fps (低帯域・省電力モード)</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">音声トラック</label>
          <select class="form-select" id="audio-track-select">
            <option value="main">主音声 (ステレオ)</option>
            <option value="sub">副音声 (解説 / 二重音声)</option>
          </select>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn btn-secondary close-btn">キャンセル</button>
        <button type="button" class="btn btn-primary" id="start-watch-btn">
          <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
          視聴を開始
        </button>
      </div>
    `;

    const closeButtons = this.boxElement.querySelectorAll('.dialog-close-btn, .close-btn');
    closeButtons.forEach((btn) => btn.addEventListener('click', () => this.close()));

    const startBtn = this.boxElement.querySelector<HTMLButtonElement>('#start-watch-btn');
    startBtn?.addEventListener('click', async () => {
      if (!(await confirmLiveBlocksGuideIfNeeded())) {
        return;
      }
      this.close();
      window.location.hash = `#/watch?channel=${channel.id}`;
    });

    this.overlayElement.classList.add('open');
  }

  public close(): void {
    this.overlayElement.classList.remove('open');
  }

  public isOpen(): boolean {
    return this.overlayElement.classList.contains('open');
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
