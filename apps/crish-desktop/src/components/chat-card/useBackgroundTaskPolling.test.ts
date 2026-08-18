// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBackgroundTaskPolling } from './useBackgroundTaskPolling';
import * as bgApi from '../../api/backgroundTasksApi';

describe('useBackgroundTaskPolling enabled 门闩测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('enabled 为 false 时不触发 listBackgroundTasks 且返回空数组', () => {
    const listSpy = vi.spyOn(bgApi, 'listBackgroundTasks').mockResolvedValue([]);

    const { result } = renderHook(() =>
      useBackgroundTaskPolling({ enabled: false })
    );

    expect(result.current).toEqual([]);
    expect(listSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6000);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('处于草稿态 (__pending_draft) 时彻底静默', () => {
    const listSpy = vi.spyOn(bgApi, 'listBackgroundTasks').mockResolvedValue([]);

    const { result } = renderHook(() =>
      useBackgroundTaskPolling({
        sessionId: '__pending_draft_123',
        enabled: true,
      })
    );

    expect(result.current).toEqual([]);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('未提供 sessionId 时彻底静默休眠', () => {
    const listSpy = vi.spyOn(bgApi, 'listBackgroundTasks').mockResolvedValue([]);

    const { result } = renderHook(() =>
      useBackgroundTaskPolling({ enabled: true })
    );

    expect(result.current).toEqual([]);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('enabled 为 true 且为有效会话时正常轮询并过滤异端会话任务与无 sessionId 全局任务', async () => {
    const listSpy = vi.spyOn(bgApi, 'listBackgroundTasks').mockResolvedValue([
      {
        id: 'task-1',
        title: 'test task',
        command: 'cargo build',
        state: 'running',
        startedAt: 1000,
        sessionId: 'session-123',
      } as any,
      {
        id: 'task-2',
        title: 'other session task',
        command: 'npm test',
        state: 'running',
        startedAt: 1000,
        sessionId: 'session-999',
      } as any,
      {
        id: 'task-3',
        title: 'global daemon task',
        command: 'cron-sync',
        state: 'running',
        startedAt: 1000,
      } as any,
    ]);

    let hookResult: any;
    await act(async () => {
      hookResult = renderHook(() =>
        useBackgroundTaskPolling({
          sessionId: 'session-123',
          enabled: true,
        })
      );
      await Promise.resolve();
    });

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(hookResult.result.current.length).toBe(1);
    expect(hookResult.result.current[0].id).toBe('task-1');
    expect(hookResult.result.current.some((t: any) => t.id === 'task-3')).toBe(false);
  });

  it('onTasksUpdate 引用变动不会触发额外的 listBackgroundTasks 轮询风暴', async () => {
    const listSpy = vi.spyOn(bgApi, 'listBackgroundTasks').mockResolvedValue([]);
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    let hookResult: any;
    await act(async () => {
      hookResult = renderHook(
        ({ onTasksUpdate }) =>
          useBackgroundTaskPolling({
            sessionId: 'session-123',
            enabled: true,
            onTasksUpdate,
          }),
        { initialProps: { onTasksUpdate: cb1 } }
      );
      await Promise.resolve();
    });

    expect(listSpy).toHaveBeenCalledTimes(1);

    // Re-render with new function reference
    await act(async () => {
      hookResult.rerender({ onTasksUpdate: cb2 });
      await Promise.resolve();
    });

    // Should NOT have triggered another listBackgroundTasks call immediately
    expect(listSpy).toHaveBeenCalledTimes(1);
  });
});
