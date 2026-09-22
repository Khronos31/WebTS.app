// ハッシュからの経路選び。`#/api/...` は画面ではなく操作口なので、
// 通常の画面へ落ちてしまうと走査が始まらない。

import { describe, expect, it } from 'vitest';
import { routeFromHash } from '../src/epg-ui/routes';

describe('routeFromHash', () => {
  it('画面の経路', () => {
    expect(routeFromHash('#/')).toBe('onair');
    expect(routeFromHash('')).toBe('onair');
    expect(routeFromHash('#/settings')).toBe('settings');
    expect(routeFromHash('#/about')).toBe('about');
    expect(routeFromHash('#/watch?channel=1040')).toBe('watch');
  });

  it('操作口は問い合わせが付いていても api へ送る', () => {
    expect(routeFromHash('#/api')).toBe('api');
    expect(routeFromHash('#/api/')).toBe('api');
    expect(routeFromHash('#/api/channels')).toBe('api');
    expect(routeFromHash('#/api/scan?wave=BS')).toBe('api');
    expect(routeFromHash('#/api/epg/refresh')).toBe('api');
    expect(routeFromHash('#/api?wave=BS')).toBe('api');
  });

  it('api で始まるだけの画面名は巻き込まない', () => {
    expect(routeFromHash('#/apisettings')).toBe('onair');
  });
});
