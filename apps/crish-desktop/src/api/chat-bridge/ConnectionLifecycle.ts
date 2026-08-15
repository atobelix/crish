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
import type { SessionMessage } from '../../store/types';
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

export interface HistoryMessage {
  id: string;
  sender: 'user' | 'assistant';
  text?: string;
  thinking?: string;
  tool_calls_json?: string;
  tool_call_results_json?: string;
  status?: string;
  timestamp: number;
}

export const HISTORY_TOKEN_BUDGET = 200_000;
export const HISTORY_MESSAGE_TOKEN_OVERHEAD = 8;

export function estimateTextTokens(text: string | undefined): number {
  if (!text || text.length === 0) return 0;
  let tokens = 0;
  let wordChars = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const isSep =
      code <= 0x20 ||
      (code >= 0x21 && code <= 0x2f) ||
      (code >= 0x3a && code <= 0x40) ||
      (code >= 0x5b && code <= 0x60) ||
      (code >= 0x7b && code <= 0x7e);
    if (code < 0x80) {
      if (isSep) {
        if (wordChars > 0) {
          tokens += Math.ceil(wordChars / 4);
          wordChars = 0;
        }
        tokens += 1;
      } else {
        wordChars += 1;
      }
    } else {
      if (wordChars > 0) {
        tokens += Math.ceil(wordChars / 4);
        wordChars = 0;
      }
      tokens += 1;
    }
  }
  if (wordChars > 0) tokens += Math.ceil(wordChars / 4);
  return Math.max(tokens, 1);
}

export function estimateHistoryMessageTokens(msg: HistoryMessage): number {
  return (
    estimateTextTokens(msg.text) +
    estimateTextTokens(msg.thinking) +
    estimateTextTokens(msg.tool_calls_json) +
    estimateTextTokens(msg.tool_call_results_json) +
    HISTORY_MESSAGE_TOKEN_OVERHEAD
  );
}

function isHistoryEligible(msg: SessionMessage): boolean {
  return msg.status === undefined || msg.status === 'completed';
}

function jsonFieldOrUndefined<T>(value: T[] | undefined): string | undefined {
  if (!value || value.length === 0) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function truncateHistoryWithAnchor(
  history: HistoryMessage[],
  budget: number
): HistoryMessage[] {
  const perMessageTokens = history.map(estimateHistoryMessageTokens);
  const total = perMessageTokens.reduce((sum, n) => sum + n, 0);
  if (total <= budget) return history;
  const anchorIdx = history.findIndex((m) => m.sender === 'user');
  const anchorEnd = anchorIdx === -1 ? 0 : anchorIdx;
  const headTokens = perMessageTokens
    .slice(0, anchorEnd + 1)
    .reduce((sum, n) => sum + n, 0);
  let tailStart = anchorEnd + 1;
  let tailTokens = total - headTokens;
  while (tailStart < history.length && headTokens + tailTokens > budget) {
    tailTokens -= perMessageTokens[tailStart] ?? 0;
    tailStart += 1;
  }
  return [...history.slice(0, anchorEnd + 1), ...history.slice(tailStart)];
}

export function buildHistoryMessages(
  messages: readonly SessionMessage[] | undefined | null,
  opts?: { tokenBudget?: number; excludeId?: string }
): HistoryMessage[] | undefined {
  const source = messages ?? [];
  const rawBudget = opts?.tokenBudget;
  const budget =
    typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0
      ? Math.floor(rawBudget)
      : HISTORY_TOKEN_BUDGET;
  const excludeId = opts?.excludeId;
  const history: HistoryMessage[] = [];
  for (const msg of source) {
    if (msg.sender !== 'user' && msg.sender !== 'assistant') continue;
    if (!isHistoryEligible(msg)) continue;
    if (excludeId && msg.id === excludeId) continue;
    const entry: HistoryMessage = {
      id: msg.id,
      sender: msg.sender,
      timestamp: msg.timestamp,
    };
    if (typeof msg.text === 'string' && msg.text) entry.text = msg.text;
    if (typeof msg.thinking === 'string' && msg.thinking)
      entry.thinking = msg.thinking;
    const toolCallsJson = jsonFieldOrUndefined(msg.toolCalls);
    if (toolCallsJson) entry.tool_calls_json = toolCallsJson;
    const resultsJson = jsonFieldOrUndefined(msg.toolCallResults);
    if (resultsJson) entry.tool_call_results_json = resultsJson;
    if (msg.status) entry.status = msg.status;
    history.push(entry);
  }
  return history.length > 0
    ? truncateHistoryWithAnchor(history, budget)
    : undefined;
}

export function resolveContextWindow(
  sets?: Settings | null
): number | undefined {
  const explicit = (sets as { contextWindow?: unknown } | null)?.contextWindow;
  if (
    typeof explicit === 'number' &&
    Number.isFinite(explicit) &&
    explicit > 0
  ) {
    return Math.floor(explicit);
  }
  try {
    const profileId = getActiveProfileId();
    const model = getActiveModelId();
    if (profileId && model) {
      const meta = getModelMeta(profileId, model);
      if (typeof meta.contextLength === 'number' && meta.contextLength > 0)
        return meta.contextLength;
    }
  } catch {
    /* swallow-ok */
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
      /* swallow-ok */
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
      /* swallow-ok */
    }
  };
}

export function composeSystemPrompt(
  base: string | undefined,
  guidance: string | undefined
): string | undefined {
  const baseTrimmed = typeof base === 'string' ? base.trim() : '';
  const guidanceTrimmed = typeof guidance === 'string' ? guidance.trim() : '';
  if (baseTrimmed && guidanceTrimmed)
    return `${baseTrimmed}\n\n${guidanceTrimmed}`;
  if (baseTrimmed) return baseTrimmed;
  if (guidanceTrimmed) return guidanceTrimmed;
  return undefined;
}

function isRunDead(state: StreamState): boolean {
  return state.finished || state.cancelled;
}

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
    let budgetDifficulty: string | undefined;
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
      const tl = String(sets?.defaultThinkingLevel || '')
        .trim()
        .toLowerCase();
      if (tl === 'minimal' || tl === 'low') budgetDifficulty = 'easy';
      else if (tl === 'medium') budgetDifficulty = 'normal';
      else if (tl === 'high' || tl === 'xhigh') budgetDifficulty = 'hard';

      const styleKey = String(sets?.responseStyle ?? 'medium').toLowerCase();
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
      responseStyleGuidance = styleMap[styleKey] ?? styleMap.medium;
      contextWindow = resolveContextWindow(sets);
    } catch {
      /* swallow-ok */
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
      /* swallow-ok */
    }

    if (isRunDead(state)) return;

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
          root.layout
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
  const assistantClientMessageId =
    (typeof assistantMsgId === 'string' && assistantMsgId.trim()) ||
    (typeof options?.assistantClientMessageId === 'string' &&
      options.assistantClientMessageId.trim()) ||
    '';
  try {
    callbacks.onRunMeta?.({ runId });
  } catch {
    /* swallow-ok */
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
  const cancelWithMode: StreamCancelFn = (opts) => {
    cancel(opts);
  };
  return cancelWithMode;
}
