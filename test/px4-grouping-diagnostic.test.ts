import { describe, expect, it } from 'vitest';
import { runPx4GroupingMockScenario } from '../src/usb/px4-grouping-diagnostic';

describe('PX4 upstream identity/grouping seam', () => {
  it('uses Asyncify ccall and exposes only the packed aggregate for a ready pair', async () => {
    let call: { name: string; args: readonly number[] } | null = null;
    const report = await runPx4GroupingMockScenario(() => ({
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
        return (1 << 16) | (2 << 8);
      },
    }), 0);
    expect(call).toEqual({ name: 'webts_px4_grouping_mock_summary', args: [0] });
    expect(report).toEqual({
      diagnostic: 'OK',
      candidateCount: 2,
      readyGroupCount: 1,
      incompleteGroupCount: 0,
    });
    expect(report).not.toHaveProperty('serial');
    expect(report).not.toHaveProperty('baseSerial');
  });

  it('decodes incomplete and multi-group counts without exposing identity', async () => {
    const module = (packed: number) => ({ ccall: async () => packed });
    await expect(runPx4GroupingMockScenario(() => module((1 << 24) | (1 << 8)), 1)).resolves.toEqual({
      diagnostic: 'OK',
      candidateCount: 1,
      readyGroupCount: 0,
      incompleteGroupCount: 1,
    });
    await expect(runPx4GroupingMockScenario(() => module((2 << 16) | (4 << 8)), 3)).resolves.toEqual({
      diagnostic: 'OK',
      candidateCount: 4,
      readyGroupCount: 2,
      incompleteGroupCount: 0,
    });
  });

  it('rejects out-of-range scenarios before loading WASM', async () => {
    let loaded = false;
    await expect(runPx4GroupingMockScenario(async () => {
      loaded = true;
      throw new Error('must not load');
    }, 4)).resolves.toEqual({
      diagnostic: 'INVALID_ARGUMENT',
      candidateCount: 0,
      readyGroupCount: 0,
      incompleteGroupCount: 0,
    });
    expect(loaded).toBe(false);
  });

  it('decodes upstream Error::INTERNAL from its explicit 255 value', async () => {
    await expect(runPx4GroupingMockScenario(() => ({
      ccall: async () => 0xff,
    }), 0)).resolves.toMatchObject({ diagnostic: 'INTERNAL' });
  });
});
