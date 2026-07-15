import { describe, expect, it } from 'vitest';
import { ApprovalFlowMachine } from './approvalFlowMachine';

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
});
