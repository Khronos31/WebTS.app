/**
 * Read-only WebUSB permission -> official libusb/WebUSB WASM enumeration seam.
 * License: GPL-2.0-only
 *
 * The WASM module must be built from the vendored, unmodified libusb backend.
 * The shim does not issue writes, claim interfaces, perform bulk/stream
 * transfers, tune, upload firmware, or retain serial/card/payload data.
 * The official libusb WebUSB backend may nevertheless temporarily open an
 * authorized device and issue standard control-IN GET_DESCRIPTOR requests
 * while implementing libusb_get_device_list().
 */

import type { USBDeviceFilter } from '../types/usb';
import { SUPPORTED_DEVICE_FILTERS } from './filters';

const MAX_ENUMERATED_DEVICES = 64;

export interface WebUsbPermissionSource {
  requestDevice(options: { filters: readonly USBDeviceFilter[] }): Promise<{
    readonly vendorId: number;
    readonly productId: number;
  }>;
  getDevices?(): Promise<readonly {
    readonly vendorId: number;
    readonly productId: number;
  }[]>;
}

export interface LibusbEnumerationModule {
  readonly HEAPU32: Uint32Array;
  ccall(
    name: string,
    returnType: 'number',
    argTypes: readonly string[],
    args: readonly number[],
    opts: { readonly async: true },
  ): number | Promise<number>;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _webts_libusb_probe_execution_context(): number | Promise<number>;
  _webts_libusb_get_last_diagnostic(): number;
}

export interface SianoRioEnumerationModule {
  ccall(
    name: string,
    returnType: 'number',
    argTypes: readonly string[],
    args: readonly number[],
    opts: { readonly async: true },
  ): number | Promise<number>;
}

export interface SianoFirmwareValidationModule extends SianoRioEnumerationModule {
  readonly HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
}

export type SianoRioEnumerationDiagnostic = LibusbEnumerationDiagnostic;
export const SIANO_RIO_OPT_IN_MAGIC = 0x53494f31;
const SIANO_RIO_VENDOR_ID = 0x3275;
const SIANO_RIO_PRODUCT_ID = 0x0080;

export interface SianoRioEnumerationReport {
  readonly authorizedDeviceCount: number;
  readonly supportedDeviceCount: number;
  readonly diagnostic: SianoRioEnumerationDiagnostic;
}

export interface SianoRioLifecycleReport extends SianoRioEnumerationReport {
  readonly lifecycleOpenDiagnostic: SianoRioEnumerationDiagnostic;
  readonly lifecycleCloseDiagnostic: SianoRioEnumerationDiagnostic;
}

export interface SianoVersionHandshakeReport {
  readonly startDiagnostic: LibusbEnumerationDiagnostic;
  readonly versionDiagnostic: LibusbEnumerationDiagnostic;
}

export const SIANO_RIO_FIRMWARE_MAX_BYTES = 16 * 1024 * 1024;
export const SIANO_RIO_FIRMWARE_SHA256 =
  '054520642d5d09cb7ab7d08dbd6fd9ba9365de56adf2e7d7d06927f9845ff818';

export type SianoFirmwareInspectionDiagnostic =
  | 'NONE'
  | 'FIRMWARE_INVALID_INPUT'
  | 'FIRMWARE_TOO_LARGE'
  | 'FIRMWARE_READ_FAILED'
  | 'FIRMWARE_HASH_UNAVAILABLE'
  | 'FIRMWARE_HASH_MISMATCH'
  | 'FIRMWARE_WASM_UNAVAILABLE'
  | 'FIRMWARE_INVALID_MODULE'
  | 'FIRMWARE_HEADER_INVALID'
  | 'FIRMWARE_STAGE_FAILED'
  | 'FIRMWARE_CLEANUP_FAILED';

export interface SianoFirmwareInspectionReport {
  readonly diagnostic: SianoFirmwareInspectionDiagnostic;
}

