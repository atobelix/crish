/**
 * 后台任务展示源：从 ChatStatusRibbons 壳组件抽出。
 *
 * D6.1 / CFL-10：**单源轮询**——不再独立 setInterval，改读 `useEngineState`
 * 的 `bgTasks`（4s 轮询 + 数据面事件刷新），消除与 03-V2 双轮询重复 IPC。
 */
import type { BackgroundTaskInfo } from '../../api/backgroundTasksApi';
import { useEngineState } from '../../hooks/useEngineState';

export interface UseBackgroundTaskPollingOptions {
  sessionId?: string;
  enabled?: boolean;
  onTasksUpdate?: (tasks: BackgroundTaskInfo[]) => void;
}

/**
 * 返回会话过滤后的后台任务列表（数据来自 useEngineState 单源）。
 * 当 enabled === false 或草稿态时返回空数组，不额外拉 IPC。
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

  const engine = useEngineState();

  if (!enabled || !sessionId || sessionId.startsWith('__pending')) {
    return [];
  }
  return engine.bgTasks.filter((t: BackgroundTaskInfo) => {
    return Boolean(t.sessionId && t.sessionId === sessionId);
  });
}

/** 活跃后台任务过滤：与壳组件原 useMemo 逻辑一致。 */
export function filterActiveBackgroundTasks(
  tasks: readonly BackgroundTaskInfo[]
): BackgroundTaskInfo[] {
  return tasks.filter((t: BackgroundTaskInfo) => {
    if (!t) return false;
    const raw = t as unknown as Record<string, unknown>;
    const status = String(raw.status ?? '').toLowerCase();
    return status === 'running' || status === 'pending' || status === 'queued';
  });
}
