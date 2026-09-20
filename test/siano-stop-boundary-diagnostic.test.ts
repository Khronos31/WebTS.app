import { describe, expect, it } from 'vitest';
import {
  runSianoStopBoundaryMock,
  type SianoStopBoundaryModule,
} from '../src/usb/siano-stop-boundary-diagnostic';

function moduleReturning(value: number): SianoStopBoundaryModule {
  return {
    ccall: async (_name, _returnType, _argTypes, _args, options) => {
      expect(options.async).toBe(true);
      return value;
    },
  };
}

describe('Siano release-first stop boundary fixture', () => {
  it.each([
    [0, 0, 'OK'],
    [1, 1, 'RELEASE_FAILED'],
    [2, 2, 'PENDING_NOT_SETTLED'],
    [3, 0, 'OK'],
  ] as const)('decodes offline scenario %d', async (scenario, nativeResult, diagnostic) => {
    await expect(runSianoStopBoundaryMock(() => moduleReturning(nativeResult), scenario))
      .resolves.toEqual({ diagnostic });
  });

  it('uses the fixed ABI and Asyncify ccall contract', async () => {
    let call: {
      name: string;
      returnType: string;
      argTypes: readonly string[];
      args: readonly number[];
    } | null = null;
    const report = await runSianoStopBoundaryMock(() => ({
      ccall: async (name, returnType, argTypes, args, options) => {
        expect(options.async).toBe(true);
        call = { name, returnType, argTypes, args };
        return 0;
      },
    }), 0);
    expect(call).toEqual({
      name: 'webts_siano_release_first_stop_mock',
      returnType: 'number',
      argTypes: ['number'],
      args: [0],
    });
    expect(report).toEqual({ diagnostic: 'OK' });
  });

  it('rejects invalid scenarios before loading the module', async () => {
    let loaded = false;
    await expect(runSianoStopBoundaryMock(() => {
      loaded = true;
      return moduleReturning(0);
    }, 4)).resolves.toEqual({ diagnostic: 'INVALID_ARGUMENT' });
    expect(loaded).toBe(false);
    await expect(runSianoStopBoundaryMock(() => moduleReturning(0), 1.5))
      .resolves.toEqual({ diagnostic: 'INVALID_ARGUMENT' });
  });

  it('sanitizes factory, call, and unknown-code failures', async () => {
    await expect(runSianoStopBoundaryMock(async () => {
      throw new Error('raw module failure');
    }, 0)).resolves.toEqual({ diagnostic: 'INTERNAL' });
    await expect(runSianoStopBoundaryMock(() => ({
      ccall: async () => { throw new Error('raw native failure'); },
    }), 0)).resolves.toEqual({ diagnostic: 'INTERNAL' });
    await expect(runSianoStopBoundaryMock(() => moduleReturning(99), 0))
      .resolves.toEqual({ diagnostic: 'INTERNAL' });
  });
});
