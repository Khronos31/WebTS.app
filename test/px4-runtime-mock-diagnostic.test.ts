import { describe, expect, it } from 'vitest';
import { runPx4RuntimeMockOpenClose } from '../src/usb/px4-runtime-mock-diagnostic';

describe('PX4 upstream runtime synthetic lifecycle seam', () => {
  it('uses an Asyncify ccall with no USB-visible arguments', async () => {
    let call: { name: string; argTypes: readonly string[]; args: readonly number[] } | null = null;
    const report = await runPx4RuntimeMockOpenClose(() => ({
      ccall: async (
        name: string,
        _returnType: 'number',
        argTypes: readonly string[],
        args: readonly number[],
        opts: { readonly async: true },
      ) => {
        expect(opts.async).toBe(true);
        call = { name, argTypes, args };
        return 0;
      },
    }));
    expect(call).toEqual({
      name: 'webts_px4_runtime_mock_open_close',
      argTypes: [],
      args: [],
    });
    expect(report).toEqual({ diagnostic: 'OK' });
  });

  it('sanitizes module failures and nonzero fixed errors', async () => {
    await expect(runPx4RuntimeMockOpenClose(() => ({
      ccall: async () => 0xff,
    }))).resolves.toEqual({ diagnostic: 'INTERNAL' });
    await expect(runPx4RuntimeMockOpenClose(async () => {
      throw new Error('raw module failure');
    })).resolves.toEqual({ diagnostic: 'INTERNAL' });
  });
});
