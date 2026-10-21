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

  it('手风琴折叠遵循 CSS Grid 0fr -> 1fr，高度与透明度共用到达曲线', () => {
    expect(css).toMatch(
      /\.accordionWrapper\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-rows:\s*0fr;[\s\S]*transition:\s*grid-template-rows\s+var\(--transition-accordion\);/
    );
    expect(css).toMatch(
      /\.accordionWrapper\[data-expanded=['"]true['"]\]\s*\{[\s\S]*grid-template-rows:\s*1fr;/
    );
    expect(css).toMatch(
      /\.accordionInner\s*\{[\s\S]*min-height:\s*0;[\s\S]*opacity:\s*0;[\s\S]*transition:\s*opacity\s+var\(--transition-accordion-fade\);/
    );
    expect(css).toMatch(
      /\.accordionWrapper\[data-expanded=['"]true['"]\]\s+\.accordionInner\s*\{[\s\S]*opacity:\s*1;/
    );
    // 零 display: none，彻底解耦高度塌缩阻断
    expect(css).not.toMatch(
      /\.accordionWrapper\[data-expanded=['"]false['"]\]\s*\{[\s\S]*display:\s*none;/
    );
  });

  it('侧栏灰度显示层级：会话项/项目行突出（--text-secondary），折叠控制行/时间戳/展开按钮弱化（--text-faint）', () => {
    // 突出层级：会话列表项与项目文件夹行使用 --text-secondary
    expect(blocksFor(/^\.sessionItem$/).join('\n')).toMatch(
      /color:\s*var\(--text-secondary\)/
    );
    expect(blocksFor(/^\.folderHeader$/).join('\n')).toMatch(
      /color:\s*var\(--text-secondary\)/
    );
    expect(blocksFor(/^\.folderHeader svg$/).join('\n')).toMatch(
      /color:\s*var\(--text-secondary\)/
    );

    // 次要信息层级：置顶/项目/对话折叠控制行（.sectionLabel）使用 --text-faint 且字重为 400（禁止 500 抢戏）
    const sectionLabelBlock = blocksFor(/^\.sectionLabel$/).join('\n');
    expect(sectionLabelBlock).toMatch(/color:\s*var\(--text-faint\)/);
    expect(sectionLabelBlock).toMatch(
      /font-weight:\s*var\(--font-weight-normal,\s*400\)/
    );
    expect(blocksFor(/^\.sectionLabel svg$/).join('\n')).toMatch(
      /color:\s*var\(--text-faint\)/
    );

    // 次要信息层级：会话时间戳（含选中态）与折叠展开按钮使用 --text-faint
    expect(blocksFor(/^\.sessionTime$/).join('\n')).toMatch(
      /color:\s*var\(--text-faint\)/
    );
    expect(
      blocksFor(/^\.sessionItem\.active \.sessionTime$/).join('\n')
    ).toMatch(/color:\s*var\(--text-faint\)/);
    expect(blocksFor(/^\.foldToggleBtn$/).join('\n')).toMatch(
      /color:\s*var\(--text-faint\)/
    );
  });
});
