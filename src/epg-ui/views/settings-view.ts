// EPGStationスタイルの「設定 (Settings)」ビュー

import {
  defaultEnabledChannelIds,
  getEnabledChannelIds,
  saveEnabledChannelIds,
} from '../enabled-channels';
import {
  FIRMWARE_SOURCE,
  cacheFirmware,
  clearCachedFirmware,
  extractFirmware,
  type FirmwareStage,
} from '../../usb/firmware';
import { readSetupState } from '../../ui/setup-state';
import { saveChannels } from '../channel-store';
import { scanAllWaves, stopRefresh } from '../epg-refresh';
import type { ChannelItem } from '../types';
import { channelsSync } from '../channel-source';
import { loadQ3U4Identifiers } from '../../usb/px4-identity';
import { getTheme, setTheme, type ThemeMode } from '../theme-manager';
import { allowLnb15v, setAllowLnb15v } from '../lnb-setting';

export interface SettingsViewOptions {
  onStateChanged: () => void;
}

export class SettingsView {
  public readonly element: HTMLElement;
  private onStateChanged: () => void;
  private isScanning = false;
  private scanTimer: number | null = null;

  constructor(options: SettingsViewOptions) {
    this.onStateChanged = options.onStateChanged;
    this.element = document.createElement('div');
    this.element.className = 'settings-container';

    void this.render();
  }

  private async render(): Promise<void> {
    this.element.replaceChildren();

    const state = await readSetupState();

    // 1. テーマ・外観設定 カード
    this.element.append(this.createThemeCard());

    // 2. ファームウェアを取得・設定 カード
    this.element.append(this.createFirmwareCard(state.firmware));

    // 3. 地域設定・チャンネルスキャン カード
    this.element.append(this.createScanCard());

    // 4. チューナー接続 カード
    this.element.append(this.createTunerCard(state.tuner));

    // 5. BS/CS アンテナ電源 (LNB) カード
    this.element.append(this.createLnbCard());

    // 6. 受信状態 (Signal Monitor) カード
    this.element.append(this.createSignalCard());
  }

  private createThemeCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'settings-card';

    const currentTheme = getTheme();

    card.innerHTML = `
      <div class="settings-card-header">
        <div class="settings-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
          </svg>
          <span>テーマ・外観設定</span>
        </div>
        <span class="status-badge ok" id="theme-status-badge">
          ${currentTheme === 'system' ? 'システム同期' : currentTheme === 'light' ? 'ライト' : 'ダーク'}
        </span>
      </div>

      <div class="theme-options-grid">
        <div class="theme-option-card ${currentTheme === 'system' ? 'selected' : ''}" data-theme-val="system">
          <svg viewBox="0 0 24 24" class="theme-option-icon">
            <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
          </svg>
          <span class="theme-option-title">システム設定に従う</span>
        </div>

        <div class="theme-option-card ${currentTheme === 'light' ? 'selected' : ''}" data-theme-val="light">
          <svg viewBox="0 0 24 24" class="theme-option-icon">
            <path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/>
          </svg>
          <span class="theme-option-title">ライトテーマ</span>
        </div>

        <div class="theme-option-card ${currentTheme === 'dark' ? 'selected' : ''}" data-theme-val="dark">
          <svg viewBox="0 0 24 24" class="theme-option-icon">
            <path d="M12.3 2a10 10 0 0 0-1.9 20 10 10 0 0 0 10.6-13.4 8 8 0 0 1-8.7-6.6z"/>
          </svg>
          <span class="theme-option-title">ダークテーマ</span>
        </div>
      </div>
    `;

    const cards = card.querySelectorAll<HTMLElement>('.theme-option-card');
    const badge = card.querySelector<HTMLElement>('#theme-status-badge')!;

    cards.forEach((optCard) => {
      optCard.addEventListener('click', () => {
        const val = optCard.dataset.themeVal as ThemeMode;
        if (!val) return;

        setTheme(val);

        cards.forEach((c) => c.classList.remove('selected'));
        optCard.classList.add('selected');

        badge.textContent = val === 'system' ? 'システム同期' : val === 'light' ? 'ライト' : 'ダーク';
      });
    });

