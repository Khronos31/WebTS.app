// 放送中。チャンネル一覧。ホーム。
//
// 0.1.0 ではスキャンが未実装なので常に空である。空のときは「ありません」とだけ出す。
// **手順はここに書かない。**手順はそれを必要とする設定項目の中にあり、
// 何が足りないかはメニューの印が示す。同じことを2箇所に書かない。
//
// 行の形だけ先に決めておく。1チャンネル1行の縦リスト、行頭にアイコン領域を確保し、
// 局ロゴを後から足してもレイアウトが変わらないようにする。

export interface ChannelRow {
  readonly name: string;
  /** 現在番組。無ければ null。 */
  readonly programme: { readonly title: string; readonly start: string } | null;
}

export function createLivePage(channels: readonly ChannelRow[]): HTMLElement {
  const page = document.createElement('div');

  if (channels.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'チャンネルがありません。';
    page.append(empty);
    return page;
  }

  const list = document.createElement('ul');
  list.className = 'channels';
  for (const channel of channels) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';

    // 局ロゴは0.1.0では出さない。領域だけ確保しておく。
    const logo = document.createElement('span');
    logo.className = 'logo';
    logo.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = channel.name;

    const programme = document.createElement('span');
    programme.className = 'programme';
    programme.textContent = channel.programme === null
      ? ''
      : `${channel.programme.start} ${channel.programme.title}`;

    button.append(logo, name, programme);
    row.append(button);
    list.append(row);
  }
  page.append(list);
  return page;
}
