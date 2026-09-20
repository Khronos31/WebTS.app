import { describe, expect, it } from 'vitest';
import {
  WasmEnumerationDiagnosticError,
  enumerateAuthorizedDevices,
  enumerateAuthorizedSianoRioDevices,
  inspectLocalSianoFirmware,
  runSianoVersionHandshake,
  runAuthorizedSianoRioLifecycle,
  requestAndEnumerateAuthorizedDevices,
  SIANO_RIO_FIRMWARE_MAX_BYTES,
  SIANO_RIO_FIRMWARE_SHA256,
} from '../src/usb/wasm-enumeration-diagnostic';

function fakeModule(values: number[], diagnostic = 0, webUsbDeviceCount = 0, context = 1) {
  const heap = new Uint32Array(32);
  return {
    HEAPU32: heap,
    ccall: (name: string, _returnType: 'number', _argTypes: readonly string[], args: readonly number[], opts: { readonly async: true }) => {
      expect(opts.async).toBe(true);
      if (name === 'webts_libusb_enumerate') {
        heap.set(values, args[0] / 4);
        return values.length;
      }
      if (name === 'webts_libusb_probe_webusb_device_count') return webUsbDeviceCount;
      throw new Error(`unexpected ccall: ${name}`);
    },
    _malloc: () => 4 * 4,
    _free: () => undefined,
    _webts_libusb_enumerate: (pointer: number, capacity: number) => {
      expect(capacity).toBe(64);
      heap.set(values, pointer / 4);
      return values.length;
    },
    _webts_libusb_probe_webusb_device_count: () => webUsbDeviceCount,
    _webts_libusb_probe_execution_context: () => context,
    _webts_libusb_get_last_diagnostic: () => diagnostic,
  };
}

