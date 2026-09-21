// About。使い方、ライセンスとソース、バージョン。
//
// **ライセンスとソースの提示は任意ではない。**成果物は GPL-2.0-only であり、
// 対応ソースの入手方法を示す義務がある。
//
// 「使い方」はセットアップ手順の置き場ではない。手順はそれを必要とする設定項目の
// 中にある。ここに置くのは、設定が済んだあとの使い方である。

import { describeEnvironment } from '../platform/environment';

const SOURCE_URL = 'https://github.com/Khronos31/WebTS.app';

function section(title: string): { section: HTMLElement; body: HTMLElement } {
  const element = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent = title;
  const body = document.createElement('div');
  element.append(heading, body);
  return { section: element, body };
}

export function createAboutPage(version: string): HTMLElement {
  const page = document.createElement('div');

  {
    const { section: element, body } = section('使い方');
    const steps = document.createElement('ol');
    for (const text of [
      '「設定」でファームウェアを取得・設定します。メーカーのドライバを落として渡すだけです。',
      '「設定」でチューナーを接続します。PX-Q3U4 は2つのデバイスとして見えるので、2回選びます。',
      '「設定」で地域設定・チャンネルスキャンを行います。',
      '「放送中」でチャンネルを選ぶと再生が始まります。',
    ]) {
      const step = document.createElement('li');
      step.textContent = text;
      steps.append(step);
    }
    const note = document.createElement('p');
    note.textContent =
      '設定が済んでいない項目にはメニューに印が付きます。印が消えれば視聴できます。';
    body.append(steps, note);
    page.append(element);
  }

  {
    const { section: element, body } = section('ライセンスとソース');
    const license = document.createElement('p');
    license.textContent =
      'WebTS.app は GPL-2.0-only です。同梱している第三者コードとそのライセンスは'
      + 'リポジトリの THIRD_PARTY_NOTICES.md にまとめてあります。';
    const link = document.createElement('p');
    const anchor = document.createElement('a');
    anchor.href = SOURCE_URL;
    anchor.textContent = SOURCE_URL;
    anchor.rel = 'noreferrer';
    link.append('ソース: ', anchor);
    const privacy = document.createElement('p');
    privacy.textContent =
      '受信した放送、カードとの通信、ファームウェアは、いずれもこの端末から出ません。'
      + 'サーバーを持たないため、送る先がありません。';
    body.append(license, link, privacy);
    page.append(element);
  }

  {
    const { section: element, body } = section('バージョン');
    const value = document.createElement('p');
    value.textContent = version;
    const report = document.createElement('table');
    const tbody = document.createElement('tbody');
    const environment = describeEnvironment();
    const LABELS: Record<keyof typeof environment, string> = {
      secureContext: 'セキュアコンテキスト',
      webUsbPresent: 'WebUSB',
      crossOriginIsolated: 'クロスオリジン分離',
      webCodecsPresent: 'WebCodecs',
      indexedDbPresent: 'IndexedDB',
    };
    for (const [key, label] of Object.entries(LABELS)) {
      const row = document.createElement('tr');
      const head = document.createElement('th');
      head.scope = 'row';
      head.textContent = label;
      const cell = document.createElement('td');
      cell.textContent = environment[key as keyof typeof environment] ? '利用可能' : '利用不可';
      row.append(head, cell);
      tbody.append(row);
    }
    report.append(tbody);
    body.append(value, report);
    page.append(element);
  }

  return page;
}
