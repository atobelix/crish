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
import { getTransport, startRunTask } from '../transport';
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
import type { Settings } from '../clientApi';
import type { SessionMessage } from '../../store/types';
import { getActiveModelId, getActiveProfileId } from '../providerProfiles';
import { getModelMeta } from '../modelCatalog';

export type { StreamCancelMode };

/**
 * P4 §3.7 / T-27 前端投影：`core_run_task.history` 水合载荷（camelCase，
 * 与 Rust `conex-types::history::HistoryMessage` 的 serde 字段名对齐）。
 * - `id` / `sender` / `timestamp` 必填；`text` / `thinking` /
 *   `tool_calls_json` / `tool_call_results_json` / `status` 可选；
 * - `blocks_json` 不在此组装：前端 timeline 形状与 `AgentMessageBlock`
 *   序列不兼容（T-28 实测），引擎 hydrate 模块对缺块字段走
 *   text/thinking/tool_calls_json 合成兜底（hydrate.rs resolve_blocks）。
 */
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

/** 历史回流长度上限：最近 N 条（T-31；窗口内预算兜底在引擎侧，前端只截尾部） */
export const HISTORY_CAP = 100;

/**
 * 完成态过滤（对齐引擎 hydrate.rs 规则 1）：`completed` 或无 status（旧数据）
 * 才进上下文；queued/processing/error/空串 一律跳过（半成品不进 LLM）。
 */
function isHistoryEligible(msg: SessionMessage): boolean {
  return msg.status === undefined || msg.status === 'completed';
}

/** 数组字段 → JSON 字符串（空数组 / 序列化失败 → undefined，与 sessionRustDb 写面同语义） */
function jsonFieldOrUndefined<T>(value: T[] | undefined): string | undefined {
  if (!value || value.length === 0) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * P4 T-31：会话存储消息 → `history` 载荷组装（纯函数）。
 * - 仅 user/assistant 且完成态消息进上下文（System/Tool 是 run 内瞬态角色，跨 run 不回传）；
 * - 字段按 HistoryMessage 组装：sender/text/thinking/tool_calls_json/
 *   tool_call_results_json/status/timestamp（camelCase）；
 * - 上限截断：取最近 `cap` 条（缺省 HISTORY_CAP；超长会话只回传尾部窗口）；
 * - `excludeId`：排除当前 run 的 user 消息 id（避免历史与 prompt 重复下发）；
 * - 空会话 / 全被过滤 → `undefined`（不传 = 引擎现状单消息 run，向后兼容）。
 */
export function buildHistoryMessages(
  messages: readonly SessionMessage[] | undefined | null,
  opts?: { cap?: number; excludeId?: string }
): HistoryMessage[] | undefined {
  const source = messages ?? [];
  const rawCap = opts?.cap;
  const cap =
    typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0
      ? Math.floor(rawCap)
      : HISTORY_CAP;
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
    if (typeof msg.thinking === 'string' && msg.thinking) {
      entry.thinking = msg.thinking;
    }
    const toolCallsJson = jsonFieldOrUndefined(msg.toolCalls);
    if (toolCallsJson) entry.tool_calls_json = toolCallsJson;
    const resultsJson = jsonFieldOrUndefined(msg.toolCallResults);
    if (resultsJson) entry.tool_call_results_json = resultsJson;
    if (msg.status) entry.status = msg.status;
    history.push(entry);
  }
  return history.length > 0
    ? history.slice(Math.max(0, history.length - cap))
    : undefined;
}

/**
 * P4 T-31：`contextWindow` 解析（P3 模型目录接线前的本地真源，core_run_task
 * 入站为 `Option<u32>`，T-33 预算钳制消费）。
 * 优先级：显式设置键（预留，Settings.contextWindow）→ 生效模型 catalog
 * 元数据（`getModelMeta(activeProfile, activeModel).contextLength`）→
 * `undefined`（缺省不发，引擎未启用钳制 = 现状）。
 */
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
      if (typeof meta.contextLength === 'number' && meta.contextLength > 0) {
        return meta.contextLength;
      }
    }
  } catch {
    /* ignore：目录读取失败不发窗口 */
  }
  return undefined;
}

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
        mode === 'cooperative' ? RUN_CONTROL_LEVEL.L2 : RUN_CONTROL_LEVEL.L3,
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
 * P1：systemPrompt 组装纯函数化——消除三形态漂移。
 * 规则：base 与 guidance 各自 trim 后按固定分隔符 "\n\n" 拼接；
 * guidance 为空 → 仅 base；base 为空 → 仅 guidance；两者皆空 → undefined。
 * 删除 base.includes('Response style:') 特殊分支（同一配置下形态唯一）。
 */
