// Developer tool. Decodes an MPEG-2 elementary stream and reports throughput.
//
// This exists to check that the vendored build still decodes at the speed the
// browser needs, because that is the assumption the whole server-less design
// rests on: WebCodecs cannot decode MPEG-2, so this WASM module is the only
// thing between the tuner and the screen (docs/FINDINGS.md section 7).
//
// The input is a synthetic clip, not a broadcast capture. Synthetic material
// is legitimate here because decoder throughput is the subject under test, not
// something being stood in for. Real broadcast content has different motion
// compensation cost, so this number is an indication, not a guarantee. No
// capture is committed to this repository, and none is read by CI.
//
// Generate a comparable clip with:
//   ffmpeg -f lavfi -i "testsrc2=size=1440x1080:rate=30000/1001:duration=20.02" \
//     -vf setfield=tff -c:v mpeg2video -b:v 15600k -maxrate 15600k \
//     -minrate 15600k -bufsize 3000k -flags +ilme+ildct -g 15 -bf 2 \
//     -f mpeg2video clip.m2v
//
// Usage: node scripts/mpeg2-decode-benchmark.mjs <clip.m2v> [--chunk 65536]

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const NEED_DATA = 0;
const FRAME = 1;
const SEQUENCE = 2;
const END = 3;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(root, 'build', 'mpeg2-decoder', 'mpeg2-decoder.mjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? Number(process.argv[index + 1]) : fallback;
}

const clip = process.argv[2];
if (!clip || clip.startsWith('--')) {
  process.stderr.write('usage: node scripts/mpeg2-decode-benchmark.mjs <clip.m2v> [--chunk N]\n');
  process.exit(2);
}
const chunkSize = argument('--chunk', 65_536);

try {
  statSync(modulePath);
} catch {
  throw new Error(`${modulePath} is missing. Run: npm run build:mpeg2`);
}

const bytes = readFileSync(clip);
const factory = (await import(pathToFileURL(modulePath).href)).default;
const wasm = await factory();

const decoder = wasm.ccall('webts_mpeg2_open', 'number', [], []);
if (decoder === 0) throw new Error('webts_mpeg2_open failed');

const sequenceWords = wasm.ccall('webts_mpeg2_sequence_words', 'number', [], []);
const frameWords = wasm.ccall('webts_mpeg2_frame_words', 'number', [], []);
const sequencePointer = wasm._malloc(sequenceWords * 4);
const framePointer = wasm._malloc(frameWords * 4);
const chunkPointer = wasm._malloc(chunkSize);

// libmpeg2 emits a picture only once it sees the start code that follows it,
// so the last frames of a stream stay inside the decoder unless the caller
// says the sequence has ended. 00 00 01 B7 is sequence_end_code; feeding it
// after the file is what flushes them out.
const SEQUENCE_END = Uint8Array.of(0x00, 0x00, 0x01, 0xb7);
let flushed = false;

let offset = 0;
let frames = 0;
let sequence = null;
const started = process.hrtime.bigint();

function feed(view) {
  wasm.HEAPU8.set(view, chunkPointer);
  wasm.ccall('webts_mpeg2_feed', null, ['number', 'number', 'number'],
    [decoder, chunkPointer, view.length]);
}

function readSequence() {
  if (wasm.ccall('webts_mpeg2_sequence', 'number', ['number', 'number', 'number'],
    [decoder, sequencePointer, sequenceWords]) !== 0) return;
  const words = wasm.HEAP32.subarray(sequencePointer / 4, sequencePointer / 4 + sequenceWords);
  sequence = {
    coded: `${words[0]}x${words[1]}`,
    chroma: `${words[2]}x${words[3]}`,
    picture: `${words[4]}x${words[5]}`,
    display: `${words[6]}x${words[7]}`,
    pixelAspect: `${words[8]}:${words[9]}`,
    framePeriod: words[10],
  };
}

outer: for (;;) {
  for (;;) {
    const step = wasm.ccall('webts_mpeg2_step', 'number', ['number'], [decoder]);
    if (step === NEED_DATA) break;
    if (step === END) break outer;
    if (step < 0) throw new Error(`decoder reported ${step} after ${frames} frames`);
    if (step === SEQUENCE) readSequence();
    if (step === FRAME) {
      // Touch the frame every time, so the per-frame cost of the seam is in
      // the measurement rather than optimised away by never being paid.
      wasm.ccall('webts_mpeg2_frame', 'number', ['number', 'number', 'number'],
        [decoder, framePointer, frameWords]);
      frames += 1;
    }
  }
  if (offset < bytes.length) {
    const size = Math.min(chunkSize, bytes.length - offset);
    feed(bytes.subarray(offset, offset + size));
    offset += size;
  } else if (!flushed) {
    feed(SEQUENCE_END);
    flushed = true;
  } else {
    break;
  }
}

const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
wasm._free(chunkPointer);
wasm._free(framePointer);
wasm._free(sequencePointer);
wasm.ccall('webts_mpeg2_close', null, ['number'], [decoder]);

// frame_period is in units of 1/27000000 s, which is upstream's clock.
const clipSeconds = sequence ? (frames * sequence.framePeriod) / 27_000_000 : 0;
const fps = frames / (elapsedMs / 1000);

process.stdout.write([
  `clip             ${clip}`,
  `bytes            ${bytes.length}`,
  `coded / chroma   ${sequence?.coded ?? '?'} / ${sequence?.chroma ?? '?'}`,
  `picture          ${sequence?.picture ?? '?'}`,
  `display          ${sequence?.display ?? '?'}  pixel aspect ${sequence?.pixelAspect ?? '?'}`,
  `frames           ${frames}`,
  `clip duration    ${clipSeconds.toFixed(2)} s`,
  `decode time      ${(elapsedMs / 1000).toFixed(3)} s`,
  `fps              ${fps.toFixed(1)}`,
  `realtime         ${clipSeconds > 0 ? (clipSeconds / (elapsedMs / 1000)).toFixed(2) : '?'}x`,
  '',
].join('\n'));
