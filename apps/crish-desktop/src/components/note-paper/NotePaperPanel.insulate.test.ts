/**
 * 05-B 顶栏绝缘：读盘锁 `.panel > .header` (0,2,0) + flex: 0 0 auto。
 *
 * 源码绝缘 ≠ 皮像素已交付 ≠ 打开完成。jsdom 不算 header 计算高。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : import.meta.url.startsWith('file:')
      ? dirname(fileURLToPath(import.meta.url))
      : resolve(process.cwd(), 'src/components/note-paper');

function ruleBlockAfter(css: string, selectorPrefix: string): string {
  const normalized = css.replace(/\r\n/g, '\n');
  const idx = normalized.indexOf(selectorPrefix);
  expect(idx, `缺少选择器 ${selectorPrefix}`).toBeGreaterThanOrEqual(0);
  const open = normalized.indexOf('{', idx);
  const close = normalized.indexOf('}', open);
  expect(close, `${selectorPrefix} 块未闭合`).toBeGreaterThan(open);
  return normalized.slice(open, close + 1);
}

describe('NotePaperPanel 05-B 顶栏绝缘（源码读盘）', () => {
  const css = readFileSync(join(DIR, 'NotePaperPanel.module.css'), 'utf8');

  it('含 .panel > .header / .footer，flex: 0 0 auto 且 max-height: none', () => {
    expect(css).toContain('.panel > .header');
    expect(css).toContain('.panel > .footer');

    const chrome = ruleBlockAfter(css, '.panel > .header,');
    expect(chrome).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(chrome).toMatch(/max-height:\s*none/);
    expect(chrome).toMatch(/width:\s*100%/);
    expect(chrome).toMatch(/min-height:\s*unset/);
  });

  it('.panel > .body 吃满滚区，不被 100% 与顶栏均分', () => {
    expect(css).toContain('.panel > .body');
    const body = ruleBlockAfter(css, '.panel > .body');
    expect(body).toMatch(/flex:\s*1\s+1\s+0%/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/max-height:\s*none/);
  });

  it('未改 V1 6% 公式；绝缘块无 rgba / !important', () => {
    expect(css).toMatch(/--np-focus-edge:\s*color-mix\(/);
    expect(css).toMatch(/var\(--border-color\)\s*94%/);
    expect(css).toMatch(/var\(--text-primary\)\s*6%/);
    const chrome = ruleBlockAfter(css, '.panel > .header,');
    expect(chrome).not.toContain('rgba(');
    expect(chrome).not.toContain('!important');
    const body = ruleBlockAfter(css, '.panel > .body');
    expect(body).not.toContain('rgba(');
    expect(body).not.toContain('!important');
  });
});
