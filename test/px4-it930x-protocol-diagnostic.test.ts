import { describe, expect, it } from 'vitest';
import {
  runPx4It930xProtocolMock,
  type Px4It930xProtocolModule,
} from '../src/usb/px4-it930x-protocol-diagnostic';

function moduleReturning(value: number): Px4It930xProtocolModule {
  return {
    ccall: async (_name, _returnType, _argTypes, _args, options) => {
      expect(options.async).toBe(true);
      return value;
    },
  };
}

describe('PX4 upstream IT930x protocol fixture', () => {
  it.each([
    [0, 0, 'OK'],
    [1, 0, 'OK'],
    [2, 1, 'REJECTED'],
    [3, 1, 'REJECTED'],
    [4, 1, 'REJECTED'],
    [5, 1, 'REJECTED'],
    [6, 1, 'REJECTED'],
  ] as const)('decodes synthetic scenario %d', async (scenario, nativeResult, diagnostic) => {
    await expect(runPx4It930xProtocolMock(() => moduleReturning(nativeResult), scenario))
      .resolves.toEqual({ diagnostic });
  });

  it('uses the fixed Asyncify ccall ABI and hides raw failures', async () => {
    let call: { name: string; args: readonly number[] } | null = null;
    await expect(runPx4It930xProtocolMock(() => ({
      ccall: async (name, _returnType, _argTypes, args, options) => {
        expect(options.async).toBe(true);
        call = { name, args };
        return 0;
      },
    }), 0)).resolves.toEqual({ diagnostic: 'OK' });
    expect(call).toEqual({ name: 'webts_px4_it930x_protocol_mock', args: [0] });
    await expect(runPx4It930xProtocolMock(() => moduleReturning(255), 0))
      .resolves.toEqual({ diagnostic: 'INTERNAL' });
    await expect(runPx4It930xProtocolMock(async () => {
      throw new Error('raw module error');
    }, 0)).resolves.toEqual({ diagnostic: 'INTERNAL' });
  });

  it('rejects invalid scenarios before loading the module', async () => {
    let loaded = false;
    await expect(runPx4It930xProtocolMock(() => {
      loaded = true;
      return moduleReturning(0);
    }, 7)).resolves.toEqual({ diagnostic: 'INVALID_ARGUMENT' });
    expect(loaded).toBe(false);
  });
});
