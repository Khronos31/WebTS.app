// 代表局の選び方と、名前の無い局の見分け。

import { describe, expect, it } from 'vitest';
import { isUnnamed, primaryIndex } from '../src/epg-ui/channel-scan';

describe('isUnnamed', () => {
  it('「－」だけや空の名前は名前の無い局', () => {
    expect(isUnnamed('－')).toBe(true);
    expect(isUnnamed('ー')).toBe(true);
    expect(isUnnamed('-')).toBe(true);
    expect(isUnnamed('')).toBe(true);
    expect(isUnnamed(' － ')).toBe(true);
  });

  it('長音を含む普通の局名は名前がある', () => {
    expect(isUnnamed('ショップチャンネル')).toBe(false);
    expect(isUnnamed('ＱＶＣ')).toBe(false);
    expect(isUnnamed('ＢＳ－ＴＢＳ')).toBe(false);
  });
});

describe('primaryIndex', () => {
  it('名前の無い局が先頭でも、名前を持つ最初の局を代表にする', () => {
    expect(primaryIndex(['－', 'ショップチャンネル', 'ＱＶＣ'])).toBe(1);
  });

  it('先頭に名前があればそれを代表にする', () => {
    expect(primaryIndex(['ＮＨＫ総合１', 'ＮＨＫ総合２'])).toBe(0);
  });

  it('名前を持つ局が無ければ代表局は無い', () => {
    expect(primaryIndex(['－', '－'])).toBe(-1);
  });
});
