export interface MinimalConfig {
  sidebarCollapsed: boolean;
  shellChromeMode: string | null;
  uiSize: string;
  tabModeEnabled: boolean;
  theme: string;
}

const KEYS = {
  shellChrome: 'crish_shell_chrome',
  sidebar: 'crish_sidebar_collapsed',
  uiSize: 'crish_ui_size',
  tabMode: 'crish_tab_mode',
};

let cached: MinimalConfig | null = null;

export function getMinimalConfig(): MinimalConfig {
  if (cached) return cached;
  try {
    const sidebar = localStorage.getItem(KEYS.sidebar) === '1';
    const chrome = localStorage.getItem(KEYS.shellChrome);
    const size = localStorage.getItem(KEYS.uiSize) || 'medium';
    const tab = localStorage.getItem(KEYS.tabMode) !== '0';
    const theme = document.documentElement.getAttribute('data-theme') || 'default';
    cached = { sidebarCollapsed: sidebar, shellChromeMode: chrome, uiSize: size, tabModeEnabled: tab, theme };
  } catch {
    cached = { sidebarCollapsed: false, shellChromeMode: null, uiSize: 'medium', tabModeEnabled: true, theme: 'default' };
  }
  return cached;
}

export async function loadMinimalConfig(): Promise<MinimalConfig> {
  return getMinimalConfig();
}
