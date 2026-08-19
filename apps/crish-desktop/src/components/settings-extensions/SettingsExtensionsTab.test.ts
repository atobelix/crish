// @vitest-environment node
/**
 * 扩展货架 / MCP 高级 / 技能高级：死皮不得回潮。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTsx(p));
    else if (/\.(tsx|ts|css)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

function readSrc(rel: string): string {
  return readFileSync(join(here, rel), 'utf8');
}

describe('扩展设置页控件皮契约', () => {
  const files = [
    ...walkTsx(here),
    ...walkTsx(join(here, '../settings-mcp')),
    ...walkTsx(join(here, '../settings-skills')),
  ];
  const joined = files.map((p) => readFileSync(p, 'utf8')).join('\n');

  it('不再挂幽灵分段 / 幽灵 input / 矩形死 class / ext-* 全局皮', () => {
    expect(joined).not.toContain('ui-segment');
    expect(joined).not.toContain('ui-segment-item');
    expect(joined).not.toContain('settings-choice-btn');
    expect(joined).not.toContain('settings-field-input');
    expect(joined).not.toContain('settings-btn-rect');
    expect(joined).not.toContain('settings-create-path');
    expect(joined).not.toContain('settings-kbd');
    expect(joined).not.toMatch(/className=["'`]ext-/);
  });

  it('货架筛选/搜索走 SegmentedControl + ui/Input search', () => {
    const src = readSrc('SettingsExtensionsTab.tsx');
    expect(src).toContain('SegmentedControl');
    expect(src).toContain('variant="search"');
    expect(src).toContain('aria-label="视图"');
    expect(src).toContain('aria-label="类型"');
    expect(src).not.toMatch(/<input[^>]*type=["']search["']/);
  });

  it('详情/配置/启用/安装走 ui/Button，启用钮带 active 选中态', () => {
    const src = readSrc('ExtensionCard.tsx');
    expect(src).toContain('active={pluginCard.pluginEnabled}');
    expect(src).toContain('active={detailOpen}');
    expect(src).toContain("variant=\"danger\"");
    expect(src).toContain('安装');
    expect(src).not.toContain('settings-btn-rect');
  });

  it('扩展 module 锁 7px，详情滚动盒类名命中 overlay-scrollbar', () => {
    const css = readSrc('SettingsExtensionsTab.module.css');
    expect(css).toContain('var(--button-radius, 7px)');
    expect(css).toContain('appearance: none');
    expect(css).toContain('detailMdCoverContent');
    expect(css).toContain('coverContent');
    expect(css).not.toMatch(/scrollbar-width\s*:/);
  });
});