export interface SianoFirmwareFile {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Test-only injection point; production callers use WebCrypto by omission. */
export type SianoFirmwareDigest =
  (algorithm: 'SHA-256', data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;

/**
 * Checks a user-selected firmware file entirely in memory, then exercises the
 * upstream header/path staging ABI. This function never touches WebUSB. Only
 * a fixed diagnostic is returned; file names, bytes, and digests never leave
 * this function. The input ArrayBuffer is wiped on exit on a best-effort basis.
 */
export async function inspectLocalSianoFirmware(
  file: SianoFirmwareFile,
  moduleFactory: () => SianoFirmwareValidationModule | Promise<SianoFirmwareValidationModule>,
  digestFunction?: SianoFirmwareDigest,
): Promise<SianoFirmwareInspectionReport> {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) {
    return firmwareReport('FIRMWARE_INVALID_INPUT');
  }
  if (file.size > SIANO_RIO_FIRMWARE_MAX_BYTES) {
    return firmwareReport('FIRMWARE_TOO_LARGE');
  }

  let bytes: Uint8Array<ArrayBuffer> | null = null;
  try {
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      return firmwareReport('FIRMWARE_READ_FAILED');
    }
    if (!(buffer instanceof ArrayBuffer)) {
      return firmwareReport('FIRMWARE_READ_FAILED');
    }
    bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== file.size) {
      return firmwareReport('FIRMWARE_READ_FAILED');
    }

    const digest = digestFunction ?? defaultSianoFirmwareDigest;
    if (digest === null) return firmwareReport('FIRMWARE_HASH_UNAVAILABLE');
    const digestInput = bytes.slice();
    let digestBuffer: ArrayBuffer;
    try {
      digestBuffer = await digest('SHA-256', digestInput);
    } catch {
      return firmwareReport('FIRMWARE_HASH_UNAVAILABLE');
    } finally {
      digestInput.fill(0);
    }
    if (!(digestBuffer instanceof ArrayBuffer)) {
      return firmwareReport('FIRMWARE_HASH_MISMATCH');
    }
    let digestMatches = false;
    try {
      digestMatches = matchesSianoFirmwareDigest(new Uint8Array(digestBuffer));
    } finally {
      new Uint8Array(digestBuffer).fill(0);
    }
    if (!digestMatches) return firmwareReport('FIRMWARE_HASH_MISMATCH');

    let module: SianoFirmwareValidationModule;
    try {
      module = await moduleFactory();
    } catch {
      return firmwareReport('FIRMWARE_WASM_UNAVAILABLE');
    }
    if (!isValidSianoFirmwareModule(module)) {
      return firmwareReport('FIRMWARE_INVALID_MODULE');
    }

    let pointer = 0;
    let stageDiagnostic: SianoFirmwareInspectionDiagnostic = 'FIRMWARE_STAGE_FAILED';
    let cleanupFailed = false;
    try {
      pointer = module._malloc(bytes.byteLength);
      const end = pointer + bytes.byteLength;
      if (Number.isSafeInteger(pointer) && pointer > 0 &&
          Number.isSafeInteger(end) && end <= module.HEAPU8.byteLength) {
        module.HEAPU8.set(bytes, pointer);
        let result: number;
        try {
          result = await module.ccall(
            'webts_siano_firmware_validate_stage',
            'number',
            ['number', 'number'],
            [pointer, bytes.byteLength],
            { async: true },
          );
        } catch {
          result = 4;
        }
        stageDiagnostic = decodeSianoFirmwareDiagnostic(result);
      }
    } catch {
      stageDiagnostic = 'FIRMWARE_STAGE_FAILED';
    } finally {
      if (pointer > 0) {
        try {
          const end = Math.min(pointer + bytes.byteLength, module.HEAPU8.byteLength);
          if (pointer < end) module.HEAPU8.fill(0, pointer, end);
        } catch {
          cleanupFailed = true;
        }
        try {
          module._free(pointer);
        } catch {
          cleanupFailed = true;
        }
      }
    }
    return firmwareReport(cleanupFailed ? 'FIRMWARE_CLEANUP_FAILED' : stageDiagnostic);
  } catch {
    return firmwareReport('FIRMWARE_READ_FAILED');
  } finally {
    if (bytes !== null) bytes.fill(0);
  }
}

function firmwareReport(diagnostic: SianoFirmwareInspectionDiagnostic): SianoFirmwareInspectionReport {
  return Object.freeze({ diagnostic });
}

