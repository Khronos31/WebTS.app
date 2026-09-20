import { describe, expect, it } from 'vitest';
import { runSianoTsQueueMock, type SianoTsQueueModule } from '../src/usb/siano-ts-queue-diagnostic';

function moduleReturning(nativeResult: number, words: readonly number[]): SianoTsQueueModule {
  const heap = new Uint8Array(128);
  let freed = 0;
  return {
    HEAPU8: heap,
    _malloc: () => 8,
    _free: () => { freed += 1; },
    ccall: async (name, _returnType, argTypes, args, options) => {
      expect(name).toBe('webts_siano_ts_queue_mock');
      expect(argTypes).toEqual(['number', 'number', 'number']);
      expect(args[2]).toBe(7);
      expect(options.async).toBe(true);
      const view = new DataView(heap.buffer);
      words.forEach((word, index) => view.setUint32(8 + index * 4, word, true));
      return nativeResult;
    },
  };
}

describe('Siano upstream ts_queue fixture', () => {
  it('decodes fixed FIFO/drain/reinitialization statistics without payload', async () => {
    await expect(runSianoTsQueueMock(() => moduleReturning(0, [0, 5, 5, 0, 0, 6, 2]), 0))
      .resolves.toEqual({ diagnostic: 'OK', acceptedBytes: 5, dequeuedBytes: 5,
        droppedChunks: 0, queuedChunks: 0, fifoVerified: true, reinitialized: true, acceptedChunks: 2 });
  });

  it.each([
    [1, [0, 256, 0, 1, 256, 0, 256]],
    [2, [0, 1, 1, 1, 0, 1, 1]],
    [3, [0, 16384, 16384, 0, 0, 0, 1]],
    [4, [0, 2, 0, 0, 1, 5, 1]],
  ] as const)('decodes scenario %d aggregate stats', async (scenario, words) => {
    await expect(runSianoTsQueueMock(() => moduleReturning(0, words), scenario))
      .resolves.toMatchObject({ diagnostic: 'OK', acceptedBytes: words[1], dequeuedBytes: words[2],
        droppedChunks: words[3], queuedChunks: words[4], acceptedChunks: words[6] });
  });

  it('sanitizes invalid scenarios, ABI failures, and native rejection', async () => {
    let loaded = false;
    await expect(runSianoTsQueueMock(() => { loaded = true; return moduleReturning(0, []); }, 5))
      .resolves.toMatchObject({ diagnostic: 'INVALID_ARGUMENT' });
    expect(loaded).toBe(false);
    await expect(runSianoTsQueueMock(() => moduleReturning(1, [1, 0, 0, 0, 0, 0, 0]), 0))
      .resolves.toMatchObject({ diagnostic: 'REJECTED' });
    await expect(runSianoTsQueueMock(async () => { throw new Error('raw'); }, 0))
      .resolves.toMatchObject({ diagnostic: 'INTERNAL' });
  });
});
