/**
 * 审批流状态机：集中 pending / inflight / deferredTerminal，避免桥层四布尔竞态。
 * 纯逻辑，无 DOM / store 依赖。
 *
 * 不变量 / 守卫：
 * - 空 toolId 的工具/审批事件 → illegal（不改状态）
 * - 同一 toolId 重复 pending → noop（Set 去重，防双渲染计数）
 * - resolve 未知 id（从未 pending）→ illegal
 * - resolve 已 resolve 且未再 pending → noop（double_resolve）
 * - cancel 非 pending → noop；cancel 视同 deny（清 pending + inflight）
 * - allow resolve 仅清 pending，保留 inflight（工具继续跑）
 * - deny/cancel resolve 同步摘 inflight，避免永久 shouldBlockTerminal
 * - force_finish 清 pending/inflight/deferred，保留 sawRunTerminal
 * - clear_all 全量复位（含 sawRunTerminal / resolved 履历）
 */

export type ApprovalFlowSnapshot = {
  pendingCount: number;
  inflightCount: number;
  deferredTerminal: boolean;
  sawRunTerminal: boolean;
};

export type ApprovalFlowEvent =
  | { type: 'tool_start'; toolId: string }
  | { type: 'tool_end'; toolId: string }
  | { type: 'approval_pending'; toolId: string }
  | { type: 'approval_resolved'; toolId: string; denied?: boolean }
  /** 取消待批：有 toolId 取消单个；省略则取消全部 pending（视同 deny） */
  | { type: 'approval_cancelled'; toolId?: string }
  | { type: 'run_terminal_seen' }
  | { type: 'defer_terminal' }
  | { type: 'clear_all' }
  | { type: 'force_finish' };

/** applied=状态变更；noop=幂等忽略；illegal=非法转换（状态不变） */
export type TransitionOutcome = 'applied' | 'noop' | 'illegal';

export type TransitionResult = {
  outcome: TransitionOutcome;
  /** 机器可读原因码，便于测试与日志 */
  reason: string | null;
  event: ApprovalFlowEvent['type'];
  changed: boolean;
  snapshot: ApprovalFlowSnapshot;
};

const EMPTY_TOOL_ID = 'empty_tool_id';

export class ApprovalFlowMachine {
  private pending = new Set<string>();
  private inflight = new Set<string>();
  /** 已 resolve/cancel 的 toolId（再 pending 前拦截 double-resolve） */
  private resolved = new Set<string>();
  private deferredTerminal = false;
  private sawRunTerminal = false;
  private lastResult: TransitionResult | null = null;

