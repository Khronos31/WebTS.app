/**
 * WebTS.app - Testable WebUSB Adapter and Session State Machine
 * License: GPL-2.0-only
 */

import type {
  AdapterState,
  DiagnosticCode,
  DiagnosticEntry,
  DiagnosticLevel,
  SanitizedDeviceSummary,
  USBConnectionEventLike,
  USBDeviceFilter,
  USBDeviceLike,
} from '../types/usb';
import { SUPPORTED_DEVICE_FILTERS, getDeviceModelInfo } from './filters';
import { evaluateInterfaceClaimability } from './claim-policy';
import { sanitizeDeviceSummary } from './sanitizers';
import {
  categorizeError,
  createDiagnosticEntry,
  appendDiagnosticEntry,
  MAX_DIAGNOSTIC_ENTRIES,
} from './diagnostics';

export interface USBFacade {
  isSupported(): boolean;
  requestDevice(options: { filters: readonly USBDeviceFilter[] }): Promise<USBDeviceLike>;
  onDisconnect(listener: (event: USBConnectionEventLike) => void): () => void;
  onConnect?(listener: (event: USBConnectionEventLike) => void): () => void;
}

export class BrowserUSBFacade implements USBFacade {
  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      'usb' in navigator &&
      Boolean((navigator as unknown as { usb?: unknown }).usb)
    );
  }

  async requestDevice(options: { filters: readonly USBDeviceFilter[] }): Promise<USBDeviceLike> {
    if (!this.isSupported()) {
      throw new Error('WebUSB is not supported in this environment');
    }
    const navUsb = (navigator as unknown as { usb: { requestDevice(opts: unknown): Promise<USBDeviceLike> } }).usb;
    return await navUsb.requestDevice(options);
  }

  onDisconnect(listener: (event: USBConnectionEventLike) => void): () => void {
    if (!this.isSupported()) return () => {};
    const navUsb = (navigator as unknown as { usb: {
      addEventListener(type: string, cb: (e: USBConnectionEventLike) => void): void;
      removeEventListener(type: string, cb: (e: USBConnectionEventLike) => void): void;
    } }).usb;

    navUsb.addEventListener('disconnect', listener);
    return () => navUsb.removeEventListener('disconnect', listener);
  }
}

export type StateChangeListener = (state: AdapterState) => void;
export type DeviceChangeListener = (summary: SanitizedDeviceSummary | null) => void;
export type DiagnosticListener = (entry: DiagnosticEntry) => void;
export type BusyChangeListener = (busy: boolean) => void;

export class WebUSBAdapter {
  private readonly usb: USBFacade;
  private state: AdapterState;
  private activeDevice: USBDeviceLike | null = null;
  private readonly claimedInterfaces: Set<number> = new Set();
  private readonly diagnostics: DiagnosticEntry[] = [];
  private isOperating = false;
  private sessionGeneration = 0;
  private removeDisconnectListener: (() => void) | null = null;

  private readonly stateListeners = new Set<StateChangeListener>();
  private readonly deviceListeners = new Set<DeviceChangeListener>();
  private readonly diagnosticListeners = new Set<DiagnosticListener>();
  private readonly busyListeners = new Set<BusyChangeListener>();

  constructor(usbFacade: USBFacade = new BrowserUSBFacade()) {
    this.usb = usbFacade;

    if (!this.usb.isSupported()) {
      this.state = 'UNSUPPORTED';
      this.addDiagnostic(
        'error',
        'UNSUPPORTED_BROWSER',
        'WebUSB APIがサポートされていません。HTTPS環境またはGoogle Chrome等のChromium系ブラウザをご利用ください。',
      );
    } else {
      this.state = 'IDLE';
      this.addDiagnostic('info', 'SUCCESS', 'WebUSB環境が正常に検出されました。待機中です。');
      this.setupDisconnectListener();
    }
  }

  private setupDisconnectListener(): void {
    this.removeDisconnectListener = this.usb.onDisconnect((event) => {
      this.handlePhysicalDisconnect(event.device);
    });
  }

  public destroy(): void {
    if (this.removeDisconnectListener) {
      this.removeDisconnectListener();
      this.removeDisconnectListener = null;
    }
    this.stateListeners.clear();
    this.deviceListeners.clear();
    this.diagnosticListeners.clear();
    this.busyListeners.clear();
  }

  public getState(): AdapterState {
    return this.state;
  }

  public isBusy(): boolean {
    return this.isOperating;
  }

  public getClaimedInterfaces(): ReadonlySet<number> {
    return new Set(this.claimedInterfaces);
  }

