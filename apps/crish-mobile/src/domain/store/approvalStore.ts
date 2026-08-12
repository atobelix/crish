// approvalStore（M5 §3.1 领域层 store）：vanilla createStore + immer，零 React 依赖
// 纯逻辑在 approvalReducers.ts（jest 直测），本文件只做一行转发 + 状态装配（M5 §3.1 reducers 纪律）
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { ApprovalItem, ApprovalRecord } from '../types/domain';
import type { ApprovalDecision } from '../../../../../packages/shared-types/src/generated/device/types';
import {
  beginDecision,
  resolveApproval,
  failDecision,
  markConflictItem,
  expireApproval,
  dismissItem,
  appendHistory,
  upsertPendingItem,
} from './approvalReducers';

export interface ApprovalState {
  /** 待批队列（已按主键剩余时间升序 + 次键排序，F2 §4.2 / A2 裁决） */
  pending: ApprovalItem[];
  /** toolCallId → 提交中（F2 §9.3-3 / R2UX-04-03 防双点状态位，M5 §3.1） */
  decisionBusy: Record<string, boolean>;
  /** outbox 待发送数（角标，M5 §3.1；由 repository 接线时经 setOutboxCount 更新） */
  outboxCount: number;
  /** 上次对账时间（F2 §4.1） */
  lastReconcileAt: number | null;
  /** 决策后审计回执记录（F2 §7 历史；保留最近 APPROVAL_HISTORY_MAX 条） */
  history: ApprovalRecord[];

  /** 事件流入 upsert：幂等（同 toolCallId 覆盖/终态忽略，F2 §11.2 / E2E-10） */
  upsertPending: (item: ApprovalItem) => void;
  /** 移除待办（对账确认/主动清理；清 decisionBusy） */
  removePending: (toolCallId: string) => void;
  /**
   * 决策发送开始（乐观置 deciding + 发送状态机 idle→sending）：
   * 防双点 300ms（F2 §9.3-3）；返回 false 表示被防抖/状态不允许拦截。
   */
  beginDecision: (toolCallId: string, nowMs?: number) => boolean;
  /** 决策落定（命令回执 ok / approval-resolved 先到者）：移除 + 审计回执入历史 */
  markDecisionSent: (
    toolCallId: string,
    decision: 'approved' | 'denied',
    nowMs?: number
  ) => void;
  /** 决策发送失败：deciding→pending 回滚 + 发送通道 failed（F2 §11.3 网络失败分支） */
  markDecisionFailed: (toolCallId: string) => void;
  /** 冲突（NotFound / 双端并发后到者）：status → conflict（F2 §11.2） */
  markDecisionConflict: (toolCallId: string) => void;
  /** approval-resolved 事件消费（含 expired 决策，F2 §8.3 / R1）：移除 + 状态记录 */
  handleResolved: (
    toolCallId: string,
    decision: ApprovalDecision,
    nowMs?: number
  ) => void;
  /** 本地倒计时到期（F2 §8.3）：pending/deciding → expired（条目置灰保留 + 历史入档） */
  markExpired: (toolCallId: string, nowMs?: number) => void;
  /** 手动清理过期条目（F2 §4.2-4 可手动清理） */
  dismissExpired: (toolCallId: string) => void;
  /** 决策入 outbox（M5 §3.1 setQueued）：status → queued */
  markQueued: (toolCallId: string) => void;
  /** 决策 busy 位（M5 §3.1 setDeciding；条目镜像同步更新） */
  setDeciding: (toolCallId: string, busy: boolean) => void;
  /** outbox 计数（角标，M5 §3.1） */
  setOutboxCount: (n: number) => void;
  /** 对账时间戳（F2 §4.1） */
  setLastReconcileAt: (ts: number) => void;
}

function nowDefault(): number {
  return Date.now();
}

// 显式 StoreApi 标注：immer 中间件组合链的推断类型引用了外部模块 draft 类型，
// 无法在导出声明中命名（TS4023/TS2883），公共面以 StoreApi<ApprovalState> 收敛
export const approvalStore: StoreApi<ApprovalState> =
  createStore<ApprovalState>()(
    immer((set, get) => ({
      pending: [],
      decisionBusy: {},
      outboxCount: 0,
      lastReconcileAt: null,
      history: [],

      upsertPending: (item) =>
        set((s) => {
          const result = upsertPendingItem(s.pending, item);
          s.pending = result.items;
          if (result.changed && item.decisionBusy) {
            s.decisionBusy[item.request.toolCallId] = true;
          }
        }),

      removePending: (toolCallId) =>
        set((s) => {
          s.pending = s.pending.filter(
            (p) => p.request.toolCallId !== toolCallId
          );
          delete s.decisionBusy[toolCallId];
        }),

      beginDecision: (toolCallId, nowMs = nowDefault()) => {
        const { items, busy, ok } = beginDecision(
          get().pending,
          get().decisionBusy,
          toolCallId,
          nowMs
        );
        if (ok) {
          set((s) => {
            s.pending = items;
            s.decisionBusy = busy;
          });
        }
        return ok;
      },

      markDecisionSent: (toolCallId, decision, nowMs = nowDefault()) =>
        set((s) => {
          const result = resolveApproval(
            s.pending,
            toolCallId,
            decision,
            nowMs
          );
          s.pending = result.items;
          if (result.record)
            s.history = appendHistory(s.history, result.record);
          delete s.decisionBusy[toolCallId];
        }),

      markDecisionFailed: (toolCallId) =>
        set((s) => {
          const result = failDecision(s.pending, s.decisionBusy, toolCallId);
          s.pending = result.items;
          s.decisionBusy = result.busy;
        }),

      markDecisionConflict: (toolCallId) =>
        set((s) => {
          const result = markConflictItem(s.pending, toolCallId);
          s.pending = result.items;
          delete s.decisionBusy[toolCallId];
        }),

      handleResolved: (toolCallId, decision, nowMs = nowDefault()) =>
        set((s) => {
          const result = resolveApproval(
            s.pending,
            toolCallId,
            decision,
            nowMs
          );
          s.pending = result.items;
          if (result.record)
            s.history = appendHistory(s.history, result.record);
          delete s.decisionBusy[toolCallId];
        }),

      markExpired: (toolCallId, nowMs = nowDefault()) =>
        set((s) => {
          const result = expireApproval(s.pending, toolCallId, nowMs);
          s.pending = result.items;
          if (result.record)
            s.history = appendHistory(s.history, result.record);
          delete s.decisionBusy[toolCallId];
        }),

      dismissExpired: (toolCallId) =>
        set((s) => {
          const result = dismissItem(s.pending, toolCallId);
          s.pending = result.items;
          delete s.decisionBusy[toolCallId];
        }),

      markQueued: (toolCallId) =>
        set((s) => {
          const p = s.pending.find((x) => x.request.toolCallId === toolCallId);
          if (p) {
            p.status = 'queued';
            p.decisionBusy = true;
            p.decisionSentAtMs = Date.now();
          }
        }),

      setDeciding: (toolCallId, busy) =>
        set((s) => {
          s.decisionBusy[toolCallId] = busy;
          const p = s.pending.find((x) => x.request.toolCallId === toolCallId);
          if (p) p.decisionBusy = busy;
        }),

      setOutboxCount: (n) =>
        set((s) => {
          s.outboxCount = n;
        }),

      setLastReconcileAt: (ts) =>
        set((s) => {
          s.lastReconcileAt = ts;
        }),
    }))
  );
