// @vitest-environment jsdom
/**
 * 快捷键设置页单源契约测试（T2-5）。
 *
 * 展示面（SettingsShortcutsTab 派生项）== 执行面（ShortcutRegistry 注册表）：
 *   ① binding/label 逐项全等（无静态副本、无绑定漂移）；
 *   ② 清单双向互盖（注册表每 id 都在设置页出现，如 export_logs；设置页无孤儿，如 close_tab）；
 *   ③ 设置页与服务共用 'shortcuts.overrides' 持久化键（overrides 链路同源）。
 * 值/fs 断言（同 style-contract 模式），不受覆盖率口径约束。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { BUILTIN_SHORTCUTS } from '../../services/ShortcutRegistry';
import { buildShortcutItems } from './SettingsShortcutsTab';

function readSrc(relPath: string): string {
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

describe('快捷键设置页单源契约（T2-5）', () => {
  const items = buildShortcutItems();

  it('展示项 binding/label 与注册表逐项全等（无静态副本、无绑定漂移）', () => {
    const registryById = new Map(BUILTIN_SHORTCUTS.map((m) => [m.id, m]));
    expect(items.length).toBe(BUILTIN_SHORTCUTS.length);

    for (const item of items) {
      const meta = registryById.get(item.id);
      expect(meta, `展示项 ${item.id} 在注册表不存在`).toBeDefined();
      expect(item.binding, `${item.id} binding 漂移`).toBe(meta!.defaultBinding);
      expect(item.label, `${item.id} label 漂移`).toBe(meta!.label);
    }
  });

  it('清单双向互盖：注册表每 id 均在设置页展示，设置页无注册表外孤儿', () => {
    const displayIds = new Set(items.map((i) => i.id));
    const registryIds = new Set(BUILTIN_SHORTCUTS.map((m) => m.id));

    const missing = [...registryIds].filter((id) => !displayIds.has(id));
    expect(missing, `注册表 id 未在设置页展示：${missing.join(', ')}`).toEqual([]);

    const orphans = [...displayIds].filter((id) => !registryIds.has(id));
    expect(orphans, `设置页展示注册表外的幽灵行：${orphans.join(', ')}`).toEqual([]);
  });

  it('export_logs 在设置页可见（注册表有、旧静态副本无的行已补上）', () => {
    expect(items.some((i) => i.id === 'export_logs')).toBe(true);
  });

  it('已退役 id（toggle_runtime / command_palette / close_tab）不出现在设置页', () => {
    const displayIds = new Set(items.map((i) => i.id));
    for (const retired of ['toggle_runtime', 'command_palette', 'close_tab']) {
      expect(displayIds.has(retired), `${retired} 应已从设置页移除`).toBe(false);
    }
  });

  it('设置页无静态绑定/文案副本（fs 断言：DEFAULT_SHORTCUTS 标识符不存在）', () => {
    const src = readSrc('components/settings/SettingsShortcutsTab.tsx');
    expect(src).not.toContain('DEFAULT_SHORTCUTS');
  });

  it('overrides 持久化键同源：设置页 persist 与服务 loadCustomOverrides 共用 shortcuts.overrides', () => {
    const settingsSrc = readSrc('components/settings/SettingsShortcutsTab.tsx');
    const serviceSrc = readSrc('services/ShortcutService.ts');
    expect(settingsSrc).toContain("'shortcuts.overrides'");
    expect(serviceSrc).toContain("'shortcuts.overrides'");
  });
});

describe('快捷键页控件皮契约（搜索 / 改键钮 / overlay 细条）', () => {
  it('搜索走 ui/Input variant=search，不再挂裸 type=search / settings-field-input', () => {
    const src = readSrc('components/settings/SettingsShortcutsTab.tsx');
    expect(src).toContain('variant="search"');
    expect(src).toContain('from \'../ui\'');
    expect(src).toMatch(/<\s*Input[\s\S]*variant="search"/);
    expect(src).not.toMatch(/<input[^>]*type=["']search["']/);
    expect(src).not.toContain('settings-field-input');
    expect(src).not.toContain('settings-shortcuts-filter');
  });

  it('改键钮走 ui/Button，并挂 7px / appearance 去 UA 皮', () => {
    const src = readSrc('components/settings/SettingsShortcutsTab.tsx');
    const css = readSrc('components/settings/SettingsShortcutsTab.module.css');
    expect(src).toContain('variant="secondary"');
    expect(src).toContain('size="sm"');
    expect(src).toContain('styles.shortcutKeyBtn');
    expect(src).not.toMatch(/<button\s+className=\{`shortcut-key-btn/);
    expect(css).toContain('appearance: none');
    expect(css).toContain('-webkit-appearance: none');
    expect(css).toContain('var(--button-radius, 7px)');
    expect(css).toContain('.shortcutSearch');
    expect(css).toContain('.shortcutKeyBtn');
  });

  it('ui/Input search 变体去掉原生皮：appearance + 7px + 不渲染 type=search', () => {
    const inputTsx = readSrc('components/ui/Input/Input.tsx');
    const inputCss = readSrc('components/ui/Input/Input.module.css');
    expect(inputTsx).toContain("variant === 'search' ? 'searchbox'");
    expect(inputTsx).not.toMatch(/variant === 'search'\s*\n\s*\? 'search'/);
    expect(inputCss).toContain('appearance: none');
    expect(inputCss).toContain('-webkit-appearance: none');
    expect(inputCss).toContain('var(--button-radius, 7px)');
    expect(inputCss).toContain('::-webkit-search-decoration');
    expect(inputCss).toContain('::-webkit-search-cancel-button');
    expect(inputCss).not.toMatch(/box-shadow:\s*0\s+4px/);
  });

  it('设置 cover/nav/Dialog 吃 overlay 细条：入口引入 + 无三角 + cover 不写 scrollbar-width', () => {
    const overlay = readSrc('styles/overlay-scrollbar.css');
    const indexCss = readSrc('index.css');
    const panel = readSrc('components/settings/SettingsPanel.module.css');
    const uiCss = readSrc('components/settings/SettingsUI.module.css');
    expect(indexCss).toContain("@import './styles/overlay-scrollbar.css'");
    expect(indexCss).not.toContain('shell-scrollbar.css');
    expect(overlay).toContain('::-webkit-scrollbar');
    expect(overlay).toContain('::-webkit-scrollbar-button');
    expect(overlay).toContain('coverContent');
    expect(overlay).toContain('navScroll');
    expect(overlay).toContain('dialogBody');
    expect(overlay).toContain('--tint-scrollbar-thumb');
    expect(overlay).not.toMatch(/(?:^|\n)\*\s*\{[^}]*scrollbar-width/);
    expect(panel).not.toMatch(/scrollbar-width\s*:/);
    expect(panel).toContain('.coverContent');
    expect(uiCss).toContain('var(--button-radius, 7px)');
    expect(uiCss).toContain('appearance: none');
  });
});
