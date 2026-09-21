// WebTS.app - EPGStation UI Entry Controller

import './theme.css';
import type { RouteType } from './types';
import { AppBar } from './components/app-bar';
import { NavDrawer } from './components/drawer';
import { ProgramDialog } from './components/program-dialog';
import { StreamDialog } from './components/stream-dialog';
import { OnAirView } from './views/onair-view';
import { WatchView } from './views/watch-view';
import { SettingsView } from './views/settings-view';
import { AboutView } from './views/about-view';
import { initTheme } from './theme-manager';
import { readSetupState } from '../ui/setup-state';

initTheme();

export function routeFromHash(hash: string): RouteType {
  const clean = hash.replace(/^#\/?/, '');
  if (clean === 'settings') return 'settings';
  if (clean === 'about') return 'about';
  if (clean === 'watch' || clean.startsWith('watch?') || clean.startsWith('watch/')) return 'watch';
  return 'onair';
}

export function channelIdFromHash(hash: string): number {
  const clean = hash.replace(/^#\/?/, '');
  const match = /[?&]channel=(\d+)/.exec(clean);
  if (match && match[1]) {
    return Number(match[1]);
  }
  return 1040;
}

export function hashForRoute(route: RouteType): string {
  return route === 'onair' ? '#/' : `#/${route}`;
}

export class EpgApp {
  private container: HTMLElement;
  private appBar: AppBar;
  private navDrawer: NavDrawer;
  private programDialog: ProgramDialog;
  private streamDialog: StreamDialog;
  private mainContent: HTMLElement;
  private currentView: OnAirView | WatchView | SettingsView | AboutView | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.classList.add('app-container');

    // ダイアログの初期化
    this.programDialog = new ProgramDialog();
    this.streamDialog = new StreamDialog();

    // 初期ルート
    const initialRoute = routeFromHash(location.hash);

    // ドロワーの初期化
    this.navDrawer = new NavDrawer({
      container: this.container,
      activeRoute: initialRoute,
      onNavigate: (route) => {
        location.hash = hashForRoute(route);
      },
    });

    // AppBar の初期化
    this.appBar = new AppBar({
      title: this.getTitleForRoute(initialRoute),
      onToggleDrawer: () => {
        this.navDrawer.toggle();
      },
      onRefresh: () => {
        void this.renderCurrentRoute();
      },
    });

    // メインコンテンツ領域
    this.mainContent = document.createElement('main');
    this.mainContent.className = 'main-content';

    // コンテナに組み立て
    this.container.append(
      this.appBar.element,
      this.navDrawer.overlayElement,
      this.navDrawer.drawerElement,
      this.mainContent,
      this.programDialog.overlayElement,
      this.streamDialog.overlayElement,
    );

    // ハッシュ変更イベントの購読
    window.addEventListener('hashchange', () => {
      void this.renderCurrentRoute();
    });

    // 初期レンダリング
    void this.renderCurrentRoute();
  }

  private getTitleForRoute(route: RouteType): string {
    switch (route) {
      case 'onair':
        return '放映中';
      case 'watch':
        return '視聴';
      case 'settings':
        return '設定';
      case 'about':
        return 'About';
    }
  }

  private async renderCurrentRoute(): Promise<void> {
    const route = routeFromHash(location.hash);
    const title = this.getTitleForRoute(route);

    // ヘッダーとドロワーの状態更新
    this.appBar.setTitle(title);
    this.navDrawer.setActive(route);
    document.title = route === 'onair' ? '放映中 — WebTS.app' : `${title} — WebTS.app`;

    // セットアップ状態の確認
    try {
      const state = await readSetupState();
      this.navDrawer.setBadgeVisible('settings', state.anyNeeded);
    } catch {
      // ignore
    }

    // 既存ビューの破棄
    if (this.currentView && 'destroy' in this.currentView && typeof this.currentView.destroy === 'function') {
      this.currentView.destroy();
    }

    this.mainContent.replaceChildren();

    // 新規ビューの生成
    switch (route) {
      case 'onair': {
        this.currentView = new OnAirView({
          programDialog: this.programDialog,
          streamDialog: this.streamDialog,
        });
        break;
      }
      case 'watch': {
        const channelId = channelIdFromHash(location.hash);
        this.currentView = new WatchView({
          channelId,
          onNavigateBack: () => {
            location.hash = '#/';
          },
          onSwitchChannel: (newChannelId) => {
            location.hash = `#/watch?channel=${newChannelId}`;
          },
        });
        break;
      }
      case 'settings': {
        this.currentView = new SettingsView({
          onStateChanged: () => {
            void this.checkSetupState();
          },
        });
        break;
      }
      case 'about': {
        this.currentView = new AboutView();
        break;
      }
    }

    this.mainContent.append(this.currentView.element);
    window.scrollTo(0, 0);
  }

  private async checkSetupState(): Promise<void> {
    const state = await readSetupState();
    this.navDrawer.setBadgeVisible('settings', state.anyNeeded);
  }
}

// 自動起動スクリプト
const root = document.querySelector<HTMLElement>('#app');
if (root) {
  new EpgApp(root);
}
