// @vitest-environment jsdom
/**
 * 样式系统契约测试（审计 F7 修复回归）
 *
 * F7-F14：z-index 硬编码残留（tabDragGhost / useSessionListDrag /
 *         LeafToolTabStrip / FileViewerCard）必须 token 化，禁裸数字。
 * F7-F27：--ui-text-* 五连 token 必须在 dark 主题块内重新定义
 *         （否则暗色下仍引用 light 值，对比度不足）。
 *
 * 采用与 Menu.lowViewport.test.tsx 相同的 fs 契约断言方式
 * （new URL(rel, import.meta.url)，不依赖 process.cwd）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const Z_INDEX_FILES = [
  'src/hooks/tab-drag/tabDragGhost.ts',
  'src/components/sidebar/session-list/useSessionListDrag.ts',
  'src/components/binary-tree/LeafToolTabStrip.module.css',
  'src/components/files/FileViewerCard.module.css',
] as const;

function readFile(relPath: string): string {
  // 注意：模板字面量先赋给中间变量再进 new URL——
  // 内联在 new URL 参数中的模板会被 transform 破坏（路径解析为 undefined）
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

describe('z-index token 契约（F7-F14）', () => {
  it('审计列出的 4 个文件不存在裸数字 z-index 硬编码', () => {
    for (const rel of Z_INDEX_FILES) {
      const src = readFile(rel);
      const bare = src.match(/z-index\s*:\s*\d+(?![\w-])/g) ?? [];
      expect(bare, `${rel} 存在裸数字 z-index：${bare.join(', ')}`).toEqual([]);
    }
  });

  it('tabDragGhost 拖拽浮层走 --z-toast 档位（值等价 token 化）', () => {
    const src = readFile('src/hooks/tab-drag/tabDragGhost.ts');
    const block = src.match(/baseOverlayFixedStyle[\s\S]*?z-index:\s*[^;]+;/);
    expect(block?.[0]).toContain('var(--z-toast)');
  });

  it('useSessionListDrag 拖拽幽灵走 --z-tooltip 档位（值等价 token 化）', () => {
    const src = readFile(
      'src/components/sidebar/session-list/useSessionListDrag.ts'
    );
    expect(src).toContain('z-index:var(--z-tooltip)');
  });

  it('LeafToolTabStrip.addDropdownMenu 走 --z-floating-panel 档位', () => {
    const src = readFile('src/components/binary-tree/LeafToolTabStrip.module.css');
    const block = src.match(/\.addDropdownMenu\s*\{[\s\S]*?\}/);
    expect(block?.[0]).toContain('z-index: var(--z-floating-panel)');
  });

  it('FileViewerCard.filesOpenMenu / filesMoreMenu 走 --z-sidebar 档位', () => {
    const src = readFile('src/components/files/FileViewerCard.module.css');
    for (const sel of ['.filesOpenMenu', '.filesMoreMenu']) {
      const block = src.match(new RegExp(`${sel}\\s*\\{[\\s\\S]*?\\}`));
      expect(block?.[0], `${sel} 应 token 化`).toContain('z-index: var(--z-sidebar)');
    }
  });
});

describe('--ui-text-* dark 覆盖契约（F7-F27）', () => {
  it('dark 主题块内重新定义 --ui-text-* 五连 token（不引用 light 值）', () => {
    const css = readFile('src/styles/tokens.css');
    const darkBlock = css.match(/html\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/);
    expect(darkBlock).toBeTruthy();
    for (const token of [
      '--ui-text-success',
      '--ui-text-danger',
      '--ui-text-muted',
      '--ui-text-info',
      '--ui-text-warning',
    ]) {
      expect(darkBlock?.[0], `dark 块应定义 ${token}`).toContain(`${token}:`);
    }
  });
});
