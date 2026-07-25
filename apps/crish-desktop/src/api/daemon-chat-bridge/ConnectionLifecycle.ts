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
  timeoutMs = 8000
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

export function createStreamCancel(
  client: ReturnType<typeof getDesktopDaemonClient>,
  runId: string,
  callbacks: StreamCallbacks,
  approvalFlow: ApprovalFlowMachine,
  cleanup: () => void,
  state: StreamState
): () => void {
  return () => {
    if (state.finished) return;
    state.cancelled = true;
    approvalFlow.dispatch({ type: 'clear_all' });
    approvalFlow.dispatch({ type: 'force_finish' });
    cleanup();
    void Promise.resolve(client.send({ type: 'cancel-run', runId })).catch(
      () => undefined
    );
    state.finished = true;
    try {
      callbacks.onComplete();
    } catch {
      /* ignore */
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
  finish: (force?: boolean) => void
): Promise<void> {
  try {
    const ready = await client.waitUntilConnected(1_500);
    if (!ready || !client.isConnected()) {
      const { streamViaDirectFetch } = await import('../directFetchBridge');
      streamViaDirectFetch(prompt, callbacks, sessionId, runId, options);
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
  };
  const approvalFlow = new ApprovalFlowMachine();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  void assistantMsgId;
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
    options?.finishTimeoutMs ?? 8000
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
    finish
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

  return () => {
    markTerminal('failed', 'cancelled');
    cancel();
  };
}
