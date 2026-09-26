// 受信機が1本しかないチューナーでの、視聴と走査の取り合い。
//
// PX-M1UR、PX-S1UR、DTV02(A)-1T1S-U、DTV03A-1TU は受信機が1本で、視聴も
// 走査（チャンネルスキャン・番組表の取得）もその1本を使う。同時には使えない。
//
// - **視聴が優先。**視聴を始めると動いている走査を止め、視聴中は新しい走査を
//   始めない（LiveBlocksScanError）。作者の決定（2026-09-26）。
// - 走査どうしは順番に回す。地上波と衛星を同時に回す流れ（フルスキャン、
//   番組表の取得）も、1本しかなければ1つずつになる。
//
// 受信機が2本以上あるチューナーでは、ここは何もしない。
//
// 視聴を始める前に「ライブ視聴中は番組表が更新できません」と確かめる画面は
// 画面側が出す。出すかどうかは liveBlocksGuideNoticeNeeded() が答える。

import { selectedTuner } from '../usb/px4-identity';

/** 使うチューナーの受信機が1本だけか。 */
export async function tunerHasOneReceiver(): Promise<boolean> {
  try {
    return (await selectedTuner())?.model.receivers === 1;
  } catch {
    return false;
  }
}

/** 視聴中なので走査を始めない、という失敗。 */
export class LiveBlocksScanError extends Error {
  constructor() {
    super('ライブ視聴中は番組表を更新できません。');
    this.name = 'LiveBlocksScanError';
  }
}

let liveHolds = false;

/** 1本しかない受信機を、いま視聴が使っているか。 */
export function liveHoldsReceiver(): boolean {
  return liveHolds;
}

export function setLiveHoldsReceiver(holds: boolean): void {
  liveHolds = holds;
}

let turn: Promise<void> = Promise.resolve();

/**
 * 走査の順番を取る。戻り値を呼ぶと次の走査に譲る。**必ず呼ぶこと。**
 * 前の走査が失敗しても、順番は次へ進む。
 */
export async function takeScanTurn(): Promise<() => void> {
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const previous = turn;
  turn = previous.then(() => mine);
  await previous;
  return release;
}

// ---- 視聴を始める前の確認 ----

const NOTICE_DISMISSED_KEY = 'webts-live-blocks-guide-dismissed';

/**
 * 視聴を始める前に「ライブ視聴中は番組表が更新できません。視聴を開始
 * しますか？」を出すべきか。受信機が1本のチューナーで、利用者が
 * 「2度と表示しない」を選んでいないときだけ true。
 */
export async function liveBlocksGuideNoticeNeeded(): Promise<boolean> {
  try {
    if (localStorage.getItem(NOTICE_DISMISSED_KEY) === '1') return false;
  } catch {
    // 覚えられない環境では毎回出す。
  }
  return tunerHasOneReceiver();
}

/** 「2度と表示しない」。 */
export function dismissLiveBlocksGuideNotice(): void {
  try {
    localStorage.setItem(NOTICE_DISMISSED_KEY, '1');
  } catch {
    // 覚えられなくても、今回は閉じるだけ。
  }
}
