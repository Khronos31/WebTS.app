// 映像を出す Worker。TS を受け取り、分離して復号し、canvas へ描く。
//
// 描画まで Worker で完結させる。OffscreenCanvas を渡してもらえば VideoFrame を
// スレッド間で渡す必要がなく、main thread は UI だけを見ていられる。
//
// 復号は実時間の9倍出る（docs/FINDINGS.md 7章・16章）ので、律速は復号ではなく
// 表示の間隔である。PTS ではなく sequence の frame_period で刻む: 地デジの
// 映像 PES は 1 PES = 1 フレームだが、フレーム周期は sequence が持っており、
// そちらのほうが素直で、PTS の飛びに影響されない。
//
// これは開発用のプレイヤーで、製品の再生系ではない。音声も字幕もまだ無い。

import { STREAM_TYPE, TsDemuxer, type Program } from '../ts/demux';
import { Mpeg2Decoder, STEP, type Mpeg2Sequence } from './mpeg2';

export interface PlayerStarted {
  readonly kind: 'started';
  readonly programNumber: number;
  readonly videoPid: number;
  readonly audioPids: readonly number[];
  readonly captionPids: readonly number[];
  readonly esBytes: number;
  readonly demuxMs: number;
  readonly counters: Record<string, number>;
}

export interface PlayerProgress {
  readonly kind: 'progress';
  readonly frames: number;
  readonly decodeMs: number;
  readonly lateMs: number;
  readonly sequence: Mpeg2Sequence | null;
}

export interface PlayerDone {
  readonly kind: 'done';
  readonly frames: number;
  readonly decodeMs: number;
}

export interface PlayerFailed {
  readonly kind: 'failed';
  readonly message: string;
}

export type PlayerMessage = PlayerStarted | PlayerProgress | PlayerDone | PlayerFailed;

interface StartRequest {
  readonly canvas: OffscreenCanvas;
  readonly ts: ArrayBuffer;
}

const post = (message: PlayerMessage): void => { self.postMessage(message); };

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

