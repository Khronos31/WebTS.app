// Worker 側の復号ループ。
//
// 実運用でも復号は Worker で回す。main thread で回すとフレームごとに
// 数ミリ秒を占有して UI が詰まるうえ、背面タブでのスロットリングも受ける。
// 測る場所は動かす場所と同じでなければ意味がない。

import { Mpeg2Decoder, SEQUENCE_END_CODE, STEP, type Mpeg2Sequence } from './mpeg2';

export interface BenchmarkRequest {
  readonly bytes: ArrayBuffer;
  readonly chunkSize: number;
}

export interface BenchmarkResult {
  readonly ok: true;
  readonly frames: number;
  readonly decodeMs: number;
  readonly clipSeconds: number;
  readonly sequence: Mpeg2Sequence | null;
  /** 面を1回ずつ読み切ったバイト数。seam のコストを測定に含めるため。 */
  readonly touchedBytes: number;
}

export interface BenchmarkFailure {
  readonly ok: false;
  readonly message: string;
}

async function run(request: BenchmarkRequest): Promise<BenchmarkResult> {
  const bytes = new Uint8Array(request.bytes);
  const decoder = await Mpeg2Decoder.create();
  let offset = 0;
  let frames = 0;
  let flushed = false;
  let touchedBytes = 0;
  const started = performance.now();
  try {
    outer: for (;;) {
      for (;;) {
        const step = decoder.step();
        if (step === STEP.needData) break;
        if (step === STEP.end) break outer;
        if (step < 0) throw new Error(`decoder reported ${step} after ${frames} frames`);
        if (step === STEP.frame) {
          const frame = decoder.frame();
          if (frame === null) throw new Error('frame reported but not readable');
          // 面を実際に触る。触らなければ seam のコストが測定から抜ける。
          touchedBytes += frame.y.length + frame.u.length + frame.v.length;
          frames += 1;
        }
      }
      if (offset < bytes.length) {
        const size = Math.min(request.chunkSize, bytes.length - offset);
        decoder.feed(bytes.subarray(offset, offset + size));
        offset += size;
      } else if (!flushed) {
        decoder.feed(SEQUENCE_END_CODE as Uint8Array);
        flushed = true;
      } else {
        break;
      }
    }
    const decodeMs = performance.now() - started;
    const sequence = decoder.sequence;
    return {
      ok: true,
      frames,
      decodeMs,
      clipSeconds: sequence ? (frames * sequence.framePeriod) / 27_000_000 : 0,
      sequence,
      touchedBytes,
    };
  } finally {
    decoder.close();
  }
}

self.addEventListener('message', (event: MessageEvent<BenchmarkRequest>) => {
  run(event.data).then(
    (result) => self.postMessage(result),
    (error: unknown) => {
      const failure: BenchmarkFailure = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(failure);
    },
  );
});
