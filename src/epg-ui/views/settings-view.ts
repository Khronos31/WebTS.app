// EPGStationスタイルの「設定 (Settings)」ビュー

import {
  defaultEnabledChannelIds,
  getEnabledChannelIds,
  saveEnabledChannelIds,
} from '../enabled-channels';
import { readSetupState } from '../../ui/setup-state';
import {
  getScanState,
  startFullScan,
  stopScan,
  subscribeScan,
  type ScanState,
} from '../scan-manager';
import { bsTunings, csTunings, grTunings, satelliteScanTunings } from '../tuning';
import type { ChannelItem } from '../types';
import { channelsSync } from '../channel-source';
import {
  forgetTuner,
  listConnectedTuners,
  loadPx4Models,
  readTunerPermission,
  selectTuner,
  subscribeTuners,
  tunersChanged,
  usbFilters,
  type ConnectedTuner,
} from '../../usb/px4-identity';
import { getTheme, setTheme, type ThemeMode } from '../theme-manager';
import { allowLnb15v, setAllowLnb15v } from '../lnb-setting';
import { getZipcode, normalizeZipcode, setZipcode } from '../bml-receiver-info';
import {
  REPORTS_BUILT,
  lastSentReport,
  reportsEnabled,
  setReportsEnabled,
} from '../../reports/beta-reports';

export interface SettingsViewOptions {
  onStateChanged: () => void;
}

export class SettingsView {
  public readonly element: HTMLElement;
  private onStateChanged: () => void;
  private unsubscribeScan: (() => void) | null = null;
  private unsubscribeTuners: (() => void) | null = null;
  private scanTimer: number | null = null;

  constructor(options: SettingsViewOptions) {
    this.onStateChanged = options.onStateChanged;
    this.element = document.createElement('div');
    this.element.className = 'settings-container';

    void this.render();
  }

