/**
 * sessionExecutionTrackerStore — 单轨后台执行状态跟踪器
 *
 * 核心契约：
 * 1. 记录所有会话的执行生命周期（思考、工具执行、审批等待、流式生成、刚刚完成）；
 * 2. 仅在状态机阶段迁移时发射变更，严禁接入 60Hz Token 增量，避免渲染雪崩；
 * 3. 会话结束时触发 3000ms 柔和衰减窗（Graceful Decay Window），防止高度瞬变抖动与误点击；
 * 4. 纯净 Zustand 单例，支持无 React 上下文的编程式直写（.getState()）。
 */

import { create } from 'zustand';

export type SessionExecutionStage =
  | 'waiting_approval' // 高危工具等待审批（琥珀色脉冲）
  | 'busy_retrying' // 任务并发排队与重试
  | 'executing_tool' // 正在执行工具/命令
  | 'thinking' // 深度推理思考
  | 'streaming_text' // 流式文本输出
  | 'goal_waiting' // Goal 模式轮次交接
  | 'just_completed' // 执行完毕（3000ms 衰减窗内）
  | 'error'; // 执行异常

export interface SessionExecutionItem {
  sessionId: string;
  runId: string | null;
  stage: SessionExecutionStage;
  startTime: number;
  stageDetail?: string;
  approvalMeta?: {
    toolId: string;
    toolName: string;
    riskLevel?: 'high' | 'medium' | 'low';
  };
  settledAt?: number;
}

export interface SessionExecutionTrackerState {
  activeRuns: Record<string, SessionExecutionItem>;
  decayTimers: Record<string, ReturnType<typeof setTimeout>>;
  startRun: (
    sessionId: string,
    runId: string | null,
    stage?: SessionExecutionStage
  ) => void;
  updateRunId: (sessionId: string, runId: string) => void;
  updateStage: (
    sessionId: string,
    stage: SessionExecutionStage,
    detail?: string
  ) => void;
  markApprovalPending: (
    sessionId: string,
    toolId: string,
    toolName: string
  ) => void;
  resolveApproval: (sessionId: string) => void;
  completeRun: (sessionId: string) => void;
  failRun: (sessionId: string, error?: string) => void;
  removeRun: (sessionId: string) => void;
  clearAllRuns: () => void;
}

export const useSessionExecutionTrackerStore =
  create<SessionExecutionTrackerState>((set, get) => ({
    activeRuns: {},
    decayTimers: {},

    startRun: (sessionId, runId, stage = 'thinking') => {
      if (!sessionId) return;
      const existingTimer = get().decayTimers[sessionId];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      set((state) => {
        const nextTimers = { ...state.decayTimers };
        delete nextTimers[sessionId];
        return {
          activeRuns: {
            ...state.activeRuns,
            [sessionId]: {
              sessionId,
              runId,
              stage,
              startTime: Date.now(),
            },
          },
          decayTimers: nextTimers,
        };
      });
    },

    updateRunId: (sessionId, runId) => {
      const item = get().activeRuns[sessionId];
      if (!item || item.runId === runId) return;
      set((state) => ({
        activeRuns: {
          ...state.activeRuns,
          [sessionId]: {
            ...item,
            runId,
          },
        },
      }));
    },

    updateStage: (sessionId, stage, detail) => {
      const item = get().activeRuns[sessionId];
      if (!item) return;
      if (item.stage === stage && item.stageDetail === detail) return;

      set((state) => ({
        activeRuns: {
          ...state.activeRuns,
          [sessionId]: {
            ...item,
            stage,
            stageDetail: detail ?? item.stageDetail,
          },
        },
      }));
    },

    markApprovalPending: (sessionId, toolId, toolName) => {
      const item = get().activeRuns[sessionId];
      if (!item) return;
      set((state) => ({
        activeRuns: {
          ...state.activeRuns,
          [sessionId]: {
            ...item,
            stage: 'waiting_approval',
            approvalMeta: { toolId, toolName },
          },
        },
      }));
    },

    resolveApproval: (sessionId) => {
      const item = get().activeRuns[sessionId];
      if (!item) return;
      set((state) => ({
        activeRuns: {
          ...state.activeRuns,
          [sessionId]: {
            ...item,
            stage: 'executing_tool',
            approvalMeta: undefined,
          },
        },
      }));
    },

    completeRun: (sessionId) => {
      const item = get().activeRuns[sessionId];
      if (!item) return;

      const existingTimer = get().decayTimers[sessionId];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        get().removeRun(sessionId);
      }, 3000);

      set((state) => ({
        activeRuns: {
          ...state.activeRuns,
          [sessionId]: {
            ...item,
            stage: 'just_completed',
            stageDetail: 'done',
            settledAt: Date.now(),
          },
        },
        decayTimers: {
          ...state.decayTimers,
          [sessionId]: timer,
        },
      }));
    },

    failRun: (sessionId, error) => {
      const item = get().activeRuns[sessionId];
      if (!item) return;

      const existingTimer = get().decayTimers[sessionId];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        get().removeRun(sessionId);
      }, 3000);

      set((state) => ({
        activeRuns: {
          ...state.activeRuns,
          [sessionId]: {
            ...item,
            stage: 'error',
            stageDetail: error || 'failed',
            settledAt: Date.now(),
          },
        },
        decayTimers: {
          ...state.decayTimers,
          [sessionId]: timer,
        },
      }));
    },

    removeRun: (sessionId) => {
      const timer = get().decayTimers[sessionId];
      if (timer) {
        clearTimeout(timer);
      }

      set((state) => {
        const nextRuns = { ...state.activeRuns };
        const nextTimers = { ...state.decayTimers };
        delete nextRuns[sessionId];
        delete nextTimers[sessionId];
        return {
          activeRuns: nextRuns,
          decayTimers: nextTimers,
        };
      });
    },

    clearAllRuns: () => {
      const timers = get().decayTimers;
      for (const t of Object.values(timers)) {
        if (t) clearTimeout(t);
      }
      set({
        activeRuns: {},
        decayTimers: {},
      });
    },
  }));