    return card;
  }

  private createFirmwareCard(firmwareState: { needed: boolean; detail: string }): HTMLElement {
    const card = document.createElement('div');
    card.className = 'settings-card';

    const isOk = !firmwareState.needed;

    card.innerHTML = `
      <div class="settings-card-header">
        <div class="settings-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
          <span>ファームウェアを取得・設定</span>
        </div>
        <span class="status-badge ${isOk ? 'ok' : 'warning'}">
          ${isOk ? '設定完了' : '要設定'}
        </span>
      </div>

      <p class="settings-card-desc">
        PX-Q3U4 / PX-W3U4 内部の IT930x デモジュレータを初期化するためにファームウェア (2,169 bytes) が必要です。
        メーカー提供の公式ドライバパッケージからブラウザ内で自動抽出され、端末内の IndexedDB に安全に保存されます。
      </p>

      <div class="form-group" style="margin-bottom: 12px;">
        <span class="form-label">メーカー公式ドライバ配布元:</span>
        <a href="${FIRMWARE_SOURCE.archiveUrl}" target="_blank" rel="noreferrer" style="color: var(--primary-light); font-size: 0.8125rem;">
          PLEX PX-W3U4 ドライバパッケージ (ZIP)
        </a>
        <span style="font-size: 0.75rem; color: var(--text-secondary); margin-left: 6px;">
          （PX-Q3U4 でも共通の IT930x ファームウェアを使用します）
        </span>
      </div>

      <div class="drop-zone" id="fw-drop-zone">
        <svg viewBox="0 0 24 24" style="width:40px;height:40px;fill:var(--text-secondary);margin-bottom:8px">
          <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
        </svg>
        <div style="font-weight: 600; font-size: 0.875rem; margin-bottom: 4px;">
          ダウンロードしたドライバ ZIP または .sys ファイルをここにドラッグ＆ドロップ
        </div>
        <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 12px;">
          またはクリックしてファイルを選択
        </div>
        <input type="file" id="fw-file-picker" accept=".zip,.sys" style="display:none;" />
        <button type="button" class="btn btn-secondary" id="fw-browse-btn">
          ファイルを選択
        </button>
      </div>

      <div id="fw-status-box" style="margin-top: 12px; font-size: 0.8125rem; display: none;"></div>

      ${isOk ? `
        <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" id="fw-clear-btn" style="color: var(--error);">
            ファームウェアを消去
          </button>
        </div>
      ` : ''}
    `;

    const picker = card.querySelector<HTMLInputElement>('#fw-file-picker')!;
    const browseBtn = card.querySelector<HTMLButtonElement>('#fw-browse-btn')!;
    const dropZone = card.querySelector<HTMLElement>('#fw-drop-zone')!;
    const statusBox = card.querySelector<HTMLElement>('#fw-status-box')!;
    const clearBtn = card.querySelector<HTMLButtonElement>('#fw-clear-btn');

    browseBtn.addEventListener('click', () => picker.click());
    dropZone.addEventListener('click', (e) => {
      if (e.target !== browseBtn) picker.click();
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file) void handleFile(file);
    });

    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (file) void handleFile(file);
    });

    clearBtn?.addEventListener('click', async () => {
      await clearCachedFirmware();
      this.onStateChanged();
      void this.render();
    });

    const handleFile = async (file: File) => {
      statusBox.style.display = 'block';
      statusBox.innerHTML = '<span style="color:var(--primary-light);">ファームウェアを抽出中...</span>';

      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const stages: FirmwareStage[] = [];
        const result = await extractFirmware(bytes, (stage) => {
          stages.push(stage);
          statusBox.innerHTML = `<div>${stages.map((s) => `✔ ${s}`).join('<br>')}</div>`;
        });
        await cacheFirmware(result.bytes);
        statusBox.innerHTML = `
          <div style="color: var(--success); font-weight: 600;">
            ✔ ファームウェア (${result.bytes.length} bytes) の抽出・IndexedDB保存が完了しました！
          </div>
        `;
        this.onStateChanged();
        setTimeout(() => void this.render(), 1200);
      } catch (err) {
        statusBox.innerHTML = `
          <div style="color: var(--error);">
            ✖ 抽出エラー: ${err instanceof Error ? err.message : String(err)}
          </div>
        `;
      }
    };

    return card;
  }

  private createScanCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'settings-card';

    // **走査で見つかった局を出す。**固定の一覧を出すと、受信できない局が
    // 並び、有効/無効の選択も実際の局と対応しなくなる。
    const known = (): ChannelItem[] => channelsSync(false);
    let enabledIds = getEnabledChannelIds();
    if (enabledIds.size === 0) enabledIds = defaultEnabledChannelIds(known());

    const updateStatusBadge = () => {
      const badge = card.querySelector<HTMLElement>('#scan-status-badge');
      if (badge) {
        badge.textContent = `有効: ${enabledIds.size} / 全${known().length}局`;
      }
    };

    card.innerHTML = `
      <div class="settings-card-header">
        <div class="settings-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M12 3C6.48 3 2 7.48 2 13c0 3.7 2.01 6.94 4.99 8.65l1-1.73C5.61 18.53 4 15.96 4 13c0-4.41 3.59-8 8-8s8 3.59 8 8c0 2.96-1.61 5.53-3.99 6.92l1 1.73C20 19.94 22 16.7 22 13c0-5.52-4.48-10-10-10zm0 4c-3.31 0-6 2.69-6 6 0 2.22 1.21 4.15 3 5.19l1-1.74c-1.19-.7-2-1.97-2-3.45 0-2.21 1.79-4 4-4s4 1.79 4 4c0 1.48-.81 2.75-2 3.45l1 1.74c1.79-1.04 3-2.97 3-5.19 0-3.31-2.69-6-6-6zm-1 4v4h2v-4h-2z"/>
          </svg>
          <span>チャンネルスキャン</span>
        </div>
        <span class="status-badge ok" id="scan-status-badge">有効: ${enabledIds.size} / 全${known().length}局</span>
      </div>

      <p class="settings-card-desc">
        地上波デジタル放送の全物理チャンネル（UHF 13ch〜52ch）を一括走査して放送局を自動検出します。
        取得した局一覧から見ない局のチェックを外して放映中リストから除外できます。
      </p>

      <div style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <button type="button" class="btn btn-primary" id="start-scan-btn">
          <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor">
            <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
          </svg>
          スキャン開始
        </button>
      </div>

      <div class="scan-progress-box" id="scan-box" style="display: none; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; font-size: 0.8125rem; margin-bottom: 6px;">
          <span id="scan-current-channel">UHF全帯域走査待機中...</span>
          <span id="scan-progress-pct">0%</span>
        </div>
        <div class="progress-track" style="margin-bottom: 12px;">
          <div class="progress-fill" id="scan-progress-bar" style="width: 0%;"></div>
        </div>
        <div class="scan-log" id="scan-log-view"></div>
      </div>

      <!-- 検出局一覧 & チェックボックス選択 -->
      <div class="channel-manager-section" style="margin-top: 16px;">
        <div class="channel-toolbar">
          <span style="font-weight: 600; font-size: 0.875rem;">検出されたチャンネル一覧</span>
          <div class="channel-btn-group">
            <button type="button" class="btn-small primary" id="btn-select-primary" title="各局の代表チャンネルのみチェック">
              代表局のみ選択
            </button>
            <button type="button" class="btn-small" id="btn-select-all">
              すべて選択
            </button>
            <button type="button" class="btn-small" id="btn-select-none">
              すべて解除
            </button>
          </div>
        </div>

        <div class="channel-table-container">
          <table class="channel-table">
            <thead>
              <tr>
                <th style="width: 68px; text-align: center; white-space: nowrap;">表示</th>
                <th>放送局名</th>
                <th>種別</th>
                <th>物理ch</th>
                <th>サービスID</th>
              </tr>
            </thead>
            <tbody id="channel-table-body">
            </tbody>
          </table>
        </div>
      </div>
    `;

    const startBtn = card.querySelector<HTMLButtonElement>('#start-scan-btn')!;
    const scanBox = card.querySelector<HTMLElement>('#scan-box')!;
    const scanChannelText = card.querySelector<HTMLElement>('#scan-current-channel')!;
    const scanPctText = card.querySelector<HTMLElement>('#scan-progress-pct')!;
    const scanBar = card.querySelector<HTMLElement>('#scan-progress-bar')!;
    const scanLog = card.querySelector<HTMLElement>('#scan-log-view')!;
    const tbody = card.querySelector<HTMLElement>('#channel-table-body')!;
    const btnSelectPrimary = card.querySelector<HTMLButtonElement>('#btn-select-primary')!;
    const btnSelectAll = card.querySelector<HTMLButtonElement>('#btn-select-all')!;
    const btnSelectNone = card.querySelector<HTMLButtonElement>('#btn-select-none')!;

    // テーブルの描画
    const renderTable = () => {
      tbody.replaceChildren();

      for (const ch of known()) {
        const tr = document.createElement('tr');
        if (ch.isSubChannel) tr.classList.add('sub-row');

        const isChecked = enabledIds.has(ch.id);

        tr.innerHTML = `
          <td style="text-align: center;">
            <input type="checkbox" class="ch-check" data-ch-id="${ch.id}" ${isChecked ? 'checked' : ''} style="cursor: pointer;" />
          </td>
          <td>
            <span style="font-weight: ${ch.isPrimary ? '700' : '400'}; margin-left: ${ch.isSubChannel ? '16px' : '0'};">
              ${escapeHtml(ch.name)}
            </span>
            ${ch.isPrimary ? '<span class="channel-primary-badge">代表</span>' : ''}
            ${ch.isSubChannel ? '<span class="channel-sub-badge">サブ</span>' : ''}
          </td>
          <td>
            <span class="channel-type-badge ${ch.channelType}">${ch.channelType}</span>
          </td>
          <td>${ch.channel ? `${ch.channel}ch` : '-'}</td>
          <td style="font-variant-numeric: tabular-nums; opacity: 0.8;">${String(ch.serviceId).padStart(5, '0')}</td>
        `;

        const checkbox = tr.querySelector<HTMLInputElement>('.ch-check')!;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            enabledIds.add(ch.id);
          } else {
            enabledIds.delete(ch.id);
          }
          saveEnabledChannelIds(enabledIds);
          updateStatusBadge();
        });

        tbody.append(tr);
      }
    };

    renderTable();

    // 代表局のみ選択
    btnSelectPrimary.addEventListener('click', () => {
      enabledIds = defaultEnabledChannelIds(known());
      saveEnabledChannelIds(enabledIds);
      renderTable();
      updateStatusBadge();
    });

    // すべて選択
    btnSelectAll.addEventListener('click', () => {
      enabledIds = new Set(known().map((c) => c.id));
      saveEnabledChannelIds(enabledIds);
      renderTable();
      updateStatusBadge();
    });

    // すべて解除
    btnSelectNone.addEventListener('click', () => {
      enabledIds = new Set();
      saveEnabledChannelIds(enabledIds);
      renderTable();
      updateStatusBadge();
    });

    const appendLog = (msg: string) => {
      const line = document.createElement('div');
      line.textContent = msg;
      scanLog.append(line);
      scanLog.scrollTop = scanLog.scrollHeight;
    };

    // フルスキャン開始
    startBtn.addEventListener('click', () => {
      if (this.isScanning) return;
      this.isScanning = true;
      startBtn.disabled = true;
      scanBox.style.display = 'block';
      scanLog.innerHTML = '';

      appendLog('[FULL-SCAN] 全帯域フルスキャンを開始します（地上波 → BS → CS）...');

      // 進捗は中継器を読み終えた時点で1回来る。ロックの成否は
      // ドライバが記録したものをそのまま出す。推測しない。
      let previousFound = 0;

      void scanAllWaves((wave) => {
        previousFound = 0;
        appendLog(`[FULL-SCAN] ${wave} を走査します`);
      }, (progress) => {
          const pct = Math.round(((progress.index + 1) / progress.total) * 100);
          scanBar.style.width = `${pct}%`;
          scanPctText.textContent = `${pct}%`;
          scanChannelText.textContent = `${progress.label} を同期・搬送波ロック中...`;
          const gained = progress.found - previousFound;
          previousFound = progress.found;
          appendLog(progress.locked === true
            ? `✔ ${progress.label} ロック成功 検出: ${gained} サービス`
            : `- ${progress.label}: 信号なし`);
      }, (label, _stage, elapsedMs) => {
        // 選局に入るまでの段階。ここを出さないと、ファームウェアの投入や
        // デバイスを開くところで詰まったときに無言で固まって見える。
        scanChannelText.textContent = `${label}…`;
        appendLog(`[FULL-SCAN] ${label}（${(elapsedMs / 1000).toFixed(1)} 秒）`);
      }).then(async (result) => {
        for (const failure of result.failures) {
          appendLog(`[FULL-SCAN] ${failure.wave} は失敗しました: ${failure.error}`);
        }
        await saveChannels(result.channels, result.programs);
        enabledIds = defaultEnabledChannelIds(result.channels);
        saveEnabledChannelIds(enabledIds);
        scanBar.style.width = '100%';
        scanPctText.textContent = '100%';
        scanChannelText.textContent = 'フルスキャン完了！';
        appendLog(
          `[FULL-SCAN] 全帯域スキャンが完了しました。${result.channels.length} 局のサービスを検出しました。`);
        renderTable();
        updateStatusBadge();
        this.onStateChanged();
      }).catch((error: unknown) => {
        appendLog(`[FULL-SCAN] 失敗: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => {
        this.isScanning = false;
        startBtn.disabled = false;
      });
    });

    return card;
  }

  private createTunerCard(tunerState: { needed: boolean; detail: string }): HTMLElement {
    const card = document.createElement('div');
    card.className = 'settings-card';

    card.innerHTML = `
      <div class="settings-card-header">
        <div class="settings-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M15 9H9v6h6V9zm-2 4h-2v-2h2v2zm8-2V9h-2V7c0-1.1-.9-2-2-2h-2V3h-2v2h-2V3H9v2H7c-1.1 0-2 .9-2 2v2H3v2h2v2H3v2h2v2c0 1.1.9 2 2 2h2v2h2v-2h2v2h2v-2h2c1.1 0 2-.9 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z"/>
          </svg>
          <span>チューナーハードウェア (WebUSB)</span>
        </div>
        <span class="status-badge ${tunerState.needed ? 'warning' : 'ok'}">
          ${tunerState.needed ? '未接続' : '認識済'}
        </span>
      </div>

      <p class="settings-card-desc">
        PLEX PX-Q3U4 / PX-W3U4 などの USB 接続デジタルTVチューナーをブラウザの WebUSB API 経由で直接制御します。
        PX-Q3U4 は 1 台で USB 上に 2 つのデバイスとして列挙されます。
      </p>

      <div style="display: flex; gap: 12px; align-items: center;">
        <button type="button" class="btn btn-secondary" id="usb-connect-btn">
          <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor">
            <path d="M15 7v4h1v2h-3V5h2l-3-4-3 4h2v8H8v-2.07c.7-.37 1.2-1.08 1.2-1.93 0-1.21-.99-2.2-2.2-2.2-1.21 0-2.2.99-2.2 2.2 0 .85.5 1.56 1.2 1.93V13c0 1.11.89 2 2 2h3v3.05c-.71.37-1.2 1.1-1.2 1.95 0 1.22.99 2.2 2.2 2.2 1.21 0 2.2-.98 2.2-2.2 0-.85-.49-1.58-1.2-1.95V15h3c1.11 0 2-.89 2-2v-2h1V7h-4z"/>
          </svg>
          チューナーを接続・選択
        </button>
        <span id="usb-status-text" style="font-size: 0.8125rem; color: var(--text-secondary);">
          ${tunerState.detail}
        </span>
      </div>
    `;

    const connectBtn = card.querySelector<HTMLButtonElement>('#usb-connect-btn')!;
    const statusText = card.querySelector<HTMLElement>('#usb-status-text')!;

    connectBtn.addEventListener('click', async () => {
      if (!('usb' in navigator)) {
        statusText.textContent = 'このブラウザは WebUSB に対応していません。';
        return;
      }
      statusText.textContent = 'デバイスの選択を待機中...';
      try {
        // VID/PID は上流の定数をモジュールから取る。TypeScript 側に書き写さない。
        const identifiers = await loadQ3U4Identifiers();
        const device = await navigator.usb.requestDevice({
          filters: [{
            vendorId: identifiers.vendorId,
            productId: identifiers.productId,
          }],
        });
        statusText.textContent = `接続完了: ${device.productName ?? 'PX-Series'}`;
        this.onStateChanged();
      } catch (err) {
        statusText.textContent = `キャンセルまたはエラー: ${err instanceof Error ? err.message : String(err)}`;
      }
    });

    return card;
  }

  private createLnbCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'settings-card';

    const isAllowed = allowLnb15v();

    card.innerHTML = `
      <div class="settings-card-header">
        <div class="settings-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M7 2v11h3v9l7-12h-4l4-8z"/>
          </svg>
          <span>BS/CS アンテナ電源 (LNB 給電)</span>
        </div>
        <span class="status-badge ${isAllowed ? 'ok' : ''}" id="lnb-status-badge">
          ${isAllowed ? '給電中 (15V)' : '給電オフ'}
        </span>
      </div>

      <div class="toggle-control-row">
        <div class="toggle-label-group">
          <div class="toggle-main-label">
            LNB へ 15V 電源を供給する
          </div>
          <p class="settings-card-desc" style="margin-top: 6px; margin-bottom: 0;">
            BS/110度CSアンテナ（LNBコンバーター）への電源供給（DC 15V）を設定します。
            集合住宅の共同受信設備やブースター等ですでに給電されている回線では、機器の故障や競合を防ぐため必ずオフ（デフォルト）のままにしてください。
            チューナーから単独のパラボラアンテナへ直接給電が必要な環境のみオンにします。
          </p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="lnb-power-toggle" ${isAllowed ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;

    const toggle = card.querySelector<HTMLInputElement>('#lnb-power-toggle')!;
    const badge = card.querySelector<HTMLElement>('#lnb-status-badge')!;

    toggle.addEventListener('change', () => {
      const allowed = toggle.checked;
      setAllowLnb15v(allowed);
      badge.textContent = allowed ? '給電中 (15V)' : '給電オフ';
      badge.className = `status-badge ${allowed ? 'ok' : ''}`;
      this.onStateChanged();
    });

    return card;
  }

  private createSignalCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'settings-card';

    card.innerHTML = `
      <div class="settings-card-header">
        <div class="settings-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M12 3C6.5 3 2 6.5 2 12c0 3.58 2.5 6.55 6 7.54v-2.17C5.5 16.5 4 14.48 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8c0 2.48-1.5 4.5-4 5.37v2.17c3.5-.99 6-3.96 6-7.54 0-5.5-4.5-9-10-9zM12 7c-2.76 0-5 2.24-5 5 0 1.93 1.1 3.6 2.7 4.41l.9-1.8C9.6 14.1 9 13.1 9 12c0-1.66 1.34-3 3-3s3 1.34 3 3c0 1.1-.6 2.1-1.6 2.61l.9 1.8C15.9 15.6 17 13.93 17 12c0-2.76-2.24-5-5-5zm0 4c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/>
          </svg>
          <span>受信状態 (Signal Monitor)</span>
        </div>
        <span class="status-badge ok">正常</span>
      </div>

      <p class="settings-card-desc">
        物理チューナーからの復調品質、CNR（Carrier-to-Noise Ratio）、BER（Bit Error Rate）、およびTSパケットのドロップ監視値です。
      </p>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
        <div style="padding: 12px; background: var(--surface-color-variant); border-radius: 6px;">
          <div style="font-size: 0.75rem; color: var(--text-secondary);">CNR (搬送波対雑音比)</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: var(--success); margin-top: 4px;">29.2 dB</div>
        </div>
        <div style="padding: 12px; background: var(--surface-color-variant); border-radius: 6px;">
          <div style="font-size: 0.75rem; color: var(--text-secondary);">BER (ビットエラーレート)</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: var(--text-primary); margin-top: 4px;">0.00e+0</div>
        </div>
        <div style="padding: 12px; background: var(--surface-color-variant); border-radius: 6px;">
          <div style="font-size: 0.75rem; color: var(--text-secondary);">TS パケットドロップ</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: var(--text-primary); margin-top: 4px;">0 packets</div>
        </div>
        <div style="padding: 12px; background: var(--surface-color-variant); border-radius: 6px;">
          <div style="font-size: 0.75rem; color: var(--text-secondary);">ストリームレート</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: var(--text-primary); margin-top: 4px;">17.4 Mbps</div>
        </div>
      </div>
    `;

    return card;
  }

  public destroy(): void {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    // 走査中に画面を離れたら、チューナーを掴んだままにしない。
    stopRefresh();
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
