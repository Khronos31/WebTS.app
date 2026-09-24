// 番組表の取り方の計画。局の並びは合成したもので、放送の実データではない。

import { describe, expect, it } from 'vitest';
import { planByNetwork, planRetry } from '../src/epg-ui/schedule-plan';
import { bsTuning, csTuning, grTuning, type Tuning } from '../src/epg-ui/tuning';
import type { ChannelItem } from '../src/epg-ui/types';

function channel(id: number, networkId: number, tuning: Tuning): ChannelItem {
  return {
    id, serviceId: id % 100_000, networkId, name: String(id), halfWidthName: String(id),
    channelType: tuning.wave, channel: tuning.label, tuning,
    hasLogoData: false, isPrimary: true, isSubChannel: false,
  } as ChannelItem;
}

const bs1 = bsTuning(1, 0x4010, 0);
const bs3 = bsTuning(3, 0x4030, 0);
const bs13 = bsTuning(13, 0x40d1, 1);
const gr27 = grTuning(27);
const gr25 = grTuning(25);

const channels = [
  channel(400101, 4, bs1),
  channel(400141, 4, bs13),
  channel(400181, 4, bs3),
  channel(3273601024, 32736, gr27),
  channel(3274001040, 32740, gr25),
];

describe('planByNetwork', () => {
  it('BS はネットワークにつき1つの中継器、地上波は局ごと', () => {
    const { plans } = planByNetwork(channels);
    expect(plans.get('satellite')?.tunings).toHaveLength(1);
    expect(plans.get('terrestrial')?.tunings).toHaveLength(2);
  });

  it('BS と CS は同じ衛星の走査にまとまる', () => {
    const cs = channel(600055, 6, csTuning(2, 0x6020, 0));
    const { plans } = planByNetwork([...channels, cs]);
    expect(plans.get('satellite')?.tunings).toHaveLength(2);
  });

  it('回る中継器に、そのネットワークの全局を待つ局として付ける', () => {
    const { plans } = planByNetwork(channels);
    const expect_ = [...(plans.get('satellite')?.expect.values() ?? [])][0];
    expect(expect_?.sort()).toEqual([400101, 400141, 400181]);
  });
});

describe('planRetry', () => {
  it('他の TS の局が1つでも届いていれば、空の局があっても回り直さない', () => {
    const { visited } = planByNetwork(channels);
    const arrived = new Set([400101, 400141]);
    expect(planRetry(channels, visited, arrived).size).toBe(0);
  });

  it('他の TS の局が1つも届かなければ、残りの中継器を回る', () => {
    const { visited } = planByNetwork(channels);
    const arrived = new Set([400101]);
    const retry = planRetry(channels, visited, arrived);
    expect(retry.get('satellite')?.tunings).toHaveLength(2);
  });

  it('回った中継器そのものは回り直さない', () => {
    const { visited } = planByNetwork(channels);
    const retry = planRetry(channels, visited, new Set());
    const keys = retry.get('satellite')?.tunings.map((tuning) => tuning.label) ?? [];
    expect(keys).not.toContain(bs1.label);
  });
});