  snapshot(): ApprovalFlowSnapshot {
    return {
      pendingCount: this.pending.size,
      inflightCount: this.inflight.size,
      deferredTerminal: this.deferredTerminal,
      sawRunTerminal: this.sawRunTerminal,
    };
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  hasInflight(): boolean {
    return this.inflight.size > 0;
  }

  isPending(toolId: string): boolean {
    return Boolean(toolId) && this.pending.has(toolId);
  }

  isInflight(toolId: string): boolean {
    return Boolean(toolId) && this.inflight.has(toolId);
  }

  isResolved(toolId: string): boolean {
    return Boolean(toolId) && this.resolved.has(toolId);
  }

  /** 是否应阻塞 run 完成收口（有待批或进行中工具） */
  shouldBlockTerminal(): boolean {
    return this.pending.size > 0 || this.inflight.size > 0;
  }

  /** 是否可在审批清空后补发 deferred 完成 */
  canFlushDeferredTerminal(): boolean {
    return this.deferredTerminal && this.pending.size === 0;
  }

  isDeferredTerminal(): boolean {
    return this.deferredTerminal;
  }

  lastTransition(): TransitionResult | null {
    return this.lastResult;
  }

  /**
   * 兼容桥层：只返回 snapshot。
   * 需要 outcome/reason 时用 transition()。
   */
  dispatch(event: ApprovalFlowEvent): ApprovalFlowSnapshot {
    return this.transition(event).snapshot;
  }

  /** 带守卫的转换：返回 applied | noop | illegal */
  transition(event: ApprovalFlowEvent): TransitionResult {
    const result = this.apply(event);
    this.lastResult = result;
    return result;
  }

  private apply(event: ApprovalFlowEvent): TransitionResult {
    const finish = (
      outcome: TransitionOutcome,
      reason: string | null,
      changed: boolean,
    ): TransitionResult => ({
      outcome,
      reason,
      event: event.type,
      changed,
      snapshot: this.snapshot(),
    });

    switch (event.type) {
      case 'tool_start': {
        if (!event.toolId) return finish('illegal', EMPTY_TOOL_ID, false);
        if (this.inflight.has(event.toolId)) {
          return finish('noop', 'already_inflight', false);
        }
        this.inflight.add(event.toolId);
        return finish('applied', 'tool_started', true);
      }

      case 'tool_end': {
        if (!event.toolId) return finish('illegal', EMPTY_TOOL_ID, false);
        if (!this.inflight.has(event.toolId)) {
          return finish('noop', 'not_inflight', false);
        }
        this.inflight.delete(event.toolId);
        return finish('applied', 'tool_ended', true);
      }

      case 'approval_pending': {
        if (!event.toolId) return finish('illegal', EMPTY_TOOL_ID, false);
        if (this.pending.has(event.toolId)) {
          return finish('noop', 'already_pending', false);
        }
        // 允许 resolve 后再 pending（二次审批）；清除 resolved 履历
        this.resolved.delete(event.toolId);
        this.pending.add(event.toolId);
        return finish('applied', 'pending_added', true);
      }

      case 'approval_resolved': {
        if (!event.toolId) return finish('illegal', EMPTY_TOOL_ID, false);
        if (this.pending.has(event.toolId)) {
          this.pending.delete(event.toolId);
          this.resolved.add(event.toolId);
          // 拒绝后该工具不会再执行：同步摘掉 inflight，避免永久 shouldBlockTerminal
          if (event.denied) this.inflight.delete(event.toolId);
          return finish(
            'applied',
            event.denied ? 'resolved_denied' : 'resolved_allowed',
            true,
          );
        }
        if (this.resolved.has(event.toolId)) {
          // 双 resolve：幂等忽略，不改状态
          return finish('noop', 'double_resolve', false);
        }
        return finish('illegal', 'resolve_not_pending', false);
      }

      case 'approval_cancelled': {
        // 取消全部 pending
        if (event.toolId === undefined) {
          if (this.pending.size === 0) {
            return finish('noop', 'nothing_to_cancel', false);
          }
          for (const id of this.pending) {
            this.inflight.delete(id);
            this.resolved.add(id);
          }
          this.pending.clear();
          return finish('applied', 'cancelled_all', true);
        }
        if (!event.toolId) return finish('illegal', EMPTY_TOOL_ID, false);
        if (!this.pending.has(event.toolId)) {
          if (this.resolved.has(event.toolId)) {
            return finish('noop', 'double_cancel', false);
          }
          return finish('noop', 'cancel_not_pending', false);
        }
        this.pending.delete(event.toolId);
        this.inflight.delete(event.toolId);
        this.resolved.add(event.toolId);
        return finish('applied', 'cancelled', true);
      }

      case 'run_terminal_seen': {
        if (this.sawRunTerminal) {
          return finish('noop', 'already_saw_run_terminal', false);
        }
        this.sawRunTerminal = true;
        return finish('applied', 'run_terminal_marked', true);
      }

      case 'defer_terminal': {
        if (this.deferredTerminal) {
          return finish('noop', 'already_deferred', false);
        }
        this.deferredTerminal = true;
        return finish('applied', 'deferred', true);
      }

      case 'clear_all': {
        const changed =
          this.pending.size > 0 ||
          this.inflight.size > 0 ||
          this.resolved.size > 0 ||
          this.deferredTerminal ||
          this.sawRunTerminal;
        this.pending.clear();
        this.inflight.clear();
        this.resolved.clear();
        this.deferredTerminal = false;
        this.sawRunTerminal = false;
        return finish(changed ? 'applied' : 'noop', changed ? 'cleared' : 'already_clear', changed);
      }

      case 'force_finish': {
        // 强制收口：清阻塞态，保留 sawRunTerminal（桥层 finish 语义）
        const changed =
          this.pending.size > 0 ||
          this.inflight.size > 0 ||
          this.resolved.size > 0 ||
          this.deferredTerminal;
        this.pending.clear();
        this.inflight.clear();
        this.resolved.clear();
        this.deferredTerminal = false;
        return finish(
          changed ? 'applied' : 'noop',
          changed ? 'force_finished' : 'already_finished',
          changed,
        );
      }

      default: {
        // 穷尽检查：未知事件不改状态
        const _exhaustive: never = event;
        void _exhaustive;
        return finish('illegal', 'unknown_event', false);
      }
    }
  }

  /** 测试/调试 */
  debugSets(): { pending: string[]; inflight: string[]; resolved: string[] } {
    return {
      pending: [...this.pending],
      inflight: [...this.inflight],
      resolved: [...this.resolved],
    };
  }
}
