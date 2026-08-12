/**
 * 连续性观测 UI store（D8 §3.7.4 临时通知 / §3.7.5 熔断横幅）。
 *
 * 事件 → store → 组件 展示链路（对齐 cacheEventsStore 模式，components 域外
 * 保持单一数据源）：
 * - 临时通知：provider-diagnostic（phase=retry）经 diagnosticHandlers 写入，
 *   老虎机滚动（attempt/maxAttempts 取事件载荷）；重连成功/失败清除。
 * - 熔断横幅：runtime-intervention-required / recovery-escalated
 *   （detail=circuit-trip）经 continuityHandlers 写入，可手动关闭。
 *
 * 数据面纪律：
 * - 不进对话历史、不进 LLM 上下文（用户约束 A/C：仅事件流 + 临时通知双面）；
 * - 会话级键控（sessionId → 状态），非持久化（过程性 UI 态不落盘）；
 * - null = 无状态（空态隐藏，防幽灵条）。
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

/** 熔断横幅状态（sessionId 级，单槽） */
export interface CircuitBanner {
  /** 横幅文案（固定「熔断已触发…」，预留来源 reason 供 detail 展示） */
  message: string;
  /** 触发来源（runtime-intervention-required reason / recovery-escalated detail） */
  reason?: string;
  /** 用户手动关闭标记（dismiss 后不重弹，新触发覆盖） */
  dismissed: boolean;
  /** 触发时间（epoch ms） */
  at: number;
}

interface ContinuityUiState {
  /** sessionId → 临时通知（null/缺键 = 无重连进行中） */
  retryNotices: Record<string, RetryNotice>;
  /** sessionId → 熔断横幅（null/缺键 = 无熔断态） */
  circuitBanners: Record<string, CircuitBanner>;

  /** provider-diagnostic phase=retry 到达：投影临时通知（attempt 递增滚动） */
  applyRetryNotice: (
    sessionId: string,
    attempt: number,
    maxAttempts?: number
  ) => void;
  /** 重连成功/失败（终态）→ 清除临时通知（不留残余滚动态） */
  clearRetryNotice: (sessionId: string) => void;
  /** 熔断触发 → 展示横幅（同 session 已有已关闭横幅时，新触发覆盖） */
  raiseCircuitBanner: (
    sessionId: string,
    message: string,
    reason?: string
  ) => void;
  /** 用户手动关闭熔断横幅 */
  dismissCircuitBanner: (sessionId: string) => void;
}

/** 熔断横幅默认文案（D8 §3.7.1：熔断已触发，需人工介入） */
export const CIRCUIT_BANNER_DEFAULT_MESSAGE =
  'Provider 连续失败，自动恢复已暂停，需人工介入';

/** 熔断触发 detail 判定：recovery-escalated.detail === 'circuit-trip' */
export function isCircuitTripDetail(
  detail: string | undefined | null
): boolean {
  return String(detail ?? '').trim() === 'circuit-trip';
}

export const useContinuityUiStore = create<ContinuityUiState>()((set) => ({
  retryNotices: {},
  circuitBanners: {},

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

  raiseCircuitBanner: (sessionId, message, reason) => {
    if (!sessionId) return;
    set((s) => ({
      circuitBanners: {
        ...s.circuitBanners,
        [sessionId]: {
          message: String(message || CIRCUIT_BANNER_DEFAULT_MESSAGE),
          ...(reason ? { reason } : {}),
          dismissed: false,
          at: Date.now(),
        },
      },
    }));
  },

  dismissCircuitBanner: (sessionId) => {
    if (!sessionId) return;
    set((s) => {
      const cur = s.circuitBanners[sessionId];
      if (!cur || cur.dismissed) return s;
      return {
        circuitBanners: {
          ...s.circuitBanners,
          [sessionId]: { ...cur, dismissed: true },
        },
      };
    });
  },
}));

/** 测试用：复位 store（防跨用例泄漏） */
export function resetContinuityUiStoreForTests(): void {
  useContinuityUiStore.setState({ retryNotices: {}, circuitBanners: {} });
}
