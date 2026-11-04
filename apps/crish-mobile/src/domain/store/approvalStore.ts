// approvalStore（M5 §3.1 领域层 store）：vanilla createStore + immer，零 React 依赖
// 纯逻辑在 approvalReducers.ts（jest 直测），本文件只做一行转发 + 状态装配（M5 §3.1 reducers 纪律）
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type { ApprovalItem, ApprovalRecord } from '../types/domain';
import type { OutboxItem } from '../data/outbox';
import type { ApprovalDecision } from '@crish/shared-types';
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
import { sourceAllowed } from './sessionStore';

export interface ApprovalState {
  /** 待批队列（已按主键剩余时间升序 + 次键排序，F2 §4.2 / A2 裁决） */
  pending: ApprovalItem[];
  /** toolCallId → 提交中（F2 §9.3-3 / R2UX-04-03 防双点状态位，M5 §3.1） */
  decisionBusy: Record<string, boolean>;
  /** outbox 待发送数（角标，M5 §3.1；由 repository 接线时经 setOutboxCount 更新） */
  outboxCount: number;
  /**
   * outbox 条目镜像（批 C 未送达行规格化）：真源在 approvalWiring 的
   * 模块级 outboxState，接线层在每次变更的同步漏斗里整表镜像进来，
   * 供未送达行投影（domain/pure/undelivered）消费；本 store 不写它。
   * （类型不带 readonly：immer draft 赋值口径与 pending 同形，镜像
   * 数组由接线层每次新建快照，消费方只读。）
   */
  outboxItems: OutboxItem[];
  /**
   * outbox 持久化故障面（收口批）：落盘/水合失败或 DB 装配失败降级内存态时
   * 由接线层置入用户可见信息，下一次真落盘成功即清；null = 持久化健康。
   * 此前失败仅有日志出口，用户无从知晓离线决策可能丢失（静默丢弃）。
   */
  outboxPersistError: string | null;
  /** 上次对账时间（F2 §4.1） */
  lastReconcileAt: number | null;
  /** 决策后审计回执记录（F2 §7 历史；保留最近 APPROVAL_HISTORY_MAX 条） */
  history: ApprovalRecord[];
  /**
   * 数据面属主设备盖章（M7 设备分区，与 sessionStore 同口径）：接线帧/
   * 对账驱动的写入（upsertPending / removePending / handleResolved）带
   * sourceDeviceId 且与盖章不符 → 直接丢弃（sourceAllowed）。决策流
   * 动作（beginDecision 等）源于本地用户对本地条目的操作，不设防。
   * null = 未盖章（不设防）。
   */
  ownerDeviceId: string | null;
  /** 盖章不符被丢弃的写入计数（M7 诊断面） */
  droppedWriteCount: number;

  /** 事件流入 upsert：幂等（同 toolCallId 覆盖/终态忽略，F2 §11.2 / E2E-10） */
  upsertPending: (item: ApprovalItem, sourceDeviceId?: string) => void;
  /** 移除待办（对账确认/主动清理；清 decisionBusy） */
  removePending: (toolCallId: string, sourceDeviceId?: string) => void;
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
    nowMs?: number,
    sourceDeviceId?: string
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
  /** outbox 条目镜像写入（接线层同步漏斗专用） */
  setOutboxItems: (items: readonly OutboxItem[]) => void;
  /** outbox 持久化故障面写入（接线层专用；同值重复写不触发状态变更） */
  setOutboxPersistError: (message: string | null) => void;
  /** 对账时间戳（F2 §4.1） */
  setLastReconcileAt: (ts: number) => void;
  /** 属主盖章（runtime 接线建立/切换时调用；只改章，不动数据） */
  stampOwner: (deviceId: string | null) => void;
  /**
   * 快照恢复（CON-3）：同设备分区快照的审批面整表装入 live
   * （remoteData 编排专用，装入后由编排方盖章 + 打陈旧标记）。
   */
  restoreSnapshotData: (data: {
    pending: ApprovalItem[];
    decisionBusy: Record<string, boolean>;
    history: ApprovalRecord[];
    lastReconcileAt: number | null;
    outboxCount: number;
  }) => void;
  /** 解绑 / 换机：清空待办、历史与 outbox 状态（连带清盖章与丢弃计数） */
  reset: () => void;
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
      outboxItems: [],
      outboxPersistError: null,
      lastReconcileAt: null,
      history: [],
      ownerDeviceId: null,
      droppedWriteCount: 0,

      upsertPending: (item, sourceDeviceId) =>
        set((s) => {
          if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
            s.droppedWriteCount += 1;
            return;
          }
          const result = upsertPendingItem(s.pending, item);
          s.pending = result.items;
          if (result.changed && item.decisionBusy) {
            s.decisionBusy[item.request.toolCallId] = true;
          }
        }),

      removePending: (toolCallId, sourceDeviceId) =>
        set((s) => {
          if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
            s.droppedWriteCount += 1;
            return;
          }
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

      handleResolved: (
        toolCallId,
        decision,
        nowMs = nowDefault(),
        sourceDeviceId
      ) =>
        set((s) => {
          if (!sourceAllowed(s.ownerDeviceId, sourceDeviceId)) {
            s.droppedWriteCount += 1;
            return;
          }
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

      setOutboxItems: (items) =>
        set((s) => {
          // 镜像数组在 store 内独立持有（接线层入参为只读快照）
          s.outboxItems = [...items];
        }),

      setOutboxPersistError: (message) => {
        if (get().outboxPersistError === message) return;
        set((s) => {
          s.outboxPersistError = message;
        });
      },

      setLastReconcileAt: (ts) =>
        set((s) => {
          s.lastReconcileAt = ts;
        }),

      stampOwner: (deviceId) =>
        set((s) => {
          s.ownerDeviceId = deviceId;
        }),

      restoreSnapshotData: (data) =>
        set((s) => {
          s.pending = data.pending;
          s.decisionBusy = data.decisionBusy;
          s.history = data.history;
          s.lastReconcileAt = data.lastReconcileAt;
          s.outboxCount = data.outboxCount;
        }),

      reset: () =>
        set((s) => {
          s.pending = [];
          s.decisionBusy = {};
          s.outboxCount = 0;
          s.outboxItems = [];
          s.outboxPersistError = null;
          s.lastReconcileAt = null;
          s.history = [];
          s.ownerDeviceId = null;
          s.droppedWriteCount = 0;
        }),
    }))
  );
