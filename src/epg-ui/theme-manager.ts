// テーマ管理（システム設定・ライト・ダーク）

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'webts_theme_mode';

export function getTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
  } catch {
    // ignore
  }
  return 'system'; // デフォルトはシステム設定に従う
}

export function setTheme(theme: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore
  }
  applyTheme(theme);
}

export function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
}

export function initTheme(): void {
  const current = getTheme();
  applyTheme(current);

  // OS側のダーク/ライトモード切り替えを監視して再適用
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', () => {
    if (getTheme() === 'system') {
      applyTheme('system');
    }
  });
}
