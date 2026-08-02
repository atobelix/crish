/**
 * Daemon stream connection lifecycle —— Tauri IPC transport 直连（C1.2 / C3.1）。
 *
 * ## Transport SoT
 * - **唯一通道**：`getTransport()`（TauriTransport，进程内核心直连，03 §3.1）。
 * - run-task 经 `startRunTask(transport, params)` 分派 `core_run_task`。
 * - 事件经 `transport.onMessage` → `router.onMsg`（listen('workbench-run-event')）。
 * - 核心未就绪（waitUntilConnected 超时）→ **拒绝启动**（C3.4：无 directFetch 降级）。
 *
 * ## 删除项（Phase C3.1 / C3.4）
 * - WS daemonClient / directFetch HTTP SSE 降级分支（ALLOW_AUTO_DIRECT_FETCH_FALLBACK 已删）；
 * - `state.transportAbort`（streamState）与 `recordTransportDegradedDirectFetch`（controlMetrics）；
 * - StreamRecovery 流恢复协议（reload/HMR 恢复由 Rust 事件通道有序保证，前端不再重放）。
 *
 * ## Cancel parity
 * - 取消经 `compositionRoot.runControl.dispatch`（L2/L3 → core_run_control）。
 */
import { getTransport, startRunTask, type Transport } from '../transport';
import type { StreamCallbacks, StreamRequestOptions } from '../chatApi';
import { toEnginePermissionMode } from '../permissionModes';
import { getPermissionMode } from '../storeAccess';
import { logInternalError, networkUserMessage } from '../userFacingErrors';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import { normalizeStreamSessionId } from './handlers/eventUtils';
import { type StreamState, cleanupStreamState } from './handlers/streamState';
import { EventRouter } from './EventRouter';
import { getCompositionRoot } from '../../app/compositionRoot';
import { RUN_CONTROL_LEVEL } from '@crish/shared-types';
/** Single SoT for cancel mode literals — do not redeclare in this package. */
import type { StreamCancelMode } from '../runControlClient';

export type { StreamCancelMode };

/**
 * 等待核心就绪并探测 get-status（AppBootstrap 启动门闩用）。
 * IPC 模式：waitUntilConnected 内部即 core_get_status 轮询，无需二次 request。
 */
export async function ensureEngineConnected(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const transport = getTransport();
  try {
    const ready = await transport.waitUntilConnected(20_000);
    if (!ready) {
      return { ok: false, error: networkUserMessage() };
    }
    return { ok: true };
  } catch (e) {
    logInternalError('ensureEngineConnected', e);
    return { ok: false, error: networkUserMessage(e) };
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

    // L2/L3 经 compositionRoot.runControl（metrics + EventBus + transport wire）
    void getCompositionRoot().runControl.dispatch({
      level:
        mode === 'cooperative'
          ? RUN_CONTROL_LEVEL.L2
          : RUN_CONTROL_LEVEL.L3,
      runId,
      reason: mode === 'cooperative' ? 'ui-stop' : 'ui-force-cancel',
    });

    state.finished = true;
    try {
      callbacks.onComplete();
    } catch {
      /* ignore */
    }
  };
}

/**
 * 创建流式 run（C1.2 主路径）：
 * 1. transport.waitUntilConnected(1.5s) —— 核心未就绪直接拒绝（无降级）；
 * 2. 挂 transport.onMessage（listen 事件通道）→ onMessage 回调；
 * 3. 组装 run-task 参数 → startRunTask 分派 core_run_task。
 *
 * 参数中 runId 为前端自管（03 §3.1），Rust 以请求携带 runId 回发事件。
 */
export async function createStreamSession(
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
  const transport = getTransport();
  try {
    const ready = await transport.waitUntilConnected(1_500);
    if (!ready || !transport.isReady()) {
      // C3.4：核心未就绪 → 拒绝启动（无 directFetch 降级）
      logInternalError(
        'stream-start-refuse-direct',
        new Error('engine not ready; no degraded fallback (C3.4)')
      );
      if (callbacks.onRunError) {
        callbacks.onRunError(networkUserMessage(), 'network');
      } else {
        callbacks.onChunk(networkUserMessage());
      }
      finish();
      return;
    }

    state.unsub = transport.onMessage(onMessage);
    callbacks.onThought('正在处理…');

    const { getWorkspacePath } = await import('../projectStore');
    const cwd = getWorkspacePath() || undefined;

    const mode = getPermissionMode();
    const permissionMode = toEnginePermissionMode(mode);

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

    await startRunTask(transport, {
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

/**
 * 产品流入口（chatApi.streamAssistantResponseApi 唯一调用）：
 * transport 事件订阅 → EventRouter 路由 → 审批/收口；返回 cancel 句柄。
 */
export function streamViaEngine(
  prompt: string,
  callbacks: StreamCallbacks,
  sessionId: string,
  assistantMsgId: string,
  options?: StreamRequestOptions
): () => void {
  const transport = getTransport();

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

  const cleanup = () => {
    cleanupStreamState(state);
  };

  const { finish, tryResumeFinish } = createFinishController(
    approvalFlow,
    callbacks,
    cleanup,
    state,
    options?.finishTimeoutMs ?? 120000
  );

  const router = new EventRouter(
    state,
    approvalFlow,
    callbacks,
    runId,
    finish,
    tryResumeFinish,
    transport,
    safeSessionId
  );

  void createStreamSession(
    prompt,
    safeSessionId,
    runId,
    callbacks,
    options,
    state,
    (msg) => router.onMsg(msg),
    finish,
    assistantClientMessageId || undefined,
  );

  const cancel = createStreamCancel(
    runId,
    callbacks,
    approvalFlow,
    cleanup,
    state
  );

  // 透传 L2/L3 mode；无参默认 force 保持 replace/旧路径兼容
  const cancelWithMode: StreamCancelFn = (opts) => {
    cancel(opts);
  };
  return cancelWithMode;
}
