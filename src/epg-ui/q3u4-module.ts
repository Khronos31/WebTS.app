// Q3U4 の WASM モジュール。**視聴と走査で同じ実体を使う。**
//
// C 側はデバイスを開いた状態をセッションとして持ち、受信機ごとの仕事が
// それを共有する。JS 側で `factory.default()` を別々に呼ぶと Emscripten の
// 実体が2つでき、ヒープもグローバルも別になる。セッションが分かれてしまえば
// 同じデバイスを2つの実体が開こうとして失敗する。
//
// そのため、実体の生成はここ1か所に集める。

import { diagnoseTunerOpen, readTunerPermission, selectedTuner } from '../usb/px4-identity';
import { REPORT_DETAILS, type Report } from '../reports/report-schema';

type ReportDetail = Report['detail'];

const MODULE_URL = '/build/q3u4-descramble/q3u4-descramble.mjs';

export interface Q3U4Module {
  ccall(
    name: string,
    returnType: string | null,
    argumentTypes: string[],
    args: unknown[],
  ): number | string;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

let modulePromise: Promise<Q3U4Module> | null = null;

export async function loadQ3U4Module(): Promise<Q3U4Module> {
  modulePromise ??= (async () => {
    const factory = (await import(/* @vite-ignore */ MODULE_URL)) as {
      default: () => Promise<Q3U4Module>;
    };
    return factory.default();
  })();
  return modulePromise;
}

/**
 * セッションを開いたままにするか。
 *
 * 視聴が終わってもデバイスを閉じない状態にしておくと、続けて走査を始める
 * ときに初期化をやり直さずに済む。逆に、誰も使わなくなったら畳みたい。
 */
export function keepSessionOpen(module: Q3U4Module, keep: boolean): void {
  module.ccall('webts_q3u4_session_keep_open', null, ['number'], [keep ? 1 : 0]);
}

/** 「デバイスを開く」の段の番号（stage-label.ts）。 */
export const STAGE_OPEN = 2;
/** 「カード」の段の番号（stage-label.ts）。 */
export const STAGE_CARD = 4;

/** 上流の Error の番号を、カードの理由の語にする（px4/error.h）。 */
const CARD_ERRORS: Readonly<Record<number, string>> = {
  4: 'busy', 5: 'not-ready', 6: 'timeout', 7: 'usb', 8: 'usb', 9: 'protocol',
  12: 'no-card', 13: 'removed',
};

/**
 * 直前にカードの初期化が通らなかった理由を、動作報告の語にする。C 側は
 * 3回まで試し直し、最後の失敗を残す（webts_q3u4_card_failure）。
 */
export function cardDetail(module: Q3U4Module): ReportDetail {
  return cardFailureWord(module) ?? 'card-init';
}

/**
 * 視聴中に復号（B25）が失敗したとき、その直前にカードとのやりとりが失敗して
 * いればその語。**視聴の途中でカードを抜くと、初期化は済んでいるので「カード」
 * の段ではなく復号で止まる**（PROTOCOL_ERROR と B25 の番号だけになった。
 * 実機、2026-10-04）。C 側は復号が止まったときにも同じ値を残す。無ければ null。
 *
 * 走査はカードを使わないので、走査の失敗には使わない（前の視聴の値が残っている）。
 */
export function cardFailureDuringViewing(module: Q3U4Module): ReportDetail | null {
  return cardFailureWord(module);
}

function cardFailureWord(module: Q3U4Module): ReportDetail | null {
  const packed = Number(module.ccall('webts_q3u4_card_failure', 'number', [], []));
  if (packed === 0) return null;
  const phase = (packed >> 8) === 2 ? 'transmit' : 'connect';
  const word = `card-${phase}-${CARD_ERRORS[packed & 0xff] ?? 'other'}`;
  return (REPORT_DETAILS as readonly string[]).includes(word) ? word as ReportDetail : null;
}

/**
 * 直前に「デバイスを開く」で止まった理由を、動作報告の語にする
 * （report-schema.ts の REPORT_DETAILS。C 側の OpenDetail と同じ並び）。
 */
export function openDetail(module: Q3U4Module): ReportDetail {
  const index = Number(module.ccall('webts_q3u4_open_detail', 'number', [], []));
  return REPORT_DETAILS[index] ?? 'none';
}

/**
 * 「デバイスを開く」で止まった理由を確かめる。それ以外の段なら none。
 *
 * C 側が no-device（対応機種の機器が1つも見えない）と言っても、WebUSB には
 * 見えていることがある。libusb の WebUSB 実装は一覧を作るときに各機器を
 * open() して記述子を読み、**失敗した機器を黙って外す**からである（別の
 * タブが視聴中のとき、実機でこうなった。2026-09-27）。そのときは JS から
 * 開いてみて、どこで失敗したかを語にする。
 */
export async function resolveOpenDetail(module: Q3U4Module, stage: number): Promise<ReportDetail> {
  if (stage === STAGE_CARD) return cardDetail(module);
  if (stage !== STAGE_OPEN) return 'none';
  const detail = openDetail(module);
  if (detail !== 'no-device') return detail;
  try {
    const found = await diagnoseTunerOpen();
    const words = {
      unseen: 'webusb-unseen', unconfigured: 'webusb-unconfigured',
      network: 'webusb-open-network', security: 'webusb-open-security',
      state: 'webusb-open-state', other: 'webusb-open-other',
      descriptor: 'webusb-descriptor', readable: 'webusb-readable',
    } as const satisfies Record<typeof found, ReportDetail>;
    return words[found];
  } catch {
    return detail;
  }
}

const SCAN_STEPS = [
  'scan-open-receiver', 'scan-start-capture', 'scan-attach', 'scan-stop-capture',
  'scan-close-receiver',
] as const satisfies readonly ReportDetail[];

/**
 * 走査で最初に上流に断られた手順を、動作報告の語にする。wave は C 側の系統
 * （地上波 0、衛星 1）。無ければ none。
 */
export function scanStepDetail(module: Q3U4Module, wave: number): ReportDetail {
  const step = Number(module.ccall('webts_q3u4_scan_failed_step', 'number', ['number'], [wave]));
  return SCAN_STEPS[step - 1] ?? 'none';
}

/**
 * カードが挿さっていない・抜かれたときに、利用者へ出す案内。**文面は Antigravity の担当。**
 *
 * WebTS はチューナー本体のカードスロットだけを使う。px4_drv が長く本体の
 * カードリーダに対応していなかったため、外付けのカードリーダを使うものだと
 * 思って挿さずに試す人がいた（Android の PX-Q3U4、2026-10-03 の報告と写真）。
 * そのとき画面には PROTOCOL_ERROR と B25 の番号しか出ず、何をすればいいか
 * 伝わらなかった。
 */
export const CARD_MISSING_GUIDANCE =
  'B-CAS カードが見つかりません（挿されていないか、抜かれました）。カードはチューナー本体のカードスロットに挿してください。'
  + '外付けのカードリーダーは非対応です。';

/** カードが無い（挿さっていない・抜かれた）ことを表す語か。 */
export function isCardMissing(detail: ReportDetail): boolean {
  return /^card-(connect|transmit)-(no-card|removed)$/.test(detail);
}

/** エラーの文言へ添える理由。語は動作報告と同じ（問い合わせのときに突き合わせられるように）。 */
export function describeOpenDetail(detail: ReportDetail): string {
  if (detail === 'none') return '';
  if (detail.startsWith('card-')) return `（カードの理由: ${detail}）`;
  if (detail.startsWith('scan-')) return `（断られた手順: ${detail}）`;
  return `（開けなかった理由: ${detail}）`;
}

/**
 * 使うチューナーを C 側へ伝える。**受信機を開く直前に毎回呼ぶ。**
 *
 * 許可されたチューナーが複数あると、上流はどれを開くか決められず
 * INVALID_ARGUMENT を返す。利用者が選んだ1台（無ければ一覧の先頭）の
 * 識別子を渡す。serial が同じ筐体がほかにつながっていれば、USB 機器の
 * 位置も渡す（px4-identity.ts の usbAddressOf）。どちらも C 側のメモリに
 * 置くだけで、外へは出ない。
 */
export async function applyTunerSelection(module: Q3U4Module): Promise<void> {
  const tuner = await selectedTuner();
  const error = module.ccall('webts_q3u4_select_tuner', 'number', ['string', 'string'],
    [tuner?.key ?? '', tuner?.usbPaths.join(',') ?? '']) as number;
  if (error !== 0) throw new Error(`チューナーを選べません (${error})`);
}

/**
 * 受信機を使い始める前の確認。
 *
 * **機種によっては1台が USB 機器いくつかとして列挙される。**PX-Q3U4 は
 * 内部に IT930x が2個あり、2つに見える（FINDINGS 9章）。ブラウザの選択
 * ダイアログには同じに見える行が2つ並び、一度では片方しか許可できない。
 * 片方だけだと C 側は NOT_FOUND を返すが、その番号を見せられても何を
 * すればいいか分からない。ここで止めて、何が足りないかを言う。
 * 何台要るかは上流の機種の表が答える（px4-identity.ts）。
 */
export async function ensureTunerAvailable(): Promise<void> {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) {
    throw new Error('この環境では WebUSB が使えません。'
      + 'Chromium 系のブラウザで、HTTPS か localhost から開いてください。');
  }
  const permission = await readTunerPermission();
  if (permission.ready) return;
  if (permission.model === null) {
    throw new Error('チューナーが許可されていません。設定の「チューナーを接続」から許可してください。');
  }
  const { model, granted, required } = permission;
  throw new Error(`${model.name} の許可が ${granted} 台ぶんしかありません。`
    + `この機種は USB 機器 ${required} つとして見え、選択ダイアログには同じ行が`
    + ` ${required} つ並びます。設定からもう一度接続して、残りも許可してください。`);
}
