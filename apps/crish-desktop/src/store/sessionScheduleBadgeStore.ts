/**
 * sessionScheduleBadgeStore.ts — 会话级定时任务徽标细粒度状态存储（INT-06 原子 Selector 隔离）
 *
 * 设计来源：
 * - `docs/scheduled-tasks-revamp/plans/03-阶段三-目标会话绑定与对话内自动化定时任务能力最终方案.md` §5.3 (INT-06)
 * - `docs/scheduled-tasks-revamp/plans/05-阶段五-前端UI交互表单能力与状态同步最终方案.md` §1.2 / §3
 *
 * 核心铁律：
 * 1. 维护 `bySessionId: Record<string, WorkflowDef[]>` 映射；
 * 2. 当工作流列表加载或变更时，经 `syncFromWorkflows(workflows)` 增量比对更新：
 *    仅当指定 `sessionId` 绑定的定时任务列表发生实质变化时才替换该会话的数组引用，
 *    未受影响会话保持原数组引用不变，全局无实质变化时不触发 store 更新；
 * 3. 提供原子级 Hook `useSessionSchedules` 与 `useSessionActiveScheduleCount`，
 *    确保单个定时任务变更仅触发其绑定会话行的局部重绘，杜绝侧栏百条会话全量重渲染。
 */

import { useCallback } from 'react';
import { create } from 'zustand';
import type { WorkflowDefinition } from '../api/workflowApi';

export type WorkflowDef = WorkflowDefinition & {
  targetSessionId?: string | null;
  targetMode?: string | null;
  executionMode?: string | null;
};

/** 不可变空任务列表常量，杜绝空会话 selector 每次返回新数组引用导致重渲染 */
export const EMPTY_SESSION_SCHEDULES: readonly WorkflowDef[] = Object.freeze(
  []
);

/** 提取工作流绑定的有效会话 ID（isolated 模式或空值返回空串） */
function resolveBoundSessionId(w: WorkflowDef | null | undefined): string {
  if (!w || typeof w !== 'object') return '';
  const record = w as Record<string, unknown>;
  const rawSid = w.targetSessionId ?? record.target_session_id;
  if (typeof rawSid !== 'string') return '';
  const sid = rawSid.trim();
  if (!sid) return '';
  const lower = sid.toLowerCase();
  if (lower === 'independent' || lower === 'none') return '';

  const mode =
    w.targetMode ??
    record.target_mode ??
    w.executionMode ??
    record.execution_mode;
  if (mode === 'isolated' || mode === 'isolated_session') {
    return '';
  }
  return sid;
}

/** 比较两个调度对象是否实质相等 */
function isScheduleEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const sa = a as Record<string, unknown>;
  const sb = b as Record<string, unknown>;
  return (
    sa.type === sb.type &&
    (sa.time ?? '') === (sb.time ?? '') &&
    (sa.timezone ?? '') === (sb.timezone ?? '') &&
    (sa.intervalMinutes ?? null) === (sb.intervalMinutes ?? null) &&
    (sa.expression ?? '') === (sb.expression ?? '') &&
    (sa.cronExpression ?? '') === (sb.cronExpression ?? '')
  );
}

/** 比较两个工作流条目是否实质相等（决定是否替换单会话数组引用） */
function isWorkflowDefEqual(a: WorkflowDef, b: WorkflowDef): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.prompt === b.prompt &&
    (a.enabled !== false) === (b.enabled !== false) &&
    (a.cwd ?? '') === (b.cwd ?? '') &&
    resolveBoundSessionId(a) === resolveBoundSessionId(b) &&
    (a.nextRunAt ?? '') === (b.nextRunAt ?? '') &&
    (a.lastRunAt ?? '') === (b.lastRunAt ?? '') &&
    (a.updatedAt ?? '') === (b.updatedAt ?? '') &&
    isScheduleEqual(a.schedule, b.schedule)
  );
}

/** 比较同一会话下的工作流数组是否发生实质变化 */
export function areSessionWorkflowListsEqual(
  prev: readonly WorkflowDef[] | undefined,
  next: readonly WorkflowDef[] | undefined
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!isWorkflowDefEqual(prev[i]!, next[i]!)) {
      return false;
    }
  }
  return true;
}

export interface SessionScheduleBadgeStoreState {
  /** sessionId -> 绑定至该会话的定时任务列表（仅含存在有效 targetSessionId 的任务） */
  bySessionId: Record<string, WorkflowDef[]>;
  /** 从最新全量工作流列表同步更新映射（按会话级实质变化保留引用） */
  syncFromWorkflows: (workflows: WorkflowDef[]) => void;
  /** 清空全部映射（供登出或测试重置使用） */
  clear: () => void;
}

