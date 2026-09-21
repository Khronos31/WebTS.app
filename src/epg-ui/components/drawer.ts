// EPGStationスタイルのナビゲーションドロワー
// デスクトップ(>=960px): 常時表示と常時非表示を切り替え
// スマホ(<960px): メニューアイコンを押したときだけオーバーレイ展開

import type { RouteType } from '../types';

export interface DrawerItem {
  id: RouteType;
  title: string;
  iconSvg: string;
  hasBadge?: boolean;
}

export interface DrawerOptions {
  container: HTMLElement;
  activeRoute: RouteType;
  onNavigate: (route: RouteType) => void;
}

const DESKTOP_BREAKPOINT = 960;
const STORAGE_KEY_DESKTOP_DRAWER = 'webts_desktop_drawer';

export class NavDrawer {
  public readonly overlayElement: HTMLElement;
  public readonly drawerElement: HTMLElement;
  private container: HTMLElement;
  private itemsMap = new Map<RouteType, HTMLAnchorElement>();
  private activeRoute: RouteType;
  private onNavigate: (route: RouteType) => void;
  private desktopOpen = true;
  private mobileOpen = false;

  constructor(options: DrawerOptions) {
    this.container = options.container;
    this.activeRoute = options.activeRoute;
    this.onNavigate = options.onNavigate;

    // デスクトップ表示設定の復元（デフォルトは常時表示 = true）
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DESKTOP_DRAWER);
      if (saved !== null) {
        this.desktopOpen = saved === 'true';
      }
    } catch {
      // ignore
    }

    // オーバーレイ（背景幕 - モバイル用）
    this.overlayElement = document.createElement('div');
    this.overlayElement.className = 'drawer-overlay';
    this.overlayElement.addEventListener('click', () => this.close());

    // ドロワー本体
    this.drawerElement = document.createElement('aside');
    this.drawerElement.className = 'nav-drawer';

    // ドロワーヘッダー（モバイルオーバーレイ時に表示）
    const header = document.createElement('div');
    header.className = 'drawer-header';
    header.innerHTML = `
      <div class="drawer-brand">
        <svg viewBox="0 0 24 24" style="width:28px;height:28px;fill:currentColor">
          <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>
        </svg>
        <span>WebTS.app</span>
      </div>
      <div class="drawer-subtitle">Client-side Tuner & Player</div>
    `;

    // メニューリスト
    const list = document.createElement('ul');
    list.className = 'drawer-list';

    // トップ階層メニュー定義（番組表は0.2.0以降のため非表示）
    const menuItems: DrawerItem[] = [
      {
        id: 'onair',
        title: '放映中',
        iconSvg: '<path d="M21 3H3c-1.11 0-2 .89-2 2v12c0 1.1.89 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.11-.9-2-2-2zm0 14H3V5h18v12zm-11-2l6-4.5-6-4.5v9z"/>',
      },
      {
        id: 'settings',
        title: '設定',
        iconSvg: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>',
        hasBadge: true,
      },
      {
        id: 'about',
        title: 'About',
        iconSvg: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>',
      },
    ];

    for (const item of menuItems) {
      const li = document.createElement('li');
      li.className = 'drawer-item';

      const a = document.createElement('a');
      a.className = 'drawer-link';
      a.href = `#/${item.id}`;
      a.innerHTML = `
        <svg viewBox="0 0 24 24">${item.iconSvg}</svg>
        <span>${item.title}</span>
        ${item.hasBadge ? '<span class="badge-dot" title="要設定" style="display:none"></span>' : ''}
      `;

      if (item.id === this.activeRoute) {
        a.classList.add('active');
      }

      a.addEventListener('click', (e) => {
        e.preventDefault();
        // モバイルのみ選択時にドロワーを閉じる（PC常時表示時は開いたまま維持）
        if (!this.isDesktop()) {
          this.close();
        }
        this.setActive(item.id);
        this.onNavigate(item.id);
      });

      this.itemsMap.set(item.id, a);
      li.append(a);
      list.append(li);
    }

    // ドロワーフッター
    const footer = document.createElement('div');
    footer.className = 'drawer-footer';
    footer.textContent = 'WebTS.app v0.1.0-dev';

    this.drawerElement.append(header, list, footer);

    // Escapeキーで閉じる
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });

    // リサイズ監視
    window.addEventListener('resize', () => {
      this.syncState();
    });

    // 初期状態同期
    this.syncState();
  }

  public isDesktop(): boolean {
    return window.innerWidth >= DESKTOP_BREAKPOINT;
  }

  private syncState(): void {
    if (this.isDesktop()) {
      // デスクトップ: コンテナに drawer-open クラスを反映し、サイドバーとして常時表示/非表示
      this.container.classList.toggle('drawer-open', this.desktopOpen);
      this.drawerElement.classList.toggle('open', this.desktopOpen);
      this.overlayElement.classList.remove('open');
    } else {
      // モバイル: コンテナのデスクトップ用オフセットは外し、オーバーレイ方式で開閉
      this.container.classList.remove('drawer-open');
      this.drawerElement.classList.toggle('open', this.mobileOpen);
      this.overlayElement.classList.toggle('open', this.mobileOpen);
    }
  }

  public open(): void {
    if (this.isDesktop()) {
      this.desktopOpen = true;
      try {
        localStorage.setItem(STORAGE_KEY_DESKTOP_DRAWER, 'true');
      } catch {
        // ignore
      }
    } else {
      this.mobileOpen = true;
    }
    this.syncState();
  }

  public close(): void {
    if (this.isDesktop()) {
      this.desktopOpen = false;
      try {
        localStorage.setItem(STORAGE_KEY_DESKTOP_DRAWER, 'false');
      } catch {
        // ignore
      }
    } else {
      this.mobileOpen = false;
    }
    this.syncState();
  }

  public toggle(): void {
    if (this.isDesktop()) {
      this.desktopOpen = !this.desktopOpen;
      try {
        localStorage.setItem(STORAGE_KEY_DESKTOP_DRAWER, String(this.desktopOpen));
      } catch {
        // ignore
      }
    } else {
      this.mobileOpen = !this.mobileOpen;
    }
    this.syncState();
  }

  public isOpen(): boolean {
    return this.isDesktop() ? this.desktopOpen : this.mobileOpen;
  }

  public setActive(route: RouteType): void {
    this.activeRoute = route;
    for (const [r, element] of this.itemsMap) {
      if (r === route) {
        element.classList.add('active');
      } else {
        element.classList.remove('active');
      }
    }
  }

  public setBadgeVisible(route: RouteType, visible: boolean): void {
    const link = this.itemsMap.get(route);
    if (!link) return;
    const dot = link.querySelector<HTMLElement>('.badge-dot');
    if (dot) {
      dot.style.display = visible ? 'inline-block' : 'none';
    }
  }
}
