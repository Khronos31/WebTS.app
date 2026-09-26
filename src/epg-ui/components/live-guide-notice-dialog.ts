// 受信機が1本しかない機種での、視聴開始前の確認ダイアログ。
// 視聴中は番組表の更新ができないことを伝え、了承を得る。

import { dismissLiveBlocksGuideNotice, liveBlocksGuideNoticeNeeded } from '../receiver-gate';

let lastConfirmedAt = 0;

/**
 * 受信機が1本の機種で視聴を始める前に確認ダイアログを出す。
 * 「2度と表示しない」が選ばれていればダイアログを出さず true を返す。
 * 直前に確認済みの場合（放映中や番組表のダイアログから遷移した直後）も true を返す。
 */
export async function confirmLiveBlocksGuideIfNeeded(): Promise<boolean> {
  if (!(await liveBlocksGuideNoticeNeeded())) {
    return true;
  }
  // 直前にダイアログで確認したばかりの場合は再確認しない（3秒間有効）
  if (Date.now() - lastConfirmedAt < 3000) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay open';
    overlay.style.zIndex = '500';

    const box = document.createElement('div');
    box.className = 'dialog-box';
    box.style.maxWidth = '460px';

    box.innerHTML = `
      <div class="dialog-header">
        <div class="dialog-title">ライブ視聴の確認</div>
        <button type="button" class="dialog-close-btn" id="live-notice-close-btn" aria-label="閉じる">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>
      <div class="dialog-body" style="font-size: 0.875rem; line-height: 1.6;">
        <p style="margin: 0 0 12px 0;">
          ライブ視聴中は番組表が更新できません。視聴を開始しますか？
        </p>
        <p style="margin: 0 0 16px 0; font-size: 0.8125rem; color: var(--text-secondary);">
          お使いのチューナーは受信機が1本のため、視聴と番組表の取得（またはスキャン）を同時に行うことができません。
        </p>
        <div style="margin-bottom: 8px;">
          <label class="checkbox-label" style="font-size: 0.8125rem; cursor: pointer;">
            <input type="checkbox" id="live-notice-dismiss-checkbox" style="cursor: pointer;" />
            <span>2度と表示しない</span>
          </label>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn btn-secondary" id="live-notice-cancel-btn">キャンセル</button>
        <button type="button" class="btn btn-primary" id="live-notice-confirm-btn">視聴を開始</button>
      </div>
    `;

    let settled = false;
    const cleanup = (result: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKeyDown);
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup(false);
    };
    window.addEventListener('keydown', onKeyDown);

    box.querySelector('#live-notice-close-btn')?.addEventListener('click', () => cleanup(false));
    box.querySelector('#live-notice-cancel-btn')?.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    box.querySelector('#live-notice-confirm-btn')?.addEventListener('click', () => {
      const checkbox = box.querySelector<HTMLInputElement>('#live-notice-dismiss-checkbox');
      if (checkbox?.checked) {
        dismissLiveBlocksGuideNotice();
      }
      lastConfirmedAt = Date.now();
      cleanup(true);
    });

    overlay.append(box);
    document.body.append(overlay);
  });
}
