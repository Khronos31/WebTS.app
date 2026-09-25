import { describe, expect, it } from 'vitest';
import { calculateScheduleBounds } from '../src/epg-ui/views/guide-view';

const HOUR = 60 * 60 * 1000;

/** 手元の時刻で「その日の h 時」。番組表は端末のローカル時刻で日を切る。 */
function at(day: number, hours: number): number {
  return new Date(2026, 8, day, hours, 0, 0, 0).getTime();
}

describe('番組表の日付の下限', () => {
  it('朝には、未明に終わった前日からの番組があっても今日から', () => {
    const now = at(25, 7.5);
    const coverage = { from: at(24, 22), to: at(25, 4) + 7 * 24 * HOUR };
    expect(calculateScheduleBounds(coverage, now).minMidnight).toBe(at(25, 0));
  });

  it('深夜には昨日も残す（終わって6時間以内の番組を見返せる）', () => {
    const now = at(25, 3);
    const coverage = { from: at(24, 22), to: at(25, 4) + 7 * 24 * HOUR };
    expect(calculateScheduleBounds(coverage, now).minMidnight).toBe(at(24, 0));
  });

  it('保存が今日からなら今日から', () => {
    const now = at(25, 3);
    const coverage = { from: at(25, 1), to: at(26, 0) };
    expect(calculateScheduleBounds(coverage, now).minMidnight).toBe(at(25, 0));
  });

  it('何日も前の番組が残っていても、6時間より前の日へは戻らない', () => {
    const now = at(25, 12);
    const coverage = { from: at(20, 10), to: at(26, 0) };
    expect(calculateScheduleBounds(coverage, now).minMidnight).toBe(at(25, 0));
  });
});
