// 動作報告。「その機種で動いたか」を配布サーバへ送る。
//
// **本番と beta で既定が違う**（作者の決定、2026-09-26）。
//
//   本番（webts.app）… **既定で送らない（オプトイン）。**利用者が設定か、
//     未確認の機種をつないだときの案内でオンにしたときだけ送る。送っている
//     あいだだけ「ログ収集中」を出す。
//   beta（beta.webts.app）… 既定で送る（オプトアウト）。機能追加の実験場。
//     最初に一度だけ注意書きを出し、送っているかを常に見える場所に出す。
//
// どちらかは deploy.yml が beta ブランチから作るときだけ VITE_WEBTS_CHANNEL=beta を
// 渡し、vite.config.ts が __WEBTS_BETA__ として埋め込む。
//
// 画面（注意書き・案内・表示・設定）は画面側が作る。ここは状態と送信だけを持つ。
//
// 送る中身は report-schema.ts が決める。同じ中身は1回しか送らない。
// 保存に失敗する環境（プライベートウィンドウなど）では、止めたことを覚えて
// おけないので送らない。

import { APP_VERSION } from '../epg-ui/version';
import { listConnectedTuners, readTunerPermission } from '../usb/px4-identity';
import {
  parseReport,
  REPORT_BROWSERS,
  REPORT_OSES,
  type Report,
} from './report-schema';

declare const __WEBTS_BETA__: boolean;

/** beta のビルドか。beta は既定で送り、本番は既定で送らない。 */
export const IS_BETA_BUILD: boolean = __WEBTS_BETA__;

const ENDPOINT = '/api/report';
/** beta：止めたら '1'（既定で送る）。 */
const KEY_OFF = 'webts-reports-off';
/** 本番：オンにしたら '1'（既定で送らない）。**beta と鍵を分ける。**意味が逆なので、取り違えると同意の向きが変わる。 */
const KEY_ON = 'webts-reports-on';
/** 本番：未確認の機種の案内を閉じた機種（product ID）。 */
const KEY_INVITE_DISMISSED = 'webts-reports-invite-dismissed';
const KEY_NOTICE = 'webts-reports-notice-shown';
const KEY_SENT = 'webts-reports-sent';
const KEY_LAST = 'webts-reports-last';
const SENT_LIMIT = 200;

type Listener = (enabled: boolean) => void;
const listeners = new Set<Listener>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageUsable(): boolean {
  return write('webts-reports-probe', '1') && write('webts-reports-probe', null);
}

/** いま送っているか。 */
export function reportsEnabled(): boolean {
  if (!storageUsable()) return false;
  return IS_BETA_BUILD ? read(KEY_OFF) !== '1' : read(KEY_ON) === '1';
}

/** 設定や案内から切り替える。 */
export function setReportsEnabled(enabled: boolean): void {
  if (IS_BETA_BUILD) write(KEY_OFF, enabled ? null : '1');
  else write(KEY_ON, enabled ? '1' : null);
  const now = reportsEnabled();
  for (const listener of listeners) listener(now);
}

/**
 * 「ログ収集中」のような表示を出すか。beta は常に（許可／停止を出す）、
 * 本番は送っているあいだだけ。
 */
export function reportsIndicatorVisible(): boolean {
  return IS_BETA_BUILD || reportsEnabled();
}

