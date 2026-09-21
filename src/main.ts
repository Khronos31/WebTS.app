// アプリの入口。行き先の切り替えとバッジの再計算だけを持つ。
//
// 見た目は作り込まない。素の要素とシステムフォントで、OS 標準の見え方に任せる。

import { createAboutPage } from './ui/about-page';
import { createLivePage } from './ui/live-page';
import { createSettingsPage } from './ui/settings-page';
import { createShell, hashForRoute, routeFromHash, type Route } from './ui/shell';
import { readSetupState } from './ui/setup-state';
import './ui/app.css';

const VERSION = '0.1.0-dev';

const container = document.querySelector('#app');
if (!(container instanceof HTMLElement)) throw new Error('app root missing');

const shell = createShell(container, (route) => {
  // 履歴に残す。戻るで前の画面へ帰れる。
  location.hash = hashForRoute(route);
});

async function render(): Promise<void> {
  const route = routeFromHash(location.hash);
  const state = await readSetupState();
  shell.setNeedsSetup(state.anyNeeded);

  if (route === 'settings') {
    shell.show(route, '設定', createSettingsPage({ state, onChanged: () => { void render(); } }));
    return;
  }
  if (route === 'about') {
    shell.show(route, 'About', createAboutPage(VERSION));
    return;
  }
  // チャンネルの保存はスキャンを作るときに足す。いまは常に空。
  shell.show('live', '放送中', createLivePage([]));
}

window.addEventListener('hashchange', () => { void render(); });
void render();