  public getDiagnostics(): readonly DiagnosticEntry[] {
    return Object.freeze([...this.diagnostics]);
  }

  public getSanitizedDeviceSummary(): SanitizedDeviceSummary | null {
    if (!this.activeDevice) {
      return null;
    }

    const baseSummary = sanitizeDeviceSummary(this.activeDevice);
    // Overlay session-tracked claimed state
    const updatedConfigurations = baseSummary.configurations.map((cfg) => ({
      ...cfg,
      interfaces: cfg.interfaces.map((iface) => ({
        ...iface,
        claimed: this.claimedInterfaces.has(iface.interfaceNumber) || iface.claimed,
      })),
    }));

    return Object.freeze({
      ...baseSummary,
      configurations: Object.freeze(updatedConfigurations),
    });
  }

  public onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  public onDeviceChange(listener: DeviceChangeListener): () => void {
    this.deviceListeners.add(listener);
    listener(this.getSanitizedDeviceSummary());
    return () => this.deviceListeners.delete(listener);
  }

  public onDiagnostic(listener: DiagnosticListener): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  public onBusyChange(listener: BusyChangeListener): () => void {
    this.busyListeners.add(listener);
    listener(this.isOperating);
    return () => this.busyListeners.delete(listener);
  }

  private setOperating(operating: boolean): void {
    this.isOperating = operating;
    for (const listener of this.busyListeners) {
      listener(this.isOperating);
    }
  }

  private setState(newState: AdapterState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    this.addDiagnostic('info', 'STATE_CHANGE', `状態遷移: ${oldState} -> ${newState}`);
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
    this.notifyDeviceChange();
  }

  private notifyDeviceChange(): void {
    const summary = this.getSanitizedDeviceSummary();
    for (const listener of this.deviceListeners) {
      listener(summary);
    }
  }

  private addDiagnostic(
    level: DiagnosticLevel,
    code: DiagnosticCode,
    message: string,
    details?: Record<string, string | number | boolean>,
  ): DiagnosticEntry {
    const entry = createDiagnosticEntry(level, code, message, details);
    appendDiagnosticEntry(this.diagnostics, entry, MAX_DIAGNOSTIC_ENTRIES);
    for (const listener of this.diagnosticListeners) {
      listener(entry);
    }
    return entry;
  }

