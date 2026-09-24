// WebTS.app - EPGStation Style Program Guide (GuideView)
//
// 1. 選局できるのは放送中の番組のみ（isOnAir(program, now) で判定）。未来の番組は詳細モーダルを開く。
// 2. データは loadScheduleRange(from, to) から取得（局ごとに時刻順で返却）。
// 3. webts-programs-updated / webts-channels-changed で自動再描画。
// 4. EPGStationスタイルの2軸固定スクロール（上部局ヘッダー固定＆左側時刻列固定）、ジャンル別アクセントカラー。
// 5. 放送番組表の取得限界（ARIB STD-B10: 直近8日間 = 当日〜7日後）に基づく前後移動の境界クランプ。

import { loadScheduleRange, programCoverage, type ChannelSchedule } from '../channel-source';
import { onRefreshStatus } from '../epg-refresh';
import { readScheduleFetchedAt } from '../channel-store';
import type { ProgramDialog } from '../components/program-dialog';
import type { StreamDialog } from '../components/stream-dialog';
import type { BroadcastType, ChannelItem, ProgramItem } from '../types';

const HOUR_MS = 60 * 60 * 1000;
/** 一度に出す時間幅（時間単位）。 */
const SPAN_HOURS = 12;
/** 前後へ送る幅（時間単位）。 */
const STEP_HOURS = 6;
/** 1分あたりのピクセル高さ（60分で 150px）。 */
const PX_PER_MINUTE = 2.5;
/** 1時間あたりのピクセル高さ。 */
const HOUR_HEIGHT = 60 * PX_PER_MINUTE;
/** チャンネル1列あたりのピクセル幅。 */
const CHANNEL_COLUMN_WIDTH = 200;

/**
 * 放送波（ARIB STD-B10 EIT[schedule]）から取得できる最大日数。
 * 当日を含めて最大8日間（直近8日: 今日 + 7日先、計192時間）。
 */
export const MAX_SCHEDULE_DAYS = 8;

export type Wave = Exclude<BroadcastType, 'ALL'>;

const WAVES: readonly { value: Wave; label: string }[] = [
  { value: 'GR', label: '地上波 (GR)' },
  { value: 'BS', label: 'BS放送' },
  { value: 'CS', label: 'CS放送' },
];

/** ARIB STD-B10 大分類ジャンル名称 */
const GENRE_LABELS: Record<string, string> = {
  '0': 'ニュース/報道',
  '1': 'スポーツ',
  '2': '情報/ワイド',
  '3': 'ドラマ',
  '4': '音楽',
  '5': 'バラエティ',
  '6': '映画',
  '7': 'アニメ/特撮',
  '8': 'ドキュメンタリー',
  '9': '劇場/公演',
  '10': '趣味/教育',
  '11': '福祉',
  '15': 'その他',
};

export interface GuideViewOptions {
  readonly hash: string;
  readonly programDialog: ProgramDialog;
  readonly streamDialog: StreamDialog;
}

export interface ScheduleBounds {
  readonly minFrom: number;
  readonly maxFrom: number;
  readonly minMidnight: number;
  readonly maxMidnight: number;
}

/** 画面切り替え後もユーザーが閲覧していた時間帯を保持する控え。 */
let lastViewedFrom: number | null = null;

/** 選んでいる波はハッシュに持つ。戻るで戻ったときに波が変わらないように。 */
export function waveFromHash(hash: string): Wave {
  const match = /[?&]wave=(GR|BS|CS)\b/.exec(hash);
  return (match?.[1] as Wave | undefined) ?? 'GR';
}

/** 放送中か。終了時刻が未定 (endAt === startAt) の番組は、始まっていれば放送中とみなす。 */
export function isOnAir(program: ProgramItem, now: number): boolean {
  return program.startAt <= now && (program.endAt > now || program.endAt === program.startAt);
}

