import { describe, expect, it } from 'vitest';
import {
  runDedicatedWorkerEnumeration,
  runWorkerEnumeration,
  type WorkerEnumerationReport,
} from '../src/usb/webusb-worker-diagnostic';
import type { LibusbEnumerationModule } from '../src/usb/wasm-enumeration-diagnostic';

function fakeLibusbModule(): LibusbEnumerationModule {
  const heap = new Uint32Array(32);
  return {
    HEAPU32: heap,
    _malloc: () => 4,
    _free: () => undefined,
    ccall: async (name, _returnType, _argTypes, args) => {
      if (name === 'webts_libusb_enumerate') {
        heap[1] = (0x3275 << 16) | 0x0080;
        expect(args[1]).toBe(64);
        return 1;
      }
      if (name === 'webts_libusb_probe_webusb_device_count') return 1;
      throw new Error('unexpected');
    },
    _webts_libusb_probe_execution_context: async () => 2,
    _webts_libusb_get_last_diagnostic: () => 0,
  };
}

const usb = {
  requestDevice: async () => { throw new Error('not available in worker'); },
  getDevices: async () => [{ vendorId: 0x3275, productId: 0x0080 }],
};

describe('Dedicated Worker WebUSB enumeration boundary', () => {
  it('returns only fixed counts/codes from the worker-scoped source', async () => {
    await expect(runWorkerEnumeration(usb, async () => fakeLibusbModule()))
      .resolves.toMatchObject({
        diagnostic: 'NONE', workerWebUsbAvailable: true,
        authorizedDeviceCount: 1, authorizedDeviceCountAfter: 1,
        authorizedDeviceCountDelta: 0, wasmDeviceCount: 1,
        wasmWebUsbDeviceCount: 1, wasmDiagnostic: 'NONE',
        wasmWebUsbDiagnostic: 'OK', wasmExecutionContext: 'DEDICATED_WORKER',
      });
  });

  it('uses fixed errors for unsupported worker USB and module failures', async () => {
    await expect(runWorkerEnumeration(null, async () => fakeLibusbModule()))
      .resolves.toMatchObject({ diagnostic: 'UNSUPPORTED_WEBUSB', workerWebUsbAvailable: false });
    await expect(runWorkerEnumeration(usb, async () => { throw new Error('raw'); }))
      .resolves.toMatchObject({ diagnostic: 'WASM_UNAVAILABLE', workerWebUsbAvailable: true });
  });

  it('terminates the worker after a valid response without exposing payload', async () => {
    let terminated = false;
    let messageListener: ((event: MessageEvent) => void) | undefined;
    const worker = {
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        if (type === 'message') messageListener = listener;
      },
      removeEventListener: () => undefined,
      postMessage: () => queueMicrotask(() => messageListener?.({
        data: {
          type: 'enumeration-result',
          report: {
            diagnostic: 'NONE', workerWebUsbAvailable: true,
            authorizedDeviceCount: 1, authorizedDeviceCountAfter: 1,
            authorizedDeviceCountDelta: 0, wasmDeviceCount: 1,
            wasmWebUsbDeviceCount: 1, wasmDiagnostic: 'NONE',
            wasmWebUsbDiagnostic: 'OK', wasmExecutionContext: 'DEDICATED_WORKER',
          } satisfies WorkerEnumerationReport,
        },
      } as MessageEvent)),
      terminate: () => { terminated = true; },
    };
    await expect(runDedicatedWorkerEnumeration('/wasm.js', 100, () => worker))
      .resolves.toMatchObject({ diagnostic: 'NONE', wasmDeviceCount: 1 });
    expect(terminated).toBe(true);
  });

  it('returns a fixed failure on timeout and does not claim cancellation', async () => {
    let terminated = false;
    const worker = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      postMessage: () => undefined,
      terminate: () => { terminated = true; },
    };
    await expect(runDedicatedWorkerEnumeration('/wasm.js', 1, () => worker))
      .resolves.toMatchObject({ diagnostic: 'WORKER_FAILED', wasmDeviceCount: null });
    expect(terminated).toBe(true);
  });
});
