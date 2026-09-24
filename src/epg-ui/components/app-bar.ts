// EPGStationスタイルのAppBar（ヘッダーバー）

export interface AppBarOptions {
  title: string;
  onToggleDrawer: () => void;
  onRefresh?: () => void;
}

export class AppBar {
  public readonly element: HTMLElement;
  private titleElement: HTMLElement;
  private refreshBtn: HTMLButtonElement;
  private refreshAction: (() => void) | null = null;

  constructor(options: AppBarOptions) {
    this.element = document.createElement('header');
    this.element.className = 'app-bar';

    // ハンバーガーボタン (☰)
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'nav-icon-btn';
    toggleBtn.setAttribute('aria-label', 'メニューを開く');
    toggleBtn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
      </svg>
    `;
    toggleBtn.addEventListener('click', () => {
      options.onToggleDrawer();
    });

    // タイトル
    this.titleElement = document.createElement('h1');
    this.titleElement.className = 'app-title';
    this.titleElement.textContent = options.title;

    // アクションエリア（更新ボタン）
    const actions = document.createElement('div');
    actions.className = 'app-bar-actions';

    this.refreshBtn = document.createElement('button');
    this.refreshBtn.type = 'button';
    this.refreshBtn.className = 'icon-button';
    this.refreshBtn.setAttribute('aria-label', '番組表を更新');
    this.refreshBtn.setAttribute('title', '番組表を更新');
    this.refreshBtn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
      </svg>
    `;
    this.refreshBtn.addEventListener('click', () => {
      this.refreshAction?.();
    });
    this.refreshBtn.style.display = 'none';
    actions.append(this.refreshBtn);

    if (options.onRefresh) {
      this.setRefreshAction(options.onRefresh);
    }

    this.element.append(toggleBtn, this.titleElement, actions);
  }

  public setTitle(title: string): void {
    this.titleElement.textContent = title;
  }

  public setRefreshAction(action: (() => void) | null, label = '番組表を更新'): void {
    this.refreshAction = action;
    if (action === null) {
      this.refreshBtn.style.display = 'none';
    } else {
      this.refreshBtn.style.display = '';
      this.refreshBtn.setAttribute('aria-label', label);
      this.refreshBtn.setAttribute('title', label);
    }
  }

  public setRefreshing(refreshing: boolean): void {
    if (refreshing) {
      this.refreshBtn.classList.add('is-spinning');
      this.refreshBtn.disabled = true;
      this.refreshBtn.setAttribute('title', '番組表を取得中…');
    } else {
      this.refreshBtn.classList.remove('is-spinning');
      this.refreshBtn.disabled = false;
      this.refreshBtn.setAttribute('title', this.refreshBtn.getAttribute('aria-label') ?? '番組表を更新');
    }
  }

  public destroy(): void {
    // 破棄処理が必要な場合はここに記述
  }
}
