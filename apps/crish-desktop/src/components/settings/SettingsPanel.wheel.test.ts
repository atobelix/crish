import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 源码守卫：确认 SettingsPanel 左右两边滚动完全解耦
 * 左边栏滚动与右边内容区滚动互不干扰；禁止在根节点绑定 onWheel 串联 scrollTop；
 * 侧栏与内容区各自独立使用 overscroll-behavior: contain。
 */
describe('SettingsPanel 左右滚动解耦与独立性守卫', () => {
  const tsxSrc = readFileSync(
    resolve(__dirname, './SettingsPanel.tsx'),
    'utf-8'
  );
  const cssSrc = readFileSync(
    resolve(__dirname, './SettingsPanel.module.css'),
    'utf-8'
  );

  it('SettingsPanel 不再包含 handleRootWheel 联动逻辑', () => {
    expect(tsxSrc).not.toContain('handleRootWheel');
  });

  it('SettingsPanel 根节点不绑定 onWheel 事件劫持', () => {
    expect(tsxSrc).not.toMatch(/onWheel=/);
  });

  it('SettingsPanel.module.css 中 .navScroll 声明 overscroll-behavior: contain', () => {
    expect(cssSrc).toMatch(/\.navScroll\s*\{[^}]*overscroll-behavior:\s*contain/);
  });

  it('SettingsPanel.module.css 中 .coverContent 声明 overscroll-behavior: contain', () => {
    expect(cssSrc).toMatch(/\.coverContent\s*\{[^}]*overscroll-behavior:\s*contain/);
  });
});
