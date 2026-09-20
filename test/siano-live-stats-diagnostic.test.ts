import { describe, expect, it } from 'vitest';
import {
  runSianoLiveStatsMock,
  runSianoLiveStatsSnapshot,
  type SianoLiveStatsModule,
} from '../src/usb/siano-live-stats-diagnostic';

const UNMEASURED = (1 << 5) | (1 << 6) | (1 << 7);
const MEASURED = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3);
const SATURATED = 1 << 9;
const WORDS = 18;

function fakeModule(nativeResult: number, words: readonly number[], expectedName: string): SianoLiveStatsModule {
  const heap = new Uint8Array(128);
  return {
    HEAPU8: heap,
    _malloc: () => 8,
    _free: () => undefined,
    ccall: async (name, _returnType, argTypes, args, options) => {
      expect(name).toBe(expectedName);
      expect(argTypes).toEqual(['number', 'number', 'number']);
      expect(args[2]).toBe(WORDS);
      expect(options.async).toBe(true);
      const view = new DataView(heap.buffer);
      words.forEach((word, index) => view.setUint32(8 + index * 4, word >>> 0, true));
      return nativeResult;
    },
  };
}

describe('Siano live statistics ABI', () => {
  it('decodes source-backed uint64 counters exactly', async () => {
    const words = [0, 2, 7, MEASURED, 3, 4, 2, 4, 5, 0, 6, 0, 7, 0, 8, 0, 1, 0];
    await expect(runSianoLiveStatsMock(() => fakeModule(0, words, 'webts_siano_live_stats_mock'), 1))
      .resolves.toEqual({
        diagnostic: 'OK', state: 'STREAMING', generation: 7,
        queueMeasured: true, dropsMeasured: true, transfersMeasured: true,
        streamErrorMeasured: true, queueClosed: false, countersSaturated: false,
        acceptedBytes: '5', dequeuedBytes: '6', droppedBytes: '7', truncatedBytes: '8',
        transferErrors: '1', queueChunks: 3, droppedChunks: 4, activeTransfers: 2,
        streamError: 'TIMEOUT',
      });
  });

  it('preserves exact uint64 values and saturation state', async () => {
    const words = [0, 2, 1, MEASURED | SATURATED, 0, 0, 0, 0,
      0xffffffff, 0xffffffff, 0, 1, 2, 0, 3, 0, 4, 0];
    await expect(runSianoLiveStatsMock(() => fakeModule(0, words, 'webts_siano_live_stats_mock'), 1))
      .resolves.toMatchObject({ countersSaturated: true, acceptedBytes: '18446744073709551615',
        dequeuedBytes: '4294967296', droppedBytes: '2', truncatedBytes: '3', transferErrors: '4' });
  });

  it.each([
    [1, 'STALE', 'OPEN'], [3, 'BUSY', 'STARTING'], [4, 'POISONED', 'POISONED'],
  ] as const)('decodes fixed diagnostic %d without exposing raw values', async (raw, diagnostic, state) => {
    const words = [raw, state === 'STARTING' ? 7 : state === 'POISONED' ? 4 : 1, 12, UNMEASURED,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    await expect(runSianoLiveStatsSnapshot(() => fakeModule(raw, words, 'webts_siano_live_stats_snapshot'), 12))
      .resolves.toMatchObject({ diagnostic, state, generation: 12,
        acceptedBytes: null, dequeuedBytes: null, droppedBytes: null,
        truncatedBytes: null, transferErrors: null });
  });

  it('preserves idle snapshots without pretending counters are measured', async () => {
    const words = [0, 0, 0, UNMEASURED, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    await expect(runSianoLiveStatsSnapshot(() => fakeModule(0, words, 'webts_siano_live_stats_snapshot')))
      .resolves.toMatchObject({ diagnostic: 'OK', state: 'IDLE', queueMeasured: false,
        queueChunks: null, activeTransfers: null, streamError: null });
  });

  it('rejects invalid inputs, module failures, and raw ABI mismatches', async () => {
    await expect(runSianoLiveStatsMock(() => fakeModule(0, [], 'unused'), 4))
      .resolves.toMatchObject({ diagnostic: 'INVALID_ARGUMENT' });
    await expect(runSianoLiveStatsMock(() => fakeModule(0, [], 'unused'), 5))
      .resolves.toMatchObject({ diagnostic: 'INVALID_ARGUMENT' });
    await expect(runSianoLiveStatsSnapshot(() => { throw new Error('raw'); }))
      .resolves.toMatchObject({ diagnostic: 'INTERNAL' });
    await expect(runSianoLiveStatsSnapshot(() => fakeModule(3,
      [0, 0, 0, UNMEASURED, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      'webts_siano_live_stats_snapshot'))).resolves.toMatchObject({ diagnostic: 'INTERNAL' });
    const invalidPointerModule = { ...fakeModule(0, [], 'webts_siano_live_stats_mock'), _malloc: () => 0 };
    await expect(runSianoLiveStatsMock(() => invalidPointerModule, 0))
      .resolves.toMatchObject({ diagnostic: 'INTERNAL' });
    await expect(runSianoLiveStatsMock(() => fakeModule(0,
      [0, 99, 1, MEASURED, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      'webts_siano_live_stats_mock'), 1)).resolves.toMatchObject({ diagnostic: 'INTERNAL' });
    await expect(runSianoLiveStatsMock(() => fakeModule(0,
      [0, 2, 1, MEASURED, 1, 0, 0, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      'webts_siano_live_stats_mock'), 1)).resolves.toMatchObject({ diagnostic: 'INTERNAL' });
  });

  it('sanitizes module getter failures', async () => {
    const bad = {} as SianoLiveStatsModule;
    Object.defineProperty(bad, 'HEAPU8', { get: () => { throw new Error('raw'); } });
    await expect(runSianoLiveStatsMock(() => bad, 0))
      .resolves.toMatchObject({ diagnostic: 'INTERNAL' });
  });
});
