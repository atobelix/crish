// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ToolNumericText } from '../ToolNumericText';
import * as toolRevealState from '../toolRevealState';

vi.mock('@/components/ui', () => ({
  NumericText: vi.fn(({ text, animateOnView, className }) => (
    <span
      className={className}
      data-testid="numeric-text-mock"
      data-animate={String(animateOnView)}
    >
      {text}
    </span>
  )),
}));

describe('ToolNumericText 实况门控守卫契约测试', () => {
  const originalDateNow = Date.now;

  beforeEach(() => {
    vi.clearAllMocks();
    Date.now = vi.fn(() => 1_000_000);
  });

  afterEach(() => {
    cleanup();
    Date.now = originalDateNow;
    vi.restoreAllMocks();
  });

  it('缺省 props：animateOnView 默认为 false，坚决不触发滚入动画', () => {
    render(<ToolNumericText text="32 行" />);
    const el = screen.getByTestId('numeric-text-mock');
    expect(el.textContent).toBe('32 行');
    expect(el.getAttribute('data-animate')).toBe('false');
  });

  it('历史会话/旧卡片展开：即使 animateOnView 为 true，由于时间戳过期出窗，坚决直出终态', () => {
    // 5 秒前完成的工具调用，已脱离实况窗 [-500ms, 2000ms)
    const oldTs = 1_000_000 - 5_000;
    render(
      <ToolNumericText text="1 处匹配" eventTs={oldTs} animateOnView={true} />
    );
    const el = screen.getByTestId('numeric-text-mock');
    expect(el.getAttribute('data-animate')).toBe('false');
  });

  it('瞬态实况到达：显式声明 animateOnView 且时间戳在实况窗内，允许滚入动画', () => {
    // 200ms 前完成的工具调用，处于实况窗内
    const liveTs = 1_000_000 - 200;
    render(
      <ToolNumericText text="+42" eventTs={liveTs} animateOnView={true} />
    );
    const el = screen.getByTestId('numeric-text-mock');
    expect(el.getAttribute('data-animate')).toBe('true');
  });

  it('无时间戳兜底：animateOnView 为 true 但无 eventTs 时，安全直出终态', () => {
    render(<ToolNumericText text="-18" animateOnView={true} />);
    const el = screen.getByTestId('numeric-text-mock');
    expect(el.getAttribute('data-animate')).toBe('false');
  });

  it('系统减动效降级：即便处于实况窗且开启 animateOnView，若减动效命中则强制静止', () => {
    vi.spyOn(toolRevealState, 'isRevealDegraded').mockReturnValue(true);
    const liveTs = 1_000_000 - 100;
    render(<ToolNumericText text="+5" eventTs={liveTs} animateOnView={true} />);
    const el = screen.getByTestId('numeric-text-mock');
    expect(el.getAttribute('data-animate')).toBe('false');
  });

  it('显式关闭 animateOnView 时，即便时间戳极新也坚决不动画', () => {
    const liveTs = 1_000_000;
    render(
      <ToolNumericText
        text="已扫描 12 个文件"
        eventTs={liveTs}
        animateOnView={false}
      />
    );
    const el = screen.getByTestId('numeric-text-mock');
    expect(el.getAttribute('data-animate')).toBe('false');
  });
});
