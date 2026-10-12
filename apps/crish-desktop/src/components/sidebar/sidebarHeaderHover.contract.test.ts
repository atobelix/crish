/**
 * 侧栏分组标题（置顶 / 项目 / 对话）、分组右侧图标钮、「查看全部」：
 * hover 只改文字 / 图标颜色，不出底色；会话行 hover / 选中底色保持。
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cssPath =
  typeof __dirname !== 'undefined'
    ? path.resolve(__dirname, 'SidebarSessionList.module.css')
    : fileURLToPath(
        new URL('./SidebarSessionList.module.css', import.meta.url)
      );

const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');

function blocksFor(selector: RegExp): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const sel = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (sel.split(',').some((s) => selector.test(s.trim()))) out.push(m[2]!);
  }
  return out;
}

const HEADER = [
  'sectionLabel',
  'sectionNew',
  'sectionSortBtn',
  'sectionSort',
  'foldToggleBtn',
  'folderNewBtn',
  'folderNewSession',
];

describe('侧栏分组头 hover 无底色', () => {
  it.each(HEADER)(
    '.%s 把 ghost Button 的 hover / active 覆盖层置透明',
    (cls) => {
      const blocks = blocksFor(new RegExp(`^\\.${cls}$`));
      const joined = blocks.join('\n');
      expect(joined).toMatch(/--btn-hover-overlay:\s*transparent/);
      expect(joined).toMatch(/--btn-active-overlay:\s*transparent/);
    }
  );

  it.each(HEADER)('.%s:hover / :active 不设置非透明底色', (cls) => {
    const blocks = blocksFor(new RegExp(`^\\.${cls}:(hover|active)$`));
    for (const b of blocks) {
      const bg = b.match(/background(?:-color)?:\s*([^;]+);/);
      if (bg) expect(bg[1]!.trim()).toBe('transparent');
    }
  });

  it('会话行 hover / 选中底色保持', () => {
    expect(blocksFor(/^\.sessionItem:hover$/).join('\n')).toMatch(
      /background:\s*var\(--sidebar-hover\)/
    );
    expect(blocksFor(/^\.sessionItem\.active$/).join('\n')).toMatch(
      /background/
    );
  });
});
