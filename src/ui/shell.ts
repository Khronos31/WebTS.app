// アプリの外枠。ヘッダのハンバーガーと、行き先の切り替えだけを持つ。
//
// 行き先は0.1.0では3つ。放送中（ホーム）、設定、About。
// 番組表は0.2.0で「放送中」の下に1行増える。押して何も起きない行は今は置かない。
//
// **設定はメニュー内で階層を潜らず、別画面へ遷移する。**ファームウェアの取り込みも
// チャンネルスキャンも時間のかかる操作で、進捗の置き場が要るため。設定画面自体は
// 平らな一覧で、そこから更に潜らない。
//
// 見た目は作り込まない。素の要素だけで、`<dialog>` も既定の見え方のまま使う。

export type Route = 'live' | 'settings' | 'about';

const ROUTES: Record<string, Route> = {
  '#/': 'live',
  '#/settings': 'settings',
  '#/about': 'about',
};

const LABELS: Record<Route, string> = {
  live: '放送中',
  settings: '設定',
  about: 'About',
};

export function routeFromHash(hash: string): Route {
  return ROUTES[hash] ?? 'live';
}

export function hashForRoute(route: Route): string {
  return route === 'live' ? '#/' : `#/${route}`;
}

/**
 * 要設定を表す印。中黒の文字色を変えただけで、画像もアイコンセットも使わない。
 * 色だけで意味を運ぶと赤緑が見分けにくい人に伝わらないので、title を付ける。
 */
export function badge(): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.textContent = '・';
  mark.title = '要設定';
  mark.className = 'badge';
  return mark;
}

export interface Shell {
  readonly root: HTMLElement;
  /** 画面の中身を差し替える。 */
  show(route: Route, title: string, body: HTMLElement): void;
  /** ハンバーガーと「設定」の行に印を出すかどうか。 */
  setNeedsSetup(needed: boolean): void;
}

export function createShell(container: HTMLElement, navigate: (route: Route) => void): Shell {
  container.replaceChildren();

  const header = document.createElement('header');
  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.textContent = '≡';
  menuButton.title = 'メニュー';
  const menuBadge = badge();
  menuBadge.hidden = true;
  menuButton.append(menuBadge);

  const title = document.createElement('h1');
  title.textContent = 'WebTS.app';
  header.append(menuButton, title);

  const dialog = document.createElement('dialog');
  const menu = document.createElement('ul');
  menu.className = 'menu';
  const settingsBadge = badge();
  settingsBadge.hidden = true;

  for (const route of ['live', 'settings', 'about'] as const) {
    const item = document.createElement('li');
    const link = document.createElement('button');
    link.type = 'button';
    link.textContent = LABELS[route];
    if (route === 'settings') link.append(settingsBadge);
    link.addEventListener('click', () => {
      dialog.close();
      navigate(route);
    });
    item.append(link);
    menu.append(item);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '閉じる';
  close.addEventListener('click', () => { dialog.close(); });
  dialog.append(menu, close);

  menuButton.addEventListener('click', () => { dialog.showModal(); });

  const main = document.createElement('main');
  container.append(header, dialog, main);

  return {
    root: main,
    show(route, pageTitle, body) {
      title.textContent = pageTitle;
      document.title = route === 'live' ? 'WebTS.app' : `${pageTitle} — WebTS.app`;
      main.replaceChildren(body);
      main.scrollTo(0, 0);
    },
    setNeedsSetup(needed) {
      menuBadge.hidden = !needed;
      settingsBadge.hidden = !needed;
    },
  };
}
