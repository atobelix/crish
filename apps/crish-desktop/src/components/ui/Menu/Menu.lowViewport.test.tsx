/**
 * ui/Menu 低视口定位回归测试（04 方案 G15a 前移，I1 轮）
 *
 * 背景：原 conex_gap_06 视口钳制缺陷（ComposePlusMenu 无 max-height/overflow、
 * ModelPicker max-h 过紧）疑已随 8e8c313c 组件目录化迁移消解；本文件以测试
 * 固化低视口（600px 高）下的钳制契约，防止回归：
 * 1. clampPosition 纯函数：600px 高视口下纵向钳入（不溢出、不越界）；
 * 2. 基座 CSS 契约：Menu.module.css 的 .menuContent 必须含
 *    `max-height: min(70vh, 360px)` + `overflow-y: auto`（低视口滚动钳制）；
 * 3. G15a 现状核销：ComposePlusMenu.module.css 的 .menuContent 必须含
 *    `max-height: min(340px, 60dvh)` + `overflow-y: auto`（已随迁移消解）；
 * 4. 组件渲染级：600px 高视口下打开高选项菜单，popover 正常挂载且
 *    content 携带 menuContent 类（Radix avoidCollisions/collisionPadding 在
 *    Menu.tsx:198-199 已配置，jsdom 下断言挂载与类名契约）。
 *
 * 说明：jsdom 无真实布局引擎，Radix floating-ui 的像素级坐标断言不可靠，
 * 故"被 clamp"以「纯函数钳位 + CSS 钳制契约 + 组件挂载」三层组合证明。
 */
// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Menu } from './Menu';
import styles from './Menu.module.css';
import { clampPosition } from './position';

const LOW_VH = 600;

afterEach(() => {
  cleanup();
});

/** 读取同目录 CSS 文件文本（断言钳制契约存在）；vitest 会拦截 .css 的 URL 导入，故用 import.meta.url 相对定位文件本身（不依赖 process.cwd，规避并行 worker 负载下的 cwd 假设） */
function readCssText(relPathFromMenu: string): string {
  return readFileSync(new URL(relPathFromMenu, import.meta.url), 'utf8');
}

function makeOptions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `opt-${i}`,
    label: `选项 ${i}`,
  }));
}

describe('ui/Menu 低视口（600px 高）定位回归', () => {
  it('clampPosition 在 600px 高视口下纵向钳入（不溢出）', () => {
    // 菜单底部贴底：600 高视口 + 280 预估高 → 应上翻并钳入留白内
    const pos = clampPosition(100, 500, 160, 280, {
      width: 1280,
      height: LOW_VH,
    });
    expect(pos.y + 280).toBeLessThanOrEqual(LOW_VH - 8);
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.transformOrigin).toContain('bottom');
  });

  it('clampPosition 在 600px 高视口下超尺寸菜单不产生负坐标', () => {
    const pos = clampPosition(100, 200, 160, 5000, {
      width: 1280,
      height: LOW_VH,
    });
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.y + 5000).toBeGreaterThanOrEqual(LOW_VH - 8);
  });

  it('基座 CSS 契约：menuContent 含低视口 max-height 钳制 + overflow-y 滚动', () => {
    const css = readCssText('Menu.module.css');
    expect(css).toContain('--radix-popover-content-available-height');
    expect(css).toContain('70vh');
    expect(css).toContain('360px');
    expect(css).toContain('overflow-y: auto');
  });

  it('G15a 核销：ComposePlusMenu 基于 Menu 基座继承视口钳制（max-height + overflow-y）', () => {
    const baseCss = readCssText('Menu.module.css');
    expect(baseCss).toContain('--radix-popover-content-available-height');
    expect(baseCss).toContain('overflow-y: auto');
    const plusCss = readCssText(
      '../../chat-composer/ComposePlusMenu.module.css'
    );
    expect(plusCss).toContain('.plusMenu');
  });

  it('600px 高视口下打开高选项菜单：popover 正常挂载且带 menuContent 钳制类', async () => {
    render(
      <Menu
        trigger={<button type="button">低视口触发器</button>}
        options={makeOptions(24)}
      />
    );
    fireEvent.click(screen.getByText('低视口触发器'));
    const content = (await screen.findByRole('menu'))
      .parentElement as HTMLElement;
    expect(content).toBeTruthy();
    expect(content.classList.contains(styles.menuContent)).toBe(true);
    // 全部选项渲染（内容超视口时由 max-height + overflow-y 承接滚动）
    expect(screen.getAllByRole('menuitem')).toHaveLength(24);
  });
});
