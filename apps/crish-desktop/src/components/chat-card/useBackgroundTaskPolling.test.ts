// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBackgroundTaskPolling } from './useBackgroundTaskPolling';
import { useEngineState } from '../../hooks/useEngineState';
import type { BackgroundTaskInfo } from '../../api/backgroundTasksApi';

vi.mock('../../hooks/useEngineState', () => ({
  useEngineState: vi.fn(() => ({ bgTasks: [] as BackgroundTaskInfo[] })),
}));

function setBg(tasks: BackgroundTaskInfo[]) {
  (useEngineState as unknown as () => { bgTasks: BackgroundTaskInfo[] }).mockReturnValue({
    bgTasks: tasks,
  });
}

describe('useBackgroundTaskPolling 单源（D6.1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBg([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enabled false 或无 sessionId / 草稿态 → 空数组且不依赖独立轮询', () => {
    setBg([
      {
        id: 't1',
        sessionId: 's1',
      } as unknown as BackgroundTaskInfo,
    ]);
    expect(renderHook(() => useBackgroundTaskPolling({ enabled: false })).result.current).toEqual([]);
    expect(renderHook(() => useBackgroundTaskPolling({ enabled: true })).result.current).toEqual([]);
    expect(
      renderHook(() =>
        useBackgroundTaskPolling({ sessionId: '__pending_draft_x', enabled: true })
      ).result.current
    ).toEqual([]);
  });

  it('按 sessionId 过滤 engine 单源任务', () => {
    setBg([
      { id: 't1', sessionId: 's1' } as unknown as BackgroundTaskInfo,
      { id: 't2', sessionId: 's2' } as unknown as BackgroundTaskInfo,
      { id: 't3' } as unknown as BackgroundTaskInfo,
    ]);
    const { result } = renderHook(() =>
      useBackgroundTaskPolling({ sessionId: 's1', enabled: true })
    );
    expect(result.current.map((t) => t.id)).toEqual(['t1']);
  });
});
