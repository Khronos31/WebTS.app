// ハッシュと画面の対応。
//
// **副作用を持たせない。**ここを読み込むだけでテーマが当たったり DOM を
// 触ったりすると、判定だけを試すことができなくなる。

import type { RouteType } from './types';

export function routeFromHash(hash: string): RouteType {
  const clean = hash.replace(/^#\/?/, '');
  if (clean === 'api' || clean.startsWith('api/') || clean.startsWith('api?')) return 'api';
  if (clean === 'guide' || clean.startsWith('guide?')) return 'guide';
  if (clean === 'settings') return 'settings';
  if (clean === 'about') return 'about';
  if (clean === 'watch' || clean.startsWith('watch?') || clean.startsWith('watch/')) return 'watch';
  return 'onair';
}

export function channelIdFromHash(hash: string): number {
  const clean = hash.replace(/^#\/?/, '');
  const match = /[?&]channel=(\d+)/.exec(clean);
  if (match && match[1]) {
    return Number(match[1]);
  }
  return 1040;
}

export function hashForRoute(route: RouteType): string {
  return route === 'onair' ? '#/' : `#/${route}`;
}
