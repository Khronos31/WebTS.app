import { describe, expect, it } from 'vitest';
import crc32, { buf } from '../src/bml/crc32';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('PNG CRC-32 (crc-32 の代わり)', () => {
  it('標準の検査値 "123456789" → 0xCBF43926 を符号付きで返す', () => {
    expect(buf(ascii('123456789'))).toBe(0xcbf43926 | 0);
  });

  it('空なら 0', () => {
    expect(buf(new Uint8Array(0))).toBe(0);
  });

  it('seed で続きから計算できる', () => {
    const whole = buf(ascii('IHDRabcdef'));
    expect(buf(ascii('abcdef'), buf(ascii('IHDR')))).toBe(whole);
  });

  it('PNG の IEND チャンクの CRC は 0xAE426082', () => {
    expect(buf(ascii('IEND'))).toBe(0xae426082 | 0);
  });

  it('default にも buf がある（web-bml の呼び方）', () => {
    expect(crc32.buf(ascii('123456789'))).toBe(0xcbf43926 | 0);
  });
});