export const useSessionScheduleBadgeStore =
  create<SessionScheduleBadgeStoreState>()((set) => ({
    bySessionId: {},

    syncFromWorkflows: (workflows) => {
      const grouped: Record<string, WorkflowDef[]> = {};
      if (Array.isArray(workflows)) {
        for (const wf of workflows) {
          const sid = resolveBoundSessionId(wf);
          if (!sid) continue;
          if (!grouped[sid]) {
            grouped[sid] = [];
          }
          grouped[sid].push(wf);
        }
      }

      set((state) => {
        const prevMap = state.bySessionId;
        const prevKeys = Object.keys(prevMap);
        const nextKeys = Object.keys(grouped);

        let anyChanged = prevKeys.length !== nextKeys.length;
        const nextMap: Record<string, WorkflowDef[]> = {};

        for (const sid of nextKeys) {
          const prevList = prevMap[sid];
          const candidateList = grouped[sid]!;
          if (
            prevList &&
            areSessionWorkflowListsEqual(prevList, candidateList)
          ) {
            // 未发生实质变化：复用旧数组引用，保障订阅该会话的组件 0 重绘
            nextMap[sid] = prevList;
          } else {
            nextMap[sid] = candidateList;
            anyChanged = true;
          }
        }

        if (!anyChanged) {
          for (const sid of prevKeys) {
            if (!(sid in nextMap)) {
              anyChanged = true;
              break;
            }
          }
        }

        return anyChanged ? { bySessionId: nextMap } : state;
      });
    },

    clear: () =>
      set((state) =>
        Object.keys(state.bySessionId).length === 0
          ? state
          : { bySessionId: {} }
      ),
  }));

/**
 * 命令式同步入口：当工作流列表加载或变更时调用，自动按会话粒度比对更新
 */
export function syncFromWorkflows(workflows: WorkflowDef[]): void {
  useSessionScheduleBadgeStore.getState().syncFromWorkflows(workflows);
}

/**
 * 原子级 Hook：订阅指定会话绑定的全部定时任务列表
 * 仅当该 `sessionId` 绑定的任务列表发生实质变化时触发当前组件重渲染。
 */
export function useSessionSchedules(
  sessionId: string | null | undefined
): WorkflowDef[] {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  const selector = useCallback(
    (state: SessionScheduleBadgeStoreState): WorkflowDef[] => {
      if (!sid) return EMPTY_SESSION_SCHEDULES as WorkflowDef[];
      return (
        state.bySessionId[sid] ?? (EMPTY_SESSION_SCHEDULES as WorkflowDef[])
      );
    },
    [sid]
  );
  return useSessionScheduleBadgeStore(selector);
}

/**
 * 原子级 Hook：订阅指定会话绑定的已启用（active）定时任务数量
 * 返回基础数值类型，仅当该会话的活跃定时任务计数变化时触发重渲染。
 */
export function useSessionActiveScheduleCount(
  sessionId: string | null | undefined
): number {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  const selector = useCallback(
    (state: SessionScheduleBadgeStoreState): number => {
      if (!sid) return 0;
      const list = state.bySessionId[sid];
      if (!list || list.length === 0) return 0;
      let activeCount = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i]?.enabled !== false) {
          activeCount++;
        }
      }
      return activeCount;
    },
    [sid]
  );
  return useSessionScheduleBadgeStore(selector);
}

/**
 * 兼容命令式单例门面（供非 Hook 上下文或命令式订阅调用，底层同源指向 useSessionScheduleBadgeStore）
 */
export const sessionScheduleBadgeStore = {
  syncFromWorkflows,
  updateCountsFromWorkflows(workflows: WorkflowDef[]): void {
    syncFromWorkflows(workflows);
  },
  getSchedules(sessionId: string | null | undefined): WorkflowDef[] {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) return EMPTY_SESSION_SCHEDULES as WorkflowDef[];
    return (
      useSessionScheduleBadgeStore.getState().bySessionId[sid] ??
      (EMPTY_SESSION_SCHEDULES as WorkflowDef[])
    );
  },
  getCount(sessionId: string | null | undefined): number {
    const list = this.getSchedules(sessionId);
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.enabled !== false) count++;
    }
    return count;
  },
  subscribe(sessionId: string, listener: (count: number) => void): () => void {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) return () => {};
    let prevCount = this.getCount(sid);
    return useSessionScheduleBadgeStore.subscribe((state) => {
      const list = state.bySessionId[sid];
      let nextCount = 0;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          if (list[i]?.enabled !== false) nextCount++;
        }
      }
      if (nextCount !== prevCount) {
        prevCount = nextCount;
        listener(nextCount);
      }
    });
  },
  clear(): void {
    useSessionScheduleBadgeStore.getState().clear();
  },
};
