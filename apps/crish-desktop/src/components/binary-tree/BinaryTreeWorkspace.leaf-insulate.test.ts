/**
 * 05 纸面皮 · leafBody 绝缘源码契约（读盘）。
 * 测绿 ≠ 皮像素已交付；9222 另验。≠ 关 EL ≠ 打开完成。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const SRC_ROOT = join(DIR, '../..');

function readBeside(rel: string): string {
  return readFileSync(join(DIR, rel), 'utf8');
}

function ruleBlock(css: string, selector: string): string {
  const needle = `${selector} {`;
  const idx = css.indexOf(needle);
  expect(idx, `缺少选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  expect(close, `${selector} 块未闭合`).toBeGreaterThan(open);
  return css.slice(open, close + 1);
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.includes('.test.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (extname(name) === '.ts' || extname(name) === '.tsx') {
      out.push(full);
    }
  }
  return out;
}

describe('05 leafBody 绝缘 · 选择器文本', () => {
  const moduleCss = readBeside('./BinaryTreeWorkspace.module.css');

  it('二级 fill 用 :not(header/footer)，打不中纸面 chrome', () => {
    expect(moduleCss).toMatch(
      /\.leafChatColumn\s*>\s*\*:not\(:global\(header\)\):not\(:global\(footer\)\)/
    );
    expect(moduleCss).toMatch(
      /\.leafChatColumn\s*>\s*\*\s*>\s*\*:not\(:global\(header\)\):not\(:global\(footer\)\)/
    );
    expect(moduleCss).not.toMatch(/\.leafBody\s+\*\s*[,{]/);
  });

  it('note 面板 header 绝缘：flex 0 0 auto + max-height:none，且彻底切除 footer 绝缘', () => {
    const headerNeedle =
      ":global([data-testid='note-paper-strict-panel']) > :global(header)";
    const footerNeedle =
      ":global([data-testid='note-paper-strict-panel']) > :global(footer)";

    // 1. 正向断言：顶栏绝缘规则坚挺存在，确保 32px 紧凑顶栏绝不坍缩
    expect(moduleCss).toContain(headerNeedle);
    const idx = moduleCss.indexOf(headerNeedle);
    const open = moduleCss.indexOf('{', idx);
    const close = moduleCss.indexOf('}', open);
    expect(close, '顶栏绝缘规则大括号必须正常闭合').toBeGreaterThan(open);
    const chrome = moduleCss.slice(open, close + 1);
    expect(chrome).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(chrome).toMatch(/max-height:\s*none/);
    expect(chrome).not.toMatch(/rgba\s*\(/);

    // 2. 负向刚性防回潮断言：note 面板底部灰块彻底拔除后，宿主叶子样式中严禁残留 footer 规则
    expect(
      moduleCss,
      '宿主样式表 BinaryTreeWorkspace.module.css 严禁残留无效的 :global(footer) 绝缘选择器'
    ).not.toContain(footerNeedle);
  });

  it('02 叶壳适配器是列 flex 吃满，不是 display:contents', () => {
    const host = ruleBlock(
      moduleCss,
      '.leafBody :global([data-note-leaf-host])'
    );
    expect(host).toMatch(/display:\s*flex/);
    expect(host).toMatch(/flex-direction:\s*column/);
    expect(host).toMatch(/flex:\s*1\s+1\s+0%/);
    expect(host).not.toMatch(/display:\s*contents/);
  });

  it('.section / .canvas / .treeBody 仍是 flex: 1 1 0%（01 刚性高未动）', () => {
    expect(ruleBlock(moduleCss, '.section')).toMatch(/flex:\s*1\s+1\s+0%/);
    expect(ruleBlock(moduleCss, '.canvas')).toMatch(/flex:\s*1\s+1\s+0%/);
    expect(ruleBlock(moduleCss, '.treeBody')).toMatch(/flex:\s*1\s+1\s+0%/);
    expect(moduleCss).not.toMatch(/\bTODO\b/);
  });
});

describe('叶 chrome IA 与真树对齐', () => {
  it('注释走 UnitChromeActions / LeafToolTabStrip，不把已删 ChatHeader 当渲染路径', () => {
    const ws = readBeside('./BinaryTreeWorkspace.tsx');
    const leaf = readBeside('./TreeLeafPanel.tsx');
    expect(ws).toMatch(/UnitChromeActions/);
    expect(ws).toMatch(/LeafToolTabStrip/);
    expect(ws).not.toMatch(/单 unit chat：ChatHeader/);
    expect(ws).not.toMatch(/UnitSessionTabStrip（per-unit/);
    expect(ws).not.toMatch(/GlobalSessionTabBar 是会话身份源/);
    expect(leaf).toMatch(/UnitChromeActions/);
    expect(leaf).toMatch(/LeafToolTabStrip/);
    expect(leaf).toMatch(/leafDockDrawer/);
    expect(leaf).not.toMatch(/from ['"]\.\/ChatHeader['"]/);
    expect(leaf).not.toMatch(/from ['"]\.\/UnitSessionTabStrip['"]/);
  });

  it('chat 叶顶行由 UnitChromeActions 自己 sticky 定位，本表不得再叠绝对定位', () => {
    const css = readBeside('./BinaryTreeWorkspace.module.css');
    expect(css).not.toMatch(/data-canvas-quiet/);
    /*
     * 参考 .chat-top-header 是流内 sticky + margin-bottom:-38px。
     * 本表曾另有一份 .leafToolHeader 绝对定位覆盖层，两套定位互相覆盖，
     * 表现为渐隐层与右上角坞开关错位。这里钉死：布局表不再碰叶顶行定位。
     */
    expect(css).not.toMatch(/\.leafToolHeader/);
    expect(css).not.toMatch(/--card-header-bg/);

    const chromeCss = readFileSync(
      join(DIR, '../chat-card/UnitChromeActions.module.css'),
      'utf8'
    );
    const header = ruleBlock(chromeCss, '.chatTopHeader');
    expect(header).toMatch(/position:\s*sticky/);
    expect(header).toMatch(/height:\s*38px/);
    expect(header).toMatch(/margin-bottom:\s*-38px/);
    expect(header).toMatch(/pointer-events:\s*none/);
    expect(header).not.toMatch(/justify-content:\s*flex-end/);
  });
});

