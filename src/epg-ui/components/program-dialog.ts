// 番組詳細ダイアログ (EPGStation ProgramDialog Style)

import type { ChannelItem, ProgramItem } from '../types';

export interface ProgramDialogOptions {
  onWatch?: (channel: ChannelItem, program: ProgramItem) => void;
}

export function isOnAir(program: ProgramItem, now: number = Date.now()): boolean {
  return program.startAt <= now && (program.endAt > now || program.endAt === program.startAt);
}

export class ProgramDialog {
  public readonly overlayElement: HTMLElement;
  private boxElement: HTMLElement;
  readonly #options: ProgramDialogOptions | undefined;

  constructor(options?: ProgramDialogOptions) {
    this.#options = options;
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

  public open(channel: ChannelItem, program: ProgramItem): void {
    const onAir = isOnAir(program, Date.now());
    const startDate = new Date(program.startAt);
    const endDate = new Date(program.endAt);
    const formatTime = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const timeStr = `${startDate.getMonth() + 1}/${startDate.getDate()} ${formatTime(startDate)} 〜 ${formatTime(endDate)} (${Math.round((program.endAt - program.startAt) / 60000)}分)`;

    let extendedHtml = '';
    if (program.extended) {
      extendedHtml = Object.entries(program.extended).map(([k, v]) => `
        <div style="margin-top: 12px;">
          <div style="font-weight: 700; font-size: 0.8125rem; color: var(--primary-light); margin-bottom: 2px;">${escapeHtml(k)}</div>
          <div style="font-size: 0.8125rem; white-space: pre-wrap; color: var(--text-primary);">${escapeHtml(v)}</div>
        </div>
      `).join('');
    }

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
        <div style="font-size: 0.8125rem; color: var(--text-secondary); margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
          <span>${timeStr}</span>
          ${onAir ? '<span class="guide-onair-tag"><span class="guide-live-dot"></span>放送中</span>' : ''}
        </div>
        <h2 style="font-size: 1.125rem; font-weight: 700; line-height: 1.4; margin-bottom: 12px; color: var(--text-primary);">
          ${escapeHtml(program.name)}
        </h2>
        <div style="margin-bottom: 12px; display: flex; gap: 6px; flex-wrap: wrap;">
          ${program.genre ? `<span class="genre-tag">${escapeHtml(program.genre)}</span>` : ''}
          <span class="genre-tag" style="background: rgba(255,255,255,0.08); color: var(--text-secondary);">
            ${program.videoType || '1080i'}
          </span>
          <span class="genre-tag" style="background: rgba(255,255,255,0.08); color: var(--text-secondary);">
            ${program.audioMode || 'ステレオ'}
          </span>
        </div>
        <div style="font-size: 0.875rem; line-height: 1.6; color: var(--text-primary); margin-bottom: 16px;">
          ${escapeHtml(program.description)}
        </div>
        ${extendedHtml}
      </div>
      <div class="dialog-footer program-dialog-footer">
        <button type="button" class="btn btn-secondary close-btn">閉じる</button>
        ${onAir ? `
          <button type="button" class="btn btn-primary watch-btn" id="dialog-watch-btn">
            <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            視聴する
          </button>
        ` : ''}
      </div>
    `;

    const closeButtons = this.boxElement.querySelectorAll('.dialog-close-btn, .close-btn');
    closeButtons.forEach((btn) => btn.addEventListener('click', () => this.close()));

    if (onAir) {
      const watchBtn = this.boxElement.querySelector<HTMLButtonElement>('#dialog-watch-btn');
      watchBtn?.addEventListener('click', () => {
        this.close();
        if (this.#options?.onWatch) {
          this.#options.onWatch(channel, program);
        } else {
          window.location.hash = `#/watch?channel=${channel.id}`;
        }
      });
    }

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
