// 選局先の組み立て。周波数は実機で合わせるまで机上の値なので、式が崩れて
// いないことだけをここで押さえる。

import { describe, expect, it } from 'vitest';
import {
  bsTuning, bsTunings, csTuning, csTunings, grTuning, grTunings,
  tuningForChannel, tuningKey,
} from '../src/epg-ui/tuning';

describe('tuning', () => {
  it('地上デジタルは ch13 = 473143 kHz から 6 MHz 間隔', () => {
    expect(grTuning(13).frequencyKhz).toBe(473_143);
    expect(grTuning(27).frequencyKhz).toBe(473_143 + 14 * 6_000);
    expect(grTuning(21).label).toBe('21');
    expect(grTunings()).toHaveLength(50);
  });

  it('BS は奇数の中継器のみ', () => {
    expect(bsTuning(1).frequencyKhz).toBe(1_049_480);
    expect(bsTuning(15).frequencyKhz).toBe(1_318_000);
    expect(bsTuning(23).frequencyKhz).toBe(1_471_440);
    expect(bsTuning(15).label).toBe('BS15');
    const all = bsTunings();
    expect(all).toHaveLength(12);
    expect(all.every((tuning) => tuning.wave === 'BS')).toBe(true);
  });

  it('CS110 は偶数の ND のみ', () => {
    expect(csTuning(2).frequencyKhz).toBe(1_613_000);
    expect(csTuning(24).frequencyKhz).toBe(2_053_000);
    expect(csTuning(4).label).toBe('ND4');
    expect(csTunings()).toHaveLength(12);
  });

  it('衛星は TSID まで含めて初めて1つの TS を指す', () => {
    // 同じ中継器でも TSID が違えば別の TS。畳んではいけない。
    expect(tuningKey(bsTuning(15, 0x40f1))).not.toBe(tuningKey(bsTuning(15, 0x40f2)));
    expect(tuningKey(grTuning(27))).toBe(tuningKey(grTuning(27)));
  });

  it('tuning を持たない古い保存は物理チャンネルから組み立てる', () => {
    expect(tuningForChannel({ channelType: 'GR', channel: '27' })?.frequencyKhz)
      .toBe(grTuning(27).frequencyKhz);
    // 衛星は名前から組み立て直せない。走査し直すまで選局先は分からない。
    expect(tuningForChannel({ channelType: 'BS', channel: 'BS15' })).toBeNull();
  });
});
