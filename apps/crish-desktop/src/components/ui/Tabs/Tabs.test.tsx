// @vitest-environment jsdom
/**
 * ui/Tabs 测试套件：
 * 1. 双层复合结构与 WAI-ARIA (tablist / tab / tabpanel)
 * 2. 受控与非受控双模
 * 3. pill 与 line 两种变体
 * 4. horizontal 与 vertical 两种方向
 * 5. xs / sm / md / lg 尺寸体系与同心圆角几何契约
 * 6. Roving TabIndex 全键盘漫游 (Arrow / Home / End)
 * 7. keepMounted 惰性装载机制
 * 8. Appica UI 物理微回弹动效与按压缩放微交互规范
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs';
import styles from './Tabs.module.css';

const CSS_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'Tabs.module.css'),
  'utf8'
);

describe('ui/Tabs', () => {
  it('渲染基本标签页且默认选中第一项或 defaultValue 项', () => {
    render(
      <Tabs defaultValue="account" aria-label="用户设置">
        <TabsList aria-label="用户设置标签">
          <TabsTrigger value="account">账户</TabsTrigger>
          <TabsTrigger value="password">密码</TabsTrigger>
          <TabsTrigger value="notifications">通知</TabsTrigger>
        </TabsList>
        <TabsContent value="account">账户设置面板</TabsContent>
        <TabsContent value="password">密码设置面板</TabsContent>
        <TabsContent value="notifications">通知设置面板</TabsContent>
      </Tabs>
    );

    const tablist = screen.getByRole('tablist', { name: '用户设置标签' });
    expect(tablist).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabIndex', '0');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('tabIndex', '-1');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[2]).toHaveAttribute('tabIndex', '-1');

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('账户设置面板');
    expect(screen.queryByText('密码设置面板')).not.toBeInTheDocument();
  });

  it('受控模式：正确响应外部 value 属性并触发 onValueChange 回调', () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <Tabs value="tab1" onValueChange={onValueChange}>
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
          <TabsTrigger value="tab2">选项2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">内容1</TabsContent>
        <TabsContent value="tab2">内容2</TabsContent>
      </Tabs>
    );

    expect(screen.getByRole('tab', { name: '选项1' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByText('内容1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '选项2' }));
    expect(onValueChange).toHaveBeenCalledWith('tab2');

    rerender(
      <Tabs value="tab2" onValueChange={onValueChange}>
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
          <TabsTrigger value="tab2">选项2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">内容1</TabsContent>
        <TabsContent value="tab2">内容2</TabsContent>
      </Tabs>
    );

    expect(screen.getByRole('tab', { name: '选项2' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByText('内容2')).toBeInTheDocument();
    expect(screen.queryByText('内容1')).not.toBeInTheDocument();
  });

  it('非受控模式：点击切换内部状态并展示对应面板', () => {
    const onValueChange = vi.fn();
    render(
      <Tabs defaultValue="tab1" onValueChange={onValueChange}>
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
          <TabsTrigger value="tab2">选项2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">内容1</TabsContent>
        <TabsContent value="tab2">内容2</TabsContent>
      </Tabs>
    );

    fireEvent.click(screen.getByRole('tab', { name: '选项2' }));
    expect(onValueChange).toHaveBeenCalledWith('tab2');
    expect(screen.getByRole('tab', { name: '选项2' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByText('内容2')).toBeInTheDocument();
    expect(screen.queryByText('内容1')).not.toBeInTheDocument();
  });

  it('支持 pill 与 line 两种变体', () => {
    const { rerender } = render(
      <Tabs defaultValue="tab1" variant="pill">
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    const root = screen.getByRole('tablist').parentElement;
    expect(root).toHaveAttribute('data-variant', 'pill');
    expect(screen.getByRole('tablist')).toHaveClass(styles.listPill);

    rerender(
      <Tabs defaultValue="tab1" variant="line">
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    expect(root).toHaveAttribute('data-variant', 'line');
    expect(screen.getByRole('tablist')).toHaveClass(styles.listLine);
  });

  it('支持 horizontal 与 vertical 排布方向及 aria-orientation', () => {
    const { rerender } = render(
      <Tabs defaultValue="tab1" orientation="horizontal">
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');

    rerender(
      <Tabs defaultValue="tab1" orientation="vertical">
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('支持 xs / sm / md / lg 尺寸档位与 block 撑满', () => {
    const { rerender } = render(
      <Tabs defaultValue="tab1" size="xs" block>
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    const root = screen.getByRole('tablist').parentElement;
    expect(root).toHaveClass(styles.sizeXs);
    expect(root).toHaveAttribute('data-block', 'true');
    expect(screen.getByRole('tablist')).toHaveAttribute('data-block', 'true');

    rerender(
      <Tabs defaultValue="tab1" size="lg">
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    expect(root).toHaveClass(styles.sizeLg);
  });

  it('禁用态：禁用触发器阻止点击切换并被键盘漫游跳过', () => {
    const onValueChange = vi.fn();
    render(
      <Tabs defaultValue="tab1" onValueChange={onValueChange}>
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
          <TabsTrigger value="tab2" disabled>
            选项2(禁用)
          </TabsTrigger>
          <TabsTrigger value="tab3">选项3</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    const disabledTab = screen.getByRole('tab', { name: '选项2(禁用)' });
    expect(disabledTab).toBeDisabled();

    fireEvent.click(disabledTab);
    expect(onValueChange).not.toHaveBeenCalled();

    const tablist = screen.getByRole('tablist');
    // 在 tab1 上按 ArrowRight 应该跳过禁用的 tab2 直达 tab3
    fireEvent.keyDown(tablist, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(onValueChange).toHaveBeenCalledWith('tab3');
  });

  it('Roving TabIndex 键盘漫游：ArrowRight / ArrowLeft / Home / End', () => {
    const onValueChange = vi.fn();
    render(
      <Tabs defaultValue="tab1" onValueChange={onValueChange}>
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
          <TabsTrigger value="tab2">选项2</TabsTrigger>
          <TabsTrigger value="tab3">选项3</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    const tablist = screen.getByRole('tablist');

    // 1. ArrowRight -> tab2
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenCalledWith('tab2');

    // 2. End -> tab3
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(onValueChange).toHaveBeenCalledWith('tab3');

    // 3. Home -> tab1
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(onValueChange).toHaveBeenCalledWith('tab1');

    // 4. ArrowLeft 从 tab1 循环到最后一项 tab3
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(onValueChange).toHaveBeenCalledWith('tab3');
  });

  it('垂直模式键盘漫游：ArrowDown / ArrowUp', () => {
    const onValueChange = vi.fn();
    render(
      <Tabs defaultValue="tab1" orientation="vertical" onValueChange={onValueChange}>
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
          <TabsTrigger value="tab2">选项2</TabsTrigger>
        </TabsList>
      </Tabs>
    );

    const tablist = screen.getByRole('tablist');

    fireEvent.keyDown(tablist, { key: 'ArrowDown' });
    expect(onValueChange).toHaveBeenCalledWith('tab2');

    fireEvent.keyDown(tablist, { key: 'ArrowUp' });
    expect(onValueChange).toHaveBeenCalledWith('tab1');
  });

  it('keepMounted 机制：为 true 时在未激活时保留 DOM 节点 (hidden)', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">选项1</TabsTrigger>
          <TabsTrigger value="tab2">选项2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">面板1</TabsContent>
        <TabsContent value="tab2" keepMounted>
          面板2 (保持挂载)
        </TabsContent>
      </Tabs>
    );

    const panel2 = screen.getByText('面板2 (保持挂载)');
    expect(panel2).toBeInTheDocument();
    expect(panel2).toHaveAttribute('hidden');
  });

  it('支持在 Trigger 中渲染前置 icon 与尾部 badge', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger
            value="tab1"
            icon={<span data-testid="icon">🔍</span>}
            badge={<span data-testid="badge">12</span>}
          >
            搜索
          </TabsTrigger>
        </TabsList>
      </Tabs>
    );

    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(screen.getByTestId('badge')).toHaveTextContent('12');
    expect(screen.getByRole('tab')).toHaveTextContent('搜索');
  });

  it('物理动效与同心圆角 CSS 规范验证', () => {
    // 1. Appica 物理微回弹动效参数
    expect(CSS_SRC).toContain('cubic-bezier(0.2, 0, 0, 1)');
    expect(CSS_SRC).toContain('--tab-duration: 250ms');
    expect(CSS_SRC).toContain('--tab-press-duration: 100ms');

    // 2. 3.5% 暖灰底板与纯白卡底
    expect(CSS_SRC).toContain('background-color: var(--bg-secondary)');
    expect(CSS_SRC).toContain('background-color: var(--bg-card, #ffffff)');

    // 3. 微观按压缩放与位移交互 (Scale 0.97 + 1px)
    expect(CSS_SRC).toContain('transform: scale(0.97) translateY(1px)');

    // 4. 同心圆角几何体系 R_inner = R_outer - Padding
    expect(CSS_SRC).toContain('--tab-inner-radius: calc(var(--tab-outer-radius) - var(--tab-pad))');
    expect(CSS_SRC).toContain('--tab-outer-radius: var(--radius-md, 6px)');
    expect(CSS_SRC).toContain('--tab-outer-radius: var(--button-radius, 8px)');
    expect(CSS_SRC).toContain('--tab-outer-radius: var(--radius-lg, 8px)');
    expect(CSS_SRC).toContain('--tab-outer-radius: var(--radius-xl, 10px)');

    // 5. 焦点环与减弱动画兜底
    expect(CSS_SRC).toContain('color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)');
    expect(CSS_SRC).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS_SRC).toContain("html[data-perf-tier='eco']");
  });
});
