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
      /\.leafBody\s*>\s*\*:not\(:global\(header\)\):not\(:global\(footer\)\)/
    );
    expect(moduleCss).toMatch(
      /\.leafBody\s*>\s*\*\s*>\s*\*:not\(:global\(header\)\):not\(:global\(footer\)\)/
    );
    expect(moduleCss).not.toMatch(/\.leafBody\s+\*\s*[,{]/);
  });

  it('note 面板 header/footer 绝缘：flex 0 0 auto + max-height:none', () => {
    const headerNeedle =
      ":global([data-testid='note-paper-strict-panel']) > :global(header)";
    const footerNeedle =
      ":global([data-testid='note-paper-strict-panel']) > :global(footer)";
    expect(moduleCss).toContain(headerNeedle);
    expect(moduleCss).toContain(footerNeedle);
    const idx = moduleCss.indexOf(headerNeedle);
    const open = moduleCss.indexOf('{', idx);
    const close = moduleCss.indexOf('}', open);
    expect(close).toBeGreaterThan(open);
    const chrome = moduleCss.slice(open, close + 1);
    expect(chrome).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(chrome).toMatch(/max-height:\s*none/);
    expect(chrome).not.toMatch(/rgba\s*\(/);
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
