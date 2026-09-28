// 動作報告で送ってよいものの定義。送る側（reports.ts）と受ける側
// （functions/api/report.ts）の両方がこれを使う。
//
// **欲しいのは「その機種で動いたか」だけである。**ここに無い項目は送らないし、
// 受け側も受け取らない。自由記述やエラーメッセージの文字列は、パスや局名や
// 端末の事情が混ざりうるので項目にしない。番号と、決まった語だけにする。
//
// 送らないもの：シリアル番号、USB のインスタンス ID、カードの情報、局・サービス
// （地域が分かる）、郵便番号、細かい時刻、端末を見分ける ID。

export const REPORT_KINDS = ['view', 'scan'] as const;
export const REPORT_WAVES = ['GR', 'BS', 'CS'] as const;
/** ok は映った（視聴）／どれかがロックした（走査）。no-signal は走査が最後まで回って1つもロックしなかった。 */
export const REPORT_RESULTS = ['ok', 'no-signal', 'failed'] as const;
export const REPORT_OSES = ['Windows', 'macOS', 'Linux', 'Android', 'ChromeOS', 'other'] as const;
export const REPORT_BROWSERS = ['Chrome', 'Edge', 'Opera', 'Brave', 'Chromium', 'other'] as const;
/**
 * 止まった理由。「デバイスを開く」と「カード」の段で止まったとき、走査が上流に
 * 断られたときに入る。
 * それ以外の段で止まったとき、止まらなかったときは none。**決まった語だけ**で、
 * 識別子もカードの応答も入らない。
 *
 * 先頭から claim-failed までは C 側の OpenDetail の番号と同じ並び
 * （native/q3u4-descramble-probe.cpp）。並びを変えないこと。
 */
export const REPORT_DETAILS = [
  'none', 'no-device', 'descriptor-unreadable', 'busy', 'open-failed', 'invalid-serial',
  'slow-usb', 'invalid-topology', 'incomplete', 'not-selected', 'enumeration-failed',
  'claim-failed',
  // ここから下は JS 側で確かめた、no-device の中身（q3u4-module.ts の
  // resolveOpenDetail）。libusb の WebUSB 実装は、一覧を作るときに各機器を
  // open() して記述子を読み、失敗した機器を黙って外す。
  'webusb-unseen', 'webusb-unconfigured', 'webusb-open-network', 'webusb-open-security',
  'webusb-open-state', 'webusb-open-other', 'webusb-descriptor', 'webusb-readable',
  // カードの段（q3u4-module.ts の cardDetail）。どの呼び出し（connect / transmit）が
  // 上流のどの Error で失敗したか。card-init は呼び出しは通ったが、応答の解釈で
  // 失敗したもの。
  'card-init', 'card-connect-timeout', 'card-connect-no-card', 'card-connect-removed',
  'card-connect-protocol', 'card-connect-usb', 'card-connect-not-ready', 'card-connect-busy',
  'card-connect-other', 'card-transmit-timeout', 'card-transmit-no-card', 'card-transmit-removed',
  'card-transmit-protocol', 'card-transmit-usb', 'card-transmit-not-ready', 'card-transmit-busy',
  'card-transmit-other',
  // 走査の作業者が上流に断られた手順（C 側の ScanStep と同じ並び）。
  'scan-open-receiver', 'scan-start-capture', 'scan-attach', 'scan-stop-capture',
  'scan-close-receiver',
] as const;

export interface Report {
  /** アプリの版。 */
  readonly v: string;
  /** 上流の機種の表にある名前。分からなければ unknown。 */
  readonly model: string;
  readonly os: (typeof REPORT_OSES)[number];
  readonly browser: (typeof REPORT_BROWSERS)[number];
  /** ブラウザのメジャー版。分からなければ 0。 */
  readonly browserMajor: number;
  readonly kind: (typeof REPORT_KINDS)[number];
  readonly wave: (typeof REPORT_WAVES)[number];
  readonly result: (typeof REPORT_RESULTS)[number];
  /** 止まった段（stage-label.ts の番号）。ok と no-signal では -1。 */
  readonly stage: number;
  /** 上流のエラー番号。ok と no-signal では 0。 */
  readonly code: number;
  /** 「デバイスを開く」か「カード」の段で止まった理由（REPORT_DETAILS）。 */
  readonly detail: (typeof REPORT_DETAILS)[number];
}

const KEYS = ['v', 'model', 'os', 'browser', 'browserMajor', 'kind', 'wave', 'result',
  'stage', 'code', 'detail'] as const;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * 受け取ったものが報告として正しいかを見る。**項目が1つでも多い・足りない・
 * 形が違えば捨てる。**受け側が黙って余計なものを保存しないためである。
 */
export function parseReport(input: unknown): Report | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  // detail が無いのは 0.3.0 までの送り手。none として受け取る（読み込み直す
  // までのあいだ、古いページからの報告を捨てないため）。
  const record: Record<string, unknown> = { detail: 'none', ...(input as Record<string, unknown>) };
  const keys = Object.keys(record);
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;

  const { v, model, os, browser, browserMajor, kind, wave, result, stage, code, detail } = record;
  if (typeof v !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(-[a-z0-9.]{1,16})?$/.test(v)) return null;
  // 上流の機種名は英数字とハイフン程度。人の名前や自由な文字列を通さない。
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(model)) return null;
  if (!oneOf(REPORT_OSES, os) || !oneOf(REPORT_BROWSERS, browser)) return null;
  if (!integerIn(browserMajor, 0, 999)) return null;
  if (!oneOf(REPORT_KINDS, kind) || !oneOf(REPORT_WAVES, wave)) return null;
  if (!oneOf(REPORT_RESULTS, result)) return null;
  if (!integerIn(stage, -1, 63) || !integerIn(code, -1, 65535)) return null;
  if (result === 'failed' ? stage < 0 : stage !== -1 || code !== 0) return null;
  if (!oneOf(REPORT_DETAILS, detail)) return null;
  if (result !== 'failed' && detail !== 'none') return null;

  return { v, model, os, browser, browserMajor, kind, wave, result, stage, code, detail };
}
