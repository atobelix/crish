/**
 * useBackgroundTaskPolling 纯函数测试：轮询 hook 的活跃过滤。
 */
import { describe, expect, it } from 'vitest';
import type { BackgroundTaskInfo } from '../../api/backgroundTasksApi';
import { filterActiveBackgroundTasks } from './useBackgroundTaskPolling';

function task(id: string, state: string): BackgroundTaskInfo {
  return { id, label: id, state: state as BackgroundTaskInfo['state'] };
}

describe('filterActiveBackgroundTasks', () => {
  it('keeps running / queued tasks only', () => {
    const tasks = [
      task('a', 'running'),
      task('b', 'queued'),
      task('c', 'done'),
      task('d', 'failed'),
    ];
    const active = filterActiveBackgroundTasks(tasks);
    expect(active.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('returns empty array for empty input', () => {
    expect(filterActiveBackgroundTasks([])).toEqual([]);
  });
});