describe('05 皮加载边 · 全局表仍为 0', () => {
  it('index.css / shell-layout.css 不含 chrome.css / paper-list.css', () => {
    const indexCss = readFileSync(join(SRC_ROOT, 'index.css'), 'utf8');
    const layoutCss = readFileSync(
      join(SRC_ROOT, 'styles/shell/shell-layout.css'),
      'utf8'
    );
    for (const [name, src] of [
      ['index.css', indexCss],
      ['shell-layout.css', layoutCss],
    ] as const) {
      expect(src, name).not.toMatch(/chrome\.css/);
      expect(src, name).not.toMatch(/paper-list\.css/);
      expect(src, name).not.toMatch(/blockChrome\.css/);
      expect(src, name).not.toMatch(/NotePaperPanel\.module/);
    }
  });
});

describe('05-E 负向 · 产品 note 路径不挂 ConexFloatHandle', () => {
  it('扩展叶 + Strict 面板 + TreeLeafPanel 源码无 ConexFloatHandle', () => {
    const hits: string[] = [];
    const files = [
      join(DIR, '../note-paper/NotePaperStrictPanel.tsx'),
      join(DIR, './TreeLeafPanel.tsx'),
      ...listSourceFiles(join(SRC_ROOT, 'extensions/note-paper')),
    ];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (src.includes('ConexFloatHandle')) {
        hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });

  it('ConexFloatHandle 三文件不在 note-paper 目录', () => {
    const notePaper = join(DIR, '../note-paper');
    for (const name of [
      'ConexFloatHandle.tsx',
      'ConexFloatHandle.module.css',
      'ConexFloatHandle.test.tsx',
    ] as const) {
      expect(existsSync(join(notePaper, name)), name).toBe(false);
    }
  });
});
