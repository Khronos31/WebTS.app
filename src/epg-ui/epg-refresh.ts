// 放映中の番組情報を取り直す。手押しの更新と自動更新の両方がここを通る。
//
// **EIT[p/f] は選局した TS の局しか載っていない。**全局の「いま放送中」を
// 知るには、局のある物理チャンネルへ順に合わせ直すしかない。EIT[p/f] は
// 数秒周期で繰り返されるので1波あたりは短く、既知の波だけなら関東で10波
// 前後、全帯域の走査に比べれば桁で速い。
//
// 取れるのは「現在」と「次」の2つである。次が保存してあるので、現在の番組が
// 終わっても**選局し直さずに1番組ぶんは追随できる**。ここを呼ぶのは、その
// 先まで尽きたときだけでよい。

import { ChannelScan, type ScanProgress } from './channel-scan';
import { mergePrograms } from './channel-store';
import { channelsSync, primeChannels } from './channel-source';
import { tuningForChannel, tuningKey, type Tuning } from './tuning';
import { LiveSession } from './live-session';

/** 自動更新の間隔の下限。失敗しても次の試行まではこれだけ空ける。 */
const COOLDOWN_MS = 10 * 60 * 1000;

let running: ChannelScan | null = null;
let lastAttempt = 0;

export function isRefreshing(): boolean {
  return running !== null;
}

/** 視聴を始めるときなど、受信機を明け渡す必要があるときに呼ぶ。 */
export function stopRefresh(): void {
  running?.stop();
}

/** 登録済みの局が乗っている中継器。同じ TS を指すものは畳む。 */
export function knownTunings(): Tuning[] {
  // 有効/無効は表示の絞り込みなので、取得は外した局のぶんも回る。
  const unique = new Map<string, Tuning>();
  for (const channel of channelsSync(false)) {
    const tuning = tuningForChannel(channel);
    if (tuning !== null) unique.set(tuningKey(tuning), tuning);
  }
  return [...unique.values()];
}

export async function refreshPrograms(
  onProgress?: (progress: ScanProgress) => void,
): Promise<number> {
  if (running !== null) throw new Error('すでに番組情報を取得しています。');
  const tunings = knownTunings();
  if (tunings.length === 0) {
    throw new Error('局が登録されていません。先にスキャンを実行してください。');
  }
  const scan = new ChannelScan();
  running = scan;
  lastAttempt = Date.now();
  try {
    const result = await scan.run(
      onProgress === undefined ? { tunings } : { tunings, onProgress });
    // **届いたぶんだけを入れ替える。**回らなかった局の番組を消さない。
    await mergePrograms(result.programs);
    await primeChannels();
    return result.programs.length;
  } finally {
    running = null;
  }
}

export interface AutoRefreshResult {
  /** 実際に受信機を使ったか。条件を満たさなければ false。 */
  readonly ran: boolean;
  readonly programs?: number;
  readonly error?: string;
}

/**
 * 条件が揃っていれば取り直す。揃っていなければ何もしない。
 *
 * 受信機は1本しか開けないので、**視聴中とほかの走査中は必ず見送る**。
 * 裏のタブでも見送る。タイマーが絞られた状態で選局を始めると、チャンネルの
 * 切り替わりを取りこぼす（FINDINGS 18章）。
 */
export async function maybeAutoRefresh(
  onProgress?: (progress: ScanProgress) => void,
): Promise<AutoRefreshResult> {
  if (running !== null) return { ran: false };
  if (LiveSession.isActive() || ChannelScan.isActive()) return { ran: false };
  if (document.visibilityState !== 'visible') return { ran: false };
  if (Date.now() - lastAttempt < COOLDOWN_MS) return { ran: false };
  if (knownTunings().length === 0) return { ran: false };
  try {
    return { ran: true, programs: await refreshPrograms(onProgress) };
  } catch (error) {
    return { ran: true, error: error instanceof Error ? error.message : String(error) };
  }
}
