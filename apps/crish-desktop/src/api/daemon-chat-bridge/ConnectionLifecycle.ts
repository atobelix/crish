/**
 * Daemon stream connection lifecycle — primary transport + degraded fallback switch.
 *
 * ## Transport SoT (inventory #10)
 * - **Primary:** `streamViaDaemon` → WS `run-task` + EventRouter (full tools/approvals/L2/L3).
 * - **Degraded:** `streamViaDirectFetch` only when daemon WS not ready within 1.5s.
 * - **Single switch:** {@link ALLOW_AUTO_DIRECT_FETCH_FALLBACK} (soft-deprecated auto path).
 * - Product entry: `chatApi.streamAssistantResponseApi` always calls `streamViaDaemon` first.
 *
 * ## When directFetch is chosen
 * ```
 * createStreamSession:
 *   waitUntilConnected(1500ms)
 *   if ready && isConnected → daemon run-task          [PRIMARY]
 *   else if ALLOW_AUTO_DIRECT_FETCH_FALLBACK
 *        → streamViaDirectFetch + state.transportAbort [DEGRADED, soft-deprecated]
 *   else → onRunError(network) + finish                [refuse]
 * ```
 *
 * ## Cancel parity
 * - Daemon: {@link createStreamCancel} → compositionRoot.runControl L2/L3 + cleanup + onComplete.
 * - Degraded: same outer `StreamCancelFn` also calls `state.transportAbort` (HTTP AbortController).
 * - Direct path has **no** cooperative L2 (abort ≈ force); do not ship features that need L2-only.
 *
 * @see docs/plans/progress/architecture-dedup-inventory.md #10
 * @see ../directFetchBridge.ts
 * @see ../chatApi.ts
 */
import { getDesktopDaemonClient } from '../daemonClient';
import type { StreamCallbacks, StreamRequestOptions } from '../chatApi';
import { toDaemonPermissionMode } from '../permissionModes';
import { getPermissionMode } from '../storeAccess';
import { logInternalError, networkUserMessage } from '../userFacingErrors';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import { streamRecovery } from '../../services/StreamRecovery';
import { normalizeStreamSessionId } from './handlers/eventUtils';
import { type StreamState, cleanupStreamState } from './handlers/streamState';
import { EventRouter } from './EventRouter';
import { getCompositionRoot } from '../../app/compositionRoot';
import { recordTransportDegradedDirectFetch } from '../controlMetrics';
import { RUN_CONTROL_LEVEL } from '@crish/shared-types';
/** Single SoT for cancel mode literals — do not redeclare in this package. */
import type { StreamCancelMode } from '../runControlClient';

export type { StreamCancelMode };

/**
 * Inventory #10 — **single switch** for auto HTTP SSE when daemon WS is down.
 *
 * - `true` (default, transitional): degrade to `streamViaDirectFetch` so chat still works
 *   offline/dev without agent-daemon. Soft-deprecated: silent dual transport confuses
 *   cancel/metrics/tool support expectations.
 * - `false` (preferred end state): refuse start with `onRunError` until daemon is reachable.
 *
 * Flip to `false` after product UX for “engine offline” is acceptable and E0 no longer
 * relies on silent direct for smoke. Do **not** add a second product entry that calls
 * directFetch outside this flag.
 *
 * @see architecture-dedup-inventory.md #10
 */
export const ALLOW_AUTO_DIRECT_FETCH_FALLBACK = true as const;

/** Soft console notice once per process when first degraded fallback fires (dev only). */
let degradedTransportNoticeShown = false;

function noticeDegradedTransportOnce(): void {
  if (degradedTransportNoticeShown) return;
  degradedTransportNoticeShown = true;
  const isDev =
    (typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { DEV?: boolean } }).env?.DEV) ||
    (typeof process !== 'undefined' && process.env.NODE_ENV === 'development');
  if (!isDev) return;
  // eslint-disable-next-line no-console
  console.info(
    '[transport] degraded to directFetch (daemon WS not ready); metric=transport_degraded_direct_fetch · inventory #10',
  );
}

