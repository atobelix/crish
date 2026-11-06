// @vitest-environment jsdom
/**
 * useHeaderTicker.test.ts
 *
 * 组标题行意图滚动摘要 Hook 测试（F3 任务 B）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHeaderTicker } from '../useHeaderTicker';
import type { MessageToolCall } from '../../../store/types';

function createTool(
  id: string,
  name: string,
  status: MessageToolCall['status'],
  intent: string
): MessageToolCall {
  return { id, name, status, arguments: '', intent };
}

describe('useHeaderTicker Hook 测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('运行态时单向锁定最新工具意图，不启动轮播定时器', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '读取配置'),
      createTool('t2', 'grep_search', 'running', '正在检索关键字'),
    ];

    const { result } = renderHook(() =>
      useHeaderTicker({
        groupTitle: '探索任务',
        tools,
        hasRunning: true,
        isSealed: false,
        isExpanded: false,
      })
    );

    // 运行态直接锁定运行中工具的意图（索引为 2，位移 -48px 定格展示）
    expect(result.current.currentText).toBe('正在检索关键字');
    expect(result.current.currentIndex).toBe(2);
    expect(result.current.transformStyle).toEqual({
      transform: 'translateY(-48px)',
    });

    // 推进时间，不发生轮播位移
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.currentIndex).toBe(2);
  });

  it('封口折叠态（运行已结束）必须静止：索引恒定为组标题，永不轮播（用户裁决 2026-11-05）', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '读取配置'),
      createTool('t2', 'edit_file', 'success', '更新字段'),
    ];

    const { result } = renderHook(() =>
      useHeaderTicker({
        groupTitle: '宏观重构',
        tools,
        hasRunning: false,
        isSealed: true,
        isExpanded: false,
      })
    );

    expect(result.current.currentIndex).toBe(0);
    expect(result.current.currentText).toBe('宏观重构');

    // 任意时长推进后仍定格在组标题，完成态不许继续滚动/轮播
    act(() => {
      vi.advanceTimersByTime(3500 * 6);
    });
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.transformStyle).toEqual({
      transform: 'translateY(-0px)',
    });
    expect(result.current.currentText).toBe('宏观重构');
  });

  it('运行时（未封口）轮播中封口：索引收敛回组标题并保持静止', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '读取配置'),
      createTool('t2', 'edit_file', 'success', '更新字段'),
    ];

    const { result, rerender } = renderHook(
      ({ isSealed }) =>
        useHeaderTicker({
          groupTitle: '宏观重构',
          tools,
          hasRunning: false,
          isSealed,
          isExpanded: false,
        }),
      { initialProps: { isSealed: false } }
    );

    // 运行时正常轮播到第 2 项
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.currentIndex).toBe(1);

    // 封口（运行结束）：收敛回组标题
    rerender({ isSealed: true });
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.currentText).toBe('宏观重构');

    // 其后不再位移
    act(() => {
      vi.advanceTimersByTime(3500 * 4);
    });
    expect(result.current.currentIndex).toBe(0);
  });

  it('未封口折叠态 (isSealed: false) 且非 running 时解除死锁，依然正常垂直轮播', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '读取配置'),
      createTool('t2', 'edit_file', 'success', '更新字段'),
    ];

    const { result } = renderHook(() =>
      useHeaderTicker({
        groupTitle: '宏观重构',
        tools,
        hasRunning: false,
        isSealed: false,
        isExpanded: false,
      })
    );

    expect(result.current.currentIndex).toBe(0);
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.currentIndex).toBe(1);
    expect(result.current.transformStyle).toEqual({
      transform: 'translateY(-24px)',
    });
    expect(result.current.currentText).toBe('读取配置');
  });

  it('鼠标悬停 (pause) 与离开 (resume) 控制运行时轮播暂停与恢复', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '任务一'),
      createTool('t2', 'read_file', 'success', '任务二'),
    ];

    const { result } = renderHook(() =>
      useHeaderTicker({
        groupTitle: '批处理',
        tools,
        hasRunning: false,
        isSealed: false,
        isExpanded: false,
      })
    );

    // 悬停暂停
    act(() => {
      result.current.pause();
    });
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(result.current.currentIndex).toBe(0);

    // 离开恢复
    act(() => {
      result.current.resume();
    });
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.currentIndex).toBe(1);
  });

  it('展开态时立即停止轮播并重置为静态组标题', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '任务一'),
      createTool('t2', 'read_file', 'success', '任务二'),
    ];

    const { result, rerender } = renderHook(
      ({ isExpanded }) =>
        useHeaderTicker({
          groupTitle: '批处理',
          tools,
          hasRunning: false,
          isSealed: false,
          isExpanded,
        }),
      { initialProps: { isExpanded: false } }
    );

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.currentIndex).toBe(1);

    // 切换为展开态
    rerender({ isExpanded: true });
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.currentText).toBe('批处理');
  });

  it('思考项（2026-11-06 第 9 条）：live 时思考行入列居首，思考更新即切到思考面', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '任务一'),
      createTool('t2', 'read_file', 'success', '任务二'),
    ];

    const { result, rerender } = renderHook(
      ({ thoughtLine }) =>
        useHeaderTicker({
          groupTitle: '批处理',
          tools,
          hasRunning: false,
          isSealed: false,
          isExpanded: false,
          thoughtLine,
        }),
      { initialProps: { thoughtLine: '正在分析目录结构' } }
    );

    // 思考项居首，初始即呈现思考面
    expect(result.current.items[0]?.kind).toBe('thought');
    expect(result.current.items[0]?.text).toBe('正在分析目录结构');
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.currentText).toBe('正在分析目录结构');

    // 轮播推进离开思考面后，思考行更新（新思考到达）立即切回思考面
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.currentIndex).not.toBe(0);
    rerender({ thoughtLine: '正在核对搜索结果' });
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.currentText).toBe('正在核对搜索结果');
  });

  it('思考项：工具开跑时仍锁定最新 running 工具（思考跟随不越过运行锁定）', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '任务一'),
      createTool('t2', 'grep_search', 'running', '正在检索关键字'),
    ];

    const { result, rerender } = renderHook(
      ({ thoughtLine }) =>
        useHeaderTicker({
          groupTitle: '批处理',
          tools,
          hasRunning: true,
          isSealed: false,
          isExpanded: false,
          thoughtLine,
        }),
      { initialProps: { thoughtLine: '先想一下检索范围' } }
    );

    expect(result.current.currentText).toBe('正在检索关键字');
    rerender({ thoughtLine: '检索范围已确定' });
    expect(result.current.currentText).toBe('正在检索关键字');
  });

  it('isSealed 缺失时以显式 isLive 判定（单项领衔组块回退路径）：live 轮播含思考、转静后收敛停住', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '任务一'),
      createTool('t2', 'read_file', 'success', '任务二'),
    ];

    const { result, rerender } = renderHook(
      ({ isLive, thoughtLine }) =>
        useHeaderTicker({
          groupTitle: '批处理',
          tools,
          hasRunning: false,
          isSealed: undefined,
          isExpanded: false,
          thoughtLine,
          isLive,
        }),
      {
        initialProps: {
          isLive: true as boolean,
          thoughtLine: '回退路径思考行' as string | null,
        },
      }
    );

    // live：思考项入列并可轮播
    expect(result.current.items.some((i) => i.kind === 'thought')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.currentIndex).toBe(1);

    // 转静（段结束）：思考出列、索引收敛回组标题、其后恒静止
    rerender({ isLive: false, thoughtLine: '回退路径思考行' });
    expect(result.current.items.some((i) => i.kind === 'thought')).toBe(false);
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.currentText).toBe('批处理');
    act(() => {
      vi.advanceTimersByTime(3500 * 4);
    });
    expect(result.current.currentIndex).toBe(0);
  });

  it('组项先封口、同块仍有工具在跑：索引收敛回组标题且不再被运行锁定拉回（实机残留回归钉）', () => {
    const runningTools = [
      createTool('t1', 'read_file', 'success', '任务一'),
      createTool('t2', 'grep_search', 'running', '正在检索关键字'),
    ];
    const stillRunningTools = [
      createTool('t1', 'read_file', 'success', '任务一'),
      createTool('t2', 'grep_search', 'running', '正在扩大检索范围'),
    ];
    const doneTools = [
      createTool('t1', 'read_file', 'success', '任务一'),
      createTool('t2', 'grep_search', 'success', '检索完成'),
    ];

    const { result, rerender } = renderHook(
      ({ tools, hasRunning, isSealed }) =>
        useHeaderTicker({
          groupTitle: '批处理',
          tools,
          hasRunning,
          isSealed,
          isExpanded: false,
        }),
      {
        initialProps: {
          tools: runningTools,
          hasRunning: true,
          isSealed: false as boolean | undefined,
        },
      }
    );
    // live + running：锁定最新 running 工具
    expect(result.current.currentText).toBe('正在检索关键字');

    // 组项封口（isSealed 转 true）但同块工具仍在跑：收敛回组标题
    rerender({ tools: stillRunningTools, hasRunning: true, isSealed: true });
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.currentText).toBe('批处理');

    // 全部完成：保持收敛静止
    rerender({ tools: doneTools, hasRunning: false, isSealed: true });
    expect(result.current.currentIndex).toBe(0);
    act(() => {
      vi.advanceTimersByTime(3500 * 3);
    });
    expect(result.current.currentIndex).toBe(0);
  });

  it('思考项：封口后思考项出列，索引回组标题并静止', () => {
    const tools = [
      createTool('t1', 'read_file', 'success', '任务一'),
      createTool('t2', 'read_file', 'success', '任务二'),
    ];

    const { result, rerender } = renderHook(
      ({ isSealed, thoughtLine }) =>
        useHeaderTicker({
          groupTitle: '批处理',
          tools,
          hasRunning: false,
          isSealed,
          isExpanded: false,
          thoughtLine,
        }),
      {
        initialProps: {
          isSealed: false as boolean | undefined,
          thoughtLine: '最后的思考行' as string | null,
        },
      }
    );
    expect(result.current.items.some((i) => i.kind === 'thought')).toBe(true);

    rerender({ isSealed: true, thoughtLine: '最后的思考行' });
    expect(result.current.items.some((i) => i.kind === 'thought')).toBe(false);
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.currentText).toBe('批处理');
    act(() => {
      vi.advanceTimersByTime(3500 * 4);
    });
    expect(result.current.currentIndex).toBe(0);
  });
});
