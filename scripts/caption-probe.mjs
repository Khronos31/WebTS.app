// Developer tool. Shows the shape of the caption PES in a capture.
//
// Usage: node scripts/caption-probe.mjs <file.ts>
import { readFileSync } from 'node:fs';
import { STREAM_TYPE, TsDemuxer } from '../src/ts/demux.ts';

const file = process.argv[2];
if (!file) { process.stderr.write('usage: node scripts/caption-probe.mjs <file.ts>\n'); process.exit(2); }
const bytes = readFileSync(file);

let programs = [];
const discovery = new TsDemuxer({ onPrograms: (list) => { programs = list; } });
discovery.push(bytes.subarray(0, 4_000_000));
const program = programs.find((p) => p.streams.some((s) => s.streamType === STREAM_TYPE.mpeg2Video));
const captions = program.streams.filter((s) => s.streamType === STREAM_TYPE.privateData);
process.stdout.write(`captions: ${captions.map((s) => `0x${s.pid.toString(16)}/tag${s.componentTag}`).join(' ')}\n`);

const seen = [];
const demuxer = new TsDemuxer({ onPes: (p) => { if (seen.length < 6) seen.push(p); } });
demuxer.select(captions.map((s) => s.pid));
demuxer.push(bytes);
demuxer.flush();
for (const packet of seen) {
  const head = [...packet.data.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  process.stdout.write(
    `pid 0x${packet.pid.toString(16)} streamId 0x${packet.streamId.toString(16)}`
    + ` len ${packet.data.length} pts ${packet.pts}\n  ${head}\n`);
}