  private async render(): Promise<void> {
    if (this.unsubscribeTuners) {
      this.unsubscribeTuners();
      this.unsubscribeTuners = null;
    }
    this.element.replaceChildren();

    const state = await readSetupState();

    // 1. テーマ・外観設定 カード
    this.element.append(this.createThemeCard());

    // 2. データ放送 地域・郵便番号設定（任意） カード
    this.element.append(this.createZipcodeCard());

    // 3. 地域設定・チャンネルスキャン カード
    this.element.append(this.createScanCard());

    // 4. チューナー接続 カード
    this.element.append(this.createTunerCard(state.tuner));

    // 5. BS/CS アンテナ電源 (LNB) カード
    this.element.append(this.createLnbCard());

    // 6. 受信状態 (Signal Monitor) カード
    this.element.append(this.createSignalCard());

    // 7. 動作報告（beta版） カード
    if (REPORTS_BUILT) {
      this.element.append(this.createBetaReportsCard());
    }
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

  private createZipcodeCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'settings-card';

    const formatCode = (code: string): string => {
      return code.length === 7 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
    };

    const currentZip = getZipcode();

    card.innerHTML = `
      <div class="settings-card-header">
        <div class="settings-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
          <span>データ放送 地域・郵便番号設定</span>
        </div>
        <span class="status-badge ${currentZip ? 'ok' : ''}" id="zipcode-status-badge">
          ${currentZip ? `設定済み (〒${formatCode(currentZip)})` : '任意（未設定）'}
        </span>
      </div>

      <p class="settings-card-desc">
        BMLデータ放送で地域情報（天気予報、ニュース、自治体からのお知らせ等）の初期表示に使用される受信機設定です。<br>
        <strong>設定は任意です。</strong>未設定でもデータ放送の視聴や操作に支障はありません（未設定の場合、一部の局で郵便番号設定の案内が表示されることがあります）。<br>
        入力された郵便番号はお使いのブラウザ（端末内の localStorage）にのみ保存され、外部サーバーへ送信されることは一切ありません。
      </p>

      <div class="form-group" style="margin-bottom: 8px;">
        <label class="form-label" for="bml-zipcode-input">郵便番号（7桁）:</label>
        <div style="display: flex; gap: 8px; max-width: 480px; align-items: center; flex-wrap: wrap;">
          <input
            type="text"
            id="bml-zipcode-input"
            class="form-input"
            style="max-width: 180px;"
            placeholder="1000001"
            value="${currentZip ?? ''}"
            maxlength="10"
            inputmode="numeric"
            autocomplete="postal-code"
          />
          <button type="button" class="btn btn-primary" id="bml-zipcode-save-btn">保存</button>
          <button type="button" class="btn btn-secondary" id="bml-zipcode-clear-btn" ${currentZip ? '' : 'style="display: none;"'}>解除</button>
        </div>
        <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 6px;">
          空欄で保存すると未設定に戻ります。
        </div>
      </div>

      <div id="bml-zipcode-status" style="margin-top: 8px; font-size: 0.8125rem; min-height: 1.25rem;"></div>
    `;

    const input = card.querySelector<HTMLInputElement>('#bml-zipcode-input')!;
    const saveBtn = card.querySelector<HTMLButtonElement>('#bml-zipcode-save-btn')!;
    const clearBtn = card.querySelector<HTMLButtonElement>('#bml-zipcode-clear-btn')!;
    const badge = card.querySelector<HTMLElement>('#zipcode-status-badge')!;
    const statusBox = card.querySelector<HTMLElement>('#bml-zipcode-status')!;

    const updateUI = () => {
      const zip = getZipcode();
      if (zip) {
        badge.className = 'status-badge ok';
        badge.textContent = `設定済み (〒${formatCode(zip)})`;
        input.value = zip;
        clearBtn.style.display = '';
      } else {
        badge.className = 'status-badge';
        badge.textContent = '任意（未設定）';
        input.value = '';
        clearBtn.style.display = 'none';
      }
    };

    const handleSave = () => {
      const val = input.value.trim();
      if (!val) {
        setZipcode(null);
        updateUI();
        statusBox.innerHTML = '<span style="color: var(--text-secondary);">郵便番号の設定を解除しました。</span>';
        return;
      }

      const normalized = normalizeZipcode(val);
      if (!normalized) {
        statusBox.innerHTML = '<span style="color: var(--error);">7桁の郵便番号を入力してください（例: 1000001）。</span>';
        input.focus();
        return;
      }

      const ok = setZipcode(normalized);
      if (ok) {
        updateUI();
        statusBox.innerHTML = `<span style="color: var(--success); font-weight: 600;">✔ 郵便番号を保存しました (〒${formatCode(normalized)})</span>`;
      } else {
        statusBox.innerHTML = '<span style="color: var(--error);">保存に失敗しました。</span>';
      }
    };

    const handleClear = () => {
      setZipcode(null);
      updateUI();
      statusBox.innerHTML = '<span style="color: var(--text-secondary);">郵便番号の設定を解除しました。</span>';
    };

    saveBtn.addEventListener('click', handleSave);
    clearBtn.addEventListener('click', handleClear);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
    });

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

    const totalGR = grTunings().length;
    const totalSat = satelliteScanTunings(bsTunings()).length + satelliteScanTunings(csTunings()).length;
    const totalTunings = totalGR + totalSat;

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
        放送局を自動検出します。取得した局一覧から見ない局のチェックを外して放映中リストから除外できます。
      </p>

      <div style="margin-bottom: 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <button type="button" class="btn btn-primary" id="start-scan-btn">
          <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor">
            <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
          </svg>
          スキャン開始
        </button>
        <button type="button" class="btn btn-secondary" id="stop-scan-btn" style="display: none;">
          スキャン中止
        </button>
      </div>

      <div class="scan-progress-box" id="scan-box" style="display: none; margin-bottom: 20px;">
        <div class="scan-overall-header">
          <div class="scan-overall-title">
            <span id="scan-overall-status">スキャン待機中...</span>
            <span class="scan-overall-count" id="scan-overall-count">0 / ${totalTunings}</span>
          </div>
          <span class="scan-overall-pct" id="scan-progress-pct">0%</span>
        </div>
        <div class="progress-track" style="margin-bottom: 12px;">
          <div class="progress-fill" id="scan-progress-bar" style="width: 0%;"></div>
        </div>

        <div class="scan-dual-grid">
          <!-- 地上波レーン -->
          <div class="scan-lane-card gr" id="scan-lane-gr">
            <div class="scan-lane-header">
              <span class="scan-lane-badge GR">GR 地上波</span>
              <span class="scan-lane-found" id="scan-gr-found">検出: 0 局</span>
            </div>
            <div class="scan-lane-progress">
              <div class="scan-lane-mini-track">
                <div class="scan-lane-mini-fill gr" id="scan-gr-bar" style="width: 0%;"></div>
              </div>
              <div class="scan-lane-mini-text" id="scan-gr-count">0 / ${totalGR}</div>
            </div>
          </div>

          <!-- 衛星レーン (BS/CS) -->
          <div class="scan-lane-card sat" id="scan-lane-sat">
            <div class="scan-lane-header">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="scan-lane-badge sat" id="scan-sat-badge">BS/CS 衛星</span>
                <span class="scan-wave-pill BS" id="scan-sat-wave-pill" style="display: none;">BS</span>
              </div>
              <span class="scan-lane-found" id="scan-sat-found">検出: 0 局</span>
            </div>
            <div class="scan-lane-progress">
              <div class="scan-lane-mini-track">
                <div class="scan-lane-mini-fill sat" id="scan-sat-bar" style="width: 0%;"></div>
              </div>
              <div class="scan-lane-mini-text" id="scan-sat-count">0 / ${totalSat}</div>
            </div>
          </div>
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
    const stopBtn = card.querySelector<HTMLButtonElement>('#stop-scan-btn')!;
    const scanBox = card.querySelector<HTMLElement>('#scan-box')!;
    const scanOverallStatus = card.querySelector<HTMLElement>('#scan-overall-status')!;
    const scanOverallCount = card.querySelector<HTMLElement>('#scan-overall-count')!;
    const scanPctText = card.querySelector<HTMLElement>('#scan-progress-pct')!;
    const scanBar = card.querySelector<HTMLElement>('#scan-progress-bar')!;

    const scanGrFound = card.querySelector<HTMLElement>('#scan-gr-found')!;
    const scanGrBar = card.querySelector<HTMLElement>('#scan-gr-bar')!;
    const scanGrCount = card.querySelector<HTMLElement>('#scan-gr-count')!;

    const scanSatBadge = card.querySelector<HTMLElement>('#scan-sat-badge')!;
    const scanSatWavePill = card.querySelector<HTMLElement>('#scan-sat-wave-pill')!;
    const scanSatFound = card.querySelector<HTMLElement>('#scan-sat-found')!;
    const scanSatBar = card.querySelector<HTMLElement>('#scan-sat-bar')!;
    const scanSatCount = card.querySelector<HTMLElement>('#scan-sat-count')!;

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

    const syncScanUI = (scanState: Readonly<ScanState>, newLog?: string) => {
      if (scanState.isScanning) {
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = false;
        stopBtn.textContent = 'スキャン中止';
        scanBox.style.display = 'block';
      } else {
        startBtn.style.display = 'inline-flex';
        startBtn.disabled = false;
        stopBtn.style.display = 'none';
        if (scanState.completed || scanState.logs.length > 0 || scanState.error) {
          scanBox.style.display = 'block';
        } else {
          scanBox.style.display = 'none';
        }
      }

      scanBar.style.width = `${scanState.percent}%`;
      scanPctText.textContent = `${scanState.percent}%`;
      scanOverallCount.textContent = scanState.overallCountText;
      scanOverallStatus.textContent = scanState.status;

      scanGrBar.style.width = scanState.gr.barWidth;
      scanGrCount.textContent = scanState.gr.countText;
      scanGrFound.textContent = scanState.gr.foundText;

      if (scanState.sat.wavePill !== 'none') {
        scanSatWavePill.textContent = scanState.sat.wavePill;
        scanSatWavePill.className = `scan-wave-pill ${scanState.sat.wavePill}`;
        scanSatWavePill.style.display = 'inline-flex';
      } else {
        scanSatWavePill.style.display = 'none';
      }
      scanSatBar.style.width = scanState.sat.barWidth;
      scanSatCount.textContent = scanState.sat.countText;
      scanSatFound.textContent = scanState.sat.foundText;

      if (newLog) {
        appendLog(newLog);
      } else {
        scanLog.innerHTML = '';
        for (const log of scanState.logs) {
          appendLog(log);
        }
      }
    };

    // 初期状態の復元
    syncScanUI(getScanState());

    // スキャンマネージャーからの通知購読
    this.unsubscribeScan = subscribeScan((scanState, newLog) => {
      syncScanUI(scanState, newLog);
      if (scanState.completed) {
        enabledIds = getEnabledChannelIds();
        renderTable();
        updateStatusBadge();
        this.onStateChanged();
      }
    });

    // フルスキャン開始
    startBtn.addEventListener('click', () => {
      void startFullScan();
    });

    // スキャン中止
    stopBtn.addEventListener('click', () => {
      stopBtn.disabled = true;
      stopBtn.textContent = '中止中...';
      stopScan();
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
        <span class="status-badge ${tunerState.needed ? 'warning' : 'ok'}" id="tuner-header-badge">
          ${tunerState.needed ? '未接続' : '認識済'}
        </span>
      </div>

      <p class="settings-card-desc">
        対応する USB 接続デジタルTVチューナー（PX-Q3U4 / PX-W3U4 / PX-MLT5PE / DTV02A-5TS-P など）をブラウザの WebUSB API 経由で直接制御します。
        複数のチューナーが接続・許可されている場合は使用する1台を選択できます（選択は次回受信開始時から反映されます。PX-Q3U4 など一部機種は1台につき複数の USB 機器の許可が必要です）。
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

      <div style="border-top: 1px solid var(--divider); padding-top: 16px; margin-top: 16px;">
        <div style="font-weight: 600; font-size: 0.875rem; margin-bottom: 8px;">
          接続済みのチューナー
        </div>
        <div id="connected-tuners-container"></div>
        <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 8px;">
          ※ 視聴や走査で使用するチューナーは1台のみです。選択内容は端末内に保存されます。
        </div>
      </div>
    `;

    const connectBtn = card.querySelector<HTMLButtonElement>('#usb-connect-btn')!;
    const statusText = card.querySelector<HTMLElement>('#usb-status-text')!;
    const headerBadge = card.querySelector<HTMLElement>('#tuner-header-badge')!;
    const tunersContainer = card.querySelector<HTMLElement>('#connected-tuners-container')!;

    let renderSeq = 0;
    const renderTunerList = async () => {
      const currentSeq = ++renderSeq;
      let tuners: ConnectedTuner[];
      try {
        tuners = await listConnectedTuners();
      } catch {
        tuners = [];
      }
      if (currentSeq !== renderSeq) return;

      try {
        const permission = await readTunerPermission();
        headerBadge.className = `status-badge ${permission.ready ? 'ok' : 'warning'}`;
        headerBadge.textContent = permission.ready ? '認識済' : '未接続';
      } catch {
        // ignore
      }

      if (tuners.length === 0) {
        tunersContainer.innerHTML = `
          <div class="tuner-empty-notice">
            接続されているチューナーはありません。「チューナーを接続・選択」から機器を許可してください。
          </div>
        `;
        return;
      }

      const tableContainer = document.createElement('div');
      tableContainer.className = 'tuner-table-container';

      const table = document.createElement('table');
      table.className = 'tuner-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th style="width: 44px; text-align: center;">選択</th>
            <th>チューナー名</th>
            <th>状態</th>
            <th style="width: 120px; text-align: right;">操作</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;

      const tbody = table.querySelector('tbody')!;

      for (const tuner of tuners) {
        const tr = document.createElement('tr');

        // 1. 選択（ラジオボタン）
        const tdRadio = document.createElement('td');
        tdRadio.style.textAlign = 'center';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'selected-tuner';
        radio.checked = tuner.selected;
        radio.disabled = !tuner.ready;
        radio.style.cursor = tuner.ready ? 'pointer' : 'not-allowed';
        radio.setAttribute('aria-label', `${tuner.label} を選択`);
        radio.addEventListener('change', () => {
          if (radio.checked) {
            selectTuner(tuner);
          }
        });
        tdRadio.append(radio);

        // 2. チューナー名（ラベル + 未確認バッジ）
        const tdName = document.createElement('td');
        const nameSpan = document.createElement('span');
        nameSpan.textContent = tuner.label;
        nameSpan.style.fontWeight = tuner.selected ? '600' : '400';
        if (tuner.ready) {
          nameSpan.style.cursor = 'pointer';
          nameSpan.addEventListener('click', () => {
            if (!radio.checked) {
              radio.checked = true;
              selectTuner(tuner);
            }
          });
        }
        tdName.append(nameSpan);

        if (!tuner.model.verified) {
          const unverifiedBadge = document.createElement('span');
          unverifiedBadge.className = 'status-badge warning';
          unverifiedBadge.style.fontSize = '0.6875rem';
          unverifiedBadge.style.marginLeft = '8px';
          unverifiedBadge.textContent = '未確認（報告募集）';
          tdName.append(unverifiedBadge);
        }

        // 3. 状態
        const tdStatus = document.createElement('td');
        const statusBadge = document.createElement('span');
        if (tuner.ready) {
          statusBadge.className = 'status-badge ok';
          statusBadge.textContent = '使える';
        } else if (tuner.granted < tuner.required) {
          statusBadge.className = 'status-badge warning';
          statusBadge.textContent = `あと ${tuner.required - tuner.granted} つ許可が要る`;
        } else {
          statusBadge.className = 'status-badge error';
          statusBadge.textContent = 'この機器を読めません';
        }
        tdStatus.append(statusBadge);

        // 4. 操作（許可を取り消すボタン）
        const tdAction = document.createElement('td');
        tdAction.style.textAlign = 'right';

        const forgetBtn = document.createElement('button');
        forgetBtn.type = 'button';
        forgetBtn.className = 'btn-small';
        forgetBtn.style.color = 'var(--error, #c62828)';
        forgetBtn.textContent = '許可を取り消す';
        forgetBtn.addEventListener('click', async () => {
          const confirmed = window.confirm(
            `${tuner.label} の許可を取り消しますか？\n他の録画ソフトやブラウザ外で利用できるようになります。`
          );
          if (!confirmed) return;
          try {
            forgetBtn.disabled = true;
            await forgetTuner(tuner);
            statusText.textContent = `${tuner.label} の許可を取り消しました`;
            this.onStateChanged();
          } catch (err) {
            alert(`許可の取り消しに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
            forgetBtn.disabled = false;
          }
        });
        tdAction.append(forgetBtn);

        tr.append(tdRadio, tdName, tdStatus, tdAction);
        tbody.append(tr);
      }

      tableContainer.append(table);
      tunersContainer.replaceChildren(tableContainer);
    };

    void renderTunerList();

    this.unsubscribeTuners = subscribeTuners(() => {
      void renderTunerList();
      this.onStateChanged();
    });

    connectBtn.addEventListener('click', async () => {
      if (!('usb' in navigator)) {
        statusText.textContent = 'このブラウザは WebUSB に対応していません。';
        return;
      }
      statusText.textContent = 'デバイスの選択を待機中...';
      try {
        // 候補は上流が知っている全機種。VID/PID と機種の表はモジュールから
        // 取り、TypeScript 側に書き写さない。
        const device = await navigator.usb.requestDevice({
          filters: usbFilters(await loadPx4Models()),
        });
        statusText.textContent = `接続完了: ${device.productName ?? 'PX-Series'}`;
        this.onStateChanged();
        // 接続済みのチューナーの一覧へ知らせる（許可は connect イベントを出さない）。
        tunersChanged();
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

  /**
   * 受信状態のカード。
   *
   * **値は出せない。**CNR と BER は復調器のレジスタから読むもので、上流の
   * API を通していない。TS ドロップとレートは受信中でなければ数えようが
   * ない。ここは雛形として 29.2 dB などの数字が直接書かれており、
   * チューナーが未接続でも表示されていた。**計測値を名乗って作り話を出す**
   * ことになるので「—」にした。視聴画面の同じ枠（watch-view）も同じ扱い。
   */
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
        <span class="status-badge">未計測</span>
      </div>

      <p class="settings-card-desc">
        物理チューナーからの復調品質、CNR（Carrier-to-Noise Ratio）、BER（Bit Error Rate）、およびTSパケットのドロップ監視値です。
        CNR と BER は復調器のレジスタから読む値で、いまの実装では取得していません。TS ドロップは視聴画面に実測が出ます。
      </p>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
        <div style="padding: 12px; background: var(--surface-color-variant); border-radius: 6px;">
          <div style="font-size: 0.75rem; color: var(--text-secondary);">CNR (搬送波対雑音比)</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: var(--text-secondary); margin-top: 4px;">—</div>
        </div>
        <div style="padding: 12px; background: var(--surface-color-variant); border-radius: 6px;">
          <div style="font-size: 0.75rem; color: var(--text-secondary);">BER (ビットエラーレート)</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: var(--text-secondary); margin-top: 4px;">—</div>
        </div>
        <div style="padding: 12px; background: var(--surface-color-variant); border-radius: 6px;">
          <div style="font-size: 0.75rem; color: var(--text-secondary);">TS パケットドロップ</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: var(--text-secondary); margin-top: 4px;">—</div>
        </div>
        <div style="padding: 12px; background: var(--surface-color-variant); border-radius: 6px;">
          <div style="font-size: 0.75rem; color: var(--text-secondary);">ストリームレート</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: var(--text-secondary); margin-top: 4px;">—</div>
        </div>
      </div>
    `;

    return card;
  }

  private createBetaReportsCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'settings-card';
    card.id = 'reports-setting-card';

    const enabled = reportsEnabled();

    card.innerHTML = `
      <div class="settings-card-header">
        <div class="settings-card-title">
          <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
            <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
          </svg>
          <span>動作報告（beta版）</span>
        </div>
        <span class="status-badge ${enabled ? 'ok' : ''}" id="beta-reports-status-badge">
          ${enabled ? '許可' : '停止'}
        </span>
      </div>

      <p class="settings-card-desc">
        beta 版（beta.webts.app）限定で、「その機種で動いたか」を確認するために最小限の動作ログを配布サーバへ送信します。
        本機能は既定で有効ですが、オプトアウト（停止）できます。
      </p>

      <div style="margin-bottom: 16px;">
        <label class="checkbox-label" style="font-size: 0.9375rem; font-weight: 600; cursor: pointer;">
          <input type="checkbox" id="beta-reports-toggle" ${enabled ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer;" />
          <span>動作報告の送信を許可する（既定で有効）</span>
        </label>
      </div>

      <div style="font-size: 0.875rem; line-height: 1.6; margin-bottom: 16px;">
        <div style="font-weight: 600; margin-bottom: 4px;">送信される情報:</div>
        <ul style="margin: 0 0 12px 20px; padding: 0; color: var(--text-secondary); font-size: 0.8125rem;">
          <li>アプリのバージョン、チューナーの機種名（例: PX-Q3U4）</li>
          <li>OSの種類（Windows / macOS / Linux / Android / ChromeOS）、ブラウザの種類とメジャーバージョン（例: Chrome 140）</li>
          <li>視聴か走査か、受信波（地上波・BS・CS）</li>
          <li>動作結果（映った・ロックした／信号なし／停止した段階とエラー番号）</li>
        </ul>
        <div style="font-weight: 600; margin-bottom: 4px;">送信されない情報:</div>
        <ul style="margin: 0 0 12px 20px; padding: 0; color: var(--text-secondary); font-size: 0.8125rem;">
          <li>シリアル番号、USB識別子、B-CASカード情報</li>
          <li>視聴した局や番組、地域設定・郵便番号、端末固有の識別ID</li>
          <li>詳細な時刻（サーバ側の保存は日付単位のみ）。受け側はIPアドレスも保存しません</li>
        </ul>
        <div style="font-size: 0.75rem; color: var(--text-secondary);">
          ※ 同じ内容の報告は1回しか送信されません。本番（webts.app）のビルドには送信処理自体が入りません。
        </div>
      </div>

      <div style="border-top: 1px solid var(--divider); padding-top: 12px; margin-top: 12px;">
        <div style="font-weight: 600; font-size: 0.875rem; margin-bottom: 6px;">最後に送信された報告:</div>
        <div id="beta-reports-last-container"></div>
      </div>
    `;

    const toggle = card.querySelector<HTMLInputElement>('#beta-reports-toggle')!;
    const badge = card.querySelector<HTMLElement>('#beta-reports-status-badge')!;
    const lastContainer = card.querySelector<HTMLElement>('#beta-reports-last-container')!;

    const renderLastReport = () => {
      const last = lastSentReport();
      if (last !== null) {
        lastContainer.innerHTML = `<pre style="background: var(--code-bg); padding: 10px; border-radius: 4px; font-size: 0.75rem; overflow-x: auto; margin: 0; font-family: monospace;">${escapeHtml(JSON.stringify(last, null, 2))}</pre>`;
      } else {
        lastContainer.innerHTML = '<div style="font-size: 0.8125rem; color: var(--text-secondary);">まだ送信されていません。</div>';
      }
    };
    renderLastReport();

    toggle.addEventListener('change', () => {
      setReportsEnabled(toggle.checked);
      const isEnabled = reportsEnabled();
      badge.className = `status-badge ${isEnabled ? 'ok' : ''}`;
      badge.textContent = isEnabled ? '許可' : '停止';
    });

    return card;
  }

  public destroy(): void {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.unsubscribeScan) {
      this.unsubscribeScan();
      this.unsubscribeScan = null;
    }
    if (this.unsubscribeTuners) {
      this.unsubscribeTuners();
      this.unsubscribeTuners = null;
    }
  }
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
