import { describe, expect, it } from 'vitest';
import {
  runSianoVersionResponseMock,
  type SianoVersionResponseModule,
} from '../src/usb/siano-version-response-diagnostic';

function moduleReturning(value: number): SianoVersionResponseModule {
  return {
    ccall: async (_name, _returnType, _argTypes, _args, options) => {
      expect(options.async).toBe(true);
      return value;
    },
  };
}

describe('Siano upstream version-response fixture', () => {
  it.each([
    [0, 0, 'OK'],
    [1, 1, 'SPLIT_OK'],
    [2, 2, 'INVALID_FRAME'],
    [3, 3, 'TIMEOUT'],
    [4, 4, 'RETRY_SUPPRESSED'],
  ] as const)('decodes scenario %d', async (scenario, nativeResult, diagnostic) => {
    await expect(runSianoVersionResponseMock(() => moduleReturning(nativeResult), scenario))
      .resolves.toEqual({ diagnostic });
  });

  it('uses only the fixed Asyncify ccall ABI', async () => {
    let observed: { name: string; argTypes: readonly string[]; args: readonly number[] } | null = null;
    const report = await runSianoVersionResponseMock(() => ({
      ccall: async (name, _returnType, argTypes, args, options) => {
        expect(options.async).toBe(true);
        observed = { name, argTypes, args };
        return 0;
      },
    }), 0);
    expect(observed).toEqual({
      name: 'webts_siano_version_response_mock',
      argTypes: ['number'],
      args: [0],
    });
    expect(report).toEqual({ diagnostic: 'OK' });
  });

  it('rejects invalid scenarios before module loading and sanitizes failures', async () => {
    let loaded = false;
    await expect(runSianoVersionResponseMock(() => {
      loaded = true;
      return moduleReturning(0);
    }, 5)).resolves.toEqual({ diagnostic: 'INVALID_ARGUMENT' });
    expect(loaded).toBe(false);
    await expect(runSianoVersionResponseMock(async () => {
      throw new Error('raw factory error');
    }, 0)).resolves.toEqual({ diagnostic: 'INTERNAL' });
    await expect(runSianoVersionResponseMock(() => moduleReturning(99), 0))
      .resolves.toEqual({ diagnostic: 'INTERNAL' });
  });
});