/** 番組表の移動可能範囲を計算する（過去は保存データ最古日/本日0時、未来は本日含め最大8日分）。 */
export function calculateScheduleBounds(
  coverage: { from: number; to: number } | null,
  now: number = Date.now(),
): ScheduleBounds {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  // 過去の下限: 本日0時、または保存されている番組の最過去の日の0時
  let minMidnight = today.getTime();
  if (coverage && coverage.from < minMidnight) {
    const covStartDay = new Date(coverage.from);
    covStartDay.setHours(0, 0, 0, 0);
    minMidnight = covStartDay.getTime();
  }

  // 未来の上限: 本日 + 7日先 (Day 7) の24:00 (計8日分の末尾)
  const maxDay = new Date(today);
  maxDay.setDate(maxDay.getDate() + (MAX_SCHEDULE_DAYS - 1));
  const maxMidnight = maxDay.getTime();

  let maxTo = maxMidnight + 24 * HOUR_MS;
  if (coverage && coverage.to > maxTo) {
    maxTo = coverage.to;
  }

  const minFrom = minMidnight;
  const maxFrom = Math.max(minMidnight, maxTo - SPAN_HOURS * HOUR_MS);

  return { minFrom, maxFrom, minMidnight, maxMidnight };
}

function startOfHour(time: number): number {
  const date = new Date(time);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function formatDay(time: number): string {
  return new Date(time).toLocaleDateString('ja-JP',
    { month: 'numeric', day: 'numeric', weekday: 'short' });
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export class GuideView {
  public readonly element: HTMLElement;
  readonly #options: GuideViewOptions;
  readonly #wave: Wave;
  #from: number;
  #minFrom: number;
  #maxFrom: number;

  readonly #tabsContainer: HTMLElement;
  readonly #toolbar: HTMLElement;
  readonly #dateSelect: HTMLSelectElement;
  readonly #hourSelect: HTMLSelectElement;
  readonly #earlierBtn: HTMLButtonElement;
  readonly #laterBtn: HTMLButtonElement;
  readonly #rangeText: HTMLElement;
  readonly #fetchedText: HTMLElement;
  readonly #statusPill: HTMLElement;
  readonly #statusText: HTMLElement;
  readonly #body: HTMLElement;

  #scrollContainer: HTMLElement | null = null;
  #shouldAutoScrollToNow = true;
  #shouldResetScrollToTop = false;
  #cleanupDrag: (() => void) | null = null;

  readonly #unsubscribe: () => void;
  readonly #onUpdated = (): void => { void this.#render(); };
  #timer: number | null = null;

  constructor(options: GuideViewOptions) {
    this.#options = options;
    this.#wave = waveFromHash(options.hash);

    const initialBounds = calculateScheduleBounds(null, Date.now());
    this.#minFrom = initialBounds.minFrom;
    this.#maxFrom = initialBounds.maxFrom;
    this.#from = Math.max(this.#minFrom, Math.min(this.#maxFrom, lastViewedFrom ?? startOfHour(Date.now())));

    this.element = document.createElement('div');
    this.element.className = 'guide-view';

    // 1. 放送波タブセレクター (GR / BS / CS)
    this.#tabsContainer = document.createElement('div');
    this.#tabsContainer.className = 'tabs-container';
    this.#renderTabs();

    // 2. ナビゲーションツールバー
    this.#toolbar = document.createElement('div');
    this.#toolbar.className = 'guide-toolbar';

    const navBar = document.createElement('div');
    navBar.className = 'guide-nav-bar';

    const controls = document.createElement('div');
    controls.className = 'guide-nav-controls';

    // 日付選択ドロップダウン
    this.#dateSelect = document.createElement('select');
    this.#dateSelect.className = 'guide-select';
    this.#dateSelect.setAttribute('aria-label', '日付選択');
    this.#dateSelect.addEventListener('change', () => {
      const selectedMidnight = Number(this.#dateSelect.value);
      if (!Number.isNaN(selectedMidnight)) {
        const curDate = new Date(this.#from);
        const target = new Date(selectedMidnight);
        target.setHours(curDate.getHours(), 0, 0, 0);
        this.#from = Math.max(this.#minFrom, Math.min(this.#maxFrom, target.getTime()));
        lastViewedFrom = this.#from;
        this.#shouldResetScrollToTop = true;
        void this.#render();
      }
    });

    // 開始時刻ドロップダウン
    this.#hourSelect = document.createElement('select');
    this.#hourSelect.className = 'guide-select';
    this.#hourSelect.setAttribute('aria-label', '開始時刻');
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = `${String(h).padStart(2, '0')}:00`;
      this.#hourSelect.append(opt);
    }
    this.#hourSelect.addEventListener('change', () => {
      const h = Number(this.#hourSelect.value);
      if (!Number.isNaN(h)) {
        const curDate = new Date(this.#from);
        curDate.setHours(h, 0, 0, 0);
        this.#from = Math.max(this.#minFrom, Math.min(this.#maxFrom, curDate.getTime()));
        lastViewedFrom = this.#from;
        this.#shouldResetScrollToTop = true;
        void this.#render();
      }
    });

    // 前後移動・いまボタン
    const btnGroup = document.createElement('div');
    btnGroup.className = 'guide-btn-group';

    this.#earlierBtn = this.#button(`◀ ${STEP_HOURS}h前`, () => {
      this.#shift(-STEP_HOURS);
    }, 'btn-small');

    const nowBtn = this.#button('いま', () => {
      const now = Date.now();
      if (now >= this.#from && now < this.#from + SPAN_HOURS * HOUR_MS) {
        this.#scrollToNow();
      } else {
        this.#from = Math.max(this.#minFrom, Math.min(this.#maxFrom, startOfHour(now)));
        lastViewedFrom = this.#from;
        this.#shouldAutoScrollToNow = true;
        void this.#render();
      }
    }, 'btn-small primary');

    this.#laterBtn = this.#button(`${STEP_HOURS}h後 ▶`, () => {
      this.#shift(STEP_HOURS);
    }, 'btn-small');

    btnGroup.append(this.#earlierBtn, nowBtn, this.#laterBtn);

    // 時間帯クイックジャンプチップス
    const chipsContainer = document.createElement('div');
    chipsContainer.className = 'guide-time-chips';
    const chips = [
      { label: '朝 04:00', hour: 4 },
      { label: '昼 11:00', hour: 11 },
      { label: '夜 18:00', hour: 18 },
      { label: '深夜 23:00', hour: 23 },
    ];
    for (const chip of chips) {
      const chipBtn = document.createElement('button');
      chipBtn.type = 'button';
      chipBtn.className = 'guide-chip';
      chipBtn.textContent = chip.label;
      chipBtn.addEventListener('click', () => {
        const curDate = new Date(this.#from);
        curDate.setHours(chip.hour, 0, 0, 0);
        this.#from = Math.max(this.#minFrom, Math.min(this.#maxFrom, curDate.getTime()));
        lastViewedFrom = this.#from;
        this.#shouldResetScrollToTop = true;
        void this.#render();
      });
      chipsContainer.append(chipBtn);
    }

    controls.append(this.#dateSelect, this.#hourSelect, btnGroup, chipsContainer);

    // メタ情報表示（範囲、取得時刻、走査ステータス）
    const metaGroup = document.createElement('div');
    metaGroup.className = 'guide-meta-group';

    this.#rangeText = document.createElement('span');
    this.#rangeText.className = 'guide-range-text';

    this.#fetchedText = document.createElement('span');
    this.#fetchedText.className = 'guide-fetched-text';

    this.#statusPill = document.createElement('div');
    this.#statusPill.className = 'guide-status-pill';
    this.#statusPill.style.display = 'none';
    const statusDot = document.createElement('span');
    statusDot.className = 'guide-status-dot';
    this.#statusText = document.createElement('span');
    this.#statusPill.append(statusDot, this.#statusText);

    metaGroup.append(this.#rangeText, this.#fetchedText, this.#statusPill);

    navBar.append(controls, metaGroup);
    this.#toolbar.append(navBar);

    // 3. メイン番組表領域
    this.#body = document.createElement('div');
    this.#body.className = 'guide-body';

    this.element.append(this.#tabsContainer, this.#toolbar, this.#body);

    // イベント購読
    this.#unsubscribe = onRefreshStatus((text) => {
      if (text !== '') {
        this.#statusPill.style.display = 'inline-flex';
        this.#statusText.textContent = text;
      } else {
        this.#statusPill.style.display = 'none';
      }
    });

    window.addEventListener('webts-programs-updated', this.#onUpdated);
    window.addEventListener('webts-channels-changed', this.#onUpdated);

    // 放送中判定と現在時刻ラインを1分ごとに更新
    this.#timer = window.setInterval(() => {
      void this.#render();
    }, 60_000);

    void this.#render();
  }

  #renderTabs(): void {
    this.#tabsContainer.replaceChildren();
    for (const entry of WAVES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tab-button ${this.#wave === entry.value ? 'active' : ''}`;
      btn.textContent = entry.label;
      btn.addEventListener('click', () => {
        location.hash = `#/guide?wave=${entry.value}`;
      });
      this.#tabsContainer.append(btn);
    }
  }

  #button(label: string, onClick: () => void, className = 'btn-small'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  #shift(hours: number): void {
    const target = this.#from + hours * HOUR_MS;
    const clamped = Math.max(this.#minFrom, Math.min(this.#maxFrom, target));
    if (clamped !== this.#from) {
      this.#from = clamped;
      lastViewedFrom = this.#from;
      this.#shouldResetScrollToTop = true;
      void this.#render();
    }
  }

  #scrollToNow(): void {
    if (!this.#scrollContainer) return;
    const now = Date.now();
    const from = this.#from;
    if (now >= from && now < from + SPAN_HOURS * HOUR_MS) {
      const nowTop = Math.round(((now - from) / 60000) * PX_PER_MINUTE);
      this.#scrollContainer.scrollTo({
        top: Math.max(0, nowTop - 120),
        behavior: 'smooth',
      });
    }
  }

  async #render(): Promise<void> {
    const coverage = await programCoverage();
    const now = Date.now();

    // 境界の更新とクランプ（最大8日間）
    const bounds = calculateScheduleBounds(coverage, now);
    this.#minFrom = bounds.minFrom;
    this.#maxFrom = bounds.maxFrom;
    this.#from = Math.max(this.#minFrom, Math.min(this.#maxFrom, this.#from));
    lastViewedFrom = this.#from;

    // 前後ボタンの活性・非活性を更新
    this.#earlierBtn.disabled = this.#from <= this.#minFrom;
    this.#laterBtn.disabled = this.#from >= this.#maxFrom;
    this.#earlierBtn.title = this.#from <= this.#minFrom
      ? 'これ以上過去へは移動できません'
      : `${STEP_HOURS}時間前へ移動`;
    this.#laterBtn.title = this.#from >= this.#maxFrom
      ? 'これ以上未来へは移動できません（番組表は最大8日分です）'
      : `${STEP_HOURS}時間後へ移動`;

    const from = this.#from;
    const to = from + SPAN_HOURS * HOUR_MS;

    // ツールバー情報更新
    this.#rangeText.textContent = `${formatDay(from)} ${formatTime(from)} 〜 ${formatTime(to)}`;
    const fetchedAt = await readScheduleFetchedAt();
    this.#fetchedText.textContent = fetchedAt === 0
      ? '番組表: 未取得'
      : `取得: ${formatDay(fetchedAt)} ${formatTime(fetchedAt)}`;

    // 日付選択ドロップダウンの更新
    this.#updateDateSelector(from, bounds);

    // 時刻選択ドロップダウンの更新
    this.#hourSelect.value = String(new Date(from).getHours());

    // データ読み込み
    const schedules = (await loadScheduleRange(from, to))
      .filter((schedule) => schedule.channel.channelType === this.#wave);

    // 読み込み中に時間帯が変更されていた場合は古い結果を破棄
    if (from !== this.#from) return;

    // チャンネルが存在しない場合の空状態
    if (schedules.length === 0) {
      this.#cleanupDrag?.();
      const waveLabel = WAVES.find((w) => w.value === this.#wave)?.label ?? this.#wave;
      this.#body.replaceChildren(this.#createEmptyState(waveLabel));
      return;
    }

    // スクロール位置の記憶
    const prevScrollTop = this.#scrollContainer?.scrollTop;
    const prevScrollLeft = this.#scrollContainer?.scrollLeft;

    const isNowVisible = now >= from && now < to;
    const nowTop = isNowVisible ? Math.round(((now - from) / 60000) * PX_PER_MINUTE) : 0;

    // 番組情報が全チャンネルで全くない場合の通知バナー
    const hasAnyPrograms = schedules.some((s) => s.programs.length > 0);

    // 番組表グリッドDOMの構築
    const gridWrapper = document.createElement('div');
    gridWrapper.className = 'guide-grid-wrapper';

    if (!hasAnyPrograms) {
      const banner = document.createElement('div');
      banner.className = 'guide-no-programs-banner';
      banner.textContent = '※ この時間帯の番組情報はまだ取得されていません（バックグラウンドで順次取得されます）。';
      this.#body.replaceChildren(banner, gridWrapper);
    } else {
      this.#body.replaceChildren(gridWrapper);
    }

    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'guide-grid-scroll';
    this.#scrollContainer = scrollContainer;

    const gridTable = document.createElement('div');
    gridTable.className = 'guide-grid-table';

    // 1. 上部ヘッダー行（固定）
    const headerRow = document.createElement('div');
    headerRow.className = 'guide-header-row';

    const cornerCell = document.createElement('div');
    cornerCell.className = 'guide-corner-cell';
    cornerCell.textContent = '時刻';
    headerRow.append(cornerCell);

    const headerChannels = document.createElement('div');
    headerChannels.className = 'guide-header-channels';

    for (const schedule of schedules) {
      headerChannels.append(this.#createChannelHeaderCell(schedule.channel));
    }
    headerRow.append(headerChannels);

    // 2. ボディ行（時刻列 + 局列）
    const bodyRow = document.createElement('div');
    bodyRow.className = 'guide-body-row';

    // 左側時刻列（固定）
    const timeColumn = document.createElement('div');
    timeColumn.className = 'guide-time-column';
    timeColumn.style.height = `${SPAN_HOURS * HOUR_HEIGHT}px`;

    for (let i = 0; i < SPAN_HOURS; i++) {
      const hourTime = from + i * HOUR_MS;
      const hourDate = new Date(hourTime);
      const hourCell = document.createElement('div');
      hourCell.className = 'guide-hour-cell';
      hourCell.style.top = `${i * HOUR_HEIGHT}px`;
      hourCell.style.height = `${HOUR_HEIGHT}px`;

      const num = document.createElement('div');
      num.className = 'guide-hour-num';
      num.textContent = String(hourDate.getHours()).padStart(2, '0');

      const min = document.createElement('div');
      min.className = 'guide-hour-min';
      min.textContent = '00';

      const halfHourLine = document.createElement('div');
      halfHourLine.className = 'guide-half-hour-line';

      hourCell.append(num, min, halfHourLine);
      timeColumn.append(hourCell);
    }

    // 現在時刻バッジ（時刻列上）
    if (isNowVisible) {
      const nowBadge = document.createElement('div');
      nowBadge.className = 'guide-now-time-badge';
      nowBadge.style.top = `${nowTop}px`;
      nowBadge.textContent = formatTime(now);
      timeColumn.append(nowBadge);
    }
    bodyRow.append(timeColumn);

    // 局ごとの番組列コンテナ
    const channelsContainer = document.createElement('div');
    channelsContainer.className = 'guide-channels-container';
    channelsContainer.style.height = `${SPAN_HOURS * HOUR_HEIGHT}px`;

    for (const schedule of schedules) {
      const col = this.#createChannelColumn(schedule, from, to, now);
      channelsContainer.append(col);
    }

    // 現在時刻ライン（全チャンネル横断）
    if (isNowVisible) {
      const nowLine = document.createElement('div');
      nowLine.className = 'guide-now-line';
      nowLine.style.top = `${nowTop}px`;
      nowLine.style.width = `${schedules.length * CHANNEL_COLUMN_WIDTH}px`;
      channelsContainer.append(nowLine);
    }
    bodyRow.append(channelsContainer);

    gridTable.append(headerRow, bodyRow);
    scrollContainer.append(gridTable);
    gridWrapper.append(scrollContainer);

    // PC向けドラッグスクロール（掴んで移動）を初期化
    this.#setupDragScroll(scrollContainer);

    // スクロール制御
    if (this.#shouldAutoScrollToNow && isNowVisible) {
      this.#shouldAutoScrollToNow = false;
      this.#shouldResetScrollToTop = false;
      scrollContainer.scrollTo({
        top: Math.max(0, nowTop - 120),
        behavior: 'smooth',
      });
    } else if (this.#shouldResetScrollToTop) {
      this.#shouldResetScrollToTop = false;
      scrollContainer.scrollTo({ top: 0, behavior: 'instant' });
    } else if (prevScrollTop !== undefined && prevScrollLeft !== undefined) {
      scrollContainer.scrollTo({ top: prevScrollTop, left: prevScrollLeft, behavior: 'instant' });
    }
  }

  #updateDateSelector(from: number, bounds: ScheduleBounds): void {
    const now = Date.now();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    const options: { value: number; label: string }[] = [];
    const cur = new Date(bounds.minMidnight);
    while (cur.getTime() <= bounds.maxMidnight) {
      const midnight = cur.getTime();
      const diffDays = Math.round((midnight - today.getTime()) / (24 * 3600 * 1000));
      let prefix = '';
      if (diffDays === 0) prefix = '今日 ';
      else if (diffDays === 1) prefix = '明日 ';
      else if (diffDays === -1) prefix = '昨日 ';

      const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
      const label = `${prefix}${cur.getMonth() + 1}/${cur.getDate()} (${weekdays[cur.getDay()]})`;
      options.push({ value: midnight, label });
      cur.setDate(cur.getDate() + 1);
    }

    const fromMidnight = new Date(from);
    fromMidnight.setHours(0, 0, 0, 0);
    const fromMidnightVal = fromMidnight.getTime();

    this.#dateSelect.replaceChildren();
    for (const opt of options) {
      const option = document.createElement('option');
      option.value = String(opt.value);
      option.textContent = opt.label;
      if (opt.value === fromMidnightVal) {
        option.selected = true;
      }
      this.#dateSelect.append(option);
    }
  }

  #createChannelHeaderCell(channel: ChannelItem): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'guide-channel-header-cell';
    cell.dataset['channelId'] = String(channel.id);

    const topRow = document.createElement('div');
    topRow.className = 'guide-channel-header-top';

    const typeBadge = document.createElement('span');
    typeBadge.className = `channel-type-badge ${channel.channelType}`;
    typeBadge.textContent = channel.channelType;
    topRow.append(typeBadge);

    if (channel.remoteControlKeyId) {
      const keyBadge = document.createElement('span');
      keyBadge.className = 'channel-key-badge';
      keyBadge.textContent = String(channel.remoteControlKeyId);
      topRow.append(keyBadge);
    }

    if (channel.isSubChannel) {
      const subBadge = document.createElement('span');
      subBadge.className = 'sub-badge';
      subBadge.textContent = 'サブ';
      topRow.append(subBadge);
    }

    const name = document.createElement('div');
    name.className = 'guide-channel-header-name';
    name.textContent = channel.name;
    name.title = channel.name;

    cell.append(topRow, name);
    return cell;
  }

  #createChannelColumn(
    schedule: ChannelSchedule,
    from: number,
    to: number,
    now: number,
  ): HTMLElement {
    const col = document.createElement('div');
    col.className = 'guide-channel-column';
    col.dataset['channelId'] = String(schedule.channel.id);

    if (schedule.programs.length === 0) {
      const emptySlot = document.createElement('div');
      emptySlot.className = 'guide-empty-column-slot';
      emptySlot.textContent = 'この時間帯の番組情報はありません';
      col.append(emptySlot);
      return col;
    }

    for (const program of schedule.programs) {
      const progStart = program.startAt;
      let progEnd = program.endAt;

      // 終了時刻が未定 (endAt === startAt) の場合は次の番組または暫定枠
      if (progEnd <= progStart) {
        const nextProg = schedule.programs.find((p) => p.startAt > progStart);
        if (nextProg) {
          progEnd = nextProg.startAt;
        } else {
          progEnd = Math.max(progStart + 30 * 60 * 1000, to);
        }
      }

      // 可視範囲にクリップ
      const visibleStart = Math.max(from, progStart);
      const visibleEnd = Math.min(to, progEnd);
      if (visibleEnd <= visibleStart) continue;

      const top = Math.round(((visibleStart - from) / 60000) * PX_PER_MINUTE);
      const bottom = Math.round(((visibleEnd - from) / 60000) * PX_PER_MINUTE);
      const height = Math.max(18, bottom - top - 1);

      const onAir = isOnAir(program, now);
      const isCompact = height < 36;
      const isMedium = height >= 36 && height < 68;

      const card = document.createElement('div');
      card.className = `guide-program-card ${onAir ? 'is-onair' : ''} ${isCompact ? 'compact' : ''}`;
      if (program.genre !== undefined) {
        card.dataset['genre'] = program.genre;
      }
      card.style.top = `${top}px`;
      card.style.height = `${height}px`;

      const timeText = program.endAt === program.startAt
        ? `${formatTime(program.startAt)}〜`
        : `${formatTime(program.startAt)}〜${formatTime(program.endAt)}`;

      let headerHtml = '';
      if (isCompact) {
        headerHtml = `
          <div class="guide-card-header">
            <span class="guide-card-time">${timeText}</span>
            ${onAir ? '<span class="guide-onair-tag"><span class="guide-live-dot"></span>LIVE</span>' : ''}
            ${onAir ? '<button type="button" class="guide-card-watch-btn" title="視聴">視聴</button>' : ''}
          </div>
          <div class="guide-card-title" title="${escapeHtml(program.name || '（番組名なし）')}">
            ${escapeHtml(program.name || '（番組名なし）')}
          </div>
        `;
      } else {
        headerHtml = `
          <div class="guide-card-header">
            <span class="guide-card-time">${timeText}</span>
            ${onAir ? '<span class="guide-onair-tag"><span class="guide-live-dot"></span>放送中</span>' : ''}
            ${onAir ? '<button type="button" class="guide-card-watch-btn" title="この番組を視聴">視聴</button>' : ''}
          </div>
          <div class="guide-card-title" title="${escapeHtml(program.name || '（番組名なし）')}">
            ${escapeHtml(program.name || '（番組名なし）')}
          </div>
          ${!isMedium && program.description ? `
            <div class="guide-card-desc" title="${escapeHtml(program.description)}">
              ${escapeHtml(program.description)}
            </div>
          ` : ''}
          ${!isMedium && program.genre && GENRE_LABELS[program.genre] ? `
            <div class="guide-card-genre">
              <span class="guide-genre-badge">${GENRE_LABELS[program.genre]}</span>
            </div>
          ` : ''}
        `;
      }

      card.innerHTML = headerHtml;

      // 放送中番組の選局ボタンクリックハンドラー（stopPropagationで詳細ダイアログの重複開きを防止）
      if (onAir) {
        const watchBtn = card.querySelector<HTMLButtonElement>('.guide-card-watch-btn');
        if (watchBtn) {
          watchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#options.streamDialog.open(schedule.channel, program);
          });
        }
      }

      // 番組カードクリックハンドラー（詳細ダイアログを開く）
      card.addEventListener('click', () => {
        this.#options.programDialog.open(schedule.channel, program);
      });

      col.append(card);
    }

    return col;
  }

  #createEmptyState(waveLabel: string): HTMLElement {
    const container = document.createElement('div');
    container.className = 'guide-empty-state';
    container.innerHTML = `
      <div class="guide-empty-icon">
        <svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:currentColor;opacity:0.4;">
          <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>
        </svg>
      </div>
      <h3>${escapeHtml(waveLabel)}のチャンネルがありません</h3>
      <p>設定画面からチャンネルスキャンを実行するか、チャンネルの表示設定をご確認ください。</p>
      <button type="button" class="btn btn-primary" id="guide-goto-settings-btn">
        設定画面へ移動
      </button>
    `;
    container.querySelector('#guide-goto-settings-btn')?.addEventListener('click', () => {
      location.hash = '#/settings';
    });
    return container;
  }

  #setupDragScroll(container: HTMLElement): void {
    this.#cleanupDrag?.();

    let isDown = false;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;
    let velocityX = 0;
    let velocityY = 0;
    let lastX = 0;
    let lastY = 0;
    let lastTime = 0;
    let momentumRaf: number | null = null;

    const onMouseDown = (e: MouseEvent): void => {
      // 左クリックのみ受け付ける
      if (e.button !== 0) return;

      // 慣性スクロール中なら停止
      if (momentumRaf !== null) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = null;
      }

      isDown = true;
      isDragging = false;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = container.scrollLeft;
      startScrollTop = container.scrollTop;
      lastX = e.clientX;
      lastY = e.clientY;
      lastTime = performance.now();
      velocityX = 0;
      velocityY = 0;

      window.addEventListener('mousemove', onMouseMove, { passive: false });
      window.addEventListener('mouseup', onMouseUp, { capture: true });
    };

    const onMouseMove = (e: MouseEvent): void => {
      if (!isDown) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!isDragging) {
        // わずかなクリックブレ（5px未満）はドラッグとみなさない
        if (Math.hypot(dx, dy) >= 5) {
          isDragging = true;
          container.classList.add('is-dragging');
          document.body.classList.add('guide-dragging-active');
        }
      }

      if (isDragging) {
        e.preventDefault();
        container.scrollLeft = startScrollLeft - dx;
        container.scrollTop = startScrollTop - dy;

        const now = performance.now();
        const dt = now - lastTime;
        if (dt > 10) {
          velocityX = (e.clientX - lastX) / dt;
          velocityY = (e.clientY - lastY) / dt;
          lastX = e.clientX;
          lastY = e.clientY;
          lastTime = now;
        }
      }
    };

    const onMouseUp = (): void => {
      if (!isDown) return;
      isDown = false;

      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp, { capture: true });

      if (isDragging) {
        container.classList.remove('is-dragging');
        document.body.classList.remove('guide-dragging-active');

        // ドラッグ終了直後のクリック発火（番組詳細モーダルが開くなど）を防止
        const captureClick = (clickEvent: MouseEvent): void => {
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
        };
        window.addEventListener('click', captureClick, { capture: true, once: true });
        window.setTimeout(() => {
          window.removeEventListener('click', captureClick, { capture: true });
        }, 100);

        // 慣性スクロール（フリック時のなめらかな減速スクロール）
        const now = performance.now();
        const timeSinceMove = now - lastTime;
        if (timeSinceMove < 100 && (Math.abs(velocityX) > 0.1 || Math.abs(velocityY) > 0.1)) {
          let currentVx = velocityX * 16;
          let currentVy = velocityY * 16;
          const friction = 0.92;

          const step = (): void => {
            if (Math.abs(currentVx) < 0.5 && Math.abs(currentVy) < 0.5) {
              momentumRaf = null;
              return;
            }
            container.scrollLeft -= currentVx;
            container.scrollTop -= currentVy;
            currentVx *= friction;
            currentVy *= friction;
            momentumRaf = requestAnimationFrame(step);
          };
          momentumRaf = requestAnimationFrame(step);
        }
      }
    };

    const onBlur = (): void => {
      if (isDown) {
        onMouseUp();
      }
    };

    const onDragStart = (e: DragEvent): void => {
      e.preventDefault();
    };

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('dragstart', onDragStart);
    window.addEventListener('blur', onBlur);

    this.#cleanupDrag = () => {
      if (momentumRaf !== null) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = null;
      }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp, { capture: true });
      window.removeEventListener('blur', onBlur);
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('dragstart', onDragStart);
      container.classList.remove('is-dragging');
      document.body.classList.remove('guide-dragging-active');
    };
  }

  public destroy(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    window.removeEventListener('webts-programs-updated', this.#onUpdated);
    window.removeEventListener('webts-channels-changed', this.#onUpdated);
    this.#unsubscribe();
    this.#cleanupDrag?.();
  }
}