const defaultSianoFirmwareDigest: SianoFirmwareDigest | null =
  typeof globalThis.crypto?.subtle?.digest === 'function'
    ? (algorithm, data) => globalThis.crypto.subtle.digest(algorithm, data)
    : null;

function matchesSianoFirmwareDigest(value: Uint8Array): boolean {
  const expected = new Uint8Array(SIANO_RIO_FIRMWARE_SHA256.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
  if (value.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= value[index] ^ expected[index];
  return difference === 0;
}

function decodeSianoFirmwareDiagnostic(value: number): SianoFirmwareInspectionDiagnostic {
  if (value === 0) return 'NONE';
  if (value === 1) return 'FIRMWARE_TOO_LARGE';
  if (value === 2) return 'FIRMWARE_INVALID_INPUT';
  if (value === 3) return 'FIRMWARE_HEADER_INVALID';
  return 'FIRMWARE_STAGE_FAILED';
}

/**
 * Enumerates already-authorized WebUSB devices through the vendored Siano
 * source predicate. No chooser is opened and only fixed counts/codes return.
 */
export async function enumerateAuthorizedSianoRioDevices(
  usb: WebUsbPermissionSource,
  moduleFactory: () => SianoRioEnumerationModule | Promise<SianoRioEnumerationModule>,
): Promise<SianoRioEnumerationReport> {
  if (!usb || typeof usb.getDevices !== 'function') {
    throw new WasmEnumerationDiagnosticError('UNSUPPORTED_WEBUSB', 'WebUSB getDevices is unavailable');
  }
  const authorizedDevices = await readAuthorizedDeviceIds(usb);
  let module: SianoRioEnumerationModule;
  try {
    module = await moduleFactory();
  } catch {
    throw new WasmEnumerationDiagnosticError('WASM_UNAVAILABLE', 'The Siano Rio WASM module is unavailable');
  }
  if (!isValidSianoRioModule(module)) {
    throw new WasmEnumerationDiagnosticError('INVALID_MODULE', 'The Siano Rio WASM ABI is unavailable');
  }
  let packed: number;
  try {
    packed = await module.ccall(
      'webts_siano_enumerate_rio',
      'number',
      [],
      [],
      { async: true },
    );
  } catch {
    throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The Siano Rio enumeration failed');
  }
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > 0xffffffff) {
    throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The Siano Rio enumeration failed');
  }
  return Object.freeze({
    authorizedDeviceCount: authorizedDevices.length,
    supportedDeviceCount: (packed >>> 8) & 0xff,
    diagnostic: decodeLibusbDiagnostic(packed & 0xff),
  });
}

/**
 * Opt-in native lifecycle diagnostic. Preconditions are checked in JavaScript
 * before any lifecycle call; the same module instance is used for enumerate,
 * open, and the finally-guaranteed close. This function is intentionally not
 * used by the normal enumeration buttons.
 */
export async function runAuthorizedSianoRioLifecycle(
  usb: WebUsbPermissionSource,
  moduleFactory: () => SianoRioEnumerationModule | Promise<SianoRioEnumerationModule>,
): Promise<SianoRioLifecycleReport> {
  if (!usb || typeof usb.getDevices !== 'function') {
    throw new WasmEnumerationDiagnosticError('UNSUPPORTED_WEBUSB', 'WebUSB getDevices is unavailable');
  }
  const authorizedDevices = await readAuthorizedDeviceIds(usb);
  if (authorizedDevices.length !== 1 ||
      authorizedDevices[0].vendorId !== SIANO_RIO_VENDOR_ID ||
      authorizedDevices[0].productId !== SIANO_RIO_PRODUCT_ID) {
    throw new WasmEnumerationDiagnosticError('SIANO_TARGET_MISMATCH', 'The authorized Siano target is not exactly one PX-S1UD');
  }

  let module: SianoRioEnumerationModule;
  try {
    module = await moduleFactory();
  } catch {
    throw new WasmEnumerationDiagnosticError('WASM_UNAVAILABLE', 'The Siano Rio WASM module is unavailable');
  }
  if (!isValidSianoRioModule(module)) {
    throw new WasmEnumerationDiagnosticError('INVALID_MODULE', 'The Siano Rio WASM ABI is unavailable');
  }

  const enumeration = await callSiano(module, 'webts_siano_enumerate_rio', [], []);
  const enumerationDiagnostic = decodeLibusbDiagnostic(enumeration & 0xff);
  const supportedDeviceCount = (enumeration >>> 8) & 0xff;
  if (enumerationDiagnostic !== 'NONE' || supportedDeviceCount !== 1) {
    throw new WasmEnumerationDiagnosticError('SIANO_TARGET_MISMATCH', 'The Siano WASM target is not exactly one device');
  }

  const lifecycle = await callSiano(module, 'webts_siano_lifecycle_open_close_probe', ['number', 'number'], [
    SIANO_RIO_OPT_IN_MAGIC,
    0,
  ]);
  const openDiagnostic = decodeLibusbDiagnostic(lifecycle & 0xff);
  const closeDiagnostic = decodeLibusbDiagnostic((lifecycle >>> 8) & 0xff);
  return Object.freeze({
    authorizedDeviceCount: authorizedDevices.length,
    supportedDeviceCount,
    diagnostic: enumerationDiagnostic,
    lifecycleOpenDiagnostic: openDiagnostic,
    lifecycleCloseDiagnostic: closeDiagnostic,
  });
}

/**
 * Calls the build-only native stream/version bridge. This is intentionally a
 * separate seam from firmware staging and is not connected to the M1 UI.
 */
export async function runSianoVersionHandshake(
  moduleFactory: () => SianoRioEnumerationModule | Promise<SianoRioEnumerationModule>,
): Promise<SianoVersionHandshakeReport> {
  let module: SianoRioEnumerationModule;
  try {
    module = await moduleFactory();
  } catch {
    throw new WasmEnumerationDiagnosticError('WASM_UNAVAILABLE', 'The Siano handshake WASM module is unavailable');
  }
  if (!isValidSianoRioModule(module)) {
    throw new WasmEnumerationDiagnosticError('INVALID_MODULE', 'The Siano handshake WASM ABI is unavailable');
  }
  let packed: number;
  try {
    packed = await module.ccall(
      'webts_siano_lifecycle_start_version',
      'number',
      ['number'],
      [SIANO_RIO_OPT_IN_MAGIC],
      { async: true },
    );
  } catch {
    throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The Siano handshake failed');
  }
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > 0xffffffff) {
    throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The Siano handshake failed');
  }
  return Object.freeze({
    startDiagnostic: decodeLibusbDiagnostic(packed & 0xff),
    versionDiagnostic: decodeLibusbDiagnostic((packed >>> 8) & 0xff),
  });
}