/** 送っているかの表示を追従させる。戻り値で購読をやめる。 */
export function subscribeReports(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** beta で最初の注意書きを出すべきか。本番では出さない。 */
export function reportsNoticeNeeded(): boolean {
  return IS_BETA_BUILD && read(KEY_NOTICE) !== '1';
}

/**
 * 本番で、未確認の機種をつないだときの案内を出すべきか。出すならその機種名、
 * 出さないなら null。**送っていない、案内をまだ閉じていない、WebTS で実機を
 * 確かめていない機種がつながっている**、のすべてがそろったときだけ出す。
 * beta（既定で送る）では出さない。
 */
export async function reportsInviteModel(): Promise<{ name: string; productId: number } | null> {
  if (IS_BETA_BUILD || reportsEnabled() || !storageUsable()) return null;
  const dismissed = dismissedInvites();
  try {
    const tuners = await listConnectedTuners();
    const tuner = tuners.find((item) => !item.model.verified
      && !dismissed.includes(item.model.productId));
    return tuner === undefined ? null
      : { name: tuner.model.name, productId: tuner.model.productId };
  } catch {
    return null;
  }
}

/** 案内を閉じた（オンにしなかった）。その機種では二度と出さない。 */
export function dismissReportsInvite(productId: number): void {
  write(KEY_INVITE_DISMISSED, JSON.stringify([...dismissedInvites(), productId]));
}

function dismissedInvites(): number[] {
  try {
    const parsed: unknown = JSON.parse(read(KEY_INVITE_DISMISSED) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === 'number') : [];
  } catch {
    return [];
  }
}

export function markReportsNoticeShown(): void {
  write(KEY_NOTICE, '1');
}

/** 最後に送った中身。設定画面でそのまま見せる。 */
export function lastSentReport(): Report | null {
  const text = read(KEY_LAST);
  if (text === null) return null;
  try {
    return parseReport(JSON.parse(text));
  } catch {
    return null;
  }
}

export interface Outcome {
  readonly kind: Report['kind'];
  readonly wave: Report['wave'];
  readonly result: Report['result'];
  /** failed のときだけ。 */
  readonly stage?: number;
  readonly code?: number;
}

/**
 * 結果を報告する。送らない設定なら何もしない。失敗しても視聴や走査には
 * 影響させないので、待たずに投げっぱなしにする。
 */
export function reportOutcome(outcome: Outcome): void {
  if (!reportsEnabled()) return;
  void send(outcome).catch(() => undefined);
}

async function send(outcome: Outcome): Promise<void> {
  const failed = outcome.result === 'failed';
  const browser = browserOf();
  const report = parseReport({
    v: APP_VERSION,
    model: await modelName(),
    os: osOf(),
    browser: browser.name,
    browserMajor: browser.major,
    kind: outcome.kind,
    wave: outcome.wave,
    result: outcome.result,
    stage: failed ? (outcome.stage ?? 0) : -1,
    code: failed ? (outcome.code ?? 0) : 0,
  });
  // 形が崩れたものは送らない。受け側も捨てるが、そもそも出さない。
  if (report === null || !reportsEnabled()) return;

  const key = JSON.stringify(report);
  const sent = sentKeys();
  if (sent.includes(key)) return;

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: key,
    keepalive: true,
    credentials: 'omit',
  });
  if (!response.ok) return;
  write(KEY_SENT, JSON.stringify([...sent, key].slice(-SENT_LIMIT)));
  write(KEY_LAST, key);
}

function sentKeys(): string[] {
  try {
    const parsed: unknown = JSON.parse(read(KEY_SENT) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function modelName(): Promise<string> {
  try {
    return (await readTunerPermission()).model?.name ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface UserAgentData {
  readonly platform?: string;
  readonly brands?: readonly { brand: string; version: string }[];
}

function userAgentData(): UserAgentData | undefined {
  return (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
}

function osOf(): Report['os'] {
  const platform = userAgentData()?.platform ?? '';
  const known: Record<string, Report['os']> = {
    Windows: 'Windows', macOS: 'macOS', Linux: 'Linux', Android: 'Android',
    'Chrome OS': 'ChromeOS', ChromeOS: 'ChromeOS',
  };
  const os = known[platform];
  return os !== undefined && REPORT_OSES.includes(os) ? os : 'other';
}

function browserOf(): { name: Report['browser']; major: number } {
  const brands = userAgentData()?.brands ?? [];
  const pick = (brand: string, name: Report['browser']) => {
    const entry = brands.find((item) => item.brand === brand);
    return entry === undefined ? null : { name, major: majorOf(entry.version) };
  };
  const found = pick('Microsoft Edge', 'Edge') ?? pick('Opera', 'Opera')
    ?? pick('Brave', 'Brave') ?? pick('Google Chrome', 'Chrome') ?? pick('Chromium', 'Chromium');
  if (found !== null && REPORT_BROWSERS.includes(found.name)) return found;
  return { name: 'other', major: 0 };
}

function majorOf(version: string): number {
  const major = Number.parseInt(version, 10);
  return Number.isInteger(major) && major >= 0 && major <= 999 ? major : 0;
}
