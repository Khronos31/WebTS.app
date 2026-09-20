import { describe, expect, it } from 'vitest';
import {
  runB25CoreNoCardSmoke,
  runB25FacadeNoCardSmoke,
} from '../src/usb/b25-core-diagnostic';

describe('libaribb25 source-only core smoke', () => {
  it('calls only the fixed no-input ABI and reports OK', async () => {
    let call: { name: string; argTypes: readonly string[]; args: readonly number[] } | null = null;
    const result = await runB25CoreNoCardSmoke(() => ({
      ccall: (name, returnType, argTypes, args) => {
        expect(returnType).toBe('number');
        call = { name, argTypes, args };
        return 0;
      },
    }));
    expect(call).toEqual({ name: 'webts_b25_core_no_card_smoke', argTypes: [], args: [] });
    expect(result).toEqual({ diagnostic: 'OK' });
  });

  it('sanitizes nonzero core codes and module errors', async () => {
    await expect(runB25CoreNoCardSmoke(() => ({
      ccall: () => 2,
    }))).resolves.toEqual({ diagnostic: 'INTERNAL' });
    await expect(runB25CoreNoCardSmoke(async () => {
      throw new Error('raw core error');
    })).resolves.toEqual({ diagnostic: 'INTERNAL' });
  });

  it('runs the upstream facade create/configure/release ABI without card or TS input', async () => {
    let call: { name: string; args: readonly number[] } | null = null;
    await expect(runB25FacadeNoCardSmoke(() => ({
      ccall: (name, _returnType, _argTypes, args) => {
        call = { name, args };
        return 0;
      },
    }))).resolves.toEqual({ diagnostic: 'OK' });
    expect(call).toEqual({ name: 'webts_b25_facade_no_card_smoke', args: [] });
    await expect(runB25FacadeNoCardSmoke(() => ({
      ccall: () => 2,
    }))).resolves.toEqual({ diagnostic: 'INTERNAL' });
  });
});