async function callSiano(
  module: SianoRioEnumerationModule,
  name: string,
  argTypes: readonly string[],
  args: readonly number[],
): Promise<number> {
  try {
    const value = await module.ccall(name, 'number', argTypes, args, { async: true });
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('invalid result');
    return value;
  } catch {
    throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The Siano lifecycle call failed');
  }
}

export type LibusbEnumerationModuleFactory =
  () => LibusbEnumerationModule | Promise<LibusbEnumerationModule>;

export interface WasmEnumerationDeviceId {
  readonly vendorId: number;
  readonly productId: number;
  readonly vendorIdHex: string;
  readonly productIdHex: string;
}

export interface WasmEnumerationReport {
  readonly permissionDevice: WasmEnumerationDeviceId;
  readonly wasmDeviceCount: number;
  readonly wasmDevices: readonly WasmEnumerationDeviceId[];
  readonly wasmDiagnostic: LibusbEnumerationDiagnostic;
  readonly wasmWebUsbDeviceCount: number | null;
  readonly wasmWebUsbDiagnostic: WebUsbProbeDiagnostic;
  readonly wasmExecutionContext: WasmExecutionContext;
}

export interface AuthorizedEnumerationReport {
  readonly authorizedDeviceCount: number;
  readonly authorizedDevices: readonly WasmEnumerationDeviceId[];
  readonly authorizedDeviceCountAfter: number;
  readonly authorizedDeviceCountDelta: number;
  readonly wasmDeviceCount: number;
  readonly wasmDevices: readonly WasmEnumerationDeviceId[];
  readonly wasmDiagnostic: LibusbEnumerationDiagnostic;
  readonly wasmWebUsbDeviceCount: number | null;
  readonly wasmWebUsbDiagnostic: WebUsbProbeDiagnostic;
  readonly wasmExecutionContext: WasmExecutionContext;
}

