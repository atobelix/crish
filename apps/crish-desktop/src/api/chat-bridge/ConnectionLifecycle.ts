/**
 * Daemon stream connection lifecycle —— Tauri IPC transport 直连（C1.2 / C3.1）。
 *
 * ## Transport SoT
 * - 唯一通道：getTransport()（TauriTransport，进程内核心直连，03 §3.1）。
 * - run-task 经 startRunTask(transport, params) 分派 core_run_task。
 * - 事件经 transport.onMessage → router.onMsg（listen('workbench-run-event')）。
 * - 核心未就绪（waitUntilConnected 超时）→ 拒绝启动（C3.4：无 directFetch 降级）。
 */
import { getTransport, startRunTask } from '../transport';
import type { StreamCallbacks, StreamRequestOptions } from '../chatApi';
import { toEnginePermissionMode } from '../permissionModes';
import { getPermissionMode } from '../storeAccess';
import {
  classifyErrorDomain,
  domainUserMessage,
  logInternalError,
  networkUserMessage,
} from '../userFacingErrors';
import type { ErrorDomain } from '../userFacingErrors';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import { normalizeStreamSessionId } from './handlers/eventUtils';
import { type StreamState, cleanupStreamState } from './handlers/streamState';
import { EventRouter } from './EventRouter';
import { getCompositionRoot } from '../../app/compositionRoot';
import { RUN_CONTROL_LEVEL } from '@crish/shared-types';
import type { StreamCancelMode } from '../runControlClient';
import type { Settings } from '../clientApi';
import { getActiveModelId, getActiveProfileId } from '../providerProfiles';
import { getModelMeta } from '../modelCatalog';

export type { StreamCancelMode };

export type ReadinessState = 'ok' | 'blocked_with_action' | 'retryable_wait';

export interface ReadinessGuidance {
  action: 'open-settings' | 'wait' | 'none';
  targetTab?: string;
  message: string;
}

export interface ReadinessCheckResult {
  ok: boolean;
  state: ReadinessState;
  domain: ErrorDomain | null;
  guidance?: ReadinessGuidance;
}

/** 动态重置就绪状态机（当收到配置变更或后端事件时调用） */
export function resetReadiness(): void {
  const transport = getTransport();
  if (
    typeof (transport as unknown as { resetReadiness?: () => void })
      .resetReadiness === 'function'
  ) {
    (transport as unknown as { resetReadiness: () => void }).resetReadiness();
  }
}

/** 响应式就绪监听器：收到 engine-status-changed 或 config-reloaded 事件时自愈同步 */
let readinessListenerSubscribed = false;

export function ensureReadinessSync(): void {
  if (readinessListenerSubscribed) return;
  readinessListenerSubscribed = true;
  try {
    const transport = getTransport();
    transport.onMessage((event) => {
      if (
        event?.type === 'engine-status-changed' ||
        event?.type === 'config-reloaded'
      ) {
        const isReady =
          event.engineReady === true ||
          event.engine_ready === true ||
          event.ready === true;
        if (!isReady) resetReadiness();
      }
    });
  } catch {
    /* swallow-ok */
  }
}

export {
  type HistoryMessage,
  HISTORY_TOKEN_BUDGET,
  HISTORY_MESSAGE_TOKEN_OVERHEAD,
  estimateTextTokens,
  estimateHistoryMessageTokens,
  truncateHistoryWithAnchor,
  buildHistoryMessages,
} from './historyMessages';
import { buildHistoryMessages, type HistoryMessage } from './historyMessages';

export function resolveContextWindow(
  sets?: Settings | null
): number | undefined {
  const explicit = (sets as { contextWindow?: unknown } | null)?.contextWindow;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0)
    return Math.floor(explicit);
  try {
    const profileId = getActiveProfileId(),
      model = getActiveModelId();
    if (profileId && model) {
      const meta = getModelMeta(profileId, model);
      if (typeof meta.contextLength === 'number' && meta.contextLength > 0)
        return meta.contextLength;
    }
  } catch {
    /* swallow-ok: 目录读取失败不发窗口 */
  }
  return undefined;
}

/**
 * 发送前真实就绪检查（03 §⑤ R7）：实时 core_get_status 查询，三态结构化返回值。
 */
