// 動作報告。「その機種で動いたか」を配布サーバへ送る。
//
// **既定で送らない（オプトイン）。**利用者が設定か、未確認の機種をつないだときの
// 案内でオンにしたときだけ送る。送っているあいだだけ「ログ収集中」を出す。
//
// 以前は beta（beta.webts.app）が既定で送っていたが、本番と同じものを出していて
// 違いが既定だけだったので、0.4.0 で beta をやめた（作者の決定、2026-10-05）。
//
// 画面（案内・表示・設定）は画面側が作る。ここは状態と送信だけを持つ。
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

const ENDPOINT = '/api/report';
/**
 * オンにしたら '1'（既定で送らない）。**鍵の名前を変えないこと。**beta が使っていた
 * 'webts-reports-off'（意味が逆）と取り違えると、同意の向きが変わる。
 */
const KEY_ON = 'webts-reports-on';
/** 未確認の機種の案内を閉じた機種（product ID）。 */
const KEY_INVITE_DISMISSED = 'webts-reports-invite-dismissed';
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
  return read(KEY_ON) === '1';
}

/** 設定や案内から切り替える。 */
export function setReportsEnabled(enabled: boolean): void {
  write(KEY_ON, enabled ? '1' : null);
  const now = reportsEnabled();
  for (const listener of listeners) listener(now);
}

/** 「ログ収集中」のような表示を出すか。送っているあいだだけ。 */
export function reportsIndicatorVisible(): boolean {
  return reportsEnabled();
}

/** 送っているかの表示を追従させる。戻り値で購読をやめる。 */
export function subscribeReports(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}


/**
 * 未確認の機種をつないだときの案内を出すべきか。出すならその機種名、出さない
 * なら null。**送っていない、案内をまだ閉じていない、WebTS で実機を確かめて
 * いない機種がつながっている**、のすべてがそろったときだけ出す。
 */
export async function reportsInviteModel(): Promise<{ name: string; productId: number } | null> {
  if (reportsEnabled() || !storageUsable()) return null;
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
  /** failed と incomplete のときの理由（REPORT_DETAILS の語）。 */
  readonly detail?: Report['detail'];
  /**
   * 始めた時点の機種名（reportModelName）。**送る時点で読むと、抜かれた
   * あとは unknown になる**（USB_IO で止まった報告が unknown で届いていた）。
   */
  readonly model?: string;
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
  const explained = failed || outcome.result === 'incomplete';
  const browser = browserOf();
  const report = parseReport({
    v: APP_VERSION,
    model: outcome.model ?? await reportModelName(),
    os: osOf(),
    browser: browser.name,
    browserMajor: browser.major,
    kind: outcome.kind,
    wave: outcome.wave,
    result: outcome.result,
    stage: failed ? (outcome.stage ?? 0) : -1,
    code: failed ? (outcome.code ?? 0) : 0,
    detail: explained ? (outcome.detail ?? 'none') : 'none',
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

/** いま使うチューナーの機種名。視聴や走査を始めるときに控えておく。 */
export async function reportModelName(): Promise<string> {
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
