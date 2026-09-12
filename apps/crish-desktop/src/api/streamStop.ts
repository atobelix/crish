/**
 * Shared L2/L3 stop primitives for main chat + agent panel.
 *
 * UI hooks keep their own finalize partials (messages, goalMode, agent status…).
 * Wire cancel is one place: live StreamCancelFn (createStreamCancel → root)
 * XOR runId → compositionRoot.runControl — never both (inventory #3).
 *
 * @see hooks/chat-stream/useStreamCallbacks.ts finalizeStopGeneration
 * @see hooks/useAgentStream.ts finalizeAgentStop
 * @see api/chat-bridge/ConnectionLifecycle.ts createStreamCancel
 * @see api/runControlClient.ts dispatchRunControl
 */

import type { StreamCancelMode } from './runControlClient';
import { getCompositionRoot } from '../app/compositionRoot';

/** Minimal cancel handle (StreamCancelFn or legacy () => void). */
export type StreamStopCancel = (opts?: { mode?: StreamCancelMode }) => void;

export type DispatchStreamStopCancelArgs = {
  force: boolean;
  /** Live stream cancel (preferred). When set, runId is ignored. */
  cancel?: StreamStopCancel | null;
  /** Fallback when no live cancel (e.g. agent still running without StreamCancelFn). */
  runId?: string | null;
  sessionId?: string | null;
  reasonCooperative?: string;
  reasonForce?: string;
};

export type DispatchStreamStopCancelResult = {
  mode: StreamCancelMode;
  cancelledVia: 'stream' | 'runControl' | 'none';
};

/** force=true → L3 force; false → L2 cooperative. */
export function cancelModeFromForce(force: boolean): StreamCancelMode {
  return force ? 'force' : 'cooperative';
}

/**
 * Dev fast-path for withLogger: skip verbose console work while a stream is live.
 * Ref-counted so concurrent session streams keep the flag set until the last ends.
 * Consumed by store/middleware/withLogger.ts via window.__streamingActive.
 */
let streamingActiveCount = 0;

export function markStreamingActive(active: boolean): void {
  if (typeof window === 'undefined') return;
  if (active) {
    streamingActiveCount += 1;
  } else {
    streamingActiveCount = Math.max(0, streamingActiveCount - 1);
  }
  (window as Window & { __streamingActive?: boolean }).__streamingActive =
    streamingActiveCount > 0;
}

/** Test / dev helper — not for product paths. */
export function resetStreamingActiveCountForTests(): void {
  streamingActiveCount = 0;
  if (typeof window !== 'undefined') {
    (window as Window & { __streamingActive?: boolean }).__streamingActive = false;
  }
}

/**
 * Dual-path stop wire (createStreamCancel / compositionRoot.runControl).
 * Prefer live cancel; else runId → root. Never dispatch both.
 */
export function dispatchStreamStopCancel(
  args: DispatchStreamStopCancelArgs
): DispatchStreamStopCancelResult {
  const mode = cancelModeFromForce(args.force);

  if (typeof args.cancel === 'function') {
    try {
      args.cancel({ mode });
    } catch {
      /* ignore — local UI finalize already owns product state */
    }
    return { mode, cancelledVia: 'stream' };
  }

  const runId = args.runId;
  if (runId) {
    void requestRunStopViaRoot(runId, mode, {
      sessionId: args.sessionId,
      reasonCooperative: args.reasonCooperative,
      reasonForce: args.reasonForce,
    });
    return { mode, cancelledVia: 'runControl' };
  }

  return { mode, cancelledVia: 'none' };
}

/**
 * Agent/no-stream L2/L3 fallback.
 * **唯一**出站：compositionRoot.runControl（与 createStreamCancel 同门面）。
 */
export async function requestRunStopViaRoot(
  runId: string,
  mode: StreamCancelMode = 'force',
  opts?: {
    sessionId?: string | null;
    reasonCooperative?: string;
    reasonForce?: string;
  }
): Promise<void> {
  try {
    const rc = getCompositionRoot().runControl;
    if (mode === 'cooperative') {
      await rc.cooperativeStop({
        runId,
        sessionId: opts?.sessionId,
        reason: opts?.reasonCooperative ?? 'ui-stop',
      });
    } else {
      await rc.forceCancel({
        runId,
        sessionId: opts?.sessionId,
        reason: opts?.reasonForce ?? 'ui-force-cancel',
      });
    }
  } catch {
    /* ignore — UI 已本地收口 */
  }
}