export async function ensureDaemonConnected(): Promise<{
  ok: boolean;
  url?: string;
  error?: string;
}> {
  const client = getDesktopDaemonClient();
  client.startKeepAlive();
  try {
    const ready = await client.waitUntilConnected(20_000);
    if (!ready) {
      return {
        ok: false,
        ...(client.getUrl() !== undefined && { url: client.getUrl()! }),
        error: networkUserMessage(),
      };
    }
    await client.request({ type: 'get-status' }, 'status-response', 8_000);
    return {
      ok: true,
      ...(client.getUrl() !== undefined && { url: client.getUrl()! }),
    };
  } catch (e) {
    logInternalError('ensureDaemonConnected', e);
    return {
      ok: false,
      ...(client.getUrl() !== undefined && { url: client.getUrl()! }),
      error: networkUserMessage(e),
    };
  }
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
    if (approvalFlow.isDeferredTerminal()) {
      approvalFlow.dispatch({ type: 'force_finish' });
    }
    state.finished = true;
    cleanup();
    try {
      callbacks.onComplete();
    } catch {
      /* ignore */
    }
  };

  const tryResumeFinish = () => {
    if (state.finished || state.cancelled) return;
    const snap = approvalFlow.snapshot();
    if (!snap.deferredTerminal) return;
    if (!snap.sawRunTerminal) return;
    if (approvalFlow.shouldBlockTerminal()) return;
    finish(false);
  };

  return { finish, tryResumeFinish };
}

/**
 * Stream cancel 句柄（对齐 Run 控制 L2/L3）：
 * - cooperative：L2 cooperative_stop（经 compositionRoot.runControl）
 * - force：L3 force_cancel
 *
 * mode 字面量真源：`runControlClient.StreamCancelMode`（本模块 re-export）。
 * @see apps/crish-desktop/src/api/runControlClient.ts
 */
export type StreamCancelFn = (opts?: { mode?: StreamCancelMode }) => void;

export function createStreamCancel(
  client: ReturnType<typeof getDesktopDaemonClient>,
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

    // Inventory #10 cancel parity: if we degraded to direct HTTP SSE, abort that
    // fetch first. L2/L3 run-control below is a no-op for pure-direct runs (no daemon task).
    // Cooperative mode is force-equivalent on direct path (no ControlBus).
    const localAbort = state.transportAbort;
    state.transportAbort = null;
    if (localAbort) {
      try {
        localAbort();
      } catch {
        /* ignore */
      }
    }

    cleanup();

    // L2/L3 经 compositionRoot.runControl（metrics + EventBus + wire）
    // `client` 保留签名兼容；WS 由 runControlClient → getDesktopDaemonClient 发出
    // （与本参数通常为同一单例；测试 mock daemonClient 仍命中）
    void client;
    void getCompositionRoot().runControl.dispatch({
      level:
        mode === 'cooperative'
          ? RUN_CONTROL_LEVEL.L2
          : RUN_CONTROL_LEVEL.L3,
      runId,
      reason: mode === 'cooperative' ? 'ui-stop' : 'ui-force-cancel',
    });

    state.finished = true;
    // If localAbort already called onComplete (directFetch cancel parity), skip double-fire.
    // Daemon path: transportAbort is null → onComplete once here.
    if (!localAbort) {
      try {
        callbacks.onComplete();
      } catch {
        /* ignore */
      }
    }
  };
}

