/**
 * 后台任务 3s 轮询 hook：从 ChatStatusRibbons 壳组件抽出，
 * 供动态 chip 区展示「后台任务 (N)」。
 */
import { useEffect, useState } from 'react';
import {
  listBackgroundTasks,
  isBackgroundTaskActive,
  type BackgroundTaskInfo,
} from '../../api/backgroundTasksApi';

/** 轮询间隔：与抽出前保持一致（3s）。 */
const BACKGROUND_TASK_POLL_MS = 3000;

/**
 * 返回全部后台任务列表，并每 3s 刷新一次。
 * 活跃判定（isBackgroundTaskActive）由调用方按需过滤。
 */
export function useBackgroundTaskPolling(): BackgroundTaskInfo[] {
  const [bgTasks, setBgTasks] = useState<BackgroundTaskInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fetchTasks = async () => {
      try {
        const tasks = await listBackgroundTasks();
        if (!cancelled) setBgTasks(tasks || []);
      } catch {
        /* ignore */
      }
    };
    void fetchTasks();
    const t = setInterval(() => void fetchTasks(), BACKGROUND_TASK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return bgTasks;
}

/** 活跃后台任务过滤：与壳组件原 useMemo 逻辑一致。 */
export function filterActiveBackgroundTasks(
  tasks: BackgroundTaskInfo[],
): BackgroundTaskInfo[] {
  return tasks.filter((t) => isBackgroundTaskActive(t.state));
}
