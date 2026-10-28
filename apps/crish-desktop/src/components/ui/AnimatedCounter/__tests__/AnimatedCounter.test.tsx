// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { AnimatedCounter } from '../AnimatedCounter';
import { SlotText } from '../SlotText';
import { useStreamingCounter } from '../useStreamingCounter';

afterEach(cleanup);

describe('AnimatedCounter 组件契约测试', () => {
  it('正确渲染无障碍可读文本与前缀后缀', () => {
    render(
      <AnimatedCounter
        value={1250}
        prefix="¥"
        suffix="CNY"
        decimals={2}
        locale="zh-CN"
      />
    );

    // 屏幕阅读器与测试工具能直接获取到完整的格式化数字文本
    expect(screen.getByText('¥1,250.00CNY')).toBeDefined();
  });

  it('支持带有顶部标签 label 的渲染', () => {
    render(<AnimatedCounter value={42} label="总请求数" />);
    expect(screen.getByText('总请求数')).toBeDefined();
    expect(screen.getByText('42')).toBeDefined();
  });

  it('支持负数前缀正确格式化', () => {
    render(<AnimatedCounter value={-80} prefix="$" />);
    expect(screen.getByText('-$80')).toBeDefined();
  });
});

describe('SlotText 老虎机滚轮组件契约测试', () => {
  it('格式化数字或文本，并注入无障碍读屏树', () => {
    render(
      <SlotText value={100000} format={(v) => `${(v / 10000).toFixed(1)} 万`} />
    );

    expect(screen.getByText('10.0 万')).toBeDefined();
  });

  it('字符串类型直接输出无障碍文本', () => {
    render(<SlotText value="ACTIVE-99" />);
    expect(screen.getByText('ACTIVE-99')).toBeDefined();
  });
});

describe('useStreamingCounter 节流状态机测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('非流式状态下直接更新且启用里程表', () => {
    const { result, rerender } = renderHook(
      ({ val, streaming }) =>
        useStreamingCounter({ value: val, isStreaming: streaming }),
      { initialProps: { val: 10, streaming: false } }
    );

    expect(result.current.displayValue).toBe(10);
    expect(result.current.enableOdometer).toBe(true);

    rerender({ val: 20, streaming: false });
    expect(result.current.displayValue).toBe(20);
    expect(result.current.enableOdometer).toBe(true);
  });

  it('流式状态下关闭重型里程表，并在流式结束时触发落定', () => {
    const { result, rerender } = renderHook(
      ({ val, streaming }) =>
        useStreamingCounter({
          value: val,
          isStreaming: streaming,
          throttleMs: 100,
        }),
      { initialProps: { val: 100, streaming: true } }
    );

    expect(result.current.enableOdometer).toBe(false);

    // 高频更新 105
    rerender({ val: 105, streaming: true });
    // 尚未经过 100ms 窗口
    expect(result.current.enableOdometer).toBe(false);

    // 模拟流式结束，终态落定
    rerender({ val: 150, streaming: false });
    expect(result.current.displayValue).toBe(150);
    expect(result.current.enableOdometer).toBe(true);
  });
});
