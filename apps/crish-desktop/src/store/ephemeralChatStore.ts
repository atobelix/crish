/**
 * ephemeralChatStore.ts — 瞬态进行时会话状态管理 (Volatile Ephemeral Status Store)
 * 
 * 核心契约：
 * 1. 内存独占，零持久化（不写入 SQLite、不写入 LocalStorage、不进入快照与导出）；
 * 2. 真实 AI 对话流纯洁性：主对话只保留真实 AI 输出，错误/离线/提示以灰色进行时形态挂在流底部；
 * 3. 四大原子自愈：发送新消息、点击重试、新 Token 到达、网络重连时立即原子清空；
 * 4. 单例去重：同一会话严格单例覆盖，绝不允许向下堆叠多个重复卡片。
 */

import { create } from 'zustand';

export type EphemeralErrorKind =
  | 'network'       // 网络中断 / DNS 解析失败 / 连接重置
  | 'rate_limit'    // 429 频率超限
  | 'auth'          // 401 / Key 失效
  | 'quota'         // 额度耗尽
  | 'context_length'// 上下文超限
  | 'server_error'  // 5xx 服务端故障
  | 'stream_abort'  // 异常非正常中断
  | 'generic';      // 通用运行错误

export interface InFlowRetryState {
  attempt: number;
  maxAttempts: number;
  nextRetryTimestamp: number;
  backoffMs: number;
  reasonText: string;
  rawDiagnostic?: unknown;
}

export interface EphemeralChatStatus {
  id: string;                      // 唯一指纹 ID
  sessionId: string;               // 绑定的会话 ID
  messageId?: string;              // 绑定的助手消息 ID（流内精准定位）
  kind: EphemeralErrorKind;        // 错误语义分类
  message: string;                 // 用户可读的简洁提示文案
  technicalDetail?: string;        // 详细技术信息（供排查）
  retryable: boolean;              // 是否可直接重试
  timestamp: number;               // 发生时刻（epoch ms）
  retryState?: InFlowRetryState;   // 若当前正处于重试退避中，挂载该对象
  retryContext?: {
    userMsgId?: string;
    promptText?: string;
  };
}

export interface EphemeralChatState {
  /** sessionId -> 当前会话的唯一瞬态状态（null 表示干净态） */
  statusBySession: Record<string, EphemeralChatStatus | null>;

  /** 设置/覆盖指定会话的瞬态状态（严格单例，新错误直接覆盖旧错误） */
  setEphemeralStatus: (
    sessionId: string,
    status: Omit<EphemeralChatStatus, 'sessionId'>
  ) => void;

  /** 更新重试退避进度 */
  updateRetryProgress: (
    sessionId: string,
    retry: InFlowRetryState
  ) => void;

  /** 清空指定会话的瞬态状态（自愈动作） */
  clearEphemeralStatus: (sessionId: string) => void;

  /** 清空所有会话（应用重置或测试） */
  clearAll: () => void;
}

export const useEphemeralChatStore = create<EphemeralChatState>()((set) => ({
  statusBySession: {},

  setEphemeralStatus: (sessionId, status) => {
    if (!sessionId) return;
    set((state) => ({
      statusBySession: {
        ...state.statusBySession,
        [sessionId]: {
          ...status,
          sessionId,
        },
      },
    }));
  },

  updateRetryProgress: (sessionId, retry) => {
    if (!sessionId) return;
    set((state) => {
      const current = state.statusBySession[sessionId];
      const base: EphemeralChatStatus = current || {
        id: `retry-${sessionId}-${Date.now()}`,
        sessionId,
        kind: 'rate_limit',
        message: retry.reasonText || '正在自动重试...',
        retryable: true,
        timestamp: Date.now(),
      };
      return {
        statusBySession: {
          ...state.statusBySession,
          [sessionId]: {
            ...base,
            retryState: retry,
          },
        },
      };
    });
  },

  clearEphemeralStatus: (sessionId) => {
    if (!sessionId) return;
    set((state) => {
      if (!state.statusBySession[sessionId]) return state;
      const next = { ...state.statusBySession };
      delete next[sessionId];
      return { statusBySession: next };
    });
  },

  clearAll: () => set({ statusBySession: {} }),
}));
