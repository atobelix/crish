// sessionStore（M5 §3.1.1 领域层 store）：vanilla createStore + immer，零 React 依赖
// 纯逻辑在 sessionReducers.ts（jest 直测），本文件只做一行转发 + 状态装配（M5 §3.1 reducers 纪律）
// 入站接口：upsert（session.updated 会话面消息）/ applyRunActive（agent-start/run-terminal 事件）
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { SessionIndexEntry } from '@crish/shared-types';
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
  /**
   * 数据面属主设备盖章（M7 设备分区）：接线建立时由 runtime 按当前目标
   * 盖章；带 sourceDeviceId 的入站写入与盖章不符 → 直接丢弃（见
   * sourceAllowed），把「不同设备绝不串」从清场编排约定升级为数据
   * 不变量。null = 未盖章（本地/测试形态，写入不设防）。
   */
  ownerDeviceId: string | null;
  /** 盖章不符被丢弃的写入计数（M7 诊断面：>0 说明有跨设备写入被拦下） */
  droppedWriteCount: number;

  /** session.updated 会话面消息 upsert（幂等：本地附加保留不重置） */
  upsert: (
    session: SessionIndexEntry,
    nowMs?: number,
    sourceDeviceId?: string
  ) => void;
  /** session.removed 移除（未读游标随条目清理，F5 §6.3） */
  remove: (sessionId: string, sourceDeviceId?: string) => void;
  /**
   * 全量对账（连接建立校准 / session.updatedAll 信号后重拉 / 下拉刷新）：
   * 权威列表为准，本地附加按 id 合并。返回 true = 真实差分已落地；
   * false = 无差分（状态零写入）或盖章丢弃——增量静默口径的数据面。
   */
  reconcile: (
    list: SessionIndexEntry[],
    nowMs?: number,
    sourceDeviceId?: string
  ) => boolean;
  /** 选中切换（F5 §2.1 点击进入；null 清空选中） */
  setSelected: (sessionId: string | null) => void;
  /** 已读（F5 §6.3：详情打开滚动到底 → 未读清零；sequence 只升不降） */
  markRead: (sessionId: string, sequence: number) => void;
  /** 未读重算（message-end 事件驱动：latestIsAssistant = 最新消息为助手消息，F5 §6.3 判定） */
  applyLatestSeq: (
    sessionId: string,
    latestSeq: number,
    latestIsAssistant?: boolean,
    sourceDeviceId?: string
  ) => void;
  /** 活动 run 标记（agent-start 置活跃 / run-terminal 清除，F1 §4.4 置顶数据面） */
  applyRunActive: (
    sessionId: string,
    runId: string,
    active: boolean,
    sourceDeviceId?: string
  ) => void;
  /**
   * run 终结（run-terminal 专用）：清活动标记 + 完成打点，并按
   * terminal 三态维护失败打点（批 D：抽屉行失败态的数据面）。
   */
  applyRunTerminal: (
    sessionId: string,
    runId: string,
    terminal: string,
    sourceDeviceId?: string
  ) => void;
  /** 待审批计数（approval-requested +1 / resolved −1；钳制 ≥0，F1 §5.3） */
  applyApprovalDelta: (
    sessionId: string,
    delta: 1 | -1,
    sourceDeviceId?: string
  ) => void;
  /** 属主盖章（runtime 接线建立/切换时调用；只改章，不动数据） */
  stampOwner: (deviceId: string | null) => void;
  /**
   * 快照恢复（CON-3）：同设备分区快照整表装入 live（remoteData 编排
   * 专用，装入后由编排方盖章 + 打陈旧标记；对账成功后被权威列表替换）。
   */
  restoreSnapshotData: (
    sessions: SessionSummary[],
    selectedSessionId: string | null
  ) => void;
  /** 解绑 / 换机：清空会话索引（连带清盖章与丢弃计数） */
  reset: () => void;
}

/**
 * M7 写入来源校验：无来源（本地 UI 动作/未穿线调用）或未盖章 → 放行；
 * 来源与盖章不符 → 丢弃。防的是「旧接线的在途异步写入在设备切换后
 * 落进新设备数据面」这类绕过清场编排的串列路径（会话审计 §四.2）。
 */
