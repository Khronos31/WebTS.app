// EPGStationスタイルの「About」ビュー
// ※指示により、使い方等の余計な情報は含めず、バージョン情報・ライセンス・環境診断のみを明瞭に表示する。

import { describeEnvironment } from '../../platform/environment';
import { APP_VERSION } from '../version';

const SOURCE_URL = 'https://github.com/Khronos31/WebTS.app';

export class AboutView {
  public readonly element: HTMLElement;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'about-container';

    this.render();
  }

  private render(): void {
    const env = describeEnvironment();

    this.element.innerHTML = `
      <!-- バージョン情報 -->
      <div class="about-card">
        <div class="about-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
          </svg>
          <span>バージョン情報</span>
        </div>
        <table class="about-kv-table">
          <tbody>
            <tr>
              <th>アプリケーション名</th>
              <td>WebTS.app</td>
            </tr>
            <tr>
              <th>バージョン</th>
              <td><strong>${APP_VERSION}</strong></td>
            </tr>
            <tr>
              <th>実行環境 (User Agent)</th>
              <td style="font-family: monospace; font-size: 0.75rem; word-break: break-all;">
                ${escapeHtml(navigator.userAgent)}
              </td>
            </tr>
            <tr>
              <th>ビルドターゲット</th>
              <td>ECMAScript 2022 / WebCodecs / WebUSB Native</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 動作環境診断 -->
      <div class="about-card">
        <div class="about-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
          </svg>
          <span>ブラウザ環境・APIサポート診断</span>
        </div>
        <table class="about-kv-table">
          <tbody>
            <tr>
              <th>セキュアコンテキスト (HTTPS / Localhost)</th>
              <td>
                <span class="about-status-pill ${env.secureContext ? 'supported' : 'unsupported'}">
                  ${env.secureContext ? '✔ 利用可能' : '✖ 利用不可'}
                </span>
              </td>
            </tr>
            <tr>
              <th>WebUSB API</th>
              <td>
                <span class="about-status-pill ${env.webUsbPresent ? 'supported' : 'unsupported'}">
                  ${env.webUsbPresent ? '✔ 利用可能' : '✖ 利用不可'}
                </span>
              </td>
            </tr>
            <tr>
              <th>クロスオリジン分離 (COOP/COEP)</th>
              <td>
                <span class="about-status-pill ${env.crossOriginIsolated ? 'supported' : 'unsupported'}">
                  ${env.crossOriginIsolated ? '✔ 有効 (SharedArrayBuffer 可能)' : '✖ 無効'}
                </span>
              </td>
            </tr>
            <tr>
              <th>WebCodecs API (ハードウェアアクセラレーション)</th>
              <td>
                <span class="about-status-pill ${env.webCodecsPresent ? 'supported' : 'unsupported'}">
                  ${env.webCodecsPresent ? '✔ 利用可能' : '✖ 利用不可'}
                </span>
              </td>
            </tr>
            <tr>
              <th>IndexedDB (ローカルストレージ)</th>
              <td>
                <span class="about-status-pill ${env.indexedDbPresent ? 'supported' : 'unsupported'}">
                  ${env.indexedDbPresent ? '✔ 利用可能' : '✖ 利用不可'}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ライセンスとソースコード -->
      <div class="about-card">
        <div class="about-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
          </svg>
          <span>ライセンスとソースコード</span>
        </div>
        <p style="font-size: 0.875rem; line-height: 1.6; color: var(--text-primary); margin-bottom: 12px;">
          WebTS.app は <strong>GNU General Public License v2.0 (GPL-2.0-only)</strong> のもとで公開されているオープンソースソフトウェアです。<br>
          同梱・利用しているサードパーティ製ライブラリのライセンスについてはリポジトリ内の <code>THIRD_PARTY_NOTICES.md</code> をご参照ください。
        </p>
        <p style="font-size: 0.875rem; line-height: 1.6; color: var(--text-primary); margin-bottom: 12px;">
          IT930x ファームウェアを、このアプリの配布サーバから取得します。ファイル自体は WebTS.app の GPL には含まれません。
        </p>
        <div style="font-size: 0.875rem; margin-bottom: 12px;">
          <span style="color: var(--text-secondary);">ソースコード リポジトリ:</span>
          <a href="${SOURCE_URL}" target="_blank" rel="noreferrer" style="color: var(--primary-light); margin-left: 6px; word-break: break-all;">
            ${SOURCE_URL}
          </a>
        </div>
        <div style="font-size: 0.8125rem; color: var(--text-secondary); background: var(--surface-color-variant); padding: 12px; border-radius: 6px;">
          <strong>プライバシー保護:</strong> 本アプリケーションは純粋なクライアントサイド駆動です。受信した放送波TSパケットやスマートカードとの通信データはすべて端末内で完結して処理され、外部サーバーへ送信されることはありません（IT930x ファームウェアは本アプリの配布サーバから取得しますが、端末側のデータが送信されることはありません）。
        </div>
      </div>
    `;
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
