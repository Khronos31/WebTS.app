import { describe, expect, it } from 'vitest';
import {
  installDataBroadcastConsole,
  isDataBroadcastVisible,
  sendDataBroadcastKey,
} from '../src/epg-ui/data-broadcast';

describe('DataBroadcast keys and helpers', () => {
  it('installDataBroadcastConsole registers keys including 0, 10, 11, 12, and HJKL aliases', () => {
    installDataBroadcastConsole();
    const webts = (globalThis as unknown as { webts?: { bml?: { keys: () => string[] } } }).webts;
    expect(webts?.bml).toBeDefined();

    const keys = webts?.bml?.keys() ?? [];
    // 0 (Digit0) と 10, 11, 12 (Digit10〜12) の両方が存在すること
    expect(keys).toContain('0');
    expect(keys).toContain('10');
    expect(keys).toContain('11');
    expect(keys).toContain('12');

    // カラーキーと HJKL / BRGY エイリアス
    expect(keys).toContain('blue');
    expect(keys).toContain('red');
    expect(keys).toContain('green');
    expect(keys).toContain('yellow');
    expect(keys).toContain('h');
    expect(keys).toContain('j');
    expect(keys).toContain('k');
    expect(keys).toContain('l');
    expect(keys).toContain('b');
    expect(keys).toContain('r');
    expect(keys).toContain('g');
    expect(keys).toContain('y');

    // dボタン, 決定 (enter / ok), 戻る (back / return)
    expect(keys).toContain('d');
    expect(keys).toContain('data');
    expect(keys).toContain('enter');
    expect(keys).toContain('ok');
    expect(keys).toContain('back');
    expect(keys).toContain('return');
  });

  it('sendDataBroadcastKey and isDataBroadcastVisible return false when no overlay is active', () => {
    expect(sendDataBroadcastKey('d')).toBe(false);
    expect(sendDataBroadcastKey('0')).toBe(false);
    expect(sendDataBroadcastKey('10')).toBe(false);
    expect(isDataBroadcastVisible()).toBe(false);
  });

  it('webts.bml exposes zipcode, getZipcode, and setZipcode functions', () => {
    installDataBroadcastConsole();
    const bml = (globalThis as unknown as {
      webts?: {
        bml?: {
          zipcode?: () => string | null;
          getZipcode?: () => string | null;
          setZipcode?: (v: string | null) => string;
        };
      };
    }).webts?.bml;
    expect(typeof bml?.zipcode).toBe('function');
    expect(typeof bml?.getZipcode).toBe('function');
    expect(typeof bml?.setZipcode).toBe('function');
  });
});
