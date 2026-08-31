import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * 将 HSL 转换为 sRGB [0, 1]
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/**
 * 将 Hex 转换为 sRGB [0, 1]
 */
function hexToRgb(hex: string): [number, number, number] {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * 计算相对亮度 L (W3C WCAG 2.1 公式)
 */
function getRelativeLuminance(r: number, g: number, b: number): number {
  const transform = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const R = transform(r);
  const G = transform(g);
  const B = transform(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * 计算两颜色的对比度 (>= 1.0)
 */
function getContrastRatio(rgb1: [number, number, number], rgb2: [number, number, number]): number {
  const l1 = getRelativeLuminance(...rgb1);
  const l2 = getRelativeLuminance(...rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Phase 2 Track A: 自定义富交互组件 WCAG AA 对比度与 Tokens 自动化断言', () => {
  const whiteBg: [number, number, number] = [1, 1, 1]; // #ffffff

  it('TC-C01: Light 模式 Diff 新增行文字对比度 >= 6.0:1 (超标满足 WCAG AA)', () => {
    // --diff-add-fg: hsl(142 65% 25%)
    const diffAddFg = hslToRgb(142, 65, 25);
    const contrast = getContrastRatio(diffAddFg, whiteBg);
    expect(contrast).toBeGreaterThanOrEqual(6.0);
    expect(Number(contrast.toFixed(2))).toBeGreaterThanOrEqual(6.7);
  });

  it('TC-C02: Light 模式 Diff 删除行文字对比度 >= 7.0:1 (达到 WCAG AAA 级别)', () => {
    // --diff-del-fg: hsl(0 68% 38%)
    const diffDelFg = hslToRgb(0, 68, 38);
    const contrast = getContrastRatio(diffDelFg, whiteBg);
    expect(contrast).toBeGreaterThanOrEqual(7.0);
    expect(Number(contrast.toFixed(2))).toBeGreaterThanOrEqual(7.0);
  });

  it('TC-C03: Light 模式 FileTree 修改徽标 [M] 对比度 >= 5.0:1 (超标满足 WCAG AA)', () => {
    // --filetree-badge-mod-fg: hsl(32 95% 30%)
    const modBadgeFg = hslToRgb(32, 95, 30);
    const contrast = getContrastRatio(modBadgeFg, whiteBg);
    expect(contrast).toBeGreaterThanOrEqual(5.0);
    expect(Number(contrast.toFixed(2))).toBeGreaterThanOrEqual(5.3);
  });

  it('TC-C04: Light 模式 FileTree 新增徽标 [A] 对比度 >= 5.0:1 (超标满足 WCAG AA)', () => {
    // --filetree-badge-add-fg: hsl(142 70% 28%)
    const addBadgeFg = hslToRgb(142, 70, 28);
    const contrast = getContrastRatio(addBadgeFg, whiteBg);
    expect(contrast).toBeGreaterThanOrEqual(5.0);
    expect(Number(contrast.toFixed(2))).toBeGreaterThanOrEqual(5.4);
  });

  it('TC-C05: Light 模式 FileTree 删除徽标 [D] 对比度 >= 6.5:1 (超标满足 WCAG AA)', () => {
    // --filetree-badge-del-fg: hsl(0 75% 36%)
    const delBadgeFg = hslToRgb(0, 75, 36);
    const contrast = getContrastRatio(delBadgeFg, whiteBg);
    expect(contrast).toBeGreaterThanOrEqual(6.5);
    expect(Number(contrast.toFixed(2))).toBeGreaterThanOrEqual(6.8);
  });

  it('TC-C06: Light 模式 Diff 行号文本对比度 >= 4.5:1 (达到 WCAG AA)', () => {
    // --diff-linenum-fg: #696969
    const lineNumFg = hexToRgb('#696969');
    const contrast = getContrastRatio(lineNumFg, whiteBg);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    expect(Number(contrast.toFixed(2))).toBeGreaterThanOrEqual(4.5);
  });

  it('TC-DEL01: custom-tags.module.css 中 0 处裸写 HSL/Hex (全部 Token 化)', () => {
    const cssPath = path.resolve(__dirname, '../custom-tags.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');

    const lines = cssContent.split('\n');
    const violations: string[] = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      if (trimmed.includes('rgba(0, 0, 0') || trimmed.includes('#ffffff')) return; // 合法 fallback

      // 检查裸写 hsl(数字)
      if (/hsl\(\s*\d+/i.test(trimmed)) {
        violations.push(`Line ${idx + 1}: ${trimmed}`);
      }

      // 检查非 #ffffff 裸写 hex (如 #10b981 等)
      if (/#([0-9a-fA-F]{3,8})/i.test(trimmed) && !trimmed.includes('#ffffff')) {
        violations.push(`Line ${idx + 1}: ${trimmed}`);
      }
    });

    expect(violations).toEqual([]);
  });

  it('TC-DEL02: custom-tags.module.css 中 0 处非法属性 divide-x', () => {
    const cssPath = path.resolve(__dirname, '../custom-tags.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent.includes('divide-x')).toBe(false);
  });

  it('TC-DEL03: custom-tags.module.css 中包含 .fileTreeItem 与 .fileTreeChildren 类定义', () => {
    const cssPath = path.resolve(__dirname, '../custom-tags.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent.includes('.fileTreeItem')).toBe(true);
    expect(cssContent.includes('.fileTreeChildren')).toBe(true);
  });

  it('TC-DEL04: custom-tags.module.css 中彻底删除孤立类 .portalOverlay / .portalContent / .statusPulse', () => {
    const cssPath = path.resolve(__dirname, '../custom-tags.module.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent.includes('.portalOverlay')).toBe(false);
    expect(cssContent.includes('.portalContent')).toBe(false);
    expect(cssContent.includes('.statusPulse')).toBe(false);
  });
});
