import { describe, expect, it } from 'vitest';
import {
  PACKET_SIZE,
  STREAM_TYPE,
  TsDemuxer,
  crc32,
  parsePes,
  type PesPacket,
  type Program,
} from '../src/ts/demux';

// 合成 TS で分離を検査する。ここでは**合成データが検査対象そのもの**である。
// 放送のキャプチャは使わないし、リポジトリにも入れない。

function crcAppend(section: number[]): number[] {
  const crc = crc32(Uint8Array.from(section));
  return [...section, (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
}

/**
 * section_length は table_id と自分自身の 3 バイトを除いた残り、つまり
 * ヘッダの残り 5 バイト + 本体 + CRC 4 バイト。ここを取り違えると
 * 組み立て側が永久に続きを待つ。
 */
function sectionHeader(tableId: number, bodyLength: number, id: number, version: number): number[] {
  const length = 5 + bodyLength + 4;
  return [
    tableId,
    0xb0 | ((length >> 8) & 0x0f),
    length & 0xff,
    (id >> 8) & 0xff,
    id & 0xff,
    0xc1 | (version << 1),
    0x00,
    0x00,
  ];
}

function pat(entries: [program: number, pid: number][], version = 0): number[] {
  const body = entries.flatMap(([program, pid]) => [
    (program >> 8) & 0xff, program & 0xff, 0xe0 | ((pid >> 8) & 0x1f), pid & 0xff,
  ]);
  return crcAppend([...sectionHeader(0x00, body.length, 1, version), ...body]);
}

function pmt(
  programNumber: number,
  pcrPid: number,
  streams: [type: number, pid: number, tag?: number][],
  version = 0,
): number[] {
  const body = [
    0xe0 | ((pcrPid >> 8) & 0x1f), pcrPid & 0xff,
    0xf0, 0x00,
    ...streams.flatMap(([type, pid, tag]) => {
      const descriptors = tag === undefined ? [] : [0x52, 0x01, tag];
      return [
        type, 0xe0 | ((pid >> 8) & 0x1f), pid & 0xff,
        0xf0 | ((descriptors.length >> 8) & 0x0f), descriptors.length & 0xff,
        ...descriptors,
      ];
    }),
  ];
  return crcAppend([...sectionHeader(0x02, body.length, programNumber, version), ...body]);
}

function packetize(
  pid: number,
  payload: number[],
  { section = false, counterStart = 0 } = {},
): Uint8Array {
  const body = section ? [0x00, ...payload] : payload;
  const packets: number[] = [];
  let offset = 0;
  let counter = counterStart;
  let first = true;
  while (offset < body.length) {
    const room = PACKET_SIZE - 4;
    const take = Math.min(room, body.length - offset);
    const stuffing = room - take;
    const header = [
      0x47,
      (first ? 0x40 : 0x00) | ((pid >> 8) & 0x1f),
      pid & 0xff,
      0x10 | (counter & 0x0f),
    ];
    if (stuffing > 0) {
      // adaptation field で埋める。長さ1なら中身なし。
      header[3] = 0x30 | (counter & 0x0f);
      const adaptationLength = stuffing - 1;
      const fill = Array.from({ length: Math.max(0, adaptationLength - 1) }, () => 0xff);
      packets.push(...header, adaptationLength,
        ...(adaptationLength > 0 ? [0x00, ...fill] : []),
        ...body.slice(offset, offset + take));
    } else {
      packets.push(...header, ...body.slice(offset, offset + take));
    }
    offset += take;
    counter = (counter + 1) & 0x0f;
    first = false;
  }
  return Uint8Array.from(packets);
}

function pes(streamId: number, pts: number | null, payload: number[]): number[] {
  const header: number[] = [];
  if (pts !== null) {
    const high = Math.floor(pts / 2 ** 30) & 0x07;
    const mid = Math.floor(pts / 2 ** 15) & 0x7fff;
    const low = pts & 0x7fff;
    header.push(
      0x20 | (high << 1) | 0x01,
      (mid >> 7) & 0xff,
      ((mid & 0x7f) << 1) | 0x01,
      (low >> 7) & 0xff,
      ((low & 0x7f) << 1) | 0x01,
    );
  }
  const length = 3 + header.length + payload.length;
  return [
    0x00, 0x00, 0x01, streamId,
    (length >> 8) & 0xff, length & 0xff,
    0x80, pts !== null ? 0x80 : 0x00, header.length,
    ...header, ...payload,
  ];
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.length; }
  return merged;
}

function nullPacket(): Uint8Array {
  const packet = new Uint8Array(PACKET_SIZE).fill(0xff);
  packet[0] = 0x47;
  packet[1] = 0x1f;
  packet[2] = 0xff;
  packet[3] = 0x10;
  return packet;
}

function collect(): {
  demuxer: TsDemuxer;
  programs: Program[][];
  packets: PesPacket[];
} {
  const programs: Program[][] = [];
  const packets: PesPacket[] = [];
  const demuxer = new TsDemuxer({
    onPrograms: (list) => programs.push(list.map((program) => ({ ...program }))),
    onPes: (packet) => packets.push({ ...packet, data: packet.data.slice() }),
  });
  return { demuxer, programs, packets };
}

describe('CRC32', () => {
  it('leaves zero when the checksum is appended', () => {
    const section = pat([[1, 0x1000]]);
    expect(crc32(Uint8Array.from(section))).toBe(0);
  });
});

describe('TsDemuxer', () => {
  it('follows PAT then PMT and reports the elementary streams', () => {
    const { demuxer, programs } = collect();
    demuxer.push(packetize(0x0000, pat([[1, 0x1000]]), { section: true }));
    expect(programs).toHaveLength(0);
    demuxer.push(packetize(0x1000, pmt(1, 0x0100, [
      [STREAM_TYPE.mpeg2Video, 0x0100, 0x00],
      [STREAM_TYPE.adtsAac, 0x0110, 0x10],
      [STREAM_TYPE.privateData, 0x0130, 0x30],
    ]), { section: true }));

    expect(programs).toHaveLength(1);
    const program = programs[0]?.[0];
    expect(program?.programNumber).toBe(1);
    expect(program?.pmtPid).toBe(0x1000);
    expect(program?.pcrPid).toBe(0x0100);
    expect(program?.streams).toEqual([
      { pid: 0x0100, streamType: STREAM_TYPE.mpeg2Video, componentTag: 0x00 },
      { pid: 0x0110, streamType: STREAM_TYPE.adtsAac, componentTag: 0x10 },
      { pid: 0x0130, streamType: STREAM_TYPE.privateData, componentTag: 0x30 },
    ]);
  });

  it('ignores program_number 0, which is the NIT and not a program', () => {
    const { demuxer, programs } = collect();
    demuxer.push(packetize(0x0000, pat([[0, 0x0010], [2, 0x1001]]), { section: true }));
    demuxer.push(packetize(0x0010, pmt(0, 0x0100, [[STREAM_TYPE.mpeg2Video, 0x0100]]),
      { section: true }));
    expect(programs).toHaveLength(0);
    demuxer.push(packetize(0x1001, pmt(2, 0x0200, [[STREAM_TYPE.mpeg2Video, 0x0200]]),
      { section: true }));
    expect(programs[0]?.[0]?.programNumber).toBe(2);
  });

  it('rejects a section whose CRC does not check out', () => {
    const { demuxer, programs } = collect();
    const broken = pat([[1, 0x1000]]);
    broken[broken.length - 1] = (broken[broken.length - 1]! ^ 0xff) & 0xff;
    demuxer.push(packetize(0x0000, broken, { section: true }));
    expect(programs).toHaveLength(0);
    expect(demuxer.counters.badSections).toBe(1);
  });

  it('assembles a PES that spans several packets and reads its PTS', () => {
    const { demuxer, packets } = collect();
    demuxer.select([0x0100]);
    const payload = Array.from({ length: 700 }, (_, index) => index & 0xff);
    demuxer.push(packetize(0x0100, pes(0xe0, 900_000, payload)));
    // 次の開始が来るまで出さない設計ではなく、長さ指定があるので即出る。
    expect(packets).toHaveLength(1);
    expect(packets[0]?.streamId).toBe(0xe0);
    expect(packets[0]?.pts).toBe(900_000);
    expect([...(packets[0]?.data ?? [])]).toEqual(payload);
  });

  it('holds an unbounded video PES until the next one starts', () => {
    const { demuxer, packets } = collect();
    demuxer.select([0x0100]);
    const unbounded = (marker: number): number[] => {
      const body = pes(0xe0, null, Array.from({ length: 400 }, () => marker));
      body[4] = 0x00;
      body[5] = 0x00;
      return body;
    };
    demuxer.push(packetize(0x0100, unbounded(0xaa)));
    expect(packets).toHaveLength(0);
    demuxer.push(packetize(0x0100, unbounded(0xbb), { counterStart: 3 }));
    expect(packets).toHaveLength(1);
    expect(packets[0]?.data.every((byte) => byte === 0xaa)).toBe(true);
    demuxer.flush();
    expect(packets).toHaveLength(2);
    expect(packets[1]?.data.every((byte) => byte === 0xbb)).toBe(true);
  });

  it('emits nothing for PIDs that were not selected', () => {
    const { demuxer, packets } = collect();
    demuxer.push(packetize(0x0100, pes(0xe0, 0, [1, 2, 3])));
    expect(packets).toHaveLength(0);
  });

  it('counts null packets, continuity breaks and scrambled packets', () => {
    const { demuxer } = collect();
    demuxer.select([0x0100]);
    demuxer.push(nullPacket());

    const first = packetize(0x0100, pes(0xe0, 0, [1, 2, 3]));
    const skipped = packetize(0x0100, pes(0xe0, 0, [4, 5, 6]), { counterStart: 5 });
    demuxer.push(concat(first, skipped));

    const scrambled = new Uint8Array(PACKET_SIZE);
    scrambled[0] = 0x47;
    scrambled[1] = 0x01;
    scrambled[2] = 0x00;
    scrambled[3] = 0xd0;
    demuxer.push(scrambled);

    expect(demuxer.counters.nullPackets).toBe(1);
    expect(demuxer.counters.continuityErrors).toBe(1);
    expect(demuxer.counters.scrambled).toBe(1);
    expect(demuxer.counters.badSync).toBe(0);
  });

  it('carries a packet split across two pushes', () => {
    const { demuxer, programs } = collect();
    const bytes = packetize(0x0000, pat([[1, 0x1000]]), { section: true });
    demuxer.push(bytes.subarray(0, 100));
    demuxer.push(bytes.subarray(100));
    demuxer.push(packetize(0x1000, pmt(1, 0x0100, [[STREAM_TYPE.mpeg2Video, 0x0100]]),
      { section: true }));
    expect(programs).toHaveLength(1);
  });

  it('applies a PMT update only when its version changes', () => {
    const { demuxer, programs } = collect();
    demuxer.push(packetize(0x0000, pat([[1, 0x1000]]), { section: true }));
    const streams: [number, number][] = [[STREAM_TYPE.mpeg2Video, 0x0100]];
    demuxer.push(packetize(0x1000, pmt(1, 0x0100, streams, 0), { section: true }));
    demuxer.push(packetize(0x1000, pmt(1, 0x0100, streams, 0), { section: true }));
    expect(programs).toHaveLength(1);
    demuxer.push(packetize(0x1000, pmt(1, 0x0100, [
      [STREAM_TYPE.mpeg2Video, 0x0100], [STREAM_TYPE.adtsAac, 0x0110],
    ], 1), { section: true }));
    expect(programs).toHaveLength(2);
    expect(programs[1]?.[0]?.streams).toHaveLength(2);
  });
});

describe('parsePes', () => {
  it('returns null for something that is not a PES', () => {
    expect(parsePes(0x0100, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9))).toBeNull();
  });

  it('reads a 33-bit PTS above the 32-bit boundary', () => {
    const large = 2 ** 32 + 12_345;
    const packet = parsePes(0x0100, Uint8Array.from(pes(0xe0, large, [9])));
    expect(packet?.pts).toBe(large);
  });
});