async function run(request: StartRequest): Promise<void> {
  const bytes = new Uint8Array(request.ts);

  // PMT が来るまで何を選ぶか決まらないので、まず構成を得る。
  let programs: readonly Program[] = [];
  const discovery = new TsDemuxer({ onPrograms: (list) => { programs = list; } });
  discovery.push(bytes.subarray(0, Math.min(bytes.length, 4_000_000)));
  // 最初に映像を持つ番組を選ぶ。ワンセグ (H.264) は今は扱わない。
  const program = programs.find((candidate) => candidate.streams.some(
    (stream) => stream.streamType === STREAM_TYPE.mpeg2Video));
  if (program === undefined) throw new Error('MPEG-2 映像を持つ番組が見つかりません');
  const video = program.streams.find(
    (stream) => stream.streamType === STREAM_TYPE.mpeg2Video);
  if (video === undefined) throw new Error('映像 PID がありません');

  // 映像 ES を集める。29 MiB 程度なので一度に持って構わない。
  // live ではここが流量制御の必要な場所になる。
  const chunks: Uint8Array[] = [];
  let esBytes = 0;
  const demuxer = new TsDemuxer({
    onPes: (packet) => {
      if (packet.data.length === 0) return;
      chunks.push(packet.data);
      esBytes += packet.data.length;
    },
  });
  demuxer.select([video.pid]);
  const demuxStarted = performance.now();
  demuxer.push(bytes);
  demuxer.flush();
  const demuxMs = performance.now() - demuxStarted;

  post({
    kind: 'started',
    programNumber: program.programNumber,
    videoPid: video.pid,
    audioPids: program.streams.filter((s) => s.streamType === STREAM_TYPE.adtsAac)
      .map((s) => s.pid),
    captionPids: program.streams.filter((s) => s.streamType === STREAM_TYPE.privateData)
      .map((s) => s.pid),
    esBytes,
    demuxMs,
    counters: { ...demuxer.counters },
  });

  const context = request.canvas.getContext('2d');
  if (context === null) throw new Error('2d コンテキストを取れません');

  const decoder = await Mpeg2Decoder.create();
  // libmpeg2 は「次の start code を見て」初めて直前の picture を出すので、
  // 入力の終わりに sequence_end_code を足さないと末尾が出てこない。
  chunks.push(Uint8Array.of(0x00, 0x00, 0x01, 0xb7));

  let index = 0;
  let frames = 0;
  let decodeMs = 0;
  let lateMs = 0;
  let startedAt = 0;
  let periodMs = 1000 / 29.97;
  let sized = false;
  let resized: Mpeg2Sequence | null = null;

  try {
    outer: for (;;) {
      for (;;) {
        const decodeStarted = performance.now();
        const step = decoder.step();
        decodeMs += performance.now() - decodeStarted;
        if (step === STEP.needData) break;
        if (step === STEP.end) break outer;
        if (step < 0) throw new Error(`デコーダが ${step} を返しました`);
        if (step === STEP.sequence) {
          const sequence = decoder.sequence;
          if (sequence !== null) {
            resized = sequence;
            periodMs = sequence.framePeriod / 27_000;
            if (!sized) {
              request.canvas.width = sequence.pictureWidth;
              request.canvas.height = sequence.pictureHeight;
              sized = true;
            }
          }
          continue;
        }
        if (step !== STEP.frame) continue;

        const sequence = decoder.sequence;
        const frame = decoder.frame();
        if (sequence === null || frame === null) continue;

        // VideoFrame は1本の連続したバッファを要求するので、3面をまとめて
        // 1回だけ写す。ここが表示経路で唯一のコピーである。
        const lumaSize = sequence.codedWidth * sequence.codedHeight;
        const chromaSize = sequence.chromaWidth * sequence.chromaHeight;
        const planes = new Uint8Array(lumaSize + chromaSize * 2);
        planes.set(frame.y.subarray(0, lumaSize), 0);
        planes.set(frame.u.subarray(0, chromaSize), lumaSize);
        planes.set(frame.v.subarray(0, chromaSize), lumaSize + chromaSize);

        if (startedAt === 0) startedAt = performance.now();
        const due = startedAt + frames * periodMs;
        const wait = due - performance.now();
        if (wait > 1) await sleep(wait);
        else if (wait < -periodMs) lateMs += -wait;

        const picture = new VideoFrame(planes, {
          format: 'I420',
          codedWidth: sequence.codedWidth,
          codedHeight: sequence.codedHeight,
          layout: [
            { offset: 0, stride: sequence.codedWidth },
            { offset: lumaSize, stride: sequence.chromaWidth },
            { offset: lumaSize + chromaSize, stride: sequence.chromaWidth },
          ],
          // 符号化は 1440x1088 でも見せるのは 1440x1080。
          visibleRect: { x: 0, y: 0, width: sequence.pictureWidth, height: sequence.pictureHeight },
          // 標本比 4:3 の 1440x1080 は 1920x1080 として見せる。
          displayWidth: Math.round(
            sequence.pictureWidth * (sequence.pixelWidth || 1) / (sequence.pixelHeight || 1)),
          displayHeight: sequence.pictureHeight,
          timestamp: Math.round(frames * periodMs * 1000),
        });
        context.drawImage(picture, 0, 0, request.canvas.width, request.canvas.height);
        picture.close();

        frames += 1;
        if (frames % 30 === 0) {
          post({ kind: 'progress', frames, decodeMs, lateMs, sequence: resized });
        }
      }
      if (index >= chunks.length) break;
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) decoder.feed(chunk);
    }
  } finally {
    decoder.close();
  }
  post({ kind: 'done', frames, decodeMs });
}

self.addEventListener('message', (event: MessageEvent<StartRequest>) => {
  run(event.data).catch((error: unknown) => {
    post({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
  });
});
