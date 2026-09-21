// アプリの外枠。ナビゲーションと行き先の切り替えだけを持つ。
//
// レスポンシブの骨格は agy 経由の Gemini 3.8 Flash に書かせたものを、既存の
// 呼び出し側と噛み合うよう直して取り込んだ。直した点は下のコメントに個別に書く。
//
// 行き先は0.1.0では3つ。放送中（ホーム）、設定、About。番組表は0.2.0で
// 「放送中」の下に1行増える。押して何も起きない行は今は置かない。
//
// 広い画面ではヘッダに横並びで常時見せ、狭い画面ではハンバーガーから
// 端のドロワーを出す。**切り替えは CSS のメディアクエリだけで行い、
// JavaScript で画面幅を監視しない。**

export type Route = 'live' | 'settings' | 'about';

export function routeFromHash(hash: string): Route {
  // 先頭の # や #/ を許容する。URL を直接叩かれても履歴から戻られても壊れないため。
  const clean = hash.replace(/^#\/?/, '');
  if (clean === 'settings') return 'settings';
  if (clean === 'about') return 'about';
  return 'live';
}

export function hashForRoute(route: Route): string {
  return route === 'live' ? '#/' : `#/${route}`;
}

/**
 * 要設定を表す印。中黒の文字色を変えただけで、画像もアイコンセットも使わない。
 * 色だけで意味を運ぶと赤緑が見分けにくい人に伝わらないので title を付ける。
 *
 * **既定では見える状態で返す。**設定画面は「必要な項目にだけ `badge()` を置く」
 * 形で使っており、隠して返すとそちらが出なくなる。ナビゲーション側は常に
 * 置いてから `setNeedsSetup()` で出し入れするので、そちらで明示的に隠す。
 */
export function badge(): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'badge';
  span.textContent = '・';
  span.title = '要設定';
  return span;
}

export interface Shell {
  /** 中身を差し替える領域。`<main>` である。 */
  readonly root: HTMLElement;
  show(route: Route, title: string, body: HTMLElement): void;
  setNeedsSetup(needed: boolean): void;
}

interface NavItem {
  readonly route: Route;
  readonly label: string;
  readonly hasBadge?: boolean;
}

// 番組表が増えてもここへ1行足すだけで済むようにしておく。
const NAV_ITEMS: readonly NavItem[] = [
  { route: 'live', label: '放送中' },
  { route: 'settings', label: '設定', hasBadge: true },
  { route: 'about', label: 'About' },
];

export function createShell(container: HTMLElement, navigate: (route: Route) => void): Shell {
  // 呼び出し側は1回しか呼ばないが、作り直されても二重に生えないようにする。
  container.replaceChildren();

  const shell = document.createElement('div');
  shell.className = 'shell';

  const header = document.createElement('header');
  header.className = 'shell-header';

  const headerStart = document.createElement('div');
  headerStart.className = 'shell-header-start';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-label', 'メニューを開く');
  toggle.setAttribute('aria-expanded', 'false');

  // 画像にも SVG にも依存せず、OS のフォントで出る記号で済ませる。
  const toggleIcon = document.createElement('span');
  toggleIcon.setAttribute('aria-hidden', 'true');
  toggleIcon.textContent = '☰';
  toggle.append(toggleIcon);

  // ドロワーを開かなくても要設定に気付けるようにする。
  const toggleBadge = badge();
  toggleBadge.hidden = true;
  toggle.append(toggleBadge);

  headerStart.append(toggle);

  const title = document.createElement('h1');
  title.className = 'shell-title';
  headerStart.append(title);
  header.append(headerStart);

  // 狭い画面ではドロワー、広い画面ではヘッダ内のただの箱として振る舞わせる。
  // `<dialog>` を使うのは、フォーカストラップ・Escape・背景の操作抑止が
  // 標準で手に入るため。
  const dialog = document.createElement('dialog');
  dialog.className = 'nav-dialog';

  const dialogHeader = document.createElement('div');
  dialogHeader.className = 'nav-dialog-header';
  const dialogTitle = document.createElement('span');
  dialogTitle.className = 'nav-dialog-title';
  dialogTitle.textContent = 'メニュー';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'nav-dialog-close';
  close.setAttribute('aria-label', 'メニューを閉じる');
  close.textContent = '✕';
  dialogHeader.append(dialogTitle, close);
  dialog.append(dialogHeader);

  const nav = document.createElement('nav');
  nav.className = 'shell-nav';
  nav.setAttribute('aria-label', 'メインナビゲーション');
  const list = document.createElement('ul');
  list.className = 'nav-list';

  const links = new Map<Route, HTMLAnchorElement>();
  let settingsBadge: HTMLSpanElement | null = null;

  for (const entry of NAV_ITEMS) {
    const row = document.createElement('li');
    row.className = 'nav-item';

    // 素の `<a>` にしておく。キーボードでも中クリックでも普通に扱える。
    const link = document.createElement('a');
    link.className = 'nav-link';
    link.href = hashForRoute(entry.route);
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = entry.label;
    link.append(label);

    if (entry.hasBadge === true) {
      const mark = badge();
      mark.hidden = true;
      link.append(mark);
      if (entry.route === 'settings') settingsBadge = mark;
    }

    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (dialog.open) dialog.close();
      navigate(entry.route);
    });

    links.set(entry.route, link);
    row.append(link);
    list.append(row);
  }

  nav.append(list);
  dialog.append(nav);
  header.append(dialog);

  const main = document.createElement('main');
  main.className = 'shell-main';

  shell.append(header, main);
  container.append(shell);

  toggle.addEventListener('click', () => {
    dialog.showModal();
    toggle.setAttribute('aria-expanded', 'true');
  });
  close.addEventListener('click', () => { dialog.close(); });
  // Escape で閉じられたときも状態を合わせる。
  dialog.addEventListener('close', () => {
    toggle.setAttribute('aria-expanded', 'false');
  });
  // 背景を押しても閉じられるようにする。`<dialog>` 自身が backdrop の
  // クリック先になるので、座標が中身の矩形の外かどうかで判定する。
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = rect.top <= event.clientY && event.clientY <= rect.bottom
      && rect.left <= event.clientX && event.clientX <= rect.right;
    if (!inside) dialog.close();
  });

  return {
    root: main,
    show(route, pageTitle, body) {
      title.textContent = pageTitle;
      document.title = route === 'live' ? 'WebTS.app' : `${pageTitle} — WebTS.app`;
      main.replaceChildren(body);
      main.scrollTo(0, 0);
      for (const [candidate, link] of links) {
        if (candidate === route) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    },
    setNeedsSetup(needed) {
      toggleBadge.hidden = !needed;
      if (settingsBadge !== null) settingsBadge.hidden = !needed;
    },
  };
}
