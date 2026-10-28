/**
 * 流会话创建与取消入口（从 ConnectionLifecycle 拆出，纯结构性）。
 *
 * run-task 经 startRunTask(transport, params) 分派 core_run_task。
 * 事件经 transport.onMessage → router.onMsg（listen('workbench-run-event')）。
 */
import { getTransport, startRunTask } from '../transport';
import type { StreamCallbacks, StreamRequestOptions } from '../chatApi';
import { getPermissionMode, getSessionStoreState } from '../storeAccess';
import {
  classifyErrorDomain,
  logInternalError,
  networkUserMessage,
} from '../userFacingErrors';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import { normalizeStreamSessionId } from './handlers/eventUtils';
import { type StreamState, cleanupStreamState } from './handlers/streamState';
import { EventRouter } from './EventRouter';
import {
  composeSystemPrompt,
  createFinishController,
  createStreamCancel,
  type StreamCancelFn,
} from './streamFinishControl';
import { resolveContextWindow, ENGINE_SEND_GATE_TIMEOUT_MS } from './readiness';
import { loadRunHistory } from './runHistory';
import { anchorHistoryToLatestSummary } from './historyMessages';
import {
  resolveRunGoalOptions,
  resolveRunThinking,
  resolveUserClientMessageId,
} from './runTaskOptions';
export { anchorHistoryToLatestSummary };
import { clearBusy, noteBusy } from '../sessionStreamManager';
import {
  getResponseStyleDescription,
  resolveResponseStyle,
} from '../../prompts';

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
  const userClientMessageId = resolveUserClientMessageId(options);

  try {
    const ready = await transport.waitUntilConnected(
      ENGINE_SEND_GATE_TIMEOUT_MS
    );
    if (isRunDead(state)) {
      cleanupStreamState(state);
      return;
    }
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

    if (isRunDead(state)) {
      cleanupStreamState(state);
      return;
    }
    state.unsub = transport.onMessage(onMessage);

    const { getWorkspacePath } = await import('../projectStore');
    const cwd = getWorkspacePath() || undefined;
    const permissionMode = getPermissionMode();
    const hasImages = Boolean(
      options?.hasImages ||
      options?.content?.some((p) => p.type === 'image_url')
    );

    let mcpDisabledTools: Record<string, string[]> | undefined;
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

      // 响应风格：设置值经 resolveResponseStyle 归一为 wire 档位后，
      // 取英文单行描述（行为等价原 STYLE_ZH_MAP/STYLE_DESCS 硬编码字典，文本源迁至 prompts SSOT）
      const styleLevel = resolveResponseStyle(sets?.responseStyle);
      responseStyleGuidance = getResponseStyleDescription(styleLevel, 'en-US');
      contextWindow = resolveContextWindow(sets);
    } catch {
      /* swallow-ok: 设置解析失败按默认执行 */
    }

    const { thinkingTitle, thinkingWire, reasoningEffort } = resolveRunThinking(
      options,
      safeSessionId
    );
    const {
      goalMode,
      visibleGoal,
      maxRounds,
      maxStalledRounds,
      asstClientMessageId,
    } = resolveRunGoalOptions(options, assistantClientMessageId);
    const systemPrompt = composeSystemPrompt(
      options?.systemPrompt,
      responseStyleGuidance
    );

    const history = await loadRunHistory(safeSessionId, userClientMessageId);

    if (isRunDead(state)) {
      cleanupStreamState(state);
      return;
    }

    // I1-α②：若发送瞬间未消费则兜底取走暂存 context-state（仅供引擎入参，绝不在流式中异步向前端补插卡片）
    let contextStateText = options?.contextState;
    if (!contextStateText) {
      const pending = (
        await import('../provider-profiles/contextStatePending')
      ).takePendingContextState(safeSessionId);
      if (pending) {
        contextStateText =
          typeof pending === 'string' ? pending : pending?.text || '';
      }
    }

    if (isRunDead(state)) {
      cleanupStreamState(state);
      return;
    }

    await startRunTask(
      transport,
      {
        runId,
        prompt,
        sessionId: safeSessionId,
        permissionMode,
        ...(cwd ? { cwd } : {}),
        ...(mcpDisabledTools ? { mcpDisabledTools } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(thinkingTitle ? { thinkingTitle } : {}),
        ...(thinkingWire ? { thinkingWire } : {}),
        ...(contextStateText ? { contextState: contextStateText } : {}),
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
        ...(userClientMessageId
          ? { clientMessageId: userClientMessageId }
          : {}),
        ...(asstClientMessageId
          ? { assistantClientMessageId: asstClientMessageId }
          : {}),
      },
      () => getWorkspacePath() || undefined
    );
    // run 已被后端受理：串行守卫退避计数归零
    if (userClientMessageId) clearBusy(userClientMessageId);
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
      // P1-d 方案 B：只走前端 drain（useGoalMode 按 busyRetry 计数退避重发，
      // 用尽后 queued → error + ComposerErrorBar）。不再 followUp：runId 为空
      // 的 core_run_control 到不了后端 follow_up 环（静默空调用）。
      try {
        const sessionStore = getSessionStoreState();
        if (userClientMessageId) {
          noteBusy(safeSessionId, userClientMessageId);
          // processing → queued 需 force（StatusTransitionGuard）
          sessionStore.setSessionMessageStatus(
            safeSessionId,
            userClientMessageId,
            'queued',
            undefined,
            { force: true }
          );
        }
        if (assistantClientMessageId) {
          sessionStore.withdrawMessage(
            '',
            safeSessionId,
            assistantClientMessageId
          );
        }
      } catch (err) {
        logInternalError('stream-start-busy-queue-state', err);
      }
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