export type WebUsbProbeDiagnostic = 'OK' | 'UNSUPPORTED' | 'FAILED' | 'INVALID';
export type WasmExecutionContext = 'WINDOW' | 'DEDICATED_WORKER' | 'OTHER_WORKER' | 'NO_NAVIGATOR' | 'UNKNOWN';

export type LibusbEnumerationDiagnostic =
  | 'NONE'
  | 'IO'
  | 'INVALID_PARAM'
  | 'ACCESS'
  | 'NO_DEVICE'
  | 'NOT_FOUND'
  | 'BUSY'
  | 'TIMEOUT'
  | 'OVERFLOW'
  | 'PIPE'
  | 'INTERRUPTED'
  | 'NO_MEM'
  | 'NOT_SUPPORTED'
  | 'OTHER'
  | 'UNKNOWN';

export type WasmEnumerationDiagnosticCode =
  | 'UNSUPPORTED_WEBUSB'
  | 'PERMISSION_REQUEST_FAILED'
  | 'AUTHORIZED_DEVICE_QUERY_FAILED'
  | 'WASM_UNAVAILABLE'
  | 'WASM_ENUMERATION_FAILED'
  | 'INVALID_MODULE'
  | 'SIANO_TARGET_MISMATCH';

export class WasmEnumerationDiagnosticError extends Error {
  public readonly code: WasmEnumerationDiagnosticCode;

  public constructor(code: WasmEnumerationDiagnosticCode, message: string) {
    super(message);
    this.name = 'WasmEnumerationDiagnosticError';
    this.code = code;
  }
}

/**
 * Must be called directly from a user-gesture handler. requestDevice() runs
 * before module loading so browser permission remains tied to that gesture.
 */
export async function requestAndEnumerateAuthorizedDevices(
  usb: WebUsbPermissionSource,
  moduleFactory: LibusbEnumerationModuleFactory,
  filters: readonly USBDeviceFilter[] = SUPPORTED_DEVICE_FILTERS,
): Promise<WasmEnumerationReport> {
  if (!usb || typeof usb.requestDevice !== 'function') {
    throw new WasmEnumerationDiagnosticError('UNSUPPORTED_WEBUSB', 'WebUSB requestDevice is unavailable');
  }

  let selected: Awaited<ReturnType<WebUsbPermissionSource['requestDevice']>>;
  try {
    selected = await usb.requestDevice({ filters });
  } catch {
    throw new WasmEnumerationDiagnosticError('PERMISSION_REQUEST_FAILED', 'The WebUSB permission request failed');
  }
  const permissionDevice = toDeviceId(selected.vendorId, selected.productId);

  const enumeration = await enumerateWithModule(moduleFactory);
  return Object.freeze({
    permissionDevice,
    wasmDeviceCount: enumeration.devices.length,
    wasmDevices: enumeration.devices,
    wasmDiagnostic: enumeration.diagnostic,
    wasmWebUsbDeviceCount: enumeration.webUsbDeviceCount,
    wasmWebUsbDiagnostic: enumeration.webUsbDiagnostic,
    wasmExecutionContext: enumeration.executionContext,
  });
}

/**
 * Enumerate only devices already authorized for this origin. This path never
 * opens a chooser. The official backend may temporarily open authorized
 * devices and read standard descriptors during libusb enumeration; this path
 * performs no writes, claims, or bulk/stream transfers. An empty result is valid.
 */
