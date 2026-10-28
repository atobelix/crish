/**
 * ui/Dialog 遮罩契约：全部弹窗共用一个轻遮罩 token（--modal-scrim，浅 / 深各一份），
 * 不做 backdrop-filter 模糊；弹窗叠弹窗时只保留最上层遮罩。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, './Dialog.module.css'), 'utf8');
const tokens = readFileSync(
  resolve(__dirname, '../../../styles/tokens-surface.css'),
  'utf8'
);

function themeBlock(selectorRe: RegExp): string {
  const start = tokens.search(selectorRe);
  if (start < 0) return '';
  const open = tokens.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (tokens[i] === '{') depth += 1;
    if (tokens[i] === '}') {
      depth -= 1;
      if (depth === 0) return tokens.slice(start, i + 1);
    }
  }
  return '';
}

describe('ui/Dialog 遮罩（--modal-scrim）', () => {
  it('遮罩只引用 --modal-scrim，且没有任何模糊 / 主题分叉', () => {
    const backdrop = css.match(/\n\.backdrop\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(backdrop).toMatch(/background:\s*var\(--modal-scrim\);/);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/data-theme='dark'\]\)\s*\.backdrop/);
  });

  it('tokens.css 浅色与深色各定义一份轻遮罩（基于 --shadow-color 的低比例 color-mix）', () => {
    const light = themeBlock(/:root,\s*\r?\nhtml\[data-theme='default'\]/);
    const dark = themeBlock(/html\[data-theme='dark'\]\s*\{/);
    const pick = (block: string) =>
      block.match(
        /--modal-scrim:\s*color-mix\(in srgb, var\(--shadow-color\) (\d+)%, transparent\);/
      );
    const l = pick(light);
    const d = pick(dark);
    expect(l, 'light --modal-scrim').not.toBeNull();
    expect(d, 'dark --modal-scrim').not.toBeNull();
    // 轻压暗：浅色低于旧值 22%，深色低于旧值 48%
    expect(Number(l![1])).toBeLessThan(22);
    expect(Number(d![1])).toBeLessThan(48);
  });

  it('弹窗叠弹窗：下层遮罩在存在未退场的上层弹窗时让位（只保留最上层遮罩）', () => {
    expect(css).toMatch(
      /\[data-focus-trap\]:has\(\s*~\s*\[data-focus-trap\]\s*>\s*\[data-dialog-overlay\]:not\(\[data-dialog-state='exiting'\]\)\s*\)\s*>\s*\[data-dialog-overlay\]\s*>\s*\.backdrop\s*\{\s*background:\s*transparent;/
    );
  });

  it('全屏形态已删除', () => {
    expect(css).not.toMatch(/dialogFullscreen/);
    const tsx = readFileSync(resolve(__dirname, './Dialog.tsx'), 'utf8');
    expect(tsx).not.toMatch(/fullscreen/i);
  });
});
