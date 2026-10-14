/**
 * 流会话创建与取消入口（从 ConnectionLifecycle 拆出，纯结构性）。
 *
 * run-task 经 startRunTask(transport, params) 分派 core_run_task。
 * 事件经 transport.onMessage → router.onMsg（listen('workbench-run-event')）。
 */
import { getTransport, startRunTask } from '../transport';
import type { StreamCallbacks, StreamRequestOptions } from '../chatApi';
import { toEnginePermissionMode } from '../permissionModes';
import { getPermissionMode, getSessionById } from '../storeAccess';
import {
  classifyErrorDomain,
  logInternalError,
  networkUserMessage,
} from '../userFacingErrors';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import { normalizeStreamSessionId } from './handlers/eventUtils';
import { type StreamState, cleanupStreamState } from './handlers/streamState';
import { EventRouter } from './EventRouter';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  composeSystemPrompt,
  createFinishController,
  createStreamCancel,
  type StreamCancelFn,
} from './streamFinishControl';
import {
  resolveContextWindow,
  resolveSendThinkingFields,
  ENGINE_SEND_GATE_TIMEOUT_MS,
} from './readiness';
import { type HistoryMessage, buildHistoryMessages } from './historyMessages';
import { clearBusy, noteBusy } from '../sessionStreamManager';
import {
  getResponseStyleDescription,
  resolveResponseStyle,
} from '../../prompts';
import type { SessionMessage } from '../../store/types';

function isRunDead(state: StreamState): boolean {
  return state.finished || state.cancelled;
}

/**
 * 锚定历史消息到最新的压缩摘要块，防止跨轮全量正文复活。
 * 保留系统消息、折叠链消息（compacted-summary-*）、最新的摘要块以及其后的所有保留消息；
 * 过滤掉最新摘要块之前已被折叠的历史正文消息。
 */
export function anchorHistoryToLatestSummary(
  messages: readonly SessionMessage[] | undefined | null
): SessionMessage[] {
  if (!messages || messages.length === 0) return [];

  let lastSummaryIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg &&
      (msg.id.startsWith('compacted-summary') ||
        Boolean(
          (msg.metadata as Record<string, unknown> | undefined)
            ?.isCompactedSummary
        ))
    ) {
      lastSummaryIdx = i;
      break;
    }
  }

  if (lastSummaryIdx === -1) {
    return [...messages];
  }

  const result: SessionMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (i >= lastSummaryIdx) {
      result.push(msg);
    } else {
      const isSystem = (msg.sender as string) === 'system';
      const isCompacted =
        msg.id.startsWith('compacted-summary') ||
        Boolean(
          (msg.metadata as Record<string, unknown> | undefined)
            ?.isCompactedSummary
        );
      if (isSystem || isCompacted) {
        result.push(msg);
      }
    }
  }

  return result;
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
    const mode = getPermissionMode();
    const permissionMode = toEnginePermissionMode(mode);
    const hasImages = Boolean(
      options?.hasImages ||
      options?.content?.some((p) => p.type === 'image_url')
    );

    let mcpDisabledTools: Record<string, string[]> | undefined;
    let thinkingTitle: string | undefined;
    let thinkingWire: string | undefined;
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

    const optionWire =
      typeof options?.thinkingWire === 'string' && options.thinkingWire.trim()
        ? options.thinkingWire.trim()
        : undefined;
    const optionTitle =
      typeof options?.thinkingTitle === 'string' && options.thinkingTitle.trim()
        ? options.thinkingTitle.trim()
        : undefined;
    if (optionWire) {
      thinkingWire = optionWire;
      thinkingTitle = optionTitle;
    } else {
      const fields = resolveSendThinkingFields(safeSessionId, optionTitle);
      thinkingTitle = fields.thinkingTitle;
      thinkingWire = fields.thinkingWire;
    }
    const reasoningEffort = thinkingWire || thinkingTitle;

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
      let body: SessionMessage[] | undefined;
      try {
        const { loadSessionBody } =
          await import('../session-persistence/sessionRustDb');
        body = await loadSessionBody(safeSessionId);
      } catch {
        /* swallow-ok: 历史加载失败不阻塞 run */
      }
      // 若内存 store 中的消息更完整（例如尚未完成 SQLite 写防抖的上一轮最新助手回复），
      // 或内存包含最新压缩折叠摘要（此时内存条数少于未清理的 SQLite 全量正文），
      // 优先采用内存中的真实会话消息，防止上一轮助手回复在历史装配中湮灭或旧正文复活
      const memSession = getSessionById(safeSessionId);
      const memMsgs = memSession?.messages;
      const memHasSummary = Boolean(
        memMsgs?.some(
          (m) =>
            m.id.startsWith('compacted-summary') ||
            Boolean(
              (m.metadata as Record<string, unknown> | undefined)
                ?.isCompactedSummary
            )
        )
      );
      if (memMsgs && (memHasSummary || memMsgs.length > (body?.length ?? 0))) {
        body = memMsgs;
      }
      const anchoredBody = anchorHistoryToLatestSummary(body);
      history = buildHistoryMessages(anchoredBody, {
        excludeId: userClientMessageId,
      });
    } catch {
      /* swallow-ok: 历史加载失败不阻塞 run */
    }

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

    await startRunTask(transport, {
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
      ...(userClientMessageId ? { clientMessageId: userClientMessageId } : {}),
      ...(asstClientMessageId
        ? { assistantClientMessageId: asstClientMessageId }
        : {}),
    });
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
        const root = getCompositionRoot();
        if (userClientMessageId) {
          noteBusy(safeSessionId, userClientMessageId);
          // processing → queued 需 force（StatusTransitionGuard）
          root.session
            .getState()
            .setSessionMessageStatus(
              safeSessionId,
              userClientMessageId,
              'queued',
              undefined,
              { force: true }
            );
        }
        if (assistantClientMessageId) {
          root.session
            .getState()
            .withdrawMessage('', safeSessionId, assistantClientMessageId);
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