export async function createStreamSession(
  client: ReturnType<typeof getDesktopDaemonClient>,
  prompt: string,
  sessionId: string,
  runId: string,
  callbacks: StreamCallbacks,
  options: StreamRequestOptions | undefined,
  state: StreamState,
  onMessage: (msg: Record<string, unknown>) => void,
  finish: (force?: boolean) => void,
  /** 本地助手 placeholder id（= clientMessageId），经 run-task 下发 */
  assistantClientMessageId?: string,
): Promise<void> {
  try {
    const ready = await client.waitUntilConnected(1_500);
    // --- inventory #10: transport branch (primary vs degraded) ---
    if (!ready || !client.isConnected()) {
      if (!ALLOW_AUTO_DIRECT_FETCH_FALLBACK) {
        // Preferred end state: refuse rather than a second silent transport.
        logInternalError(
          'stream-start-refuse-direct',
          new Error('daemon unreachable; ALLOW_AUTO_DIRECT_FETCH_FALLBACK=false')
        );
        if (callbacks.onRunError) {
          callbacks.onRunError(networkUserMessage(), 'network');
        } else {
          callbacks.onChunk(networkUserMessage());
        }
        finish();
        return;
      }
      // DEGRADED (soft-deprecated auto): HTTP SSE. Retain abort on state for Stop parity.
      // OPT-F7: one controlMetrics counter per fallback (kill #10 residual observability).
      recordTransportDegradedDirectFetch();
      noticeDegradedTransportOnce();
      const { streamViaDirectFetch } = await import('../directFetchBridge');
      state.transportAbort = streamViaDirectFetch(
        prompt,
        callbacks,
        sessionId,
        runId,
        options
      );
      return;
    }

    state.unsub = client.onMessage(onMessage);
    callbacks.onThought('正在处理…');

    const { getWorkspacePath } = await import('../projectStore');
    const cwd = getWorkspacePath() || undefined;

    const mode = getPermissionMode();
    const permissionMode = toDaemonPermissionMode(mode);

    const hasImages = Boolean(
      options?.hasImages ||
      options?.content?.some((p) => p.type === 'image_url')
    );
    const safeSessionId = normalizeStreamSessionId(sessionId);

    let mcpDisabledTools: Record<string, string[]> | undefined;
    let budgetDifficulty: string | undefined;
    let responseStyleSystemPrompt: string | undefined;
    try {
      const { clientApi } = await import('../clientApi');
      const sets = await clientApi.getSettingsEx(cwd || '__global__');
      if (
        sets?.mcpDisabledTools &&
        Object.keys(sets.mcpDisabledTools).length > 0
      ) {
        mcpDisabledTools = sets.mcpDisabledTools;
      }
      const tl = String(sets?.defaultThinkingLevel || '')
        .trim()
        .toLowerCase();
      if (tl === 'off') budgetDifficulty = undefined;
      else if (tl === 'minimal') budgetDifficulty = 'easy';
      else if (tl === 'low') budgetDifficulty = 'easy';
      else if (tl === 'medium') budgetDifficulty = 'normal';
      else if (tl === 'high') budgetDifficulty = 'hard';
      else if (tl === 'xhigh') budgetDifficulty = 'hard';

      const styleKey = String(sets?.responseStyle ?? 'medium');
      const styleMap: Record<string, string> = {
        minimal:
          'Response style: minimal. Prefer the shortest correct answer. Avoid preambles, lists, and restating the question.',
        low: 'Response style: concise. Keep answers short; use bullets only when they improve clarity. Skip lengthy explanations unless asked.',
        medium:
          'Response style: balanced. Be clear and complete without padding. Explain non-obvious steps briefly.',
        high: 'Response style: thorough. Provide structured reasoning, edge cases, and verification steps when useful. Still stay on-topic.',
        极简: 'Response style: minimal. Prefer the shortest correct answer. Avoid preambles, lists, and restating the question.',
        简洁: 'Response style: concise. Keep answers short; use bullets only when they improve clarity. Skip lengthy explanations unless asked.',
        适中: 'Response style: balanced. Be clear and complete without padding. Explain non-obvious steps briefly.',
        深入: 'Response style: thorough. Provide structured reasoning, edge cases, and verification steps when useful. Still stay on-topic.',
      };
      const guidance =
        styleMap[styleKey] ??
        styleMap[styleKey.toLowerCase()] ??
        styleMap.medium;
      const base =
        typeof options?.systemPrompt === 'string'
          ? options.systemPrompt.trim()
          : '';
      if (base.includes('Response style:')) {
        responseStyleSystemPrompt = base;
      } else if (base) {
        responseStyleSystemPrompt = `${base}\n\n${guidance}`;
      } else {
        responseStyleSystemPrompt = guidance;
      }
    } catch {
      /* ignore */
    }

    const goalMode =
      typeof options?.mode === 'string' ? options.mode.trim() : '';
    const visibleGoal =
      typeof options?.visibleGoal === 'string'
        ? options.visibleGoal.trim()
        : '';
    const maxRounds =
      typeof options?.maxRounds === 'number' &&
      Number.isFinite(options.maxRounds) &&
      options.maxRounds > 0
        ? Math.floor(options.maxRounds)
        : undefined;
    const maxStalledRounds =
      typeof options?.maxStalledRounds === 'number' &&
      Number.isFinite(options.maxStalledRounds) &&
      options.maxStalledRounds > 0
        ? Math.floor(options.maxStalledRounds)
        : undefined;

    const systemPrompt =
      responseStyleSystemPrompt ||
      (typeof options?.systemPrompt === 'string' && options.systemPrompt.trim()
        ? options.systemPrompt.trim()
        : undefined);

    const userClientMessageId =
      typeof options?.clientMessageId === 'string' && options.clientMessageId.trim()
        ? options.clientMessageId.trim()
        : undefined;
    const asstClientMessageId =
      (typeof assistantClientMessageId === 'string' && assistantClientMessageId.trim()
        ? assistantClientMessageId.trim()
        : undefined) ||
      (typeof options?.assistantClientMessageId === 'string' &&
      options.assistantClientMessageId.trim()
        ? options.assistantClientMessageId.trim()
        : undefined);

    await client.send({
      type: 'run-task',
      runId,
      prompt,
      sessionId: safeSessionId,
      permissionMode,
      ...(cwd ? { cwd } : {}),
      ...(mcpDisabledTools ? { mcpDisabledTools } : {}),
      ...(budgetDifficulty ? { budgetDifficulty } : {}),
      ...(options?.content?.length ? { content: options.content } : {}),
      ...(hasImages ? { hasImages: true } : {}),
      ...(options?.attachments?.length
        ? { attachments: options.attachments }
        : {}),
      ...(goalMode ? { mode: goalMode } : {}),
      ...(visibleGoal ? { visibleGoal } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(maxStalledRounds !== undefined ? { maxStalledRounds } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      // 幂等键：与本地乐观 message.id 对齐，供 message-end / hydrate rekey
      ...(userClientMessageId ? { clientMessageId: userClientMessageId } : {}),
      ...(asstClientMessageId
        ? { assistantClientMessageId: asstClientMessageId }
        : {}),
    });
  } catch (e) {
    logInternalError('stream-start', e);
    if (callbacks.onRunError)
      callbacks.onRunError(networkUserMessage(), 'network');
    else callbacks.onChunk(networkUserMessage());
    finish();
  }
}

export function streamViaDaemon(
  prompt: string,
  callbacks: StreamCallbacks,
  sessionId: string,
  assistantMsgId: string,
  options?: StreamRequestOptions
): () => void {
  const client = getDesktopDaemonClient();
  client.startKeepAlive();

  const safeSessionId = normalizeStreamSessionId(sessionId);

  const state: StreamState = {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
    transportAbort: null,
  };
  const approvalFlow = new ApprovalFlowMachine();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // assistantMsgId = 本地 clientMessageId：热路径 upsert + run-task 下发
  const assistantClientMessageId =
    (typeof assistantMsgId === 'string' && assistantMsgId.trim()) ||
    (typeof options?.assistantClientMessageId === 'string' &&
      options.assistantClientMessageId.trim()) ||
    '';
  try {
    callbacks.onRunMeta?.({ runId });
  } catch {
    /* ignore */
  }

  streamRecovery.registerStream(safeSessionId, runId);

  let terminalMarked = false;
  const markTerminal = (kind: 'completed' | 'failed', error?: string) => {
    if (terminalMarked) return;
    terminalMarked = true;
    if (kind === 'completed') streamRecovery.markCompleted(safeSessionId);
    else streamRecovery.markFailed(safeSessionId, error || 'failed');
  };

  const trackedCallbacks: StreamCallbacks = {
    ...callbacks,
    onChunk: (chunk: string) => {
      if (chunk) {
        streamRecovery.updateHeartbeat(safeSessionId, { bytes: chunk.length });
      }
      callbacks.onChunk(chunk);
    },
    onComplete: () => {
      if (state.cancelled) markTerminal('failed', 'cancelled');
      else markTerminal('completed');
      callbacks.onComplete();
    },
    onRunError: (message, kind, detail) => {
      markTerminal('failed', message || kind || 'error');
      if (callbacks.onRunError) callbacks.onRunError(message, kind, detail);
    },
  };

  const cleanup = () => {
    cleanupStreamState(state);
    streamRecovery.setReplayHandler(safeSessionId, null);
  };

  const { finish, tryResumeFinish } = createFinishController(
    approvalFlow,
    trackedCallbacks,
    cleanup,
    state,
    options?.finishTimeoutMs ?? 120000
  );

  const router = new EventRouter(
    state,
    approvalFlow,
    trackedCallbacks,
    runId,
    finish,
    tryResumeFinish,
    client,
    safeSessionId
  );

  streamRecovery.setReplayHandler(safeSessionId, (payload) => {
    router.applyReplayEvents(payload);
  });

  const ensureLiveSubscription = () => {
    if (state.finished || state.cancelled) return;
    if (!state.unsub) {
      state.unsub = client.onMessage((msg) => router.onMsg(msg));
    }
  };

  void createStreamSession(
    client,
    prompt,
    safeSessionId,
    runId,
    trackedCallbacks,
    options,
    state,
    (msg) => router.onMsg(msg),
    finish,
    assistantClientMessageId || undefined,
  ).then(() => {
    ensureLiveSubscription();
  });

  const cancel = createStreamCancel(
    client,
    runId,
    trackedCallbacks,
    approvalFlow,
    cleanup,
    state
  );

  // 透传 L2/L3 mode；无参默认 force 保持 replace/旧路径兼容
  const cancelWithMode: StreamCancelFn = (opts) => {
    markTerminal('failed', opts?.mode === 'cooperative' ? 'cancelled' : 'force_cancelled');
    cancel(opts);
  };
  return cancelWithMode;
}
