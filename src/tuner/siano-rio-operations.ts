import {
  SIANO_RIO_OPT_IN_MAGIC,
  type SianoRioEnumerationModule,
  type WebUsbPermissionSource,
} from '../usb/wasm-enumeration-diagnostic';
import type { TunerOperations } from './adapter';

/** Fixed, non-device-specific diagnostics for the Siano lifecycle bridge. */
export type SianoRioBridgeDiagnostic =
  | 'NONE'
  | 'UNSUPPORTED'
  | 'AUTHORIZED_QUERY_FAILED'
  | 'TARGET_MISMATCH'
  | 'WASM_UNAVAILABLE'
  | 'INVALID_MODULE'
  | 'ENUMERATION_FAILED'
  | 'NATIVE_FAILURE'
  | 'BUSY';

export interface SianoRioTunerOperationsOptions {
  readonly usb: WebUsbPermissionSource;
  readonly moduleFactory: () => SianoRioEnumerationModule | Promise<SianoRioEnumerationModule>;
  /** Only the single Rio index is accepted by this narrow M1 bridge. */
  readonly deviceIndex?: number;
}

/**
 * ManagedTunerAdapter operations for the already-authorized PX-S1UD Rio.
 *
 * This bridge is deliberately limited to native open/close. It verifies one
 * authorized 0x3275:0x0080 device and one Siano WASM enumeration result in
 * the same module instance before calling the opt-in lifecycle ABI. It never
 * implements firmware, tune, stream, or version operations.
 */
export class SianoRioTunerOperations implements TunerOperations {
  private readonly usb: WebUsbPermissionSource;
  private readonly moduleFactory: SianoRioTunerOperationsOptions['moduleFactory'];
  private readonly deviceIndex: number;
  private module: SianoRioEnumerationModule | null = null;
  private openAttempted = false;
  private opened = false;
  private nativeBusy = false;
  private currentDiagnostic: SianoRioBridgeDiagnostic = 'NONE';

  public constructor(options: SianoRioTunerOperationsOptions) {
    this.usb = options.usb;
    this.moduleFactory = options.moduleFactory;
    this.deviceIndex = options.deviceIndex ?? 0;
  }

  public get diagnostic(): SianoRioBridgeDiagnostic { return this.currentDiagnostic; }

  public async open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw this.fail('BUSY');
    if (this.openAttempted || this.opened || this.nativeBusy) throw this.fail('BUSY');
    if (this.deviceIndex !== 0) throw this.fail('TARGET_MISMATCH');

    const devices = await this.readAuthorizedDevices();
    if (devices.length !== 1 || devices[0].vendorId !== 0x3275 || devices[0].productId !== 0x0080) {
      throw this.fail('TARGET_MISMATCH');
    }
    if (signal.aborted) throw this.fail('BUSY');

    let module: SianoRioEnumerationModule;
    try {
      module = await this.moduleFactory();
    } catch {
      throw this.fail('WASM_UNAVAILABLE');
    }
    if (!isSianoModule(module)) throw this.fail('INVALID_MODULE');
    this.module = module;

    const enumeration = await this.call('webts_siano_enumerate_rio', []);
    if ((enumeration & 0xff) !== 0 || ((enumeration >>> 8) & 0xff) !== 1) {
      throw this.fail('ENUMERATION_FAILED');
    }
    if (signal.aborted) throw this.fail('BUSY');

    // Mark before the native call so ManagedTunerAdapter's compensation close
    // is attempted even if open_rio fails after claiming an interface.
    this.openAttempted = true;
    const result = await this.call('webts_siano_lifecycle_open', [SIANO_RIO_OPT_IN_MAGIC, this.deviceIndex]);
    if ((result & 0xff) !== 0) throw this.fail('NATIVE_FAILURE');
    this.opened = true;
    this.currentDiagnostic = 'NONE';
  }

  public async close(_signal: AbortSignal): Promise<void> {
    if (!this.openAttempted) return;
    if (this.nativeBusy) throw this.fail('BUSY');
    const module = this.module;
    if (!module) throw this.fail('INVALID_MODULE');
    const result = await this.call('webts_siano_lifecycle_close', [SIANO_RIO_OPT_IN_MAGIC]);
    if ((result & 0xff) !== 0) throw this.fail('NATIVE_FAILURE');
    this.openAttempted = false;
    this.opened = false;
    this.module = null;
    this.currentDiagnostic = 'NONE';
  }

  /** Best-effort cleanup invoked by ManagedTunerAdapter.disconnect(). */
  public async onDisconnect(): Promise<void> {
    if (!this.openAttempted || this.nativeBusy) return;
    try {
      await this.close(new AbortController().signal);
    } catch {
      // ManagedTunerAdapter exposes only its fixed lifecycle error contract.
      this.currentDiagnostic = 'NATIVE_FAILURE';
    }
  }

  private async readAuthorizedDevices(): Promise<readonly { vendorId: number; productId: number }[]> {
    if (!this.usb || typeof this.usb.getDevices !== 'function') throw this.fail('UNSUPPORTED');
    try {
      const devices = await this.usb.getDevices();
      if (!Array.isArray(devices)) throw new Error('invalid');
      return devices.map((device) => ({ vendorId: device.vendorId, productId: device.productId }));
    } catch {
      throw this.fail('AUTHORIZED_QUERY_FAILED');
    }
  }

  private async call(name: string, args: readonly number[]): Promise<number> {
    if (this.nativeBusy) throw this.fail('BUSY');
    const module = this.module;
    if (!module) throw this.fail('INVALID_MODULE');
    this.nativeBusy = true;
    try {
      const value = await module.ccall(name, 'number', args.map(() => 'number'), args, { async: true });
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('invalid');
      return value;
    } catch {
      throw this.fail('NATIVE_FAILURE');
    } finally {
      this.nativeBusy = false;
    }
  }

  private fail(diagnostic: SianoRioBridgeDiagnostic): Error {
    this.currentDiagnostic = diagnostic;
    return new Error('Siano lifecycle operation failed');
  }
}

function isSianoModule(value: unknown): value is SianoRioEnumerationModule {
  try {
    return typeof (value as Partial<SianoRioEnumerationModule> | null)?.ccall === 'function';
  } catch {
    return false;
  }
}
