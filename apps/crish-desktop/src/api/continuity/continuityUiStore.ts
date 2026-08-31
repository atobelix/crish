/**
 * 连续性观测 UI store（D8 §3.7.4 临时通知）。
 *
 * 事件 → store → 组件 展示链路（对齐 cacheEventsStore 模式，components 域外
 * 保持单一数据源）：
 * - 临时通知：provider-diagnostic（phase=retry）经 diagnosticHandlers 写入，
 *   老虎机滚动（attempt/maxAttempts 取事件载荷）；重连成功/失败清除。
 *
 * 数据面纪律：
 * - 不进对话历史、不进 LLM 上下文（用户约束 A/C：仅事件流 + 临时通知双面）；
 * - 会话级键控（sessionId → 状态），非持久化（过程性 UI 态不落盘）；
 * - null = 无状态（空态隐藏，防幽灵条）。
 * - 遵守 ANTI_OVERENGINEERING_GUARDRAILS 禁令 9：彻底移除全局滑动窗口断路器（CircuitBreaker / CircuitBanner）。
 */
import { create } from 'zustand';

/** 临时通知（老虎机滚动重连）状态 */
export interface RetryNotice {
  /** 当前重试序号（1 起，事件载荷 attempt） */
  attempt: number;
  /** 重试上限（事件载荷 maxAttempts；未下发为 undefined） */
  maxAttempts?: number;
  /** 最近一次事件到达时间（epoch ms） */
  updatedAt: number;
}

interface ContinuityUiState {
  /** sessionId → 临时通知（null/缺键 = 无重连进行中） */
  retryNotices: Record<string, RetryNotice>;

  /** provider-diagnostic phase=retry 到达：投影临时通知（attempt 递增滚动） */
  applyRetryNotice: (
    sessionId: string,
    attempt: number,
    maxAttempts?: number
  ) => void;
  /** 重连成功/失败（终态）→ 清除临时通知（不留残余滚动态） */
  clearRetryNotice: (sessionId: string) => void;
}

export const useContinuityUiStore = create<ContinuityUiState>()((set) => ({
  retryNotices: {},

  applyRetryNotice: (sessionId, attempt, maxAttempts) => {
    if (!sessionId) return;
    set((s) => ({
      retryNotices: {
        ...s.retryNotices,
        [sessionId]: {
          attempt: Math.max(0, Math.floor(attempt)),
          ...(maxAttempts !== undefined && maxAttempts > 0
            ? { maxAttempts: Math.floor(maxAttempts) }
            : {}),
          updatedAt: Date.now(),
        },
      },
    }));
  },

  clearRetryNotice: (sessionId) => {
    if (!sessionId) return;
    set((s) => {
      if (!s.retryNotices[sessionId]) return s;
      const next = { ...s.retryNotices };
      delete next[sessionId];
      return { retryNotices: next };
    });
  },
}));

/** 测试用：复位 store（防跨用例泄漏） */
export function resetContinuityUiStoreForTests(): void {
  useContinuityUiStore.setState({ retryNotices: {} });
}
