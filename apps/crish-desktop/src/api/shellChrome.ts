/**
 * 壳层 chrome 形态（纯类型 + 解析，无 store）。
 * classic / inset 均：外层壳色 + 内层圆角内容卡
 * classic：保留顶栏搜索
 * inset：无独立顶栏 + 双行工作台标签
 */

export type ShellChromeMode = 'classic' | 'inset';

/** 产品默认 inset：双行工作台，少一层独立顶栏，界面更干净 */
export const DEFAULT_SHELL_CHROME: ShellChromeMode = 'inset';
export const SHELL_CHROME_IDS = ['classic', 'inset'] as const satisfies readonly ShellChromeMode[];
export const SHELL_CHROME_STORAGE_KEY = 'crish_shell_chrome';

export function parseShellChromeMode(raw: unknown): ShellChromeMode {
  if (raw === undefined) return DEFAULT_SHELL_CHROME;
  if (raw === 'inset' || raw === 'classic') return raw;
  return 'classic';
}
