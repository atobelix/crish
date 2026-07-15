/**
 * 审批流状态机：集中 pending / inflight / deferredTerminal，避免桥层四布尔竞态。
 * 纯逻辑，无 DOM / store 依赖。
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
  | { type: 'run_terminal_seen' }
  | { type: 'defer_terminal' }
  | { type: 'clear_all' }
  | { type: 'force_finish' };

export class ApprovalFlowMachine {
  private pending = new Set<string>();
  private inflight = new Set<string>();
  private deferredTerminal = false;
  private sawRunTerminal = false;

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

  dispatch(event: ApprovalFlowEvent): ApprovalFlowSnapshot {
    switch (event.type) {
      case 'tool_start':
        if (event.toolId) this.inflight.add(event.toolId);
        break;
      case 'tool_end':
        if (event.toolId) this.inflight.delete(event.toolId);
        break;
      case 'approval_pending':
        if (event.toolId) this.pending.add(event.toolId);
        break;
      case 'approval_resolved':
        if (event.toolId) this.pending.delete(event.toolId);
        break;
      case 'run_terminal_seen':
        this.sawRunTerminal = true;
        break;
      case 'defer_terminal':
        this.deferredTerminal = true;
        break;
      case 'clear_all':
        this.pending.clear();
        this.inflight.clear();
        this.deferredTerminal = false;
        this.sawRunTerminal = false;
        break;
      case 'force_finish':
        this.pending.clear();
        this.inflight.clear();
        this.deferredTerminal = false;
        break;
      default:
        break;
    }
    return this.snapshot();
  }

  /** 测试/调试 */
  debugSets(): { pending: string[]; inflight: string[] } {
    return {
      pending: [...this.pending],
      inflight: [...this.inflight],
    };
  }
}
