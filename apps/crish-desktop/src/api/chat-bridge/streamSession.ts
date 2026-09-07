/**
 * 流会话创建与取消入口（从 ConnectionLifecycle 拆出，纯结构性）。
 *
 * run-task 经 startRunTask(transport, params) 分派 core_run_task。
 * 事件经 transport.onMessage → router.onMsg（listen('workbench-run-event')）。
 */
import { getTransport, startRunTask } from '../transport';
import type { StreamCallbacks, StreamRequestOptions } from '../chatApi';
import { toEnginePermissionMode } from '../permissionModes';
import { getPermissionMode } from '../storeAccess';
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
import { resolveContextWindow } from './readiness';
import { type HistoryMessage, buildHistoryMessages } from './historyMessages';
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
  const userClientMessageId =
    typeof options?.clientMessageId === 'string' &&
    options.clientMessageId.trim()
      ? options.clientMessageId.trim()
      : undefined;

  try {
    const ready = await transport.waitUntilConnected(1_500);
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

      // 响应风格：设置值经 resolveResponseStyle 归一为 wire 档位后，
      // 取英文单行描述（行为等价原 STYLE_ZH_MAP/STYLE_DESCS 硬编码字典，文本源迁至 prompts SSOT）
      const styleLevel = resolveResponseStyle(sets?.responseStyle);
      responseStyleGuidance = getResponseStyleDescription(styleLevel, 'en-US');
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

    if (isRunDead(state)) {
      cleanupStreamState(state);
      return;
    }

    // I1-α②：取走暂存 context-state（会话寻址——仅消费绑定本会话或未绑定
    // 的暂存，跨会话串扰根除）→ run-task 下发 → 队列去重注入；取走即清空。
    // 纪律：消息发送前无论变动几次均不显示不注入；仅在正式发消息时顺带携带注入
    const contextState = (
      await import('../provider-profiles/contextStatePending')
    ).takePendingContextState(safeSessionId);

    if (contextState) {
      try {
        const { contextInjectionDispatcher } = await import(
          '../contextInjectionDispatcher'
        );
        const { readContextStateSnapshot } = await import(
          '../provider-profiles/contextStatePending'
        );
        const snapshot = readContextStateSnapshot();
        const rawText = typeof contextState === 'string' ? contextState : contextState?.text || '';
        const model = (typeof contextState === 'object' && contextState?.model) || snapshot.model || undefined;
        const profile = (typeof contextState === 'object' && contextState?.profile) || snapshot.profile || undefined;
        const permission = (typeof contextState === 'object' && contextState?.permission) || snapshot.permission || undefined;
        const thinking = (typeof contextState === 'object' && contextState?.thinking) || snapshot.thinking || undefined;

        contextInjectionDispatcher.inject(safeSessionId, {
          kind: 'workspace_env',
          title: '上下文状态切换',
          summary: rawText,
          status: 'injected',
          source: 'system_event',
          content: rawText,
          metadata: {
            mode: 'context-state',
            ...(model ? { model } : {}),
            ...(profile ? { profile } : {}),
            ...(permission ? { permission } : {}),
            ...(thinking ? { thinking } : {}),
          },
        });
      } catch {
        /* swallow-ok: 提示卡片注入失败不阻断 run 核心调用 */
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
      ...(contextState ? { contextState: contextState.text } : {}),
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
