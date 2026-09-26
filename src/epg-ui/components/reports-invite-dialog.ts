// 本番環境で未確認のチューナー機種が接続された際の動作報告（オプトイン）案内ダイアログ。
// 利用者が明示的に「オンにする」を選択した場合のみ送信を許可する。

import { dismissReportsInvite, setReportsEnabled } from '../../reports/reports';

export function showReportsInviteDialog(model: { name: string; productId: number }): Promise<void> {
  return new Promise<void>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay open';
    overlay.style.zIndex = '500';

    const box = document.createElement('div');
    box.className = 'dialog-box';
    box.style.maxWidth = '480px';

    box.innerHTML = `
      <div class="dialog-header">
        <div class="dialog-title">動作報告へのご協力のお願い</div>
        <button type="button" class="dialog-close-btn" id="reports-invite-close-btn" aria-label="閉じる">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>
      <div class="dialog-body" style="font-size: 0.875rem; line-height: 1.6;">
        <p style="margin: 0 0 12px 0;">
          接続されたチューナー「<strong>${escapeHtml(model.name)}</strong>」は、WebTS での動作がまだ実機で確認されていない機種です。
        </p>
        <p style="margin: 0 0 12px 0; color: var(--text-secondary); font-size: 0.8125rem;">
          今後の対応改善のため、最小限の動作ログを配布サーバへ送信する動作報告をオンにしていただけないでしょうか。
        </p>
        <div style="font-size: 0.8125rem; line-height: 1.5; margin-bottom: 12px; background: var(--surface-color-variant); padding: 10px 12px; border-radius: 6px;">
          <div style="font-weight: 600; margin-bottom: 4px; color: var(--text-primary);">送る中身:</div>
          <div style="color: var(--text-secondary); margin-bottom: 8px;">
            アプリのバージョン、チューナー機種名、OS/ブラウザの種類とメジャー版、視聴か走査か、受信波（地上波・BS・CS）、動作結果（映った・ロックした／信号なし／エラー番号）。※同じ内容は1回しか送りません。
          </div>
          <div style="font-weight: 600; margin-bottom: 4px; color: var(--text-primary);">送らない中身:</div>
          <div style="color: var(--text-secondary);">
            シリアル番号、USB識別子、B-CASカード情報、見た局・番組、地域・郵便番号、時刻（日付のみ保存）、端末識別ID。受け側はIPアドレスも保存しません。
          </div>
        </div>
        <p style="margin: 0; font-size: 0.75rem; color: var(--text-secondary);">
          ※ 設定ページからいつでもオン・オフを切り替えることができます。
        </p>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn btn-secondary" id="reports-invite-dismiss-btn">オンにしない</button>
        <button type="button" class="btn btn-primary" id="reports-invite-accept-btn">オンにする</button>
      </div>
    `;

    let settled = false;
    const cleanup = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKeyDown);
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 200);
      if (accepted) {
        setReportsEnabled(true);
      } else {
        dismissReportsInvite(model.productId);
      }
      resolve();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup(false);
    };
    window.addEventListener('keydown', onKeyDown);

    box.querySelector('#reports-invite-close-btn')?.addEventListener('click', () => cleanup(false));
    box.querySelector('#reports-invite-dismiss-btn')?.addEventListener('click', () => cleanup(false));
    box.querySelector('#reports-invite-accept-btn')?.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    overlay.append(box);
    document.body.append(overlay);
  });
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