export async function enumerateAuthorizedDevices(
  usb: WebUsbPermissionSource,
  moduleFactory: LibusbEnumerationModuleFactory,
): Promise<AuthorizedEnumerationReport> {
  if (!usb || typeof usb.getDevices !== 'function') {
    throw new WasmEnumerationDiagnosticError('UNSUPPORTED_WEBUSB', 'WebUSB getDevices is unavailable');
  }

  const authorizedDevices = await readAuthorizedDeviceIds(usb);
  const enumeration = await enumerateWithModule(moduleFactory);
  const authorizedDevicesAfter = await readAuthorizedDeviceIds(usb);
  return Object.freeze({
    authorizedDeviceCount: authorizedDevices.length,
    authorizedDevices,
    authorizedDeviceCountAfter: authorizedDevicesAfter.length,
    authorizedDeviceCountDelta: authorizedDevicesAfter.length - authorizedDevices.length,
    wasmDeviceCount: enumeration.devices.length,
    wasmDevices: enumeration.devices,
    wasmDiagnostic: enumeration.diagnostic,
    wasmWebUsbDeviceCount: enumeration.webUsbDeviceCount,
    wasmWebUsbDiagnostic: enumeration.webUsbDiagnostic,
    wasmExecutionContext: enumeration.executionContext,
  });
}

async function readAuthorizedDeviceIds(
  usb: WebUsbPermissionSource,
): Promise<readonly WasmEnumerationDeviceId[]> {
  if (typeof usb.getDevices !== 'function') {
    throw new WasmEnumerationDiagnosticError('UNSUPPORTED_WEBUSB', 'WebUSB getDevices is unavailable');
  }
  let authorized: Awaited<ReturnType<NonNullable<WebUsbPermissionSource['getDevices']>>>;
  try {
    authorized = await usb.getDevices();
  } catch {
    throw new WasmEnumerationDiagnosticError(
      'AUTHORIZED_DEVICE_QUERY_FAILED',
      'The authorized WebUSB device query failed',
    );
  }
  if (!Array.isArray(authorized)) {
    throw new WasmEnumerationDiagnosticError(
      'AUTHORIZED_DEVICE_QUERY_FAILED',
      'The authorized WebUSB device query returned an invalid result',
    );
  }
  try {
    return Object.freeze(
      authorized.map((device) => toDeviceId(device.vendorId, device.productId)),
    );
  } catch (error) {
    if (error instanceof WasmEnumerationDiagnosticError) throw error;
    throw new WasmEnumerationDiagnosticError(
      'AUTHORIZED_DEVICE_QUERY_FAILED',
      'The authorized WebUSB device query returned an invalid result',
    );
  }
}

interface EnumerationResult {
  readonly devices: readonly WasmEnumerationDeviceId[];
  readonly diagnostic: LibusbEnumerationDiagnostic;
  readonly webUsbDeviceCount: number | null;
  readonly webUsbDiagnostic: WebUsbProbeDiagnostic;
  readonly executionContext: WasmExecutionContext;
}

async function enumerateWithModule(
  moduleFactory: LibusbEnumerationModuleFactory,
): Promise<EnumerationResult> {

  let module: LibusbEnumerationModule;
  try {
    module = await moduleFactory();
  } catch {
    throw new WasmEnumerationDiagnosticError('WASM_UNAVAILABLE', 'The libusb WASM module is unavailable');
  }
  if (!isValidModule(module)) {
    throw new WasmEnumerationDiagnosticError('INVALID_MODULE', 'The libusb WASM diagnostic ABI is unavailable');
  }

  let pointer: number;
  try {
    pointer = module._malloc(MAX_ENUMERATED_DEVICES * Uint32Array.BYTES_PER_ELEMENT);
  } catch {
    throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The WASM enumeration buffer could not be allocated');
  }
  if (!Number.isSafeInteger(pointer) || pointer <= 0) {
    throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The WASM enumeration buffer could not be allocated');
  }
  try {
    const count = await module.ccall(
      'webts_libusb_enumerate',
      'number',
      ['number', 'number'],
      [pointer, MAX_ENUMERATED_DEVICES],
      { async: true },
    );
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ENUMERATED_DEVICES) {
      throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The libusb enumeration failed');
    }
    const webUsbProbe = decodeWebUsbProbe(await module.ccall(
      'webts_libusb_probe_webusb_device_count',
      'number',
      [],
      [],
      { async: true },
    ));
    const executionContext = decodeExecutionContext(await module._webts_libusb_probe_execution_context());
    const diagnosticCode = await module._webts_libusb_get_last_diagnostic();
    const diagnostic = decodeLibusbDiagnostic(diagnosticCode);
    const start = Math.floor(pointer / Uint32Array.BYTES_PER_ELEMENT);
    const values = module.HEAPU32.slice(start, start + count);
    const wasmDevices = Array.from(values, (packed) => toDeviceId(packed >>> 16, packed & 0xffff));
    return Object.freeze({
      devices: Object.freeze(wasmDevices),
      diagnostic,
      webUsbDeviceCount: webUsbProbe.count,
      webUsbDiagnostic: webUsbProbe.diagnostic,
      executionContext,
    });
  } catch (error) {
    if (error instanceof WasmEnumerationDiagnosticError) throw error;
    throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The libusb enumeration failed');
  } finally {
    try {
      module._free(pointer);
    } catch {
      // Keep cleanup exceptions private; diagnostics expose fixed codes only.
    }
  }
}

