export interface MinimalConfig {
  sidebarCollapsed: boolean;
  shellChromeMode: string | null;
  uiSize: string;
  tabModeEnabled: boolean;
  theme: string;
}

let cached: MinimalConfig | null = null;

function getMinimalConfig(): MinimalConfig {
  if (cached) return cached;
  try {
    const theme = document.documentElement.getAttribute('data-theme') || 'default';
    cached = { sidebarCollapsed: false, shellChromeMode: null, uiSize: 'medium', tabModeEnabled: true, theme };
  } catch {
    cached = { sidebarCollapsed: false, shellChromeMode: null, uiSize: 'medium', tabModeEnabled: true, theme: 'default' };
  }
  return cached;
}

export async function loadMinimalConfig(): Promise<MinimalConfig> {
  return getMinimalConfig();
}
