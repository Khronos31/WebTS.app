// Developer tool. Runs the demuxer over a TS file and prints what it found.
//
// The unit tests build their own synthetic TS, which is the right way to test
// the parsing rules but cannot tell you whether real broadcast matches the
// assumptions. This does that half. The file is one the operator captured
// themselves with the descramble page; nothing here is committed, and CI does
// not run this.
//
// Usage: node scripts/ts-demux-report.mjs <file.ts>

import { readFileSync } from 'node:fs';
import { STREAM_TYPE, TsDemuxer } from '../src/ts/demux.ts';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node scripts/ts-demux-report.mjs <file.ts>\n');
  process.exit(2);
}

const bytes = readFileSync(file);

// PMT が見えるまでは何を選べばよいか分からない。先頭だけ流して構成を得る。
let programs = [];
const discovery = new TsDemuxer({ onPrograms: (list) => { programs = list; } });
discovery.push(bytes.subarray(0, Math.min(bytes.length, 4_000_000)));
if (programs.length === 0) {
  process.stderr.write('no program found in the first 4 MiB\n');
  process.exit(1);
}

const hex = (value) => `0x${value.toString(16).padStart(4, '0')}`;
for (const program of programs) {
  process.stdout.write(
    `program ${program.programNumber}  pmt ${hex(program.pmtPid)}  pcr ${hex(program.pcrPid)}\n`);
  for (const stream of program.streams) {
    const tag = stream.componentTag === null ? '' : `  tag ${stream.componentTag}`;
    process.stdout.write(
      `  ${hex(stream.pid)}  stream_type 0x${stream.streamType.toString(16)}${tag}\n`);
  }
}

// 先頭の番組の映像・音声・字幕を選び、全体を流し直す。
const first = programs[0];
const wanted = first.streams.filter((stream) => stream.streamType === STREAM_TYPE.mpeg2Video
  || stream.streamType === STREAM_TYPE.adtsAac
  || stream.streamType === STREAM_TYPE.privateData);

const counts = new Map();
const firstPts = new Map();
const lastPts = new Map();
const payloadBytes = new Map();
const demuxer = new TsDemuxer({
  onPes: (packet) => {
    counts.set(packet.pid, (counts.get(packet.pid) ?? 0) + 1);
    payloadBytes.set(packet.pid, (payloadBytes.get(packet.pid) ?? 0) + packet.data.length);
    if (packet.pts !== null) {
      if (!firstPts.has(packet.pid)) firstPts.set(packet.pid, packet.pts);
      lastPts.set(packet.pid, packet.pts);
    }
  },
});
demuxer.select(wanted.map((stream) => stream.pid));

const started = process.hrtime.bigint();
demuxer.push(bytes);
demuxer.flush();
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

process.stdout.write(`\ncounters ${JSON.stringify(demuxer.counters)}\n`);
process.stdout.write(
  `demux ${(bytes.length / 1_048_576).toFixed(1)} MiB in ${elapsedMs.toFixed(0)} ms\n\n`);
for (const stream of wanted) {
  const count = counts.get(stream.pid) ?? 0;
  const span = firstPts.has(stream.pid)
    ? (lastPts.get(stream.pid) - firstPts.get(stream.pid)) / 90_000
    : 0;
  process.stdout.write(
    `${hex(stream.pid)}  type 0x${stream.streamType.toString(16)}  `
    + `${count} PES  ${((payloadBytes.get(stream.pid) ?? 0) / 1_048_576).toFixed(2)} MiB  `
    + `PTS span ${span.toFixed(2)} s\n`);
}
