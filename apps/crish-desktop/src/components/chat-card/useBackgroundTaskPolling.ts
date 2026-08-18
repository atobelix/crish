/**
 * 后台任务 3s 轮询 hook：从 ChatStatusRibbons 壳组件抽出，
 * 供动态 chip 区展示「后台任务 (N)」。
 */
import { useEffect, useRef, useState } from 'react';
import {
  listBackgroundTasks,
  isBackgroundTaskActive,
  type BackgroundTaskInfo,
} from '../../api/backgroundTasksApi';

/** 轮询间隔：与抽出前保持一致（3s）。 */
const BACKGROUND_TASK_POLL_MS = 3000;

export interface UseBackgroundTaskPollingOptions {
  sessionId?: string;
  enabled?: boolean;
  onTasksUpdate?: (tasks: BackgroundTaskInfo[]) => void;
}

/**
 * 返回全部后台任务列表，并每 3s 刷新一次。
 * 当 enabled === false 或处于草稿态时彻底静默休眠，不启动任何定时器。
 * 活跃判定（isBackgroundTaskActive）由调用方按需过滤。
 */
export function useBackgroundTaskPolling(
  optionsOrEnabled?: boolean | UseBackgroundTaskPollingOptions
): BackgroundTaskInfo[] {
  const enabled =
    typeof optionsOrEnabled === 'boolean'
      ? optionsOrEnabled
      : (optionsOrEnabled?.enabled ?? true);
  const sessionId =
    typeof optionsOrEnabled === 'object'
      ? optionsOrEnabled.sessionId
      : undefined;
  const onTasksUpdate =
    typeof optionsOrEnabled === 'object'
      ? optionsOrEnabled.onTasksUpdate
      : undefined;

  const onTasksUpdateRef = useRef(onTasksUpdate);
  onTasksUpdateRef.current = onTasksUpdate;

  const [bgTasks, setBgTasks] = useState<BackgroundTaskInfo[]>([]);

  useEffect(() => {
    // 空态白板门闩：未启用、未传递 sessionId、或处于临时草稿态时彻底休眠
    if (!enabled || !sessionId || sessionId.startsWith('__pending')) {
      setBgTasks([]);
      return;
    }
    let cancelled = false;
    const fetchTasks = async () => {
      try {
        const tasks = await listBackgroundTasks();
        if (!cancelled) {
          // 严格会话过滤：阻断全局后台任务渗透进入当前会话
          const list = (tasks || []).filter((t) => {
            return Boolean(t.sessionId && t.sessionId === sessionId);
          });
          setBgTasks(list);
          onTasksUpdateRef.current?.(list);
        }
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
  }, [enabled, sessionId]);

  return bgTasks;
}

/** 活跃后台任务过滤：与壳组件原 useMemo 逻辑一致。 */
export function filterActiveBackgroundTasks(
  tasks: BackgroundTaskInfo[]
): BackgroundTaskInfo[] {
  return tasks.filter((t) => isBackgroundTaskActive(t.state));
}