  /**
   * Requests a supported USB tuner device via navigator.usb.requestDevice().
   * Filtering is restricted to PX-Q3U4 and Siano Rio PIDs.
   * Rejects if an active device or session already exists.
   */
  public async requestDevice(): Promise<boolean> {
    if (this.isOperating) {
      this.addDiagnostic('warn', 'BUSY_ERROR', '別のUSB操作が実行中です。完了するまでお待ちください。', {
        context: 'requestDevice',
      });
      return false;
    }

    if (!this.usb.isSupported()) {
      this.addDiagnostic('error', 'UNSUPPORTED_BROWSER', 'WebUSB APIが利用できないため、デバイスを要求できません。');
      return false;
    }

    // Reject if a current device or session exists; explicit close is required
    if (this.activeDevice !== null || (this.state !== 'IDLE' && this.state !== 'CLOSED' && this.state !== 'DISCONNECTED')) {
      this.addDiagnostic(
        'warn',
        'OPEN_FAILED',
        '既存のデバイスセッションが存在します。新しいデバイスを選択する前に、現在のセッションを解放・クローズしてください。',
        { context: 'requestDevice' },
      );
      return false;
    }

    this.setOperating(true);
    const targetGeneration = this.sessionGeneration;
    try {
      const device = await this.usb.requestDevice({
        filters: SUPPORTED_DEVICE_FILTERS,
      });

      if (this.sessionGeneration !== targetGeneration) {
        return false;
      }

      this.sessionGeneration++;
      this.activeDevice = device;
      this.claimedInterfaces.clear();

      const model = getDeviceModelInfo(device.vendorId, device.productId);
      const vidHex = device.vendorId.toString(16).padStart(4, '0');
      const pidHex = device.productId.toString(16).padStart(4, '0');

      this.addDiagnostic('success', 'SUCCESS', `デバイスを選択しました: ${model.label} [0x${vidHex}:0x${pidHex}]`, {
        vendorId: `0x${vidHex}`,
        productId: `0x${pidHex}`,
        model: model.label,
        context: 'requestDevice',
      });

      if (device.opened) {
        if (device.configuration) {
          this.setState('OPENED');
        } else {
          this.setState('OPENED_NO_CONFIG');
        }
      } else {
        this.setState('DEVICE_SELECTED');
      }

      return true;
    } catch (error) {
      if (this.sessionGeneration !== targetGeneration) {
        return false;
      }
      const categorized = categorizeError(error, 'requestDevice');
      this.addDiagnostic(categorized.level, categorized.code, categorized.message, categorized.details);
      return false;
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * Explicit user action to open the selected device.
   */
  public async openDevice(): Promise<boolean> {
    if (this.isOperating) {
      this.addDiagnostic('warn', 'BUSY_ERROR', '別のUSB操作が実行中です。完了するまでお待ちください。', {
        context: 'open',
      });
      return false;
    }

    if (this.state !== 'DEVICE_SELECTED' || !this.activeDevice) {
      this.addDiagnostic('warn', 'OPEN_FAILED', 'デバイスが開けない状態です。先にデバイスを選択してください。', {
        context: 'open',
      });
      return false;
    }

    this.setOperating(true);
    const targetDevice = this.activeDevice;
    const targetGeneration = this.sessionGeneration;

    try {
      await targetDevice.open();

      // Check if session was disconnected or replaced during await
      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }

      if (targetDevice.configuration) {
        this.setState('OPENED');
        this.addDiagnostic(
          'success',
          'SUCCESS',
          `デバイスを開きました。アクティブなコンフィギュレーション: #${targetDevice.configuration.configurationValue}`,
          {
            configurationValue: targetDevice.configuration.configurationValue,
            context: 'open',
          },
        );
      } else {
        this.setState('OPENED_NO_CONFIG');
        this.addDiagnostic(
          'warn',
          'SUCCESS',
          'デバイスを開きました。OSによりコンフィギュレーションが選択されていないため、明示的に選択してください。',
          { context: 'open' },
        );
      }

      return true;
    } catch (error) {
      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }
      const categorized = categorizeError(error, 'open');
      this.addDiagnostic(categorized.level, categorized.code, categorized.message, categorized.details);
      return false;
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * Explicit user action to select a configuration on the opened device.
   * Validates that configurationValue exists in descriptors before applying.
   */
  public async selectConfiguration(configurationValue: number): Promise<boolean> {
    if (this.isOperating) {
      this.addDiagnostic('warn', 'BUSY_ERROR', '別のUSB操作が実行中です。完了するまでお待ちください。', {
        context: 'selectConfiguration',
      });
      return false;
    }

    if ((this.state !== 'OPENED_NO_CONFIG' && this.state !== 'OPENED') || !this.activeDevice) {
      this.addDiagnostic('warn', 'CONFIGURATION_FAILED', 'デバイスが開かれていないためコンフィギュレーションを選択できません。', {
        context: 'selectConfiguration',
      });
      return false;
    }

    // Validate that configurationValue exists in device configurations
    const exists = this.activeDevice.configurations.some(
      (cfg) => cfg.configurationValue === configurationValue,
    );
    if (!exists) {
      this.addDiagnostic(
        'error',
        'CONFIGURATION_FAILED',
        `指定されたコンフィギュレーション (#${configurationValue}) はデバイスの記述子に存在しません。`,
        {
          configurationValue,
          context: 'selectConfiguration',
        },
      );
      return false;
    }

    this.setOperating(true);
    const targetDevice = this.activeDevice;
    const targetGeneration = this.sessionGeneration;

    try {
      await targetDevice.selectConfiguration(configurationValue);

      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }

      this.setState('OPENED');
      this.addDiagnostic(
        'success',
        'SUCCESS',
        `コンフィギュレーション #${configurationValue} を正常に選択しました。`,
        {
          configurationValue,
          context: 'selectConfiguration',
        },
      );
      return true;
    } catch (error) {
      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }
      const categorized = categorizeError(error, 'selectConfiguration');
      this.addDiagnostic(categorized.level, categorized.code, categorized.message, categorized.details);
      return false;
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * Explicit user action to claim a vendor-specific interface.
   * Denies non-vendor interfaces and strictly denies CCID (0x0b).
   */
  public async claimInterface(interfaceNumber: number): Promise<boolean> {
    if (this.isOperating) {
      this.addDiagnostic('warn', 'BUSY_ERROR', '別のUSB操作が実行中です。完了するまでお待ちください。', {
        context: 'claimInterface',
      });
      return false;
    }

    if (this.state !== 'OPENED' || !this.activeDevice || !this.activeDevice.configuration) {
      this.addDiagnostic('warn', 'CLAIM_FAILED', 'アクティブなコンフィギュレーションが存在しないためインターフェイスを要求できません。', {
        context: 'claimInterface',
      });
      return false;
    }

    const iface = this.activeDevice.configuration.interfaces.find(
      (i) => i.interfaceNumber === interfaceNumber,
    );

    if (!iface) {
      this.addDiagnostic('error', 'CLAIM_FAILED', `インターフェイス #${interfaceNumber} がコンフィギュレーションに見つかりません。`, {
        interfaceNumber,
        context: 'claimInterface',
      });
      return false;
    }

    const claimEval = evaluateInterfaceClaimability(iface);
    if (!claimEval.allowed) {
      this.addDiagnostic('error', 'CLAIM_DISALLOWED', `インターフェイス #${interfaceNumber} の要求は拒否されました: ${claimEval.reason}`, {
        interfaceNumber,
        isSmartCardCcid: claimEval.isSmartCardCcid,
        context: 'claimInterface',
      });
      return false;
    }

    if (this.claimedInterfaces.has(interfaceNumber)) {
      this.addDiagnostic('warn', 'CLAIM_FAILED', `インターフェイス #${interfaceNumber} は既にこのセッションで要求済みです。`, {
        interfaceNumber,
        context: 'claimInterface',
      });
      return false;
    }

    this.setOperating(true);
    const targetDevice = this.activeDevice;
    const targetGeneration = this.sessionGeneration;

    try {
      await targetDevice.claimInterface(interfaceNumber);

      // Check if session was disconnected or replaced during await
      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }

      this.claimedInterfaces.add(interfaceNumber);
      this.addDiagnostic(
        'success',
        'SUCCESS',
        `インターフェイス #${interfaceNumber} を要求（claim）しました。`,
        {
          interfaceNumber,
          context: 'claimInterface',
        },
      );
      this.notifyDeviceChange();
      return true;
    } catch (error) {
      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }
      const categorized = categorizeError(error, 'claimInterface');
      this.addDiagnostic(categorized.level, categorized.code, categorized.message, {
        ...categorized.details,
        interfaceNumber,
      });
      return false;
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * Explicit user action to release a previously claimed interface.
   */
  public async releaseInterface(interfaceNumber: number): Promise<boolean> {
    if (this.isOperating) {
      this.addDiagnostic('warn', 'BUSY_ERROR', '別のUSB操作が実行中です。完了するまでお待ちください。', {
        context: 'releaseInterface',
      });
      return false;
    }

    if (!this.activeDevice || !this.claimedInterfaces.has(interfaceNumber)) {
      this.addDiagnostic('warn', 'RELEASE_FAILED', `インターフェイス #${interfaceNumber} は要求されていません。`, {
        interfaceNumber,
        context: 'releaseInterface',
      });
      return false;
    }

    this.setOperating(true);
    const targetDevice = this.activeDevice;
    const targetGeneration = this.sessionGeneration;

    try {
      await targetDevice.releaseInterface(interfaceNumber);

      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }

      this.claimedInterfaces.delete(interfaceNumber);
      this.addDiagnostic(
        'success',
        'SUCCESS',
        `インターフェイス #${interfaceNumber} を解放（release）しました。`,
        {
          interfaceNumber,
          context: 'releaseInterface',
        },
      );
      this.notifyDeviceChange();
      return true;
    } catch (error) {
      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }
      const categorized = categorizeError(error, 'releaseInterface');
      this.addDiagnostic(categorized.level, categorized.code, categorized.message, {
        ...categorized.details,
        interfaceNumber,
      });
      return false;
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * Internal implementation of interface release and device closure.
   * Preserves failed claimed-interfaces and active handle if close fails.
   */
  private async releaseAndCloseInternal(): Promise<boolean> {
    if (!this.activeDevice) {
      this.setState('CLOSED');
      return true;
    }

    const targetDevice = this.activeDevice;
    const targetGeneration = this.sessionGeneration;

    let allReleasesSucceeded = true;

    // 1. Release all claimed interfaces tracked in this session
    const interfacesToRelease = Array.from(this.claimedInterfaces);
    for (const ifaceNum of interfacesToRelease) {
      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }

      try {
        await targetDevice.releaseInterface(ifaceNum);

        if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
          return false;
        }

        this.claimedInterfaces.delete(ifaceNum);
        this.addDiagnostic('info', 'SUCCESS', `インターフェイス #${ifaceNum} を解放しました。`, {
          interfaceNumber: ifaceNum,
          context: 'releaseInterface',
        });
      } catch (error) {
        if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
          return false;
        }
        allReleasesSucceeded = false;
        // Keep in this.claimedInterfaces so cleanup can be retried!
        const categorized = categorizeError(error, 'releaseInterface');
        this.addDiagnostic(categorized.level, categorized.code, `クローズ中のインターフェイス #${ifaceNum} 解放に失敗しました。`, {
          interfaceNumber: ifaceNum,
          context: 'releaseInterface',
        });
      }
    }

