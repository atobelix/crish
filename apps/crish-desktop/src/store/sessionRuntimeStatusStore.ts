/**
 * sessionRuntimeStatusStore.ts — 会话级运行时状态单一状态机（单轨收敛 SSOT）
 *
 * 设计来源：docs/chat-notice-convergence/00-通知与异常展示单轨收敛总方案 §2.0
 *
 * 核心契约：
 * 1. 每会话至多一个状态（sessionId → SessionRuntimeStatus；缺键即 idle），相位互斥：
 *    idle → retrying（对话流内瞬态行）→ failed（输入框上方错误条）→ idle。
 *    retrying 与 failed 是同一字段的两个相位，物理上不可能同屏双显。
 * 2. 全局唯一上报入口 reportRuntimeStatus：onRunError / onProviderDiagnostic
 *    两个事件源只能经它写入；配 scripts/check-runtime-status-ssot.mjs 门禁。
 * 3. 内存独占、零持久化（不写 SQLite / 快照 / 导出）。
 * 4. 原子自愈：新 Token 到达 / run complete / 新一轮发送 / 切换会话 / 用户关闭 →
 *    clearRuntimeStatus；transport 恢复 → clearNetworkFailedRuntimeStatuses（全会话）。
 * 5. failed 相位只携带「定位信息」（userMsgId / assistantMsgId），不缓存提问文本：
 *    重试时按 id 现查，用户改过消息也不会重发旧内容。
 */

import { create } from 'zustand';

export type RuntimeErrorKind =
  | 'network'       // 网络中断 / DNS 解析失败 / 连接重置
  | 'rate_limit'    // 429 频率超限
  | 'auth'          // 401 / Key 失效
  | 'quota'         // 额度耗尽
  | 'context_length'// 上下文超限
  | 'server_error'  // 5xx 服务端故障
  | 'stream_abort'  // 异常非正常中断
  | 'generic';      // 通用运行错误

/** 重试进行中（对话流瞬态行数据；引擎不下发倒计时，前端不臆造秒表） */
export interface RuntimeRetryInfo {
  attempt: number;
  /** 引擎未下发上限时缺省（UI 显示「第 n 次」而非伪造分母） */
  maxAttempts?: number;
  /** 引擎分类（ProviderErrorKind 字串），仅供诊断，不直接作文案 */
  errorKind?: string;
}

/** 失败轮次定位（重试按钮原位重发所需的最小信息） */
export interface FailedTurnRef {
  userMsgId: string;
  assistantMsgId: string;
}

export type SessionRuntimeStatus =
  | {
      phase: 'retrying';
      sessionId: string;
      retry: RuntimeRetryInfo;
      timestamp: number;
    }
  | {
      phase: 'failed';
      sessionId: string;
      kind: RuntimeErrorKind;
      message: string;               // 用户可读的简洁提示文案
      technicalDetail?: string;      // 详细技术信息（详情展开）
      turn: FailedTurnRef;
      timestamp: number;
    };

export type RuntimeStatusEvent =
  | {
      type: 'retrying';
      sessionId: string;
      retry: RuntimeRetryInfo;
    }
  | {
      type: 'failed';
      sessionId: string;
      kind: RuntimeErrorKind;
      message: string;
      technicalDetail?: string;
      turn: FailedTurnRef;
    };

export interface SessionRuntimeStatusState {
  /** sessionId -> 当前会话的运行时状态（缺键即 idle） */
  statusBySession: Record<string, SessionRuntimeStatus | undefined>;

  /** 全局唯一上报入口：事件驱动状态迁移（单例覆盖） */
  report: (event: RuntimeStatusEvent) => void;

  /** 清空指定会话（自愈动作：新发送 / 新 Token / complete / 切会话 / 用户关闭） */
  clear: (sessionId: string) => void;

  /** transport 恢复：清空所有会话的 network 类 failed（其余终态错误保留至用户处理） */
  clearNetworkFailed: () => void;

  /** 清空所有会话（应用重置或测试） */
  clearAll: () => void;
}

function withoutSession(
  map: Record<string, SessionRuntimeStatus | undefined>,
  sessionId: string
): Record<string, SessionRuntimeStatus | undefined> {
  const next = { ...map };
  delete next[sessionId];
  return next;
}

export const useSessionRuntimeStatusStore =
  create<SessionRuntimeStatusState>()((set) => ({
    statusBySession: {},

    report: (event) => {
      const sessionId = event.sessionId;
      if (!sessionId) return;
      const status: SessionRuntimeStatus =
        event.type === 'retrying'
          ? {
              phase: 'retrying',
              sessionId,
              retry: event.retry,
              timestamp: Date.now(),
            }
          : {
              phase: 'failed',
              sessionId,
              kind: event.kind,
              message: event.message,
              technicalDetail: event.technicalDetail,
              turn: event.turn,
              timestamp: Date.now(),
            };
      // 单例覆盖：新状态直接替换旧状态（相位互斥由类型保证）
      set((state) => ({
        statusBySession: { ...state.statusBySession, [sessionId]: status },
      }));
    },

    clear: (sessionId) => {
      if (!sessionId) return;
      set((state) => {
        if (!state.statusBySession[sessionId]) return state;
        return { statusBySession: withoutSession(state.statusBySession, sessionId) };
      });
    },

    clearNetworkFailed: () => {
      set((state) => {
        let next: Record<string, SessionRuntimeStatus | undefined> | null = null;
        for (const [sid, status] of Object.entries(state.statusBySession)) {
          if (status?.phase === 'failed' && status.kind === 'network') {
            next = withoutSession(next ?? state.statusBySession, sid);
          }
        }
        return next ? { statusBySession: next } : state;
      });
    },

    clearAll: () => set({ statusBySession: {} }),
  }));

/**
 * 全局唯一上报入口（命令式，供非 React 事件源调用）。
 * 会话运行类状态的**唯一**写入路径（见 scripts/check-runtime-status-ssot.mjs）。
 */
export function reportRuntimeStatus(event: RuntimeStatusEvent): void {
  useSessionRuntimeStatusStore.getState().report(event);
}

/** 自愈清空（命令式）：新发送 / 新 Token / complete / 切会话 / 用户关闭。 */
export function clearRuntimeStatus(sessionId: string): void {
  useSessionRuntimeStatusStore.getState().clear(sessionId);
}

/** transport 恢复：所有会话的 network 类 failed 一次性清空（含非活跃会话）。 */
export function clearNetworkFailedRuntimeStatuses(): void {
  useSessionRuntimeStatusStore.getState().clearNetworkFailed();
}
