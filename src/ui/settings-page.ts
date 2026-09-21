// 設定。平らな一覧で、ここから更に画面を潜らない。
//
// 各項目は自分の状態を自分で表示し、操作もその場で完結する。手順の説明も
// それを必要とする項目の中に置く。初回専用の画面や別途のチュートリアルを作らない。
//
// 0.1.0 の項目:
//   ファームウェアを取得・設定
//   チューナーを接続
//   受信状態
//   地域設定・チャンネルスキャン
//   番組表を更新
//
// 「番組表を更新」は 0.2.0 以降もここに置く。保守操作であって閲覧ではない。

import {
  FIRMWARE_SOURCE,
  cacheFirmware,
  clearCachedFirmware,
  extractFirmware,
  type FirmwareStage,
} from '../usb/firmware';
import { loadQ3U4Identifiers } from '../usb/px4-identity';
import { badge } from './shell';
import type { SetupState } from './setup-state';

/** 1項目。見出し・状態・説明・操作をまとめて1つの `<section>` にする。 */
function item(
  title: string,
  state: { needed: boolean; detail: string } | { detail: string },
): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent = title;
  if ('needed' in state && state.needed) heading.append(badge());
  const detail = document.createElement('p');
  detail.className = 'detail';
  detail.textContent = state.detail;
  const body = document.createElement('div');
  section.append(heading, detail, body);
  return { section, body };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SettingsPageOptions {
  readonly state: SetupState;
  /** 状態が変わったときに呼ぶ。バッジの再計算と画面の描き直しに使う。 */
  readonly onChanged: () => void;
}

export function createSettingsPage(options: SettingsPageOptions): HTMLElement {
  const page = document.createElement('div');
  page.append(
    firmwareSection(options),
    tunerSection(options),
    receptionSection(),
    scanSection(options),
    epgSection(),
  );
  return page;
}

function firmwareSection(options: SettingsPageOptions): HTMLElement {
  const { section, body } = item('ファームウェアを取得・設定', options.state.firmware);

  const explain = document.createElement('p');
  explain.textContent =
    'PX-Q3U4 を動かすには IT930x のファームウェアが要ります。これは配布できないため、'
    + 'メーカーのドライバから取り出します。取り出した 2169 バイトは端末内 (IndexedDB) に'
    + '保存するだけで、どこへも送信しません。';
  body.append(explain);

  const listLabel = document.createElement('p');
  listLabel.textContent = 'メーカーのドライバ';
  body.append(listLabel);

  const list = document.createElement('ul');
  const entry = document.createElement('li');
  const link = document.createElement('a');
  link.href = FIRMWARE_SOURCE.archiveUrl;
  link.textContent = 'PX-W3U4 用ドライバ';
  link.rel = 'noreferrer';
  entry.append(link);
  const note = document.createElement('span');
  note.textContent = '（PX-Q3U4 でもこれを使います。IT930x は共通です）';
  entry.append(' ', note);
  list.append(entry);
  body.append(list);

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.zip,.sys';
  picker.hidden = true;

  const choose = document.createElement('button');
  choose.type = 'button';
  choose.textContent = 'ダウンロードしたドライバを設定';
  choose.addEventListener('click', () => { picker.click(); });

  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const stages = document.createElement('ol');

  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    choose.disabled = true;
    stages.replaceChildren();
    status.textContent = '取り出しています…';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const onStage = (stage: FirmwareStage) => {
        const line = document.createElement('li');
        line.textContent = stage;
        stages.append(line);
      };
      const result = await extractFirmware(bytes, onStage);
      await cacheFirmware(result.bytes);
      status.textContent = `設定しました。${result.bytes.length} バイト。`;
      options.onChanged();
    } catch (error) {
      status.textContent = `失敗: ${describe(error)}`;
    } finally {
      choose.disabled = false;
      picker.value = '';
    }
  });

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = '取り消す';
  clear.disabled = options.state.firmware.needed;
  clear.addEventListener('click', async () => {
    await clearCachedFirmware();
    options.onChanged();
  });

  body.append(picker, choose, ' ', clear, status, stages);
  return section;
}

function tunerSection(options: SettingsPageOptions): HTMLElement {
  const { section, body } = item('チューナーを接続', options.state.tuner);

  const explain = document.createElement('p');
  explain.textContent =
    'PX-Q3U4 は1台が USB 上で2つのデバイスとして見えます。'
    + '両方を選んでください。1つずつ2回に分けて選ぶ形になります。';
  body.append(explain);

  const connect = document.createElement('button');
  connect.type = 'button';
  connect.textContent = 'チューナーを選ぶ';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');

  connect.addEventListener('click', async () => {
    connect.disabled = true;
    status.textContent = '選択を待っています…';
    try {
      // requestDevice は利用者の操作からしか呼ばない。
      const identifiers = await loadQ3U4Identifiers();
      await navigator.usb.requestDevice({
        filters: [{ vendorId: identifiers.vendorId, productId: identifiers.productId }],
      });
      status.textContent = '許可されました。';
      options.onChanged();
    } catch (error) {
      // 利用者が選ばずに閉じた場合もここへ来る。失敗として騒がない。
      status.textContent = describe(error).includes('No device selected')
        ? '選ばれませんでした。'
        : `失敗: ${describe(error)}`;
    } finally {
      connect.disabled = false;
    }
  });

  body.append(connect, status);
  return section;
}

function receptionSection(): HTMLElement {
  const { section, body } = item('受信状態', { detail: '視聴中に表示します' });
  const explain = document.createElement('p');
  explain.textContent =
    '選局・復号・分離の各段の数値を出します。視聴していないときは何もありません。';
  body.append(explain);
  return section;
}

function scanSection(options: SettingsPageOptions): HTMLElement {
  const { section, body } = item('地域設定・チャンネルスキャン', options.state.channels);
  const explain = document.createElement('p');
  explain.textContent =
    '受信できるチャンネルを探します。引越しやアンテナの変更があったときにやり直します。'
    + '全物理チャンネルを順に選局するため時間がかかります。';
  body.append(explain);

  const scan = document.createElement('button');
  scan.type = 'button';
  scan.textContent = 'スキャンを開始';
  // 未実装。押せる見た目で何も起きない状態にはしない。
  scan.disabled = true;
  const note = document.createElement('p');
  note.className = 'detail';
  note.textContent = '未実装です。';
  body.append(scan, note);
  return section;
}

function epgSection(): HTMLElement {
  const { section, body } = item('番組表を更新', { detail: '未取得' });
  const explain = document.createElement('p');
  explain.textContent = '番組情報だけを取り直します。チャンネルの構成は変えません。';
  body.append(explain);

  const update = document.createElement('button');
  update.type = 'button';
  update.textContent = '番組表を更新';
  update.disabled = true;
  const note = document.createElement('p');
  note.className = 'detail';
  note.textContent = '未実装です。';
  body.append(update, note);
  return section;
}
