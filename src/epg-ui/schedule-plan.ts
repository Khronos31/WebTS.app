// 番組表をどの中継器で取るかを決める。副作用を持たない。
//
// **ネットワークごとに1つの中継器だけ回る。**Mirakurun と同じ
// （Channel.ts `_epgGatherer`）。BS と CS はネットワークの全局の番組表が
// 1つの TS に載る。実測で、BS の1つの TS から登録済み BS 局のほぼ全部が
// 届いた（FINDINGS 33章）。地上波は局ごとにネットワークが違うので、結局
// すべての中継器を回る。

import { tuningForChannel, tuningKey, type Tuning } from './tuning';
import type { ChannelItem } from './types';

/**
 * 受信機の系統。**BS と CS は同じ衛星用の受信機を使う**ので、1回の走査に
 * まとめて並列に回せる。地上波と衛星は1回の走査に混ぜられない。
 */
export type ReceiverClass = 'terrestrial' | 'satellite';

export interface SchedulePlan {
  readonly tunings: Tuning[];
  /** 中継器ごとに、番組表が届くはずの局。鍵は `tuningKey`。 */
  readonly expect: Map<string, number[]>;
}

export interface NetworkPlan {
  readonly plans: Map<ReceiverClass, SchedulePlan>;
  /** ネットワークごとに、回ることにした中継器（`tuningKey`）。 */
  readonly visited: Map<number, string>;
}

type PlannedChannel = Pick<ChannelItem, 'id' | 'networkId' | 'channelType' | 'channel' | 'tuning'>;

function classOf(tuning: Tuning): ReceiverClass {
  return tuning.wave === 'GR' ? 'terrestrial' : 'satellite';
}

function add(
  plans: Map<ReceiverClass, SchedulePlan>, tuning: Tuning, ids: readonly number[],
): void {
  const receiverClass = classOf(tuning);
  let plan = plans.get(receiverClass);
  if (plan === undefined) {
    plan = { tunings: [], expect: new Map() };
    plans.set(receiverClass, plan);
  }
  const key = tuningKey(tuning);
  const known = plan.expect.get(key);
  if (known === undefined) {
    plan.tunings.push(tuning);
    plan.expect.set(key, [...ids]);
  } else {
    known.push(...ids);
  }
}

export function planByNetwork(channels: readonly PlannedChannel[]): NetworkPlan {
  const byNetwork = new Map<number, { tuning: Tuning; ids: number[] }>();
  for (const channel of channels) {
    const tuning = tuningForChannel(channel);
    if (tuning === null) continue;
    const entry = byNetwork.get(channel.networkId);
    if (entry === undefined) byNetwork.set(channel.networkId, { tuning, ids: [channel.id] });
    else entry.ids.push(channel.id);
  }
  const plans = new Map<ReceiverClass, SchedulePlan>();
  const visited = new Map<number, string>();
  for (const [networkId, { tuning, ids }] of byNetwork) {
    add(plans, tuning, ids);
    visited.set(networkId, tuningKey(tuning));
  }
  return { plans, visited };
}

/**
 * 1回目で前提が外れたネットワークだけ、残りの中継器を回り直す。
 *
 * **判断はネットワーク単位にする。**回った中継器の外にある局から1件も
 * 届かなければ、そのネットワークは他の TS の番組表を載せていない。
 * 1局だけ空なのは正常で、臨時サービスやサブチャンネルは番組表を送らない。
 * 局単位で判断していたころは、実測で BS の5つの中継器を毎回無駄に回っていた。
 */
export function planRetry(
  channels: readonly PlannedChannel[],
  visited: ReadonlyMap<number, string>,
  arrived: ReadonlySet<number>,
): Map<ReceiverClass, SchedulePlan> {
  const elsewhere = new Map<number, { channel: PlannedChannel; tuning: Tuning }[]>();
  for (const channel of channels) {
    const tuning = tuningForChannel(channel);
    if (tuning === null) continue;
    if (visited.get(channel.networkId) === tuningKey(tuning)) continue;
    const list = elsewhere.get(channel.networkId);
    if (list === undefined) elsewhere.set(channel.networkId, [{ channel, tuning }]);
    else list.push({ channel, tuning });
  }
  const plans = new Map<ReceiverClass, SchedulePlan>();
  for (const list of elsewhere.values()) {
    if (list.some(({ channel }) => arrived.has(channel.id))) continue;
    for (const { channel, tuning } of list) add(plans, tuning, [channel.id]);
  }
  return plans;
}
