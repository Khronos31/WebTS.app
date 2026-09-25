import { describe, expect, it } from 'vitest';
import { isStaleProgram, mergeSchedule } from '../src/epg-ui/schedule-merge';
import type { ProgramItem } from '../src/epg-ui/types';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 24, 1, 0);

function program(id: number, channelId: number, startHours: number): ProgramItem {
  const startAt = NOW + startHours * HOUR;
  return { id, channelId, startAt, endAt: startAt + HOUR, name: `p${id}`, description: '' };
}

describe('mergeSchedule', () => {
  it('揃った局では、届かなかった未来の番組を消す', () => {
    const existing = [program(1, 10, 1), program(2, 10, 2)];
    const incoming = [program(3, 10, 2)];
    const ids = mergeSchedule(existing, incoming, new Set([10]), NOW, NOW).map((p) => p.id);
    expect(ids).toEqual([3]);
  });

  it('揃わなかった局では消さずに足すだけ', () => {
    const existing = [program(1, 10, 1)];
    const incoming = [program(3, 10, 2)];
    const ids = mergeSchedule(existing, incoming, new Set(), NOW, NOW).map((p) => p.id);
    expect(ids.sort()).toEqual([1, 3]);
  });

  it('取得を始める前に始まっていた番組は消さない', () => {
    const existing = [program(1, 10, -0.5)];
    const ids = mergeSchedule(existing, [], new Set([10]), NOW, NOW).map((p) => p.id);
    expect(ids).toEqual([1]);
  });

  it('ほかの局の番組には触らない', () => {
    const existing = [program(1, 20, 1)];
    const ids = mergeSchedule(existing, [program(3, 10, 1)], new Set([10]), NOW, NOW)
      .map((p) => p.id);
    expect(ids.sort()).toEqual([1, 3]);
  });

  it('終わって6時間を過ぎた番組は捨てる', () => {
    const existing = [program(1, 20, -8)];
    expect(mergeSchedule(existing, [], new Set(), NOW, NOW)).toEqual([]);
  });

  it('終了時刻が未定の番組は、始まって24時間までは残す', () => {
    const existing = [undetermined(1, 20, -23)];
    expect(mergeSchedule(existing, [], new Set(), NOW, NOW).map((p) => p.id)).toEqual([1]);
  });

  it('終了時刻が未定の番組でも、始まって24時間を過ぎたら捨てる', () => {
    const existing = [undetermined(1, 20, -25), undetermined(2, 20, -24 * 5)];
    expect(mergeSchedule(existing, [], new Set(), NOW, NOW)).toEqual([]);
  });
});

/** 終了時刻が未定の番組。endAt === startAt で表す。 */
function undetermined(id: number, channelId: number, startHours: number): ProgramItem {
  const startAt = NOW + startHours * HOUR;
  return { id, channelId, startAt, endAt: startAt, name: `p${id}`, description: '' };
}

describe('isStaleProgram', () => {
  it('終わって6時間以内は残す', () => {
    expect(isStaleProgram(program(1, 10, -6.5), NOW)).toBe(false);
  });

  it('終わって6時間を過ぎたら捨てる', () => {
    expect(isStaleProgram(program(1, 10, -7.5), NOW)).toBe(true);
  });

  it('未定は始まりから24時間で切る', () => {
    expect(isStaleProgram(undetermined(1, 10, -2), NOW)).toBe(false);
    expect(isStaleProgram(undetermined(1, 10, -24), NOW)).toBe(true);
  });
});
