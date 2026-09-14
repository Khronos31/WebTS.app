/**
 * WebTS.app M0 - UI Controller
 * License: GPL-2.0-only
 */

import { WebUSBAdapter } from '../usb/adapter';
import type { AdapterState, DiagnosticEntry, SanitizedDeviceSummary } from '../types/usb';
import {
  createDeviceSummaryElement,
  createDiagnosticsElement,
  createUnsupportedNoticeElement,
  createWindowsNoticeElement,
  getStateLabelAndClass,
} from './components';
import { appendDiagnosticEntry, MAX_DIAGNOSTIC_ENTRIES } from '../usb/diagnostics';

export class UIController {
  private readonly adapter: WebUSBAdapter;
  private readonly container: HTMLElement;

  private stateBadge: HTMLElement | null = null;
  private btnRequest: HTMLButtonElement | null = null;
  private btnOpen: HTMLButtonElement | null = null;
  private btnClose: HTMLButtonElement | null = null;
  private btnReset: HTMLButtonElement | null = null;

  private noticeArea: HTMLElement | null = null;
  private summaryArea: HTMLElement | null = null;
  private diagnosticsArea: HTMLElement | null = null;

  private currentLogs: DiagnosticEntry[] = [];
  private isBusy = false;

  constructor(container: HTMLElement, adapter: WebUSBAdapter = new WebUSBAdapter()) {
    this.container = container;
    this.adapter = adapter;
  }

  public init(): void {
    this.buildInitialLayout();
    this.bindAdapterEvents();
  }

  private buildInitialLayout(): void {
    this.container.innerHTML = '';

    // Header
    const header = document.createElement('header');
    header.className = 'app-header';

    const headerTop = document.createElement('div');
    headerTop.className = 'header-top';

    const titleGroup = document.createElement('div');
    const title = document.createElement('h1');
    title.className = 'app-title';
    title.textContent = 'WebTS.app M0 技術検証プローブ';
    const subtitle = document.createElement('p');
    subtitle.className = 'app-subtitle';
    subtitle.textContent = 'ISDBチューナー (PX-Q3U4 / PX-S1UD) WebUSB 接続適合性診断';
    titleGroup.appendChild(title);
    titleGroup.appendChild(subtitle);
    headerTop.appendChild(titleGroup);

    this.stateBadge = document.createElement('span');
    this.stateBadge.className = 'status-badge idle';
    this.stateBadge.textContent = '待機中';
    this.stateBadge.setAttribute('aria-live', 'polite');
    headerTop.appendChild(this.stateBadge);

    header.appendChild(headerTop);
    this.container.appendChild(header);

    // Notice Area (Windows warning & unsupported alert)
    this.noticeArea = document.createElement('div');
    this.noticeArea.className = 'notice-area';
    this.noticeArea.appendChild(createWindowsNoticeElement());
    this.container.appendChild(this.noticeArea);

    // Controls Card
    const controlsCard = document.createElement('section');
    controlsCard.className = 'card';
    controlsCard.setAttribute('aria-labelledby', 'controls-title');

    const controlsTitle = document.createElement('h2');
    controlsTitle.id = 'controls-title';
    controlsTitle.className = 'card-title';
    controlsTitle.innerHTML = '<span>⚙️</span> USB操作コントロール (明示的操作のみ)';
    controlsCard.appendChild(controlsTitle);

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'button-group';

    this.btnRequest = document.createElement('button');
    this.btnRequest.type = 'button';
    this.btnRequest.className = 'btn btn-primary';
    this.btnRequest.textContent = '① デバイスを選択 (requestDevice)';
    this.btnRequest.addEventListener('click', () => this.handleRequestDevice());
    buttonGroup.appendChild(this.btnRequest);

    this.btnOpen = document.createElement('button');
    this.btnOpen.type = 'button';
    this.btnOpen.className = 'btn btn-success';
    this.btnOpen.textContent = '② デバイスを開く (open)';
    this.btnOpen.disabled = true;
    this.btnOpen.addEventListener('click', () => this.handleOpenDevice());
    buttonGroup.appendChild(this.btnOpen);

    this.btnClose = document.createElement('button');
    this.btnClose.type = 'button';
    this.btnClose.className = 'btn btn-danger';
    this.btnClose.textContent = '③ 解放してクローズ (release & close)';
    this.btnClose.disabled = true;
    this.btnClose.addEventListener('click', () => this.handleReleaseAndClose());
    buttonGroup.appendChild(this.btnClose);

    this.btnReset = document.createElement('button');
    this.btnReset.type = 'button';
    this.btnReset.className = 'btn btn-secondary';
    this.btnReset.textContent = 'リセット';
    this.btnReset.addEventListener('click', () => this.handleReset());
    buttonGroup.appendChild(this.btnReset);

    controlsCard.appendChild(buttonGroup);
    this.container.appendChild(controlsCard);

    // Summary Area
    this.summaryArea = document.createElement('div');
    this.summaryArea.className = 'summary-area';
    this.container.appendChild(this.summaryArea);

    // Diagnostics Area
    this.diagnosticsArea = document.createElement('div');
    this.diagnosticsArea.className = 'diagnostics-area';
    this.container.appendChild(this.diagnosticsArea);

    // Footer
    const footer = document.createElement('footer');
    footer.className = 'app-footer';
    footer.innerHTML = `
      <p>WebTS.app M0 Diagnostic Probe &bull; License: GPL-2.0-only &bull; Framework-Free Static App</p>
      <p style="margin-top: 0.25rem;">外部ネットワーク送信、分析ログ、Cookie、ローカルストレージは一切使用しません。</p>
    `;
    this.container.appendChild(footer);
  }

