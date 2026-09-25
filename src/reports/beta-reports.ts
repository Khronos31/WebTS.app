// beta 版だけの動作報告。「その機種で動いたか」を配布サーバへ送る。
//
// **beta のビルドにしか入らない。**deploy.yml が beta ブランチから作るときだけ
// VITE_WEBTS_CHANNEL=beta を渡し、vite.config.ts が __WEBTS_BETA__ として埋め込む。
// それ以外のビルドでは false に畳まれ、送る処理は成果物から落ちる。
//
// 既定で送る。利用者は設定から止められる（オプトアウト）。最初に一度だけ
// 注意書きを出すことと、送っているかを常に見える場所に出すことは画面側が行う。
// ここはその状態と送信だけを持つ。
//
// 送る中身は report-schema.ts が決める。同じ中身は1回しか送らない。
// 保存に失敗する環境（プライベートウィンドウなど）では、止めたことを覚えて
// おけないので送らない。

import { APP_VERSION } from '../epg-ui/version';
import { readTunerPermission } from '../usb/px4-identity';
import {
  parseReport,
  REPORT_BROWSERS,
  REPORT_OSES,
  type Report,
} from './report-schema';

declare const __WEBTS_BETA__: boolean;

export const REPORTS_BUILT: boolean = __WEBTS_BETA__;

const ENDPOINT = '/api/report';
const KEY_OFF = 'webts-reports-off';
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

/** いま送っているか。beta でなければ常に false。 */
export function reportsEnabled(): boolean {
  return REPORTS_BUILT && storageUsable() && read(KEY_OFF) !== '1';
}

/** 設定から切り替える。 */
export function setReportsEnabled(enabled: boolean): void {
  if (!REPORTS_BUILT) return;
  write(KEY_OFF, enabled ? null : '1');
  const now = reportsEnabled();
  for (const listener of listeners) listener(now);
}

/** 送っているかの表示を追従させる。戻り値で購読をやめる。 */
export function subscribeReports(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 最初の注意書きを出すべきか。 */
export function reportsNoticeNeeded(): boolean {
  return REPORTS_BUILT && read(KEY_NOTICE) !== '1';
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
  if (!REPORTS_BUILT || !reportsEnabled()) return;
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
