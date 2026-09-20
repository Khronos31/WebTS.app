import { describe, expect, it } from 'vitest';
import {
  ManagedTunerAdapter,
  SianoRioTunerOperations,
} from '../src/tuner';
import type { SianoRioEnumerationModule, WebUsbPermissionSource } from '../src/usb/wasm-enumeration-diagnostic';

const targetUsb = (devices = [{ vendorId: 0x3275, productId: 0x0080 }]): WebUsbPermissionSource => ({
  requestDevice: async () => devices[0] ?? { vendorId: 0, productId: 0 },
  getDevices: async () => devices,
});

function moduleWith(results: Record<string, number>, calls: string[] = []): SianoRioEnumerationModule {
  return {
    ccall: async (name, _returnType, _argTypes, _args, options) => {
      expect(options.async).toBe(true);
      calls.push(name);
      return results[name] ?? 0;
    },
  };
}

describe('SianoRioTunerOperations', () => {
  it('verifies one authorized target and uses the same module for enumerate/open/close', async () => {
    const calls: string[] = [];
    const module = moduleWith({
      webts_siano_enumerate_rio: 1 << 8,
      webts_siano_lifecycle_open: 0,
      webts_siano_lifecycle_close: 0,
    }, calls);
    const operations = new SianoRioTunerOperations({
      usb: targetUsb(),
      moduleFactory: () => module,
    });
    const adapter = new ManagedTunerAdapter(operations);
    await adapter.open();
    await adapter.close();
    expect(calls).toEqual([
      'webts_siano_enumerate_rio',
      'webts_siano_lifecycle_open',
      'webts_siano_lifecycle_close',
    ]);
    expect(adapter.state).toBe('CLOSED');
    expect(operations.diagnostic).toBe('NONE');
  });

  it('rejects a non-single target without loading WASM or calling native open', async () => {
    let loaded = false;
    const operations = new SianoRioTunerOperations({
      usb: targetUsb([{ vendorId: 0x3275, productId: 0x0080 }, { vendorId: 0x3275, productId: 0x0080 }]),
      moduleFactory: () => { loaded = true; return moduleWith({}); },
    });
    const adapter = new ManagedTunerAdapter(operations);
    await expect(adapter.open()).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    expect(loaded).toBe(false);
    expect(operations.diagnostic).toBe('TARGET_MISMATCH');
    expect(adapter.state).toBe('IDLE');
  });

  it('attempts native close when open fails after the session boundary starts', async () => {
    const calls: string[] = [];
    const module = moduleWith({
      webts_siano_enumerate_rio: 1 << 8,
      webts_siano_lifecycle_open: 7,
      webts_siano_lifecycle_close: 0,
    }, calls);
    const adapter = new ManagedTunerAdapter(new SianoRioTunerOperations({ usb: targetUsb(), moduleFactory: () => module }));
    await expect(adapter.open()).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    expect(calls).toEqual([
      'webts_siano_enumerate_rio',
      'webts_siano_lifecycle_open',
      'webts_siano_lifecycle_close',
    ]);
    expect(adapter.state).toBe('IDLE');
  });

  it('does not retain an enumeration-only failure and can retry with a fresh module', async () => {
    let factoryCalls = 0;
    const first = moduleWith({ webts_siano_enumerate_rio: 0 });
    const second = moduleWith({
      webts_siano_enumerate_rio: 1 << 8,
      webts_siano_lifecycle_open: 0,
      webts_siano_lifecycle_close: 0,
    });
    const operations = new SianoRioTunerOperations({
      usb: targetUsb(),
      moduleFactory: () => ++factoryCalls === 1 ? first : second,
    });
    const adapter = new ManagedTunerAdapter(operations);
    await expect(adapter.open()).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    expect(adapter.state).toBe('IDLE');
    await adapter.open();
    await adapter.close();
    expect(factoryCalls).toBe(2);
    expect(adapter.state).toBe('CLOSED');
  });

  it('keeps the session retryable after close failure and supports a later close', async () => {
    let closeCalls = 0;
    const module: SianoRioEnumerationModule = {
      ccall: async (name) => {
        if (name === 'webts_siano_lifecycle_close') {
          closeCalls += 1;
          return closeCalls === 1 ? 7 : 0;
        }
        if (name === 'webts_siano_enumerate_rio') return 1 << 8;
        return 0;
      },
    };
    const adapter = new ManagedTunerAdapter(new SianoRioTunerOperations({ usb: targetUsb(), moduleFactory: () => module }));
    await adapter.open();
    await expect(adapter.close()).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    expect(adapter.state).toBe('OPEN');
    await adapter.close();
    expect(adapter.state).toBe('CLOSED');
    expect(closeCalls).toBe(2);
  });

  it('inherits ManagedTunerAdapter busy and disconnect handling', async () => {
    let resolveOpen!: (value: number) => void;
    const opening = new Promise<number>((resolve) => { resolveOpen = resolve; });
    const calls: string[] = [];
    const module: SianoRioEnumerationModule = {
      ccall: async (name) => {
        calls.push(name);
        if (name === 'webts_siano_enumerate_rio') return 1 << 8;
        if (name === 'webts_siano_lifecycle_open') return opening;
        return 0;
      },
    };
    const adapter = new ManagedTunerAdapter(new SianoRioTunerOperations({ usb: targetUsb(), moduleFactory: () => module }));
    const open = adapter.open();
    await expect(adapter.open()).rejects.toMatchObject({ code: 'BUSY' });
    adapter.disconnect();
    resolveOpen(0);
    await expect(open).rejects.toMatchObject({ code: 'ABORTED' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(adapter.state).toBe('DISCONNECTED');
    expect(calls).toContain('webts_siano_lifecycle_close');
  });

  it('leaves firmware, tune, and stream operations unimplemented', async () => {
    const module = moduleWith({ webts_siano_enumerate_rio: 1 << 8 });
    const adapter = new ManagedTunerAdapter(new SianoRioTunerOperations({ usb: targetUsb(), moduleFactory: () => module }));
    await expect(adapter.firmware()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await adapter.open();
    await expect(adapter.firmware()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(adapter.tune({ channel: 13 })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    // TUNED cannot be reached while tune is intentionally unimplemented; the
    // lifecycle adapter therefore rejects start at the state-machine boundary.
    await expect(adapter.start()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