function isValidModule(module: unknown): module is LibusbEnumerationModule {
  try {
    const candidate = module as Partial<LibusbEnumerationModule> | null;
    return Boolean(
      candidate &&
      candidate.HEAPU32 instanceof Uint32Array &&
        typeof candidate.ccall === 'function' &&
        typeof candidate._malloc === 'function' &&
        typeof candidate._free === 'function' &&
        typeof candidate._webts_libusb_probe_execution_context === 'function' &&
        typeof candidate._webts_libusb_get_last_diagnostic === 'function',
    );
  } catch {
    // Emscripten runtime properties may be lazy getters. Keep diagnostics
    // within the fixed-code contract if a generated module exposes a broken
    // or unavailable runtime property.
    return false;
  }
}

function isValidSianoRioModule(module: unknown): module is SianoRioEnumerationModule {
  try {
    return typeof (module as Partial<SianoRioEnumerationModule> | null)?.ccall === 'function';
  } catch {
    return false;
  }
}

function isValidSianoFirmwareModule(module: unknown): module is SianoFirmwareValidationModule {
  try {
    const candidate = module as Partial<SianoFirmwareValidationModule> | null;
    return Boolean(
      candidate &&
      candidate.HEAPU8 instanceof Uint8Array &&
      typeof candidate.ccall === 'function' &&
      typeof candidate._malloc === 'function' &&
      typeof candidate._free === 'function',
    );
  } catch {
    return false;
  }
}

function decodeLibusbDiagnostic(value: number): LibusbEnumerationDiagnostic {
  const diagnostics: readonly LibusbEnumerationDiagnostic[] = [
    'NONE', 'IO', 'INVALID_PARAM', 'ACCESS', 'NO_DEVICE', 'NOT_FOUND',
    'BUSY', 'TIMEOUT', 'OVERFLOW', 'PIPE', 'INTERRUPTED', 'NO_MEM',
    'NOT_SUPPORTED', 'OTHER',
  ];
  return Number.isSafeInteger(value) && value >= 0 && value < diagnostics.length
    ? diagnostics[value]
    : 'UNKNOWN';
}

function decodeWebUsbProbe(value: number): {
  readonly count: number | null;
  readonly diagnostic: WebUsbProbeDiagnostic;
} {
  if (Number.isSafeInteger(value) && value >= 0) {
    return { count: value, diagnostic: 'OK' };
  }
  if (value === -2) return { count: null, diagnostic: 'UNSUPPORTED' };
  if (value === -1) return { count: null, diagnostic: 'FAILED' };
  return { count: null, diagnostic: 'INVALID' };
}

function decodeExecutionContext(value: number): WasmExecutionContext {
  if (value === 1) return 'WINDOW';
  if (value === 2) return 'DEDICATED_WORKER';
  if (value === 3) return 'OTHER_WORKER';
  if (value === 4) return 'NO_NAVIGATOR';
  return 'UNKNOWN';
}

function toDeviceId(vendorId: number, productId: number): WasmEnumerationDeviceId {
  if (!Number.isInteger(vendorId) || vendorId < 0 || vendorId > 0xffff ||
      !Number.isInteger(productId) || productId < 0 || productId > 0xffff) {
    throw new WasmEnumerationDiagnosticError('WASM_ENUMERATION_FAILED', 'The browser returned invalid USB identifiers');
  }
  return Object.freeze({
    vendorId,
    productId,
    vendorIdHex: `0x${vendorId.toString(16).padStart(4, '0')}`,
    productIdHex: `0x${productId.toString(16).padStart(4, '0')}`,
  });
}
