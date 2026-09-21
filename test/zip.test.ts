import { describe, expect, it } from 'vitest';
import { ZipError, listZipEntries, readZipEntry } from '../src/usb/zip';

// 合成 ZIP でリーダー自体を検査する。実配布物に対する検査は
// firmware-extraction.test.ts が行う。

function buildZip(entries: { name: string; body: Uint8Array }[]): Uint8Array {
  const parts: number[] = [];
  const push = (...bytes: number[]) => parts.push(...bytes);
  const u16 = (v: number) => push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number) => { u16(v); u16(v >>> 16); };
  const text = (s: string) => { for (const b of new TextEncoder().encode(s)) push(b); };

  const central: { name: string; offset: number; size: number }[] = [];
  for (const entry of entries) {
    central.push({ name: entry.name, offset: parts.length, size: entry.body.length });
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(0); u32(entry.body.length); u32(entry.body.length);
    u16(entry.name.length); u16(0);
    text(entry.name);
    for (const b of entry.body) push(b);
  }
  const directoryOffset = parts.length;
  for (const entry of central) {
    u32(0x02014b50); u16(20); u16(20); u16(0); u16(0); u16(0); u16(0);
    u32(0); u32(entry.size); u32(entry.size);
    u16(entry.name.length); u16(0); u16(0); u16(0); u16(0); u32(0);
    u32(entry.offset);
    text(entry.name);
  }
  const directorySize = parts.length - directoryOffset;
  u32(0x06054b50); u16(0); u16(0); u16(central.length); u16(central.length);
  u32(directorySize); u32(directoryOffset); u16(0);
  return Uint8Array.from(parts);
}

describe('minimal ZIP reader', () => {
  const body = new TextEncoder().encode('firmware-ish bytes');
  const archive = buildZip([
    { name: 'dir/first.bin', body },
    { name: 'dir/second.bin', body: new Uint8Array([1, 2, 3]) },
  ]);

  it('lists every entry with its name and size', () => {
    expect(listZipEntries(archive).map((e) => `${e.name}:${e.uncompressedSize}`))
      .toEqual([`dir/first.bin:${body.length}`, 'dir/second.bin:3']);
  });

  it('reads a stored entry back byte for byte', async () => {
    expect(await readZipEntry(archive, 'dir/first.bin')).toEqual(body);
  });

  it('refuses a missing entry rather than returning something else', async () => {
    await expect(readZipEntry(archive, 'dir/absent.bin')).rejects.toBeInstanceOf(ZipError);
  });

  it('refuses input that is not a ZIP', () => {
    expect(() => listZipEntries(new Uint8Array(64))).toThrow(ZipError);
  });
});
