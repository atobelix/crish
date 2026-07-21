import { describe, expect, it } from 'vitest';
import {
  ApprovalFlowMachine,
  type ApprovalFlowEvent,
  type TransitionOutcome,
} from './approvalFlowMachine';

function expectTransition(
  m: ApprovalFlowMachine,
  event: ApprovalFlowEvent,
  outcome: TransitionOutcome,
  reason: string | null
) {
  const r = m.transition(event);
  expect(r.outcome).toBe(outcome);
  expect(r.reason).toBe(reason);
  expect(r.event).toBe(event.type);
  expect(r.changed).toBe(outcome === 'applied');
  expect(m.lastTransition()).toEqual(r);
  return r;
}

describe('ApprovalFlowMachine', () => {
  it('tracks inflight and pending separately', () => {
    const m = new ApprovalFlowMachine();
    m.dispatch({ type: 'tool_start', toolId: 't1' });
    m.dispatch({ type: 'approval_pending', toolId: 't1' });
    expect(m.shouldBlockTerminal()).toBe(true);
    m.dispatch({ type: 'tool_end', toolId: 't1' });
    expect(m.hasInflight()).toBe(false);
    expect(m.hasPending()).toBe(true);
    m.dispatch({ type: 'approval_resolved', toolId: 't1' });
    expect(m.shouldBlockTerminal()).toBe(false);
  });

  it('deferred terminal only flushes when pending empty', () => {
    const m = new ApprovalFlowMachine();
    m.dispatch({ type: 'approval_pending', toolId: 'a' });
    m.dispatch({ type: 'defer_terminal' });
    expect(m.canFlushDeferredTerminal()).toBe(false);
    m.dispatch({ type: 'approval_resolved', toolId: 'a' });
    expect(m.canFlushDeferredTerminal()).toBe(true);
  });

  it('clear_all resets state', () => {
    const m = new ApprovalFlowMachine();
    m.dispatch({ type: 'tool_start', toolId: 'x' });
    m.dispatch({ type: 'approval_pending', toolId: 'y' });
    m.dispatch({ type: 'run_terminal_seen' });
    m.dispatch({ type: 'clear_all' });
    const s = m.snapshot();
    expect(s.pendingCount).toBe(0);
    expect(s.inflightCount).toBe(0);
    expect(s.deferredTerminal).toBe(false);
    expect(s.sawRunTerminal).toBe(false);
  });

  it('duplicate approval_pending for same toolId counts once', () => {
    const m = new ApprovalFlowMachine();
    m.dispatch({ type: 'approval_pending', toolId: 'dup' });
    m.dispatch({ type: 'approval_pending', toolId: 'dup' });
    m.dispatch({ type: 'approval_pending', toolId: 'dup' });
    expect(m.snapshot().pendingCount).toBe(1);
    expect(m.debugSets().pending).toEqual(['dup']);
  });

  it('denied approval_resolved also clears inflight so terminal is not stuck', () => {
    const m = new ApprovalFlowMachine();
    m.dispatch({ type: 'tool_start', toolId: 'deny-me' });
    m.dispatch({ type: 'approval_pending', toolId: 'deny-me' });
    expect(m.shouldBlockTerminal()).toBe(true);
    // allow 路径：仅清 pending，inflight 仍阻塞（工具继续跑）
    m.dispatch({ type: 'approval_resolved', toolId: 'deny-me', denied: false });
    expect(m.hasPending()).toBe(false);
    expect(m.hasInflight()).toBe(true);
    expect(m.shouldBlockTerminal()).toBe(true);
    // 重新挂 pending 再 deny
    m.dispatch({ type: 'approval_pending', toolId: 'deny-me' });
    m.dispatch({ type: 'approval_resolved', toolId: 'deny-me', denied: true });
    expect(m.hasPending()).toBe(false);
    expect(m.hasInflight()).toBe(false);
    expect(m.shouldBlockTerminal()).toBe(false);
  });

  it('ignores empty toolId on start/pending/resolved', () => {
    const m = new ApprovalFlowMachine();
    m.dispatch({ type: 'tool_start', toolId: '' });
    m.dispatch({ type: 'approval_pending', toolId: '' });
    m.dispatch({ type: 'approval_resolved', toolId: '', denied: true });
    expect(m.snapshot().pendingCount).toBe(0);
    expect(m.snapshot().inflightCount).toBe(0);
  });

  // ── transition outcomes / guards ──────────────────────────────────────────

  describe('illegal transition guards', () => {
    it('rejects empty toolId on tool/approval events as illegal', () => {
      const m = new ApprovalFlowMachine();
      for (const event of [
        { type: 'tool_start' as const, toolId: '' },
        { type: 'tool_end' as const, toolId: '' },
        { type: 'approval_pending' as const, toolId: '' },
        { type: 'approval_resolved' as const, toolId: '' },
        { type: 'approval_cancelled' as const, toolId: '' },
      ]) {
        expectTransition(m, event, 'illegal', 'empty_tool_id');
      }
      expect(m.snapshot()).toEqual({
        pendingCount: 0,
        inflightCount: 0,
        deferredTerminal: false,
        sawRunTerminal: false,
        flowStatus: 'idle',
      });
    });

    it('resolve of never-pending toolId is illegal', () => {
      const m = new ApprovalFlowMachine();
      expectTransition(
        m,
        { type: 'approval_resolved', toolId: 'ghost' },
        'illegal',
        'resolve_not_pending'
      );
      expect(m.hasPending()).toBe(false);
      expect(m.isResolved('ghost')).toBe(false);
    });
  });

  describe('double-resolve', () => {
    it('second resolve is noop double_resolve and does not change snapshot', () => {
      const m = new ApprovalFlowMachine();
      m.transition({ type: 'tool_start', toolId: 't' });
      m.transition({ type: 'approval_pending', toolId: 't' });
      expectTransition(
        m,
        { type: 'approval_resolved', toolId: 't', denied: false },
        'applied',
        'resolved_allowed'
      );
      expect(m.isResolved('t')).toBe(true);
      expect(m.isPending('t')).toBe(false);
      expect(m.isInflight('t')).toBe(true); // allow keeps inflight

      const snap = m.snapshot();
      expectTransition(
        m,
        { type: 'approval_resolved', toolId: 't', denied: true },
        'noop',
        'double_resolve'
      );
      // deny on double-resolve must NOT strip inflight
      expect(m.snapshot()).toEqual(snap);
      expect(m.isInflight('t')).toBe(true);
    });

    it('re-pending after resolve allows a second resolve cycle', () => {
      const m = new ApprovalFlowMachine();
      m.transition({ type: 'approval_pending', toolId: 'r' });
      m.transition({ type: 'approval_resolved', toolId: 'r' });
      expectTransition(
        m,
        { type: 'approval_resolved', toolId: 'r' },
        'noop',
        'double_resolve'
      );
      expectTransition(
        m,
        { type: 'approval_pending', toolId: 'r' },
        'applied',
        'pending_added'
      );
      expect(m.isResolved('r')).toBe(false);
      expectTransition(
        m,
        { type: 'approval_resolved', toolId: 'r', denied: true },
        'applied',
        'resolved_denied'
      );
    });
  });

  describe('cancel / resolve paths', () => {
    it('cancel single pending clears pending and inflight (deny-like)', () => {
      const m = new ApprovalFlowMachine();
      m.transition({ type: 'tool_start', toolId: 'c1' });
      m.transition({ type: 'approval_pending', toolId: 'c1' });
      expectTransition(
        m,
        { type: 'approval_cancelled', toolId: 'c1' },
        'applied',
        'cancelled'
      );
      expect(m.hasPending()).toBe(false);
      expect(m.hasInflight()).toBe(false);
      expect(m.isResolved('c1')).toBe(true);
      expect(m.shouldBlockTerminal()).toBe(false);
    });

    it('cancel all pending tools at once', () => {
      const m = new ApprovalFlowMachine();
      m.transition({ type: 'tool_start', toolId: 'a' });
      m.transition({ type: 'tool_start', toolId: 'b' });
      m.transition({ type: 'approval_pending', toolId: 'a' });
      m.transition({ type: 'approval_pending', toolId: 'b' });
      expectTransition(
        m,
        { type: 'approval_cancelled' },
        'applied',
        'cancelled_all'
      );
      expect(m.snapshot().pendingCount).toBe(0);
      expect(m.snapshot().inflightCount).toBe(0);
      expect(m.debugSets().resolved.sort()).toEqual(['a', 'b']);
    });

    it('cancel when nothing pending is noop', () => {
      const m = new ApprovalFlowMachine();
      expectTransition(
        m,
        { type: 'approval_cancelled' },
        'noop',
        'nothing_to_cancel'
      );
      expectTransition(
        m,
        { type: 'approval_cancelled', toolId: 'x' },
        'noop',
        'cancel_not_pending'
      );
    });

    it('double cancel after resolve is noop', () => {
      const m = new ApprovalFlowMachine();
      m.transition({ type: 'approval_pending', toolId: 'd' });
      m.transition({ type: 'approval_resolved', toolId: 'd', denied: true });
      expectTransition(
        m,
        { type: 'approval_cancelled', toolId: 'd' },
        'noop',
        'double_cancel'
      );
    });

    it('allow vs deny resolve differs on inflight retention', () => {
      const allowM = new ApprovalFlowMachine();
      allowM.transition({ type: 'tool_start', toolId: 'x' });
      allowM.transition({ type: 'approval_pending', toolId: 'x' });
      expectTransition(
        allowM,
        { type: 'approval_resolved', toolId: 'x', denied: false },
        'applied',
        'resolved_allowed'
      );
      expect(allowM.isInflight('x')).toBe(true);

      const denyM = new ApprovalFlowMachine();
      denyM.transition({ type: 'tool_start', toolId: 'x' });
      denyM.transition({ type: 'approval_pending', toolId: 'x' });
      expectTransition(
        denyM,
        { type: 'approval_resolved', toolId: 'x', denied: true },
        'applied',
        'resolved_denied'
      );
      expect(denyM.isInflight('x')).toBe(false);
    });
  });

  describe('idempotent / noop transitions', () => {
    it('duplicate pending / inflight / defer / run_terminal are noop', () => {
      const m = new ApprovalFlowMachine();
      expectTransition(
        m,
        { type: 'tool_start', toolId: 't' },
        'applied',
        'tool_started'
      );
      expectTransition(
        m,
        { type: 'tool_start', toolId: 't' },
        'noop',
        'already_inflight'
      );
      expectTransition(
        m,
        { type: 'approval_pending', toolId: 't' },
        'applied',
        'pending_added'
      );
      expectTransition(
        m,
        { type: 'approval_pending', toolId: 't' },
        'noop',
        'already_pending'
      );
      expectTransition(
        m,
        { type: 'run_terminal_seen' },
        'applied',
        'run_terminal_marked'
      );
      expectTransition(
        m,
        { type: 'run_terminal_seen' },
        'noop',
        'already_saw_run_terminal'
      );
      expectTransition(m, { type: 'defer_terminal' }, 'applied', 'deferred');
      expectTransition(
        m,
        { type: 'defer_terminal' },
        'noop',
        'already_deferred'
      );
      expectTransition(
        m,
        { type: 'tool_end', toolId: 'missing' },
        'noop',
        'not_inflight'
      );
    });

    it('clear_all / force_finish on empty machine are noop', () => {
      const m = new ApprovalFlowMachine();
      expectTransition(m, { type: 'clear_all' }, 'noop', 'already_clear');
      expectTransition(m, { type: 'force_finish' }, 'noop', 'already_finished');
    });
  });

  describe('force_finish vs clear_all', () => {
    it('force_finish clears blockers but keeps sawRunTerminal', () => {
      const m = new ApprovalFlowMachine();
      m.transition({ type: 'tool_start', toolId: 'f' });
      m.transition({ type: 'approval_pending', toolId: 'f' });
      m.transition({ type: 'run_terminal_seen' });
      m.transition({ type: 'defer_terminal' });
      expectTransition(
        m,
        { type: 'force_finish' },
        'applied',
        'force_finished'
      );
      expect(m.snapshot()).toEqual({
        pendingCount: 0,
        inflightCount: 0,
        deferredTerminal: false,
        sawRunTerminal: true,
        flowStatus: 'idle',
      });
      expect(m.debugSets().resolved).toEqual([]);
    });

    it('clear_all also resets sawRunTerminal and resolved history', () => {
      const m = new ApprovalFlowMachine();
      m.transition({ type: 'approval_pending', toolId: 'z' });
      m.transition({ type: 'approval_resolved', toolId: 'z' });
      m.transition({ type: 'run_terminal_seen' });
      expect(m.isResolved('z')).toBe(true);
      expectTransition(m, { type: 'clear_all' }, 'applied', 'cleared');
      expect(m.snapshot().sawRunTerminal).toBe(false);
      expect(m.isResolved('z')).toBe(false);
    });
  });

  describe('full event matrix (idle start)', () => {
    const cases: Array<{
      event: ApprovalFlowEvent;
      outcome: TransitionOutcome;
      reason: string | null;
    }> = [
      {
        event: { type: 'tool_start', toolId: 'm' },
        outcome: 'applied',
        reason: 'tool_started',
      },
      {
        event: { type: 'tool_end', toolId: 'm' },
        outcome: 'noop',
        reason: 'not_inflight',
      },
      {
        event: { type: 'approval_pending', toolId: 'm' },
        outcome: 'applied',
        reason: 'pending_added',
      },
      {
        event: { type: 'approval_resolved', toolId: 'm' },
        outcome: 'illegal',
        reason: 'resolve_not_pending',
      },
      {
        event: { type: 'approval_cancelled', toolId: 'm' },
        outcome: 'noop',
        reason: 'cancel_not_pending',
      },
      {
        event: { type: 'approval_cancelled' },
        outcome: 'noop',
        reason: 'nothing_to_cancel',
      },
      {
        event: { type: 'run_terminal_seen' },
        outcome: 'applied',
        reason: 'run_terminal_marked',
      },
      {
        event: { type: 'defer_terminal' },
        outcome: 'applied',
        reason: 'deferred',
      },
      {
        event: { type: 'clear_all' },
        outcome: 'noop',
        reason: 'already_clear',
      },
      {
        event: { type: 'force_finish' },
        outcome: 'noop',
        reason: 'already_finished',
      },
      {
        event: { type: 'tool_start', toolId: '' },
        outcome: 'illegal',
        reason: 'empty_tool_id',
      },
    ];

    for (const c of cases) {
      it(`${c.event.type}${
        'toolId' in c.event ? `(${JSON.stringify(c.event.toolId)})` : ''
      } → ${c.outcome}/${c.reason}`, () => {
        const m = new ApprovalFlowMachine();
        expectTransition(m, c.event, c.outcome, c.reason);
      });
    }
  });

  describe('multi-tool concurrent + deferred flush path', () => {
    it('blocks until all pending resolved; allow leaves other inflight', () => {
      const m = new ApprovalFlowMachine();
      m.transition({ type: 'tool_start', toolId: 't1' });
      m.transition({ type: 'tool_start', toolId: 't2' });
      m.transition({ type: 'approval_pending', toolId: 't1' });
      m.transition({ type: 'approval_pending', toolId: 't2' });
      m.transition({ type: 'run_terminal_seen' });
      m.transition({ type: 'defer_terminal' });

      expect(m.shouldBlockTerminal()).toBe(true);
      expect(m.canFlushDeferredTerminal()).toBe(false);

      m.transition({ type: 'approval_resolved', toolId: 't1', denied: false });
      expect(m.canFlushDeferredTerminal()).toBe(false); // t2 still pending
      expect(m.isInflight('t1')).toBe(true);

      m.transition({ type: 'approval_resolved', toolId: 't2', denied: true });
      expect(m.hasPending()).toBe(false);
      expect(m.canFlushDeferredTerminal()).toBe(true);
      // t2 denied → inflight gone; t1 still inflight → still block terminal
      expect(m.shouldBlockTerminal()).toBe(true);
      expect(m.isInflight('t1')).toBe(true);
      expect(m.isInflight('t2')).toBe(false);

      m.transition({ type: 'tool_end', toolId: 't1' });
      expect(m.shouldBlockTerminal()).toBe(false);
      expect(m.canFlushDeferredTerminal()).toBe(true);
    });

    it('dispatch returns snapshot compatible with bridge', () => {
      const m = new ApprovalFlowMachine();
      const snap = m.dispatch({ type: 'approval_pending', toolId: 'bridge' });
      expect(snap).toEqual(m.snapshot());
      expect(snap.pendingCount).toBe(1);
      expect(m.lastTransition()?.outcome).toBe('applied');
    });
  });

  describe('query helpers', () => {
    it('isPending / isInflight / isResolved track per-tool state', () => {
      const m = new ApprovalFlowMachine();
      expect(m.isPending('')).toBe(false);
      expect(m.isInflight('')).toBe(false);
      expect(m.isResolved('')).toBe(false);

      m.transition({ type: 'tool_start', toolId: 'q' });
      expect(m.isInflight('q')).toBe(true);
      m.transition({ type: 'approval_pending', toolId: 'q' });
      expect(m.isPending('q')).toBe(true);
      m.transition({ type: 'approval_resolved', toolId: 'q', denied: true });
      expect(m.isPending('q')).toBe(false);
      expect(m.isInflight('q')).toBe(false);
      expect(m.isResolved('q')).toBe(true);
    });
  });
});
