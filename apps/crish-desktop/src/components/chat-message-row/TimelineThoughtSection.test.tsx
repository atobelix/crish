// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimelineThoughtSection } from './TimelineThoughtSection';

describe('TimelineThoughtSection', () => {
  it('正常展示思考阶段与耗时（不显示字数与放大图标），支持折叠展开', () => {
    render(
      <TimelineThoughtSection
        content="这是简短的思考过程"
        durationMs={2400}
        turnIndex={0}
      />
    );

    expect(screen.getByText('思考')).toBeDefined();
    expect(screen.getAllByText('这是简短的思考过程').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/共.*字/)).toBeNull();
    expect(screen.queryByRole('button', { name: /查看完整思考链/i })).toBeNull();
  });

  it('思考没有第几阶段这一说：即便 turnIndex > 0 也永远展示“思考”', () => {
    render(
      <TimelineThoughtSection
        content="后续步骤思考"
        durationMs={1500}
        turnIndex={3}
      />
    );
    expect(screen.getByText('思考')).toBeDefined();
    expect(screen.queryByText(/第.*阶段/)).toBeNull();
  });

  it('展开态下头部单行不展示摘要内容，避免与正文首句重复', () => {
    const { container } = render(
      <TimelineThoughtSection
        content="首句思考内容详细展开"
        defaultExpanded={true}
      />
    );
    // 头部 button 内部不包含 thoughtSummary
    const headerBtn = container.querySelector('[class*="thoughtHeaderBtn"]');
    expect(headerBtn?.querySelector('[class*="thoughtSummary"]')).toBeNull();
  });

  it('系统性记录起始时间与持续时间并在 DOM 与 tooltip 透出', () => {
    const now = 1757512345678;
    const { container } = render(
      <TimelineThoughtSection
        content="计时测试"
        startTime={now}
        durationMs={2800}
      />
    );
    const section = container.querySelector('[data-kind="thought"]');
    expect(section).toHaveAttribute('data-start-time', String(now));
    expect(section).toHaveAttribute('data-duration-ms', '2800');
    const headerBtn = container.querySelector('[class*="thoughtHeaderBtn"]');
    expect(headerBtn?.getAttribute('title')).toContain('开始时间:');
    expect(headerBtn?.getAttribute('title')).toContain('耗时: 2.8秒');
  });

  it('实时思考中展示流式文案，无呼吸绿点', () => {
    const { container } = render(
      <TimelineThoughtSection content="正在思考下一步工具调用" isLive={true} />
    );

    expect(screen.getByText('正在思考')).toBeDefined();
    expect(screen.getAllByText('正在思考下一步工具调用').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('[class*="thoughtLiveDot"]')).toBeNull();
  });

  it('defaultExpanded 控制新渲染块的初始开合', () => {
    const open = render(
      <TimelineThoughtSection content="推理段落" defaultExpanded />
    );
    expect(
      open.container.querySelector('[data-kind="thought"] [aria-expanded="true"]')
    ).not.toBeNull();
    expect(
      open.container.querySelector('[data-kind="thought"] [data-expanded="true"]')
    ).not.toBeNull();
    open.unmount();

    const closed = render(
      <TimelineThoughtSection content="推理段落" defaultExpanded={false} />
    );
    expect(
      closed.container.querySelector(
        '[data-kind="thought"] [aria-expanded="false"]'
      )
    ).not.toBeNull();
    expect(
      closed.container.querySelector(
        '[data-kind="thought"] [data-expanded="false"]'
      )
    ).not.toBeNull();
  });

  it('长文本思考内容直接在折叠面板内完整渲染，不显示截断提示或弹窗放大按钮', () => {
    const longThought = 'A'.repeat(15000);
    const { container } = render(
      <TimelineThoughtSection
        messageId="msg-long-1"
        content={longThought}
        defaultExpanded={true}
      />
    );

    // 不存在截断提示与弹窗按钮
    expect(screen.queryByText(/(行内已截断)/)).toBeNull();
    expect(screen.queryByRole('button', { name: /查看完整思考链/i })).toBeNull();
    expect(container.querySelector('[class*="thoughtScrollBody"]')).not.toBeNull();
  });

  it('切除 168px 局部内部滚动与吸底：展开时在文档流内自然展开，不劫持内部滚动与吸底', () => {
    const { container, rerender } = render(
      <TimelineThoughtSection
        content="第 1 批思考 Token"
        isLive={true}
        defaultExpanded={true}
      />
    );

    const scrollBody = container.querySelector('[class*="thoughtScrollBody"]') as HTMLDivElement;
    expect(scrollBody).not.toBeNull();
    // 确认未挂载内部 onscroll 监听劫持
    expect(scrollBody.onscroll).toBeNull();

    // 追踪 scrollTop 是否被内部逻辑篡改
    let scrollTopAssigned = false;
    Object.defineProperty(scrollBody, 'scrollTop', {
      get: () => 0,
      set: () => {
        scrollTopAssigned = true;
      },
      configurable: true,
    });

    // 模拟流式追加内容
    rerender(
      <TimelineThoughtSection
        content="第 1 批思考 Token\n第 2 批思考 Token\n第 3 批思考 Token..."
        isLive={true}
        defaultExpanded={true}
      />
    );

    // 内部不再主动执行 el.scrollTop = el.scrollHeight 局部吸底，交由全局视口宿主统一管理
    expect(scrollTopAssigned).toBe(false);
  });
});

