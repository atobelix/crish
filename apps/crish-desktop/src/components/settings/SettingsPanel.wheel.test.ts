import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 轻量源码守卫：确认 SettingsPanel 仍保留 handleRootWheel
 * （侧栏/顶栏非内容区滚轮联动内容区 scrollTop 的有意功能）。
 * 防止后续误删该职责或改回「补丁」语义。
 */
describe('SettingsPanel handleRootWheel 守卫', () => {
  const src = readFileSync(
    resolve(__dirname, './SettingsPanel.tsx'),
    'utf-8'
  );

  it('源码仍含 handleRootWheel 定义', () => {
    expect(src).toContain('handleRootWheel');
  });

  it('onWheel 挂载到 root 根节点', () => {
    expect(src).toMatch(/onWheel=\{handleRootWheel\}/);
  });

  it('models tab 早退守卫仍在', () => {
    expect(src).toMatch(/safeActiveTab === 'models'/);
  });

  it('contains 守卫仍在（内容区原生滚动，防双倍速）', () => {
    expect(src).toContain('contains(e.target as Node)');
  });
});