    // 2. Close device if opened
    if (targetDevice.opened) {
      if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
        return false;
      }

      try {
        await targetDevice.close();

        if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
          return false;
        }

        this.sessionGeneration++;
        this.activeDevice = null;
        this.claimedInterfaces.clear();
        this.setState('CLOSED');
        this.addDiagnostic('success', 'SUCCESS', 'デバイスを正常にクローズしました。', {
          context: 'close',
        });

        // If release failed earlier, return false to report partial failure
        return allReleasesSucceeded;
      } catch (error) {
        if (this.sessionGeneration !== targetGeneration || this.activeDevice !== targetDevice) {
          return false;
        }
        // Close failed: do NOT report CLOSED or discard active handle
        const categorized = categorizeError(error, 'close');
        this.addDiagnostic(
          'error',
          'CLOSE_FAILED',
          'デバイスのクローズに失敗しました。',
          categorized.details,
        );
        this.notifyDeviceChange();
        return false;
      }
    }

    // Device was not opened
    this.sessionGeneration++;
    this.activeDevice = null;
    this.claimedInterfaces.clear();
    this.setState('CLOSED');
    return allReleasesSucceeded;
  }

  /**
   * Explicit user action to release all session-claimed interfaces and close the device,
   * reaching a clean terminal state.
   */
  public async releaseAndClose(): Promise<boolean> {
    if (this.isOperating) {
      this.addDiagnostic('warn', 'BUSY_ERROR', '別のUSB操作が実行中です。完了するまでお待ちください。', {
        context: 'releaseAndClose',
      });
      return false;
    }

    this.setOperating(true);
    try {
      return await this.releaseAndCloseInternal();
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * Handles physical disconnect events dispatched by WebUSB.
   * Matches WebUSB device object identity ONLY. Never matches by VID:PID.
   */
  public handlePhysicalDisconnect(disconnectedDevice: USBDeviceLike): void {
    if (this.activeDevice && this.activeDevice === disconnectedDevice) {
      this.sessionGeneration++;
      const model = getDeviceModelInfo(this.activeDevice.vendorId, this.activeDevice.productId);
      this.claimedInterfaces.clear();
      this.activeDevice = null;
      this.setState('DISCONNECTED');
      this.addDiagnostic(
        'warn',
        'DISCONNECT',
        `デバイスの物理的な切断を検出しました: ${model.label}。セッションを終了しクリーンな切断状態へ移行しました。`,
        { context: 'disconnect' },
      );
    }
  }

  /**
   * Resets adapter to IDLE state. Awaits cleanup of any open/claimed device.
   * If close fails, preserves state and device handle, returning false.
   * If close succeeds after partial release failure, cleanly transitions to IDLE.
   */
  public async reset(): Promise<boolean> {
    if (this.isOperating) {
      this.addDiagnostic('warn', 'BUSY_ERROR', '別のUSB操作が実行中です。完了するまでお待ちください。', {
        context: 'reset',
      });
      return false;
    }

    this.setOperating(true);
    try {
      if (this.activeDevice) {
        const cleanupSuccess = await this.releaseAndCloseInternal();

        // Check if close failed (handle preserved):
        if (this.activeDevice !== null) {
          this.addDiagnostic(
            'error',
            'CLOSE_FAILED',
            'リセット処理中のデバイスクローズに失敗しました。デバイス状態を維持します。',
            { context: 'reset' },
          );
          return false;
        }

        // Close succeeded, but some interface releases had failed:
        if (!cleanupSuccess) {
          this.addDiagnostic(
            'warn',
            'RELEASE_FAILED',
            '一部インターフェイスの解放に失敗しましたが、デバイスは正常にクローズされました。IDLE状態へ復帰します。',
            { context: 'reset' },
          );
        }
      }

      this.sessionGeneration++;
      this.claimedInterfaces.clear();
      this.activeDevice = null;
      if (this.usb.isSupported()) {
        this.setState('IDLE');
        return true;
      } else {
        this.setState('UNSUPPORTED');
        return false;
      }
    } finally {
      this.setOperating(false);
    }
  }
}