  private bindAdapterEvents(): void {
    this.adapter.onStateChange((state) => this.handleStateChanged(state));
    this.adapter.onDeviceChange((summary) => this.renderSummary(summary));
    this.adapter.onBusyChange((busy) => this.handleBusyChanged(busy));
    this.adapter.onDiagnostic((entry) => {
      appendDiagnosticEntry(this.currentLogs, entry, MAX_DIAGNOSTIC_ENTRIES);
      this.renderDiagnostics();
    });

    // Initial sync
    this.handleStateChanged(this.adapter.getState());
    this.renderSummary(this.adapter.getSanitizedDeviceSummary());
    this.currentLogs = [...this.adapter.getDiagnostics()];
    this.renderDiagnostics();
  }

  private handleBusyChanged(busy: boolean): void {
    this.isBusy = busy;
    this.updateButtonStates();
    this.renderSummary(this.adapter.getSanitizedDeviceSummary());
  }

  private handleStateChanged(state: AdapterState): void {
    if (!this.stateBadge) return;

    const { label, className } = getStateLabelAndClass(state);
    this.stateBadge.textContent = label;
    this.stateBadge.className = `status-badge ${className}`;

    // Update notice area for unsupported environment
    if (state === 'UNSUPPORTED') {
      if (this.noticeArea && !this.noticeArea.querySelector('[role="alert"]')) {
        this.noticeArea.appendChild(createUnsupportedNoticeElement());
      }
    }

    this.updateButtonStates();
  }

  private updateButtonStates(): void {
    if (!this.btnRequest || !this.btnOpen || !this.btnClose || !this.btnReset) return;

    if (this.isBusy) {
      this.btnRequest.disabled = true;
      this.btnOpen.disabled = true;
      this.btnClose.disabled = true;
      this.btnReset.disabled = true;
      return;
    }

    this.btnReset.disabled = false;
    const state = this.adapter.getState();

    if (state === 'UNSUPPORTED') {
      this.btnRequest.disabled = true;
      this.btnOpen.disabled = true;
      this.btnClose.disabled = true;
      return;
    }

    switch (state) {
      case 'IDLE':
      case 'CLOSED':
      case 'DISCONNECTED':
        // Ready to select a new device
        this.btnRequest.disabled = false;
        this.btnOpen.disabled = true;
        this.btnClose.disabled = true;
        break;

      case 'DEVICE_SELECTED':
        // Device selected: require explicit close or open before requesting again
        this.btnRequest.disabled = true;
        this.btnOpen.disabled = false;
        this.btnClose.disabled = false;
        break;

      case 'OPENED_NO_CONFIG':
        // Open without config: require config select or close
        this.btnRequest.disabled = true;
        this.btnOpen.disabled = true;
        this.btnClose.disabled = false;
        break;

      case 'OPENED':
        // Device opened: require close before requesting another device
        this.btnRequest.disabled = true;
        this.btnOpen.disabled = true;
        this.btnClose.disabled = false;
        break;
    }
  }

  private renderSummary(summary: SanitizedDeviceSummary | null): void {
    if (!this.summaryArea) return;
    this.summaryArea.innerHTML = '';

    if (!summary) return;

    const summaryEl = createDeviceSummaryElement(
      summary,
      this.adapter.getClaimedInterfaces(),
      {
        onClaimInterface: (iface) => this.handleClaimInterface(iface),
        onReleaseInterface: (iface) => this.handleReleaseInterface(iface),
        onSelectConfig: (cfg) => this.handleSelectConfiguration(cfg),
      },
      this.isBusy,
    );
    this.summaryArea.appendChild(summaryEl);
  }

  private renderDiagnostics(): void {
    if (!this.diagnosticsArea) return;
    this.diagnosticsArea.innerHTML = '';

    const diagEl = createDiagnosticsElement(this.currentLogs, () => {
      this.currentLogs = [];
      this.renderDiagnostics();
    });
    this.diagnosticsArea.appendChild(diagEl);
  }

  private async handleRequestDevice(): Promise<void> {
    await this.adapter.requestDevice();
  }

  private async handleOpenDevice(): Promise<void> {
    await this.adapter.openDevice();
  }

  private async handleReleaseAndClose(): Promise<void> {
    await this.adapter.releaseAndClose();
  }

  private async handleReset(): Promise<void> {
    await this.adapter.reset();
  }

  private async handleSelectConfiguration(cfg: number): Promise<void> {
    await this.adapter.selectConfiguration(cfg);
  }

  private async handleClaimInterface(iface: number): Promise<void> {
    await this.adapter.claimInterface(iface);
  }

  private async handleReleaseInterface(iface: number): Promise<void> {
    await this.adapter.releaseInterface(iface);
  }
}
