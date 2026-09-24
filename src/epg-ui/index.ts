// WebTS.app - EPGStation UI Entry Controller

import './theme.css';
import type { RouteType } from './types';
import { channelIdFromHash, hashForRoute, routeFromHash } from './routes';
import { AppBar } from './components/app-bar';
import { NavDrawer } from './components/drawer';
import { ProgramDialog } from './components/program-dialog';
import { StreamDialog } from './components/stream-dialog';
import { OnAirView } from './views/onair-view';
import { GuideView } from './views/guide-view';
import { WatchView } from './views/watch-view';
import { SettingsView } from './views/settings-view';
import { AboutView } from './views/about-view';
import { ApiView } from './views/api-view';
import { initTheme } from './theme-manager';
import { readSetupState } from '../ui/setup-state';
import { primeChannels } from './channel-source';
import {
  emitStatus, fetchSchedule, isRefreshing, onRefreshStatus, tickAutoRefresh,
} from './epg-refresh';
import { requestPersistentStorage } from './persist-storage';

initTheme();

// 番組情報の自動更新。
//
// **画面ではなくアプリが回す。**受信機は8本あり、走査は視聴が使っている
// ものを避けて残りを使うので、視聴中でも取りに行ける。放映中の画面に
// 置いていたころは、視聴中はその画面が外れていて一度も判定されなかった。
//
// **裏のタブでも回す。**走査の待ちは Worker で数えるので絞られない
// （FINDINGS 33章）。判定のこのタイマーは裏では1分おきに絞られるが、
// 30分おきの取得を決めるには十分。前面に戻った時点でもすぐ判定する。
const AUTO_REFRESH_INTERVAL_MS = 30_000;
setInterval(() => { void tickAutoRefresh(); }, AUTO_REFRESH_INTERVAL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void tickAutoRefresh();
});

export class EpgApp {
  private container: HTMLElement;
  private appBar: AppBar;
  private navDrawer: NavDrawer;
  private programDialog: ProgramDialog;
  private streamDialog: StreamDialog;
  private mainContent: HTMLElement;
  private currentView:
    OnAirView | GuideView | WatchView | SettingsView | AboutView | ApiView | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.classList.add('app-container');

    // ダイアログの初期化
    this.streamDialog = new StreamDialog();
    this.programDialog = new ProgramDialog({
      onWatch: (channel, program) => {
        this.streamDialog.open(channel, program);
      },
    });

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
    });

    // 走査・取得ステータスと AppBar の更新ボタンの回転状態を同期
    onRefreshStatus((text) => {
      this.appBar.setRefreshing(text !== '');
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
      case 'guide':
        return '番組表';
      case 'watch':
        return '視聴';
      case 'settings':
        return '設定';
      case 'about':
        return 'About';
      case 'api':
        return 'API';
    }
  }

  private async renderCurrentRoute(): Promise<void> {
    const route = routeFromHash(location.hash);
    const title = this.getTitleForRoute(route);

    // ヘッダーとドロワーの状態更新
    this.appBar.setTitle(title);
    this.navDrawer.setActive(route);
    document.title = route === 'onair' ? '放映中 — WebTS.app' : `${title} — WebTS.app`;

    // 番組表ページでのみ右上に「番組表を更新」ボタンを表示し、他ページでは非表示
    if (route === 'guide') {
      this.appBar.setRefreshAction(async () => {
        if (isRefreshing()) return;
        emitStatus('番組表を取得しています…');
        try {
          await fetchSchedule({
            byUser: true,
            onProgress: (progress) => {
              emitStatus(`番組表を取得しています… ${progress.label} (${progress.index + 1}/${progress.total})`);
            },
          });
          emitStatus('');
        } catch (error) {
          emitStatus(`番組表の取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
          setTimeout(() => { emitStatus(''); }, 5000);
        }
      }, '番組表を更新');
      this.appBar.setRefreshing(isRefreshing());
    } else {
      this.appBar.setRefreshAction(null);
    }

    // 保存済みのチャンネルを読んでおく。視聴画面は DOM を組み立てる時点で要る。
    await primeChannels();

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
      case 'api': {
        this.currentView = new ApiView(location.hash);
        break;
      }
      case 'onair': {
        this.currentView = new OnAirView({
          programDialog: this.programDialog,
          streamDialog: this.streamDialog,
        });
        break;
      }
      case 'guide': {
        this.currentView = new GuideView({
          hash: location.hash,
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

    if (this.currentView !== null) this.mainContent.append(this.currentView.element);
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

// Service Worker の登録（PWA対応）
//
// **配信物でだけ登録する。**開発サーバーで登録すると、/assets と /build 以外を
// stale-while-revalidate で返すので、コードを直した直後の読み直しで古い
// モジュールが動く。実機で測るときに、どの版を測ったのか分からなくなる。
// 開発サーバーで以前に登録されたものは外しておく。
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
    });
  } else {
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) void registration.unregister();
    });
  }
}

// 局・番組表・ファームウェアをブラウザに消されないよう、永続化を頼む
// （persist-storage.ts）。断られても動作は変わらない。
void requestPersistentStorage();

export { channelIdFromHash, hashForRoute, routeFromHash };
