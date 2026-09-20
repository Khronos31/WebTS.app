import { describe, expect, it } from 'vitest';
import { runPx4TaggedTsDemuxMock, type Px4TaggedTsDemuxModule } from '../src/usb/px4-tagged-ts-demux-diagnostic';

const WORDS = 12;
function fakeModule(raw: number, words: readonly number[]): Px4TaggedTsDemuxModule {
  const heap = new Uint8Array(128);
  return {
    HEAPU8: heap, _malloc: () => 8, _free: () => undefined,
    ccall: async (_name, _returnType, _argTypes, args, options) => {
      expect(args[2]).toBe(WORDS); expect(options.async).toBe(true);
      const view = new DataView(heap.buffer);
      words.forEach((word, index) => view.setUint32(8 + index * 4, word >>> 0, true));
      return raw;
    },
  };
}

describe('PX4 tagged TS demux ABI', () => {
  it('decodes fixed aggregate counters for all four tags', async () => {
    await expect(runPx4TaggedTsDemuxMock(() => fakeModule(0,
      [0, 752, 4, 0, 0, 0, 0, 1, 1, 1, 1, 4]), 0))
      .resolves.toMatchObject({ diagnostic: 'OK', emittedPackets: 4,
        receiverPacketCounts: [1, 1, 1, 1], packetTagsVerified: true });
  });

  it('covers split input, invalid tags, sync loss, retry, reset, and input bounds', async () => {
    await expect(runPx4TaggedTsDemuxMock(() => fakeModule(0,
      [0, 752, 4, 0, 0, 0, 0, 1, 1, 1, 1, 4]), 1))
      .resolves.toMatchObject({ diagnostic: 'OK', emittedPackets: 4 });
    await expect(runPx4TaggedTsDemuxMock(() => fakeModule(0,
      [0, 2068, 8, 188, 2, 1, 0, 2, 2, 2, 2, 0x34]), 2))
      .resolves.toMatchObject({ diagnostic: 'OK', invalidTagPackets: 2, syncLossEvents: 1 });
    await expect(runPx4TaggedTsDemuxMock(() => fakeModule(0,
      [0, 752, 4, 0, 0, 0, 0, 1, 1, 1, 1, 1]), 3))
      .resolves.toMatchObject({ diagnostic: 'OK', retryVerified: true, bufferedBytes: 0 });
    await expect(runPx4TaggedTsDemuxMock(() => fakeModule(0,
      [0, 752, 4, 0, 0, 0, 0, 1, 1, 1, 1, 2]), 4))
      .resolves.toMatchObject({ diagnostic: 'OK', resetVerified: true, bufferedBytes: 0 });
    await expect(runPx4TaggedTsDemuxMock(() => fakeModule(0,
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8]), 5))
      .resolves.toMatchObject({ diagnostic: 'OK', boundaryVerified: true });
  });

  it('sanitizes invalid arguments and module failures', async () => {
    await expect(runPx4TaggedTsDemuxMock(() => fakeModule(0, []), 6))
      .resolves.toMatchObject({ diagnostic: 'INVALID_ARGUMENT' });
    await expect(runPx4TaggedTsDemuxMock(() => { throw new Error('raw'); }, 0))
      .resolves.toMatchObject({ diagnostic: 'INTERNAL' });
    await expect(runPx4TaggedTsDemuxMock(() => fakeModule(255,
      [255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0))
      .resolves.toMatchObject({ diagnostic: 'INTERNAL' });
  });
});
