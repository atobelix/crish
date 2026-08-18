/**
 * 流程收尾控制 + 取消 + systemPrompt 组装（从 ConnectionLifecycle 拆出，纯结构性）。
 */
import type { StreamCallbacks } from '../chatApi';
import type { ApprovalFlowMachine } from '../approvalFlowMachine';
import { type StreamState } from './handlers/streamState';
import { getCompositionRoot } from '../../app/compositionRoot';
import { RUN_CONTROL_LEVEL } from '@crish/shared-types';
import type { StreamCancelMode } from '../runControlClient';

export type StreamCancelFn = (opts?: { mode?: StreamCancelMode }) => void;

export function composeSystemPrompt(
  base: string | undefined,
  guidance: string | undefined
): string | undefined {
  const b = typeof base === 'string' ? base.trim() : '';
  const g = typeof guidance === 'string' ? guidance.trim() : '';
  if (b && g) return `${b}\n\n${g}`;
  return b || g || undefined;
}

export function createFinishController(
  approvalFlow: ApprovalFlowMachine,
  callbacks: StreamCallbacks,
  cleanup: () => void,
  state: StreamState,
  timeoutMs = 120000
): { finish: (force?: boolean) => void; tryResumeFinish: () => void } {
  const finish = (force = false) => {
    if (state.finished) return;
    if (!force && !state.cancelled) {
      if (approvalFlow.hasPending()) {
        approvalFlow.dispatch({ type: 'defer_terminal' });
        return;
      }
      if (approvalFlow.hasInflight()) {
        approvalFlow.dispatch({ type: 'defer_terminal' });
        if (state.endTimer) clearTimeout(state.endTimer);
        state.endTimer = setTimeout(() => finish(true), timeoutMs);
        return;
      }
    }
    if (approvalFlow.isDeferredTerminal())
      approvalFlow.dispatch({ type: 'force_finish' });
    state.finished = true;
    cleanup();
    try {
      callbacks.onComplete();
    } catch {
      /* swallow-ok: 完成回调抛错不阻断终态 */
    }
  };

  const tryResumeFinish = () => {
    if (state.finished || state.cancelled) return;
    const snap = approvalFlow.snapshot();
    if (
      !snap.deferredTerminal ||
      !snap.sawRunTerminal ||
      approvalFlow.shouldBlockTerminal()
    )
      return;
    finish(false);
  };

  return { finish, tryResumeFinish };
}

export function createStreamCancel(
  runId: string,
  callbacks: StreamCallbacks,
  approvalFlow: ApprovalFlowMachine,
  cleanup: () => void,
  state: StreamState
): StreamCancelFn {
  return (opts) => {
    if (state.finished) return;
    const mode: StreamCancelMode = opts?.mode ?? 'force';
    state.cancelled = true;
    approvalFlow.dispatch({ type: 'clear_all' });
    approvalFlow.dispatch({ type: 'force_finish' });
    cleanup();

    void getCompositionRoot().runControl.dispatch({
      level:
        mode === 'cooperative' ? RUN_CONTROL_LEVEL.L2 : RUN_CONTROL_LEVEL.L3,
      runId,
      reason: mode === 'cooperative' ? 'ui-stop' : 'ui-force-cancel',
    });

    state.finished = true;
    try {
      callbacks.onComplete();
    } catch {
      /* swallow-ok: 完成回调抛错不阻断终态 */
    }
  };
}