export async function checkEngineReadyRealtime(
  timeoutMs = 3_000
): Promise<ReadinessCheckResult> {
  ensureReadinessSync();
  const transport = getTransport();
  let status: unknown;
  try {
    status = await transport.request<unknown>(
      'core_get_status',
      {},
      { timeoutMs }
    );
  } catch {
    /* swallow-ok: 查询失败放行，避免双重报错 */
    return {
      ok: true,
      state: 'ok',
      domain: null,
      guidance: { action: 'none', message: '' },
    };
  }
  const domain = classifyErrorDomain(status);
  if (domain === 'S2') {
    return {
      ok: false,
      state: 'blocked_with_action',
      domain: 'S2',
      guidance: {
        action: 'open-settings',
        targetTab: 'models',
        message: domainUserMessage('S2'),
      },
    };
  }
  if (domain) {
    return {
      ok: false,
      state: 'retryable_wait',
      domain,
      guidance: { action: 'wait', message: domainUserMessage(domain) },
    };
  }
  return {
    ok: true,
    state: 'ok',
    domain: null,
    guidance: { action: 'none', message: '' },
  };
}

export async function ensureEngineConnected(): Promise<{
  ok: boolean;
  error?: string;
}> {
  ensureReadinessSync();
  const transport = getTransport();
  try {
    const ready = await transport.waitUntilConnected(20_000);
    if (!ready) {
      return {
        ok: false,
        error: networkUserMessage(new Error('核心未就绪（等待连接超时）')),
      };
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

export function composeSystemPrompt(
  base: string | undefined,
  guidance: string | undefined
): string | undefined {
  const b = typeof base === 'string' ? base.trim() : '';
  const g = typeof guidance === 'string' ? guidance.trim() : '';
  if (b && g) return `${b}\n\n${g}`;
  return b || g || undefined;
}

function isRunDead(state: StreamState): boolean {
  return state.finished || state.cancelled;
}

const STYLE_DESCS: Record<string, string> = {
  minimal:
    'Response style: minimal. Prefer the shortest correct answer. Avoid preambles, lists, and restating the question.',
  low: 'Response style: concise. Keep answers short; use bullets only when they improve clarity. Skip lengthy explanations unless asked.',
  medium:
    'Response style: balanced. Be clear and complete without padding. Explain non-obvious steps briefly.',
  high: 'Response style: thorough. Provide structured reasoning, edge cases, and verification steps when useful. Still stay on-topic.',
};
const STYLE_ZH_MAP: Record<string, string> = {
  极简: 'minimal',
  简洁: 'low',
  适中: 'medium',
  深入: 'high',
};

export async function createStreamSession(
  prompt: string,
  sessionId: string,
  runId: string,
  callbacks: StreamCallbacks,
  options: StreamRequestOptions | undefined,
  state: StreamState,
  onMessage: (msg: Record<string, unknown>) => void,
  finish: (force?: boolean) => void,
  assistantClientMessageId?: string
): Promise<void> {
  const transport = getTransport();
  const safeSessionId = normalizeStreamSessionId(sessionId);
  const userClientMessageId =
    typeof options?.clientMessageId === 'string' &&
    options.clientMessageId.trim()
      ? options.clientMessageId.trim()
      : undefined;

  try {
    const ready = await transport.waitUntilConnected(1_500);
    if (isRunDead(state)) return;
    if (!ready || !transport.isReady()) {
      logInternalError(
        'stream-start-refuse-direct',
        new Error('engine not ready; no degraded fallback (C3.4)')
      );
      const msg = networkUserMessage(
        new Error('核心未就绪（waitUntilConnected 超时）')
      );
      if (callbacks.onRunError) callbacks.onRunError(msg, 'network');
      else callbacks.onChunk(msg);
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

    let mcpDisabledTools: Record<string, string[]> | undefined;
    let reasoningEffort: string | undefined;
    let responseStyleGuidance: string | undefined;
    let contextWindow: number | undefined;
    try {
      const { clientApi } = await import('../clientApi');
      const sets = await clientApi.getSettingsEx(cwd || '__global__');
      if (
        sets?.mcpDisabledTools &&
        Object.keys(sets.mcpDisabledTools).length > 0
      ) {
        mcpDisabledTools = sets.mcpDisabledTools;
      }
      // I1-β：defaultThinkingLevel → ReasoningEffort（wire 值 = 枚举字面量）
      const tl = String(sets?.defaultThinkingLevel || '')
        .trim()
        .toLowerCase();
      if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(tl)) {
        reasoningEffort = tl;
      }

      const rawStyle = String(sets?.responseStyle ?? 'medium');
      const resolvedKey = STYLE_ZH_MAP[rawStyle] || rawStyle.toLowerCase();
      responseStyleGuidance = STYLE_DESCS[resolvedKey] ?? STYLE_DESCS.medium;
      contextWindow = resolveContextWindow(sets);
    } catch {
      /* swallow-ok: 设置解析失败按默认执行 */
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
    const systemPrompt = composeSystemPrompt(
      options?.systemPrompt,
      responseStyleGuidance
    );
    const asstClientMessageId =
      (typeof assistantClientMessageId === 'string' &&
      assistantClientMessageId.trim()
        ? assistantClientMessageId.trim()
        : undefined) ||
      (typeof options?.assistantClientMessageId === 'string' &&
      options.assistantClientMessageId.trim()
        ? options.assistantClientMessageId.trim()
        : undefined);

    let history: HistoryMessage[] | undefined;
    try {
      const { loadSessionBody } =
        await import('../session-persistence/sessionRustDb');
      const body = await loadSessionBody(safeSessionId);
      history = buildHistoryMessages(body, { excludeId: userClientMessageId });
    } catch {
      /* swallow-ok: 历史加载失败不阻塞 run */
    }

    if (isRunDead(state)) return;

    // I1-α②：取走暂存 context-state → run-task 下发 → 队列去重注入；取走即清空
    const contextState = (
      await import('../provider-profiles/contextStatePending')
    ).takePendingContextState();

    await startRunTask(transport, {
      runId,
      prompt,
      sessionId: safeSessionId,
      permissionMode,
      ...(cwd ? { cwd } : {}),
      ...(mcpDisabledTools ? { mcpDisabledTools } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(contextState ? { contextState } : {}),
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
      ...(history ? { history } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(userClientMessageId ? { clientMessageId: userClientMessageId } : {}),
      ...(asstClientMessageId
        ? { assistantClientMessageId: asstClientMessageId }
        : {}),
    });
  } catch (e) {
    const text =
      typeof e === 'object' && e !== null
        ? (e as { message?: string }).message || String(e)
        : String(e);
    const domain = classifyErrorDomain(e);
    const isSessionBusy =
      domain === 'S7' || /SESSION_BUSY|已有活动 run|串行守卫/i.test(text);

    if (isSessionBusy) {
      logInternalError('stream-start-busy-queued', e);
      try {
        const root = getCompositionRoot();
        if (userClientMessageId) {
          root.session
            .getState()
            .setSessionMessageStatus(
              safeSessionId,
              userClientMessageId,
              'queued'
            );
        }
        void root.runControl.followUp({
          runId: null,
          sessionId: safeSessionId,
          text: prompt,
          clientMessageId: userClientMessageId,
          reason: 'serial-guard-auto-queue',
        });
      } catch (err) {
        logInternalError('stream-start-busy-followup', err);
      }
      if (callbacks.onThought)
        callbacks.onThought('当前会话上一轮任务仍在收尾中，已自动为您排队…');
      finish();
      return;
    }

    logInternalError('stream-start', e);
    const msg = networkUserMessage(e);
    if (callbacks.onRunError) callbacks.onRunError(msg, 'network');
    else callbacks.onChunk(msg);
    finish();
  }
}

export function streamViaEngine(
  prompt: string,
  callbacks: StreamCallbacks,
  sessionId: string,
  assistantMsgId: string,
  options?: StreamRequestOptions
): StreamCancelFn {
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
  const assistantClientMessageId =
    (typeof assistantMsgId === 'string' && assistantMsgId.trim()) ||
    (typeof options?.assistantClientMessageId === 'string' &&
      options.assistantClientMessageId.trim()) ||
    '';
  try {
    callbacks.onRunMeta?.({ runId });
  } catch {
    /* swallow-ok: meta 回调失败不阻断 */
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
    assistantClientMessageId || undefined
  );
  const cancel = createStreamCancel(
    runId,
    callbacks,
    approvalFlow,
    cleanup,
    state
  );
  return cancel;
}
