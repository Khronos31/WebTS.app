// 放映中の画面で選んでいた波を覚える。
//
// **画面は行き来のたびに作り直される。**視聴へ移ると放映中のビューは破棄され、
// 戻ってくると新しく組み立てられる。選択をビューの中だけに持つと、BS を見て
// いた人が戻るたびに地上波へ放り出される。
//
// ハッシュに載せる案もあるが、タブの切り替えで履歴が増えるのは戻る操作の
// 邪魔になる。保存に置いて、画面の組み立て時に読む。

import type { BroadcastType } from './types';

const KEY = 'webts-onair-tab';
const VALID: readonly BroadcastType[] = ['ALL', 'GR', 'BS', 'CS'];

export function readOnAirTab(fallback: BroadcastType = 'GR'): BroadcastType {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved !== null && VALID.includes(saved as BroadcastType)) {
      return saved as BroadcastType;
    }
  } catch {
    // 読めない環境では既定で始める。
  }
  return fallback;
}

export function saveOnAirTab(tab: BroadcastType): void {
  try {
    localStorage.setItem(KEY, tab);
  } catch {
    // 保存できなくても表示は変わらない。
  }
}