describe('write-free WebUSB -> libusb WASM enumeration seam', () => {
  it('requests permission first and returns only VID/PID diagnostics', async () => {
    const calls: string[] = [];
    const report = await requestAndEnumerateAuthorizedDevices(
      {
        requestDevice: async () => {
          calls.push('requestDevice');
          return { vendorId: 0x0511, productId: 0x084a };
        },
      },
      async () => {
        calls.push('module');
        return fakeModule([(0x0511 << 16) | 0x084a, (0x3275 << 16) | 0x0080]);
      },
    );

    expect(calls).toEqual(['requestDevice', 'module']);
    expect(report).toEqual({
      permissionDevice: { vendorId: 0x0511, productId: 0x084a, vendorIdHex: '0x0511', productIdHex: '0x084a' },
      wasmDeviceCount: 2,
      wasmDevices: [
        { vendorId: 0x0511, productId: 0x084a, vendorIdHex: '0x0511', productIdHex: '0x084a' },
        { vendorId: 0x3275, productId: 0x0080, vendorIdHex: '0x3275', productIdHex: '0x0080' },
      ],
      wasmDiagnostic: 'NONE',
      wasmWebUsbDeviceCount: 0,
      wasmWebUsbDiagnostic: 'OK',
      wasmExecutionContext: 'WINDOW',
    });
    expect(report).not.toHaveProperty('serialNumber');
  });

  it('frees the WASM buffer and sanitizes enumeration failures', async () => {
    let freed = false;
    await expect(requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }) },
      () => ({
        HEAPU32: new Uint32Array(8),
        ccall: () => -1,
        _malloc: () => 4,
        _free: () => { freed = true; },
        _webts_libusb_enumerate: () => -1,
        _webts_libusb_probe_webusb_device_count: () => 0,
        _webts_libusb_probe_execution_context: () => 1,
        _webts_libusb_get_last_diagnostic: () => 0,
      }),
    )).rejects.toMatchObject({ code: 'WASM_ENUMERATION_FAILED' });
    expect(freed).toBe(true);
  });

  it('awaits the Asyncify promise returned by the generated WASM export', async () => {
    const heap = new Uint32Array(8);
    const report = await requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }) },
      () => ({
        HEAPU32: heap,
        ccall: async (name: string, _returnType: 'number', _argTypes: readonly string[], args: readonly number[], opts: { readonly async: true }) => {
          expect(opts.async).toBe(true);
          if (name === 'webts_libusb_enumerate') {
            await Promise.resolve();
            heap[args[0] / 4] = (1 << 16) | 2;
            return 1;
          }
          if (name === 'webts_libusb_probe_webusb_device_count') return 0;
          throw new Error(`unexpected ccall: ${name}`);
        },
        _malloc: () => 4,
        _free: () => undefined,
        _webts_libusb_enumerate: async (pointer: number) => {
          await Promise.resolve();
          heap[pointer / 4] = (1 << 16) | 2;
          return 1;
        },
        _webts_libusb_probe_webusb_device_count: () => 0,
        _webts_libusb_probe_execution_context: () => 1,
        _webts_libusb_get_last_diagnostic: () => 0,
      }),
    );
    expect(report.wasmDeviceCount).toBe(1);
    expect(report.wasmDevices[0]).toMatchObject({ vendorId: 1, productId: 2 });
    expect(report.wasmDiagnostic).toBe('NONE');
    expect(report.wasmWebUsbDeviceCount).toBe(0);
    expect(report.wasmExecutionContext).toBe('WINDOW');
  });

  it('does not expose raw module exceptions or load WASM before permission', async () => {
    let loaded = false;
    await expect(requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }) },
      async () => {
        loaded = true;
        throw new Error('secret device path');
      },
    )).rejects.toMatchObject({ code: 'WASM_UNAVAILABLE' });
    expect(loaded).toBe(true);
  });

  it('rejects invalid module ABI without opening any device', async () => {
    await expect(requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }) },
      () => ({} as never),
    )).rejects.toBeInstanceOf(WasmEnumerationDiagnosticError);
  });

  it('sanitizes runtime getter failures during ABI validation', async () => {
    const brokenModule = {} as Record<string, unknown>;
    Object.defineProperty(brokenModule, 'HEAPU32', {
      get: () => { throw new Error('private runtime failure'); },
    });
    await expect(requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }) },
      () => brokenModule as never,
    )).rejects.toMatchObject({ code: 'INVALID_MODULE' });
  });

  it('sanitizes permission failures without exposing browser exception text', async () => {
    await expect(requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => { throw new Error('private permission details'); } },
      () => fakeModule([]),
    )).rejects.toMatchObject({ code: 'PERMISSION_REQUEST_FAILED' });
  });

  it('enumerates only already-authorized devices without opening a chooser', async () => {
    let requested = false;
    let getDevicesCalls = 0;
    const report = await enumerateAuthorizedDevices(
      {
        requestDevice: async () => {
          requested = true;
          return { vendorId: 1, productId: 2 };
        },
        getDevices: async () => {
          getDevicesCalls += 1;
          return [{ vendorId: 0x3275, productId: 0x0080 }];
        },
      },
      () => fakeModule([], 0, 1),
    );
    expect(requested).toBe(false);
    expect(getDevicesCalls).toBe(2);
    expect(report.authorizedDeviceCount).toBe(1);
    expect(report.authorizedDevices[0]).toMatchObject({ vendorId: 0x3275, productId: 0x0080 });
    expect(report.authorizedDeviceCountAfter).toBe(1);
    expect(report.authorizedDeviceCountDelta).toBe(0);
    expect(report.wasmDeviceCount).toBe(0);
    expect(report.wasmDiagnostic).toBe('NONE');
    expect(report.wasmWebUsbDeviceCount).toBe(1);
    expect(report.wasmExecutionContext).toBe('WINDOW');
  });

  it('uses getDevices errors as a fixed diagnostic code', async () => {
    await expect(enumerateAuthorizedDevices(
      {
        requestDevice: async () => ({ vendorId: 1, productId: 2 }),
        getDevices: async () => { throw new Error('private browser details'); },
      },
      () => fakeModule([]),
    )).rejects.toMatchObject({ code: 'AUTHORIZED_DEVICE_QUERY_FAILED' });
  });

  it('returns only the fixed libusb diagnostic enum, never raw log text', async () => {
    const report = await requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }) },
      () => fakeModule([], 1),
    );
    expect(report.wasmDiagnostic).toBe('IO');

    const unknown = await requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }) },
      () => fakeModule([], 999),
    );
    expect(unknown.wasmDiagnostic).toBe('UNKNOWN');
  });

  it('returns a fixed execution-context enum', async () => {
    const worker = await requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }) },
      () => fakeModule([], 0, 0, 2),
    );
    expect(worker.wasmExecutionContext).toBe('DEDICATED_WORKER');

    const unknown = await requestAndEnumerateAuthorizedDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }) },
      () => fakeModule([], 0, 0, 999),
    );
    expect(unknown.wasmExecutionContext).toBe('UNKNOWN');
  });

  it('uses the vendored Siano predicate through an Asyncify ccall without opening a chooser', async () => {
    let requested = false;
    let ccallName = '';
    const report = await enumerateAuthorizedSianoRioDevices(
      {
        requestDevice: async () => {
          requested = true;
          return { vendorId: 1, productId: 2 };
        },
        getDevices: async () => [{ vendorId: 0x3275, productId: 0x0080 }],
      },
      () => ({
        ccall: async (name: string, _returnType: 'number', args: readonly string[], values: readonly number[], opts: { readonly async: true }) => {
          ccallName = name;
          expect(args).toEqual([]);
          expect(values).toEqual([]);
          expect(opts.async).toBe(true);
          await Promise.resolve();
          return (2 << 8) | 0;
        },
      }),
    );
    expect(requested).toBe(false);
    expect(ccallName).toBe('webts_siano_enumerate_rio');
    expect(report).toEqual({ authorizedDeviceCount: 1, supportedDeviceCount: 2, diagnostic: 'NONE' });
  });

  it('sanitizes Siano module failures and raw diagnostics', async () => {
    await expect(enumerateAuthorizedSianoRioDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }), getDevices: async () => [] },
      () => ({ ccall: async () => { throw new Error('private libusb log'); } }),
    )).rejects.toMatchObject({ code: 'WASM_ENUMERATION_FAILED' });

    const report = await enumerateAuthorizedSianoRioDevices(
      { requestDevice: async () => ({ vendorId: 1, productId: 2 }), getDevices: async () => [] },
      () => ({ ccall: () => (3 << 8) | 999 }),
    );
    expect(report).toEqual({ authorizedDeviceCount: 0, supportedDeviceCount: 3, diagnostic: 'UNKNOWN' });
  });

  it('requires exactly one PX-S1UD and runs open then close on the same module', async () => {
    const calls: string[] = [];
    const report = await runAuthorizedSianoRioLifecycle(
      {
        requestDevice: async () => ({ vendorId: 1, productId: 2 }),
        getDevices: async () => [{ vendorId: 0x3275, productId: 0x0080 }],
      },
      () => ({
        ccall: async (name: string, _returnType: 'number', _args: readonly string[], values: readonly number[], opts: { readonly async: true }) => {
          expect(opts.async).toBe(true);
          calls.push(name);
          if (name === 'webts_siano_enumerate_rio') return 1 << 8;
          if (name === 'webts_siano_lifecycle_open_close_probe') {
            expect(values).toEqual([0x53494f31, 0]);
            return 0;
          }
          throw new Error('unexpected call');
        },
      }),
    );
    expect(calls).toEqual([
      'webts_siano_enumerate_rio',
      'webts_siano_lifecycle_open_close_probe',
    ]);
    expect(report.lifecycleOpenDiagnostic).toBe('NONE');
    expect(report.lifecycleCloseDiagnostic).toBe('NONE');
  });

  it('always attempts close after an open failure and refuses non-target sets', async () => {
    const calls: string[] = [];
    const failedOpenReport = await runAuthorizedSianoRioLifecycle(
      {
        requestDevice: async () => ({ vendorId: 1, productId: 2 }),
        getDevices: async () => [{ vendorId: 0x3275, productId: 0x0080 }],
      },
      () => ({
        ccall: async (name: string) => {
          calls.push(name);
          if (name === 'webts_siano_enumerate_rio') return 1 << 8;
          if (name === 'webts_siano_lifecycle_open_close_probe') return 0x07 | (0 << 8);
          throw new Error('unexpected call');
        },
      }),
    );
    expect(calls).toEqual([
      'webts_siano_enumerate_rio',
      'webts_siano_lifecycle_open_close_probe',
    ]);
    expect(failedOpenReport.lifecycleOpenDiagnostic).toBe('TIMEOUT');
    expect(failedOpenReport.lifecycleCloseDiagnostic).toBe('NONE');

    await expect(runAuthorizedSianoRioLifecycle(
      {
        requestDevice: async () => ({ vendorId: 1, productId: 2 }),
        getDevices: async () => [{ vendorId: 0x0511, productId: 0x084a }],
      },
      () => ({ ccall: () => 0 }),
    )).rejects.toMatchObject({ code: 'SIANO_TARGET_MISMATCH' });
  });

  it('uses the bounded stream/version bridge with Asyncify and fixed diagnostics', async () => {
    let call: { name: string; args: readonly number[] } | null = null;
    const report = await runSianoVersionHandshake(() => ({
      ccall: async (
        name: string,
        _returnType: 'number',
        argTypes: readonly string[],
        args: readonly number[],
        opts: { readonly async: true },
      ) => {
        expect(argTypes).toEqual(['number']);
        expect(opts.async).toBe(true);
        call = { name, args };
        return (7 << 8) | 1;
      },
    }));
    expect(call).toEqual({ name: 'webts_siano_lifecycle_start_version', args: [0x53494f31] });
    expect(report).toEqual({ startDiagnostic: 'IO', versionDiagnostic: 'TIMEOUT' });
  });

  it('keeps conservative native handshake failures as OTHER', async () => {
    const report = await runSianoVersionHandshake(() => ({
      ccall: async () => (13 << 8) | 13,
    }));
    expect(report).toEqual({ startDiagnostic: 'OTHER', versionDiagnostic: 'OTHER' });
  });

  it('hash-gates local firmware before loading WASM and wipes the input bytes', async () => {
    const bytes = new Uint8Array(12);
    let loaded = false;
    const report = await inspectLocalSianoFirmware(
      { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer },
      async () => {
        loaded = true;
        throw new Error('must not load after hash mismatch');
      },
      async () => new Uint8Array(32).buffer,
    );
    expect(report).toEqual({ diagnostic: 'FIRMWARE_HASH_MISMATCH' });
    expect(loaded).toBe(false);
    expect(bytes.every((value) => value === 0)).toBe(true);
  });

  it('copies matching synthetic bytes through Asyncify ccall and cleans the WASM heap', async () => {
    const bytes = new Uint8Array(12);
    const heap = new Uint8Array(64);
    let freed = false;
    let staged = false;
    const expectedDigest = new Uint8Array(SIANO_RIO_FIRMWARE_SHA256.match(/../g)!
      .map((pair) => Number.parseInt(pair, 16)));
    const report = await inspectLocalSianoFirmware(
      { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer },
      () => ({
        HEAPU8: heap,
        _malloc: () => 8,
        _free: (pointer: number) => {
          expect(pointer).toBe(8);
          freed = true;
        },
        ccall: async (
          name: string,
          _returnType: 'number',
          argTypes: readonly string[],
          args: readonly number[],
          opts: { readonly async: true },
        ) => {
          expect(name).toBe('webts_siano_firmware_validate_stage');
          expect(argTypes).toEqual(['number', 'number']);
          expect(args).toEqual([8, 12]);
          expect(opts.async).toBe(true);
          expect(Array.from(heap.slice(8, 20))).toEqual(Array.from(bytes));
          staged = true;
          return 0;
        },
      }),
      async () => expectedDigest.buffer,
    );
    expect(report).toEqual({ diagnostic: 'NONE' });
    expect(staged).toBe(true);
    expect(freed).toBe(true);
    expect(Array.from(heap.slice(8, 20))).toEqual(new Array(12).fill(0));
    expect(bytes.every((value) => value === 0)).toBe(true);
    expect(expectedDigest.every((value) => value === 0)).toBe(true);
  });

  it('maps fixed header and size diagnostics without exposing raw errors', async () => {
    const bytes = new Uint8Array(12);
    const digest = async () => new Uint8Array(SIANO_RIO_FIRMWARE_SHA256.match(/../g)!
      .map((pair) => Number.parseInt(pair, 16))).buffer;
    const header = await inspectLocalSianoFirmware(
      { size: 12, arrayBuffer: async () => bytes.buffer },
      () => ({
        HEAPU8: new Uint8Array(32),
        _malloc: () => 4,
        _free: () => undefined,
        ccall: async () => 3,
      }),
      digest,
    );
    expect(header).toEqual({ diagnostic: 'FIRMWARE_HEADER_INVALID' });

    let read = false;
    const oversized = await inspectLocalSianoFirmware(
      { size: SIANO_RIO_FIRMWARE_MAX_BYTES + 1, arrayBuffer: async () => {
        read = true;
        return bytes.buffer;
      } },
      () => { throw new Error('must not load'); },
      digest,
    );
    expect(oversized).toEqual({ diagnostic: 'FIRMWARE_TOO_LARGE' });
    expect(read).toBe(false);
  });

  it('wipes a returned ArrayBuffer even when its reported file size mismatches', async () => {
    const bytes = new Uint8Array(12);
    const report = await inspectLocalSianoFirmware(
      { size: 13, arrayBuffer: async () => bytes.buffer },
      () => { throw new Error('must not load'); },
    );
    expect(report).toEqual({ diagnostic: 'FIRMWARE_READ_FAILED' });
    expect(bytes.every((value) => value === 0)).toBe(true);
  });
});