export function sourceAllowed(
  ownerDeviceId: string | null,
  sourceDeviceId?: string
): boolean {
  return (
    sourceDeviceId === undefined ||
    ownerDeviceId === null ||
    sourceDeviceId === ownerDeviceId
  );
}

function nowDefault(): number {
  return Date.now();
}

// 显式 StoreApi 标注：immer 中间件组合链的推断类型引用外部模块 draft 类型，
// 无法在导出声明中命名（TS4023/TS2883），公共面以 StoreApi<SessionState> 收敛（approvalStore 同款）
export const sessionStore: StoreApi<SessionState> = createStore<SessionState>()(
  immer((set, get) => ({
    sessions: [],
    selectedSessionId: null,
    ownerDeviceId: null,
    droppedWriteCount: 0,

    upsert: (session, nowMs = nowDefault(), sourceDeviceId) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        const result = upsertSessionItem(s.sessions, session, nowMs);
        s.sessions = result.items;
      }),

    remove: (sessionId, sourceDeviceId) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        const result = removeSessionItem(s.sessions, sessionId);
        s.sessions = result.items;
        if (s.selectedSessionId === sessionId) {
          s.selectedSessionId = null;
        }
      }),

    reconcile: (list, nowMs = nowDefault(), sourceDeviceId) => {
      const state = get();
      if (!sourceAllowed(state.ownerDeviceId, sourceDeviceId)) {
        set((s) => {
          s.droppedWriteCount += 1;
        });
        return false;
      }
      const result = reconcileSessions(state.sessions, list, nowMs);
      // 无差分 → 零写入（同一数组引用、零订阅通知）：静默同步的数据面保证
      if (!result.changed) return false;
      set((s) => {
        s.sessions = result.items;
        if (
          s.selectedSessionId !== null &&
          !result.items.some((x) => x.id === s.selectedSessionId)
        ) {
          s.selectedSessionId = null;
        }
      });
      return true;
    },

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

    applyLatestSeq: (
      sessionId,
      latestSeq,
      latestIsAssistant = false,
      sourceDeviceId
    ) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        const index = s.sessions.findIndex((x) => x.id === sessionId);
        if (index < 0) return;
        s.sessions[index] = applyLatestSeq(
          s.sessions[index]!,
          latestSeq,
          latestIsAssistant
        );
      }),

    applyRunActive: (sessionId, runId, active, sourceDeviceId) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        const index = s.sessions.findIndex((x) => x.id === sessionId);
        if (index < 0) return;
        const current = s.sessions[index]!;
        // nowMs 穿线：run-terminal 落地打完成点（状态板「连后完成」资格面）
        const next = applyRunActive(current, runId, active, Date.now());
        if (next !== current) {
          s.sessions[index] = next;
          // 活跃性变化影响置顶排序（F1 §4.4）
          s.sessions = sortSessions(s.sessions);
        }
      }),

    applyRunTerminal: (sessionId, runId, terminal, sourceDeviceId) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
        const index = s.sessions.findIndex((x) => x.id === sessionId);
        if (index < 0) return;
        const current = s.sessions[index]!;
        const next = applyRunActive(
          current,
          runId,
          false,
          Date.now(),
          terminal
        );
        if (next !== current) {
          s.sessions[index] = next;
          s.sessions = sortSessions(s.sessions);
        }
      }),

    applyApprovalDelta: (sessionId, delta, sourceDeviceId) =>
      set((s) => {
        if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
          s.droppedWriteCount += 1;
          return;
        }
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

    stampOwner: (deviceId) =>
      set((s) => {
        s.ownerDeviceId = deviceId;
      }),

    restoreSnapshotData: (sessions, selectedSessionId) =>
      set((s) => {
        s.sessions = sessions;
        s.selectedSessionId =
          selectedSessionId !== null &&
          sessions.some((x) => x.id === selectedSessionId)
            ? selectedSessionId
            : null;
      }),

    reset: () =>
      set((s) => {
        s.sessions = [];
        s.selectedSessionId = null;
        s.ownerDeviceId = null;
        s.droppedWriteCount = 0;
      }),
  }))
);

/** 选中会话选择器（未选中返回 null） */
export function selectedSessionOf(): SessionSummary | null {
  const state = sessionStore.getState();
  if (state.selectedSessionId === null) return null;
  return state.sessions.find((s) => s.id === state.selectedSessionId) ?? null;
}
