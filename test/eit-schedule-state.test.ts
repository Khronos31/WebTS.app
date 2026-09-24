// EIT[schedule] の「揃った」判定。
//
// **合成した見出しでロジックだけを確かめる。**実際の放送で揃うかどうかは
// ここでは分からない（実機で測る）。

import { describe, expect, it } from 'vitest';
import { ScheduleCompleteness, serviceKey, type ScheduleSectionHeader } from '../src/ts/eit-schedule-state';

// JST 2026-09-24 10:30 = UTC 01:30。今日の3番目のセグメント (09:00-12:00) の中。
const NOW = Date.UTC(2026, 8, 24, 1, 30);
const SEGMENT_OF_DAY = 3;

function header(overrides: Partial<ScheduleSectionHeader>): ScheduleSectionHeader {
  return {
    tableId: 0x50, networkId: 4, serviceId: 101, version: 1,
    sectionNumber: 0, lastSectionNumber: 0xf8, segmentLastSectionNumber: 0,
    lastTableId: 0x50,
    ...overrides,
  };
}

/** 1表の、今日の残りと未来の全セグメントを1セクションずつ送る。 */
function feedTable(state: ScheduleCompleteness, base: Partial<ScheduleSectionHeader>): void {
  const tableIndex = (base.tableId ?? 0x50) & 0x07;
  const first = tableIndex === 0 ? SEGMENT_OF_DAY : 0;
  for (let segment = first; segment < 32; segment += 1) {
    const sectionNumber = segment * 8;
    state.record(header({ ...base, sectionNumber, segmentLastSectionNumber: sectionNumber }));
  }
}

describe('ScheduleCompleteness', () => {
  it('過ぎたセグメントを待たずに揃う', () => {
    const state = new ScheduleCompleteness(() => NOW);
    feedTable(state, {});
    expect(state.isComplete(serviceKey(4, 101))).toBe(true);
    expect(state.allSeenComplete()).toBe(true);
  });

  it('1セグメント欠けていれば揃わない', () => {
    const state = new ScheduleCompleteness(() => NOW);
    for (let segment = SEGMENT_OF_DAY; segment < 32; segment += 1) {
      if (segment === 20) continue;
      const sectionNumber = segment * 8;
      state.record(header({ sectionNumber, segmentLastSectionNumber: sectionNumber }));
    }
    expect(state.allSeenComplete()).toBe(false);
  });

  it('last_table_id が示す後続の表も待つ', () => {
    const state = new ScheduleCompleteness(() => NOW);
    feedTable(state, { tableId: 0x50, lastTableId: 0x51 });
    expect(state.allSeenComplete()).toBe(false);
    feedTable(state, { tableId: 0x51, lastTableId: 0x51 });
    expect(state.allSeenComplete()).toBe(true);
  });

  it('extended を送らない局は basic だけで揃う', () => {
    const state = new ScheduleCompleteness(() => NOW);
    feedTable(state, { tableId: 0x50 });
    expect(state.allSeenComplete()).toBe(true);
  });

  it('extended が届き始めたら extended も待つ', () => {
    const state = new ScheduleCompleteness(() => NOW);
    feedTable(state, { tableId: 0x50 });
    state.record(header({ tableId: 0x58, lastTableId: 0x58, sectionNumber: 24,
      segmentLastSectionNumber: 24 }));
    expect(state.allSeenComplete()).toBe(false);
    feedTable(state, { tableId: 0x58, lastTableId: 0x58 });
    expect(state.allSeenComplete()).toBe(true);
  });

  it('other (0x60〜) も同じ判定で数える', () => {
    const state = new ScheduleCompleteness(() => NOW);
    feedTable(state, { tableId: 0x60, lastTableId: 0x60, serviceId: 141 });
    expect(state.isComplete(serviceKey(4, 141))).toBe(true);
  });

  it('局ごとに別に数え、揃った局だけを返す', () => {
    const state = new ScheduleCompleteness(() => NOW);
    feedTable(state, { serviceId: 101 });
    state.record(header({ serviceId: 103, sectionNumber: SEGMENT_OF_DAY * 8,
      segmentLastSectionNumber: SEGMENT_OF_DAY * 8 }));
    expect(state.completeKeys()).toEqual([serviceKey(4, 101)]);
    expect(state.allSeenComplete()).toBe(false);
  });

  it('版が変わったら数え直す', () => {
    const state = new ScheduleCompleteness(() => NOW);
    feedTable(state, { version: 1 });
    expect(state.allSeenComplete()).toBe(true);
    state.record(header({ version: 2, sectionNumber: SEGMENT_OF_DAY * 8,
      segmentLastSectionNumber: SEGMENT_OF_DAY * 8 }));
    expect(state.allSeenComplete()).toBe(false);
    feedTable(state, { version: 2 });
    expect(state.allSeenComplete()).toBe(true);
  });

  it('1つ前の版が遅れて届いても数え直さない', () => {
    const state = new ScheduleCompleteness(() => NOW);
    feedTable(state, { version: 5 });
    state.record(header({ version: 4, sectionNumber: 200, segmentLastSectionNumber: 200 }));
    expect(state.allSeenComplete()).toBe(true);
  });

  it('登録していない局は判定に数えない', () => {
    const state = new ScheduleCompleteness(() => NOW);
    feedTable(state, { serviceId: 101 });
    // データ放送のように、枠だけあって埋まらない局。
    state.record(header({ serviceId: 700, sectionNumber: SEGMENT_OF_DAY * 8,
      segmentLastSectionNumber: SEGMENT_OF_DAY * 8 }));
    expect(state.allSeenComplete()).toBe(false);
    expect(state.allSeenComplete((key) => key === serviceKey(4, 101))).toBe(true);
  });

  it('何も届いていなければ揃っていない', () => {
    expect(new ScheduleCompleteness(() => NOW).allSeenComplete()).toBe(false);
  });
});