export function composeSystemPrompt(
  base: string | undefined,
  guidance: string | undefined
): string | undefined {
  const baseTrimmed = typeof base === 'string' ? base.trim() : '';
  const guidanceTrimmed = typeof guidance === 'string' ? guidance.trim() : '';
  if (baseTrimmed && guidanceTrimmed) {
    return `${baseTrimmed}\n\n${guidanceTrimmed}`;
  }
  if (baseTrimmed) return baseTrimmed;
  if (guidanceTrimmed) return guidanceTrimmed;
  return undefined;
}

/**
 * P1-F2（F5-04）取消竞态判定：run 是否已死（cancelled / finished）。
 *
 * 根因：createStreamSession 对 createStreamCancel 为异步并发（fire-and-forget），
 * waitUntilConnected 挂起期间用户点停止 → cancel 置 cancelled/finished 并派发 L3
 * force_cancel；若 createStreamSession 在 await 恢复后不检查取消态，仍会订阅并
 * startRunTask 派发 core_run_task——run 实际启动，且 force_cancel 早于 run 到达
 * 引擎时取消目标不存在而失效。
 *
 * 修复机制：启动流与取消共享同一 state 对象 = 取消信号自然传播到等待方；每个
 * await 点恢复后先经本判定短路（命中 → 静默 return，不启动 run、不再回调）。
 */
function isRunDead(state: StreamState): boolean {
  return state.finished || state.cancelled;
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
  assistantClientMessageId?: string
): Promise<void> {
  const transport = getTransport();
  try {
    const ready = await transport.waitUntilConnected(1_500);
    // P1-F2（F5-04）①：等待连接期间用户点了停止（createStreamCancel 已置
    // cancelled/finished 并派发 force_cancel）→ 不订阅、不 onChunk/onRunError、
    // 不启动 run，静默返回（cancel 已自行收口 onComplete）。
    if (isRunDead(state)) return;
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
    let responseStyleGuidance: string | undefined;
    // P4 T-31：生效模型窗口（P3 目录接线前由前端下发；缺省不发 = 引擎不钳制）
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
      // 只含 styleMap 映射文案（不含 base），与 base 的拼接统一走 composeSystemPrompt
      responseStyleGuidance =
        styleMap[styleKey] ??
        styleMap[styleKey.toLowerCase()] ??
        styleMap.medium;

      // P4 T-31：contextWindow 解析（设置预留键 → 生效模型 catalog；缺省 undefined）
      contextWindow = resolveContextWindow(sets);
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

    const systemPrompt = composeSystemPrompt(
      options?.systemPrompt,
      responseStyleGuidance
    );

    const userClientMessageId =
      typeof options?.clientMessageId === 'string' &&
      options.clientMessageId.trim()
        ? options.clientMessageId.trim()
        : undefined;
    const asstClientMessageId =
      (typeof assistantClientMessageId === 'string' &&
      assistantClientMessageId.trim()
        ? assistantClientMessageId.trim()
        : undefined) ||
      (typeof options?.assistantClientMessageId === 'string' &&
      options.assistantClientMessageId.trim()
        ? options.assistantClientMessageId.trim()
        : undefined);

    // P4 T-31：历史回流组装（loadSessionBody 为 UI 读面真源，sessionRustDb.ts:499-504）。
    // 排除当前 run 的 user 消息 id（历史与 prompt 不重复）；空会话 / 加载失败 /
    // 全被完成态过滤 → undefined 不发（引擎回退 SessionHistoryCache 或现状单消息）。
    let history: HistoryMessage[] | undefined;
    try {
      const { loadSessionBody } =
        await import('../session-persistence/sessionRustDb');
      const body = await loadSessionBody(safeSessionId);
      history = buildHistoryMessages(body, { excludeId: userClientMessageId });
    } catch {
      /* ignore：历史加载失败不阻塞 run（向后兼容） */
    }

    // P1-F2（F5-04）②：参数组装（动态 import / getSettingsEx / loadSessionBody
    // 等 await 点）期间发生取消 → 短路，不派发 core_run_task（避免 force_cancel
    // 早于 run 到达引擎而失效，run 全量跑完用户取消无效）。守卫命中前若已订阅，
    // createStreamCancel 的 cleanup 已退订（cleanupStreamState），无需二次处理。
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
      // P4 T-31：history / contextWindow 全部可选，缺省不发 = 引擎现状单消息 run
      ...(history ? { history } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
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
    assistantClientMessageId || undefined
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
