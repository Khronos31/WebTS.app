// EPGStationスタイルのAppBar（ヘッダーバー）

export interface AppBarOptions {
  title: string;
  onToggleDrawer: () => void;
  onRefresh?: () => void;
}

export class AppBar {
  public readonly element: HTMLElement;
  private titleElement: HTMLElement;
  private clockElement: HTMLElement;
  private clockTimer: number | null = null;

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

    // アクションエリア（時計 + 更新ボタン）
    const actions = document.createElement('div');
    actions.className = 'app-bar-actions';

    this.clockElement = document.createElement('span');
    this.clockElement.className = 'clock-display';
    this.updateClock();

    actions.append(this.clockElement);

    if (options.onRefresh) {
      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'icon-button';
      refreshBtn.setAttribute('aria-label', '更新');
      refreshBtn.innerHTML = `
        <svg viewBox="0 0 24 24">
          <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
        </svg>
      `;
      refreshBtn.addEventListener('click', () => {
        options.onRefresh?.();
      });
      actions.append(refreshBtn);
    }

    this.element.append(toggleBtn, this.titleElement, actions);

    // 時計の定期更新
    this.clockTimer = window.setInterval(() => this.updateClock(), 1000);
  }

  public setTitle(title: string): void {
    this.titleElement.textContent = title;
  }

  private updateClock(): void {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    this.clockElement.textContent = `${hours}:${minutes}:${seconds}`;
  }

  public destroy(): void {
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }
}
