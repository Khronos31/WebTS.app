// 188 バイト区切りの取り直し。パケットは合成したもので、放送の実データではない。

import { describe, expect, it } from 'vitest';
import { PacketAligner, PACKET_SIZE } from '../src/ts/demux';

function packet(pid: number): Uint8Array {
  const bytes = new Uint8Array(PACKET_SIZE).fill(0xff);
  bytes[0] = 0x47;
  bytes[1] = (pid >> 8) & 0x1f;
  bytes[2] = pid & 0xff;
  bytes[3] = 0x10;
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function pids(aligner: PacketAligner, ...chunks: Uint8Array[]): number[] {
  const seen: number[] = [];
  for (const chunk of chunks) {
    aligner.push(chunk, (p) => { seen.push((((p[1] ?? 0) & 0x1f) << 8) | (p[2] ?? 0)); });
  }
  return seen;
}

describe('PacketAligner', () => {
  it('揃っていればそのまま切る', () => {
    const aligner = new PacketAligner();
    expect(pids(aligner, concat(packet(1), packet(2), packet(3)))).toEqual([1, 2, 3]);
    expect(aligner.resyncs).toBe(0);
  });

  it('push をまたいだ端を持ち越す', () => {
    const aligner = new PacketAligner();
    const all = concat(packet(1), packet(2), packet(3));
    expect(pids(aligner, all.subarray(0, 100), all.subarray(100, 400), all.subarray(400)))
      .toEqual([1, 2, 3]);
  });

  it('途中で数バイト抜けても、次のパケットから読み直す', () => {
    const aligner = new PacketAligner();
    const broken = concat(packet(1), packet(2).subarray(0, 50), packet(3), packet(4), packet(5));
    expect(pids(aligner, broken)).toEqual([1, 3, 4, 5]);
    expect(aligner.resyncs).toBe(1);
  });

  it('先頭がパケットの途中から始まっても読み直す', () => {
    const aligner = new PacketAligner();
    const stream = concat(packet(1).subarray(90), packet(2), packet(3), packet(4));
    expect(pids(aligner, stream)).toEqual([2, 3, 4]);
  });

  it('本体の途中の 0x47 には合わせない', () => {
    const aligner = new PacketAligner();
    const tricky = packet(1).subarray(10);
    tricky[20] = 0x47;
    expect(pids(aligner, concat(tricky, packet(2), packet(3), packet(4)))).toEqual([2, 3, 4]);
  });
});
