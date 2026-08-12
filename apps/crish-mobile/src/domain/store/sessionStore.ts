// sessionStore（M5 §3.1.1 领域层 store）：vanilla createStore + immer，零 React 依赖
// 纯逻辑在 sessionReducers.ts（jest 直测），本文件只做一行转发 + 状态装配（M5 §3.1 reducers 纪律）
// 入站接口：upsert（session.updated 会话面消息）/ applyRunActive（agent-start/run-terminal 事件）
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { SessionIndexEntry } from '../../../../../packages/shared-types/src/generated/device/types';
import {
  applyApprovalDelta,
  applyLatestSeq,
  applyRunActive,
  markSessionRead,
  reconcileSessions,
  removeSessionItem,
  sortSessions,
  upsertSessionItem,
  type SessionSummary,
} from './sessionReducers';

export interface SessionState {
  /** 会话列表（保持排序不变量：pinned → 活动 → updatedAt 降序，F1 §4.4 / F5 §2.1） */
  sessions: SessionSummary[];
  /** 选中会话（F1 F05 会话列表选中态；null = 无选中） */
  selectedSessionId: string | null;

  /** session.updated 会话面消息 upsert（幂等：本地附加保留不重置） */
  upsert: (session: SessionIndexEntry, nowMs?: number) => void;
  /** session.removed 移除（未读游标随条目清理，F5 §6.3） */
  remove: (sessionId: string) => void;
  /** 全量对账（session.updatedAll 信号后重拉 / 下拉刷新）：权威列表为准，本地附加按 id 合并 */
  reconcile: (list: SessionIndexEntry[], nowMs?: number) => void;
  /** 选中切换（F5 §2.1 点击进入；null 清空选中） */
  setSelected: (sessionId: string | null) => void;
  /** 已读（F5 §6.3：详情打开滚动到底 → 未读清零；sequence 只升不降） */
  markRead: (sessionId: string, sequence: number) => void;
  /** 未读重算（message-end 事件驱动：latestIsAssistant = 最新消息为助手消息，F5 §6.3 判定） */
  applyLatestSeq: (
    sessionId: string,
    latestSeq: number,
    latestIsAssistant?: boolean
  ) => void;
  /** 活动 run 标记（agent-start 置活跃 / run-terminal 清除，F1 §4.4 置顶数据面） */
  applyRunActive: (sessionId: string, runId: string, active: boolean) => void;
  /** 待审批计数（approval-requested +1 / resolved −1；钳制 ≥0，F1 §5.3） */
  applyApprovalDelta: (sessionId: string, delta: 1 | -1) => void;
}

function nowDefault(): number {
  return Date.now();
}

// 显式 StoreApi 标注：immer 中间件组合链的推断类型引用外部模块 draft 类型，
// 无法在导出声明中命名（TS4023/TS2883），公共面以 StoreApi<SessionState> 收敛（approvalStore 同款）
export const sessionStore: StoreApi<SessionState> = createStore<SessionState>()(
  immer((set) => ({
    sessions: [],
    selectedSessionId: null,

    upsert: (session, nowMs = nowDefault()) =>
      set((s) => {
        const result = upsertSessionItem(s.sessions, session, nowMs);
        s.sessions = result.items;
      }),

    remove: (sessionId) =>
      set((s) => {
        const result = removeSessionItem(s.sessions, sessionId);
        s.sessions = result.items;
        if (s.selectedSessionId === sessionId) {
          s.selectedSessionId = null;
        }
      }),

    reconcile: (list, nowMs = nowDefault()) =>
      set((s) => {
        s.sessions = reconcileSessions(s.sessions, list, nowMs);
        if (
          s.selectedSessionId !== null &&
          !s.sessions.some((x) => x.id === s.selectedSessionId)
        ) {
          s.selectedSessionId = null;
        }
      }),

    setSelected: (sessionId) =>
      set((s) => {
        s.selectedSessionId = sessionId;
      }),

    markRead: (sessionId, sequence) =>
      set((s) => {
        const index = s.sessions.findIndex((x) => x.id === sessionId);
        if (index < 0) return;
        s.sessions[index] = markSessionRead(s.sessions[index]!, sequence);
      }),

    applyLatestSeq: (sessionId, latestSeq, latestIsAssistant = false) =>
      set((s) => {
        const index = s.sessions.findIndex((x) => x.id === sessionId);
        if (index < 0) return;
        s.sessions[index] = applyLatestSeq(
          s.sessions[index]!,
          latestSeq,
          latestIsAssistant
        );
      }),

    applyRunActive: (sessionId, runId, active) =>
      set((s) => {
        const index = s.sessions.findIndex((x) => x.id === sessionId);
        if (index < 0) return;
        const current = s.sessions[index]!;
        const next = applyRunActive(current, runId, active);
        if (next !== current) {
          s.sessions[index] = next;
          // 活跃性变化影响置顶排序（F1 §4.4）
          s.sessions = sortSessions(s.sessions);
        }
      }),

    applyApprovalDelta: (sessionId, delta) =>
      set((s) => {
        const index = s.sessions.findIndex((x) => x.id === sessionId);
        if (index < 0) return;
        const current = s.sessions[index]!;
        const next = applyApprovalDelta(current, delta);
        if (next !== current) {
          s.sessions[index] = next;
          // 待审批变化影响置顶排序（F1 §4.4）
          s.sessions = sortSessions(s.sessions);
        }
      }),
  }))
);

/** 选中会话选择器（未选中返回 null） */
export function selectedSessionOf(): SessionSummary | null {
  const state = sessionStore.getState();
  if (state.selectedSessionId === null) return null;
  return state.sessions.find((s) => s.id === state.selectedSessionId) ?? null;
}
