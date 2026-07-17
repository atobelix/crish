/**
 * Maps daemon run-task event stream → ChatCard StreamCallbacks.
 *
 * Error policy (product):
 * - User bubble only shows network-style failures.
 * - Agent/runtime failures are logged and end the run quietly so the
 *   model loop / tool cards can own operational detail.
 */

import { getDesktopDaemonClient } from './daemonClient';
import type { StreamCallbacks, StreamRequestOptions } from './chatApi';
import { parseUnifiedDiffs } from './toolFeedback';
import { toDaemonPermissionMode } from './permissionModes';
import {
  commandMatchesWhitelist,
  extractCommandForMatch,
} from './commandPermissions';
import {
  getCommandPermissions,
  getPermissionMode,
} from './storeAccess';
import {
  assistantBubbleForFailure,
  classifySoftFailure,
  logInternalError,
  networkUserMessage,
  softFailureMessage,
} from './userFacingErrors';
import { formatRunFailureForUi, recordStreamDiag } from './streamDiag';
import { ApprovalFlowMachine } from './approvalFlowMachine';
import { parseApprovalRiskMeta } from './approvalMeta';
import {
  extractApprovalCommandArgs,
  parseDaemonEnvelope,
  parseErr,
  parseOk,
  parseToolCallFields,
  type ParseResult,
} from './daemonEventSchema';
import {
  safeParseApprovalRequest,
  safeParseApprovalResolved,
  safeParseDaemonEvent,
  safeParseRunTerminal,
  safeParseToolCall,
  safeParseToolResult,
} from './daemonEventZod';
import type { FileDiff } from '../store/types';

/** Message block text / content (thought or text delta). */
export function blockText(block: unknown): string {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
  const b = block as Record<string, unknown>;
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  return '';
}

/**
 * Empty-session safety: never send blank/whitespace sessionId to the daemon.
 * Trims real ids; synthesizes a stable-looking shell id when empty.
 */
export function normalizeStreamSessionId(sessionId: unknown): string {
  if (typeof sessionId === 'string') {
    const t = sessionId.trim();
    if (t) return t;
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Event runId guard: missing/blank runId is treated as broadcast (accept);
 * non-empty mismatch drops the frame so foreign runs cannot drive this stream.
 */
export function messageBelongsToRun(msgRunId: unknown, localRunId: string): boolean {
  if (msgRunId == null) return true;
  const rid = typeof msgRunId === 'string' ? msgRunId.trim() : String(msgRunId).trim();
  if (!rid) return true;
  return rid === localRunId;
}

export type ApprovalResolvedFields = {
  toolCallId: string;
  denied: boolean;
  decision: 'allow' | 'deny';
};

/**
 * approval-resolved: single ParseResult path with `ok === false` discriminant.
 * Unknown/missing decision already mapped to deny by zod; empty toolCallId fails.
 */
export function parseApprovalResolvedFields(
  event: unknown,
): ParseResult<ApprovalResolvedFields> {
  const resolved = safeParseApprovalResolved(event);
  // Discriminant narrow: only read .error on ok === false (never !ok)
  if (resolved.ok === false) {
    return parseErr(resolved.error || 'approval-resolved parse failed');
  }
  const { toolCallId, denied, decision } = resolved.data;
  const id = typeof toolCallId === 'string' ? toolCallId.trim() : String(toolCallId ?? '').trim();
  if (!id) {
    return parseErr('approval-resolved empty toolCallId');
  }
  return parseOk({
    toolCallId: id,
    denied: Boolean(denied),
    decision: decision === 'allow' ? ('allow' as const) : ('deny' as const),
  });
}

/** Zod primary; light schema fallback; last-resort synthetic fields. */
export function toolCallFields(call: unknown): {
  id: string;
  name: string;
  args: string;
  explanation: string;
} {
  const zodParsed = safeParseToolCall(call);
  if (zodParsed.ok === true) return zodParsed.data;

  const light = parseToolCallFields(call);
  if (light.ok === true) return light.data;

  const err =
    (zodParsed.ok === false ? zodParsed.error : '') ||
    (light.ok === false ? light.error : 'tool-call parse failed');
  logInternalError('daemon-protocol', err);
  return { id: `tc-${Date.now()}`, name: 'tool', args: '', explanation: '' };
}

/**
 * tool-start 通常有 event.call；个别投影会把字段摊平到 event 顶层。
 * 先 call，再整包 event 兜底，避免丢工具卡。
 */
export function toolCallFieldsFromEvent(event: Record<string, unknown>): {
  id: string;
  name: string;
  args: string;
  explanation: string;
} {
  if (event.call != null) {
    const fromCall = toolCallFields(event.call);
    if (fromCall.id && fromCall.name && fromCall.name !== 'tool') return fromCall;
    // call 残缺时仍尝试顶层字段
    const fromTop = toolCallFields(event);
    if (fromTop.id && fromTop.name && fromTop.name !== 'tool') return fromTop;
    return fromCall;
  }
  return toolCallFields(event);
}

export function toolResultFields(result: unknown): {
  id: string;
  text: string;
  isError: boolean;
  diffs?: FileDiff[];
  filePath?: string;
} {
  const basics = safeParseToolResult(result);
  // Discriminant: only read data when ok === true
  const id = basics.ok === true ? basics.data.id : '';
  const isError = basics.ok === true ? basics.data.isError : false;
  let text = basics.ok === true ? basics.data.text : '';
  let filePath = basics.ok === true ? basics.data.filePath : undefined;

  const r =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  // 仅信任引擎结构化 diffs 或明确的 git unified diff 头，禁止用 path+输出瞎合成
  let diffs: FileDiff[] | undefined;
  if (Array.isArray(r.diffs)) {
    diffs = r.diffs as FileDiff[];
  } else if (r.output && typeof r.output === 'object' && !Array.isArray(r.output)) {
    const o = r.output as Record<string, unknown>;
    if (Array.isArray(o.diffs)) diffs = o.diffs as FileDiff[];
  }

  if (!filePath) {
    filePath =
      (typeof r.path === 'string' && r.path.trim() ? r.path.trim() : '') ||
      (typeof r.filePath === 'string' && r.filePath.trim() ? r.filePath.trim() : '') ||
      (r.output &&
      typeof r.output === 'object' &&
      !Array.isArray(r.output) &&
      typeof (r.output as { path?: string }).path === 'string' &&
      String((r.output as { path: string }).path).trim()
        ? String((r.output as { path: string }).path).trim()
        : '') ||
      undefined;
    if (filePath === '') filePath = undefined;
  }

  if (!diffs && text && !isError && (/\bdiff --git\b/.test(text) || /^@@\s+-\d/m.test(text))) {
    const parsed = parseUnifiedDiffs(text);
    if (parsed.length) diffs = parsed;
  }

  return { id, text, isError, diffs, filePath };
}

/**
 * Resolve event type via zod envelope, then light parser, then raw field.
 * Rejects non-objects, arrays, and empty type strings (event guard).
 */
export function resolveEventType(
  event: unknown,
): { type: string; raw: Record<string, unknown> } | null {
  const zodEnv = safeParseDaemonEvent(event);
  if (zodEnv.ok === true) {
    const type = String(zodEnv.data.type ?? '').trim();
    if (!type) return null;
    return { type, raw: zodEnv.data.raw };
  }
  const light = parseDaemonEnvelope(event);
  if (light.ok === true) {
    const type = String(light.data.type ?? '').trim();
    if (!type) return null;
    return { type, raw: light.data.raw };
  }
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    const raw = event as Record<string, unknown>;
    const type = String(raw.type ?? raw.event ?? raw.kind ?? '').trim();
    if (type) return { type, raw };
  }
  return null;
}

/**
 * Merge a new assistant message-end piece into accumulated text.
 * Empty piece → keep prior; prefix/suffix overlap → take longer; else paragraph join.
 */
export function mergeAssistantTextPiece(prior: string, piece: string): string {
  const p = typeof piece === 'string' ? piece.trim() : '';
  if (!p) return prior;
  if (!prior) return p;
  if (
    prior === p ||
    p.startsWith(prior) ||
    prior.endsWith(p) ||
    p.includes(prior)
  ) {
    return p.length >= prior.length ? p : prior;
  }
  return `${prior}\n\n${p}`;
}

/**
 * Start a daemon run and stream events into UI callbacks.
 * Returns a cancel function.
 *
 * Note: daemon streams type=event frames; client supplies runId.
 * options.content / hasImages：多模态图片（OpenAI-style parts）；引擎校验通过后写入消息 metadata。
 */
export function streamViaDaemon(
  prompt: string,
  callbacks: StreamCallbacks,
  sessionId: string,
  assistantMsgId: string,
  options?: StreamRequestOptions,
): () => void {
  const client = getDesktopDaemonClient();
  client.startKeepAlive();

  let cancelled = false;
  let finished = false;
  let assistantText = '';
  let assistantThought = '';
  let unsub: (() => void) | null = null;
  /** 审批 / 在飞工具状态机（替代四布尔散状态） */
  const approvalFlow = new ApprovalFlowMachine();
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  void assistantMsgId;
  try {
    callbacks.onRunMeta?.({ runId });
  } catch {
    /* ignore */
  }

  /**
   * 审批 / 在飞工具清空后，若曾 defer 终态则尝试收口。
   * 必须已见 run 终态信号，避免「审批通过 → 首个 tool-end」误收口（agent 还可能继续）。
   */
  const tryResumeFinish = () => {
    if (finished || cancelled) return;
    const snap = approvalFlow.snapshot();
    if (!snap.deferredTerminal) return;
    if (!snap.sawRunTerminal) return;
    if (approvalFlow.shouldBlockTerminal()) return;
    finish(false);
  };

  const finish = (force = false) => {
    if (finished) return;
    if (!force && !cancelled) {
      if (approvalFlow.hasPending()) {
        approvalFlow.dispatch({ type: "defer_terminal" });
        return;
      }
      // 仍有在飞工具：标记 defer，等 tool-end 重入；超时再强制收口
      if (approvalFlow.hasInflight()) {
        approvalFlow.dispatch({ type: "defer_terminal" });
        if (endTimer) clearTimeout(endTimer);
        endTimer = setTimeout(() => finish(true), 1200);
        return;
      }
    }
    if (endTimer) {
      clearTimeout(endTimer);
      endTimer = null;
    }
    // 收口时清 deferred 标记（保留 saw/pending 由 clear_all 在真失败路径处理）
    if (approvalFlow.isDeferredTerminal()) {
      approvalFlow.dispatch({ type: 'force_finish' });
    }
    finished = true;
    unsub?.();
    unsub = null;
    try {
      callbacks.onComplete();
    } catch {
      /* ignore */
    }
  };

  /**
   * 产品错误：绝不写入助手正文（避免被当成 AI 回复）。
   * 通过 onRunError 回调给 UI toast / 系统提示；附带 detail 供诊断横幅。
   */
  const surfaceFailure = (raw: unknown, scope: string) => {
    logInternalError(scope, raw);
    const kind = classifySoftFailure(raw);
    const formatted = formatRunFailureForUi(raw, scope);
    // soft 分类已有礼貌主句时保留；未知/检查点相关用 format 主句
    let msg =
      softFailureMessage(kind) ??
      assistantBubbleForFailure(raw) ??
      formatted.message;
    if (/checkpoint/i.test(String(raw || '')) || /checkpoint/i.test(scope)) {
      msg = formatted.message;
    }
    const detail = formatted.detail;
    recordStreamDiag({
      runId,
      scope,
      kind: kind || formatted.kindTag,
      message: msg,
      raw: detail,
    });
    if (callbacks.onRunError) {
      callbacks.onRunError(msg, kind || scope || 'ended', detail);
    }
  };

  /**
   * Shared approval-resolved path (nested AgentEvent + top-level WS broadcast).
   * Uses parseApprovalResolvedFields: ok === false early return + error log only.
   */
  const applyApprovalResolved = (payload: unknown) => {
    if (cancelled || finished) return;
    const resolved = parseApprovalResolvedFields(payload);
    if (resolved.ok === false) {
      logInternalError('daemon-protocol', resolved.error);
      return;
    }
    const { toolCallId: requestId, denied, decision: uiDecision } = resolved.data;
    approvalFlow.dispatch({
      type: 'approval_resolved',
      toolId: requestId,
      denied,
    });
    if (callbacks.onApprovalResolved) {
      // 未知决策已由 parser 收成 deny，避免伪造 allow
      callbacks.onApprovalResolved(requestId, uiDecision);
    }
    // allow 后引擎还会继续，勿提前收口；
    // deny：若此前因审批 defer 过终态则收口；已见 run 终态时同样 tryResume
    if (denied && approvalFlow.isDeferredTerminal() && !approvalFlow.hasPending()) {
      finish(false);
    } else if (approvalFlow.snapshot().sawRunTerminal) {
      tryResumeFinish();
    }
  };

  const handleAgentEvent = (event: Record<string, unknown>) => {
    if (cancelled || finished) return;
    const envelope = resolveEventType(event);
    if (!envelope) return;
    const type = envelope.type;
    // Prefer envelope.raw so alias-normalized type still uses original payload fields
    event = envelope.raw;

    if (type === 'message-delta' || type === 'text-delta') {
      // text-delta: { text }；message-delta: { block: { type, text } }
      let t = '';
      let isThought = false;
      if (type === 'text-delta') {
        t = typeof event.text === 'string' ? event.text : blockText(event);
      } else {
        const block = event.block;
        t = blockText(block);
        const b = block && typeof block === 'object' ? (block as Record<string, unknown>) : null;
        isThought = Boolean(b && (b.type === 'thought' || b.kind === 'thought'));
      }
      if (!t) return;
      if (isThought) {
        assistantThought += t;
        callbacks.onThought(assistantThought);
      } else {
        // 仅当 content 是累计全文（长度 ≥ 当前）时才覆盖，避免把 delta 误当全文冲掉
        if (event.message && typeof event.message === 'object') {
          const msg = event.message as Record<string, unknown>;
          if (typeof msg.content === 'string' && msg.content.length >= assistantText.length) {
            assistantText = msg.content;
          } else {
            assistantText += t;
          }
        } else {
          assistantText += t;
        }
        callbacks.onChunk(assistantText);
      }
      return;
    }

    if (type === 'message-end' && event.message && typeof event.message === 'object') {
      const msg = event.message as Record<string, unknown>;
      if (msg.role === 'assistant') {
        const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
        let text = '';
        let thought = '';
        for (const bl of blocks) {
          if (bl && typeof bl === 'object') {
            const b = bl as Record<string, unknown>;
            if (b.type === 'thought' || b.kind === 'thought') thought += blockText(b);
            else if (b.type === 'text') text += blockText(b);
          }
        }
        // content 仅作文案，不把 thought 混进正文
        if (typeof msg.content === 'string' && msg.content && !text) text = msg.content;
        if (thought.trim()) {
          // 思考累计（多轮工具时可能多段）
          if (assistantThought && !assistantThought.includes(thought.trim())) {
            assistantThought = `${assistantThought}\n${thought.trim()}`;
          } else {
            assistantThought = thought.trim();
          }
          callbacks.onThought(assistantThought);
        }
        if (text.trim()) {
          // 多轮 tool→再回复：各轮正文累计；同轮 delta 已推过则用完整段覆盖，勿重复拼接
          const piece = text.trim();
          assistantText = mergeAssistantTextPiece(assistantText, piece);
          const full = assistantText;
          // 无真实流式 delta 时直接交付完整段——
          // 旧实现用本地 setTimeout 每 16ms 切片模拟流式（revealProgressively），
          // 与真实 delta 叠加会产生闪烁 / 顺序错乱。
          // 流式观感应由 UI 层的光标动画提供，而非数据层伪造。
          callbacks.onChunk(full);
        }
      }
      return;
    }

    // 只认单条 tool-start，忽略 batch-start，避免同一工具进两次
    if (type === 'tool-start') {
      const { id, name, args, explanation } = toolCallFieldsFromEvent(event);
      // Event guard: empty tool id never enters the flow machine / UI
      if (id && id.trim()) {
        const toolId = id.trim();
        approvalFlow.dispatch({ type: 'tool_start', toolId });
        callbacks.onToolStart(toolId, name, args, explanation);
      }
      return;
    }
    if (type === 'tool-batch-start') {
      return;
    }

    if (type === 'tool-end') {
      // result 嵌套为协议主路径；兼容顶层摊平
      const resultPayload = event.result ?? event;
      const { id, text, isError, diffs } = toolResultFields(resultPayload);
      // Event guard: drop tool-end without a usable id
      if (!id || !id.trim()) return;
      const toolId = id.trim();
      approvalFlow.dispatch({ type: 'tool_end', toolId });
      if (isError) callbacks.onToolError(toolId, text || 'failed');
      else callbacks.onToolSuccess(toolId, text || '', diffs);
      // 曾 defer 的终态：在飞工具归零后立即收口，不靠超时
      tryResumeFinish();
      return;
    }

    // batch-end 与逐条 tool-end 重复，忽略以免双写
    if (type === 'tool-batch-end') {
      return;
    }

    if (type === 'approval-requested') {
      const parsed = safeParseApprovalRequest(event);
      const parsedOk = parsed.ok === true;
      const req = (
        parsedOk
          ? parsed.data.raw
          : event.request && typeof event.request === 'object' && !Array.isArray(event.request)
            ? event.request
            : event
      ) as Record<string, unknown>;
      const toolCallId = (
        parsedOk
          ? parsed.data.toolCallId
          : String(req.toolCallId ?? req.id ?? req.requestId ?? '')
      ).trim();
      // Event guard: never invent approval ids that cannot be resolved later
      if (!toolCallId) {
        if (parsed.ok === false) {
          logInternalError('daemon-protocol', parsed.error);
        } else {
          logInternalError('daemon-protocol', 'approval-requested missing toolCallId');
        }
        return;
      }
      const toolName = (
        parsedOk
          ? parsed.data.toolName
          : String(req.toolName ?? req.name ?? 'command')
      ).trim() || 'command';
      // parameters（runtime）/ input（daemon WS）；zod raw 已归一，勿整包序列化
      const args = extractApprovalCommandArgs(
        parsedOk && parsed.data.parameters
          ? { ...req, parameters: parsed.data.parameters }
          : req,
      );
      const explanation = parsedOk
        ? parsed.data.explanation
        : String(req.summary ?? req.reason ?? req.message ?? toolName ?? '需要确认');
      // BE-04：后端风险事实透传（扁平 event + nested request.metadata）
      const approvalMeta = parseApprovalRiskMeta(event);

      // 同一 toolCallId 已在 pending：不重复回调，避免 UI 双挂载
      if (approvalFlow.debugSets().pending.includes(toolCallId)) {
        return;
      }

      // 引擎发来 approval-requested 说明策略要求确认——必须弹窗并挂起，
      // 否则 run 会一直等批准。full 的非极危由引擎直接 allow，不会到这里。
      // plan 写操作由引擎 deny，同样不会 ask。
      const perm = getPermissionMode();
      if (perm === 'plan') {
        // 防御：计划模式不应 ask；若不慎收到则记 running 不拦用户
        callbacks.onToolStart(toolCallId, toolName, args, explanation);
        return;
      }

      // 命令白名单：自动 approve，不伪造输出（等引擎 tool-end）
      {
        const line = extractCommandForMatch(toolName, args);
        if (commandMatchesWhitelist(line, getCommandPermissions())) {
          callbacks.onToolStart(
            toolCallId,
            toolName,
            args,
            explanation ? `${explanation}（白名单自动允许）` : '白名单自动允许',
          );
          void client
            .send({ type: 'approve-tool', toolCallId, scope: 'project' })
            .catch(() => {
              approvalFlow.dispatch({ type: "approval_pending", toolId: toolCallId });
              if (callbacks.onToolPendingApproval) {
                callbacks.onToolPendingApproval(
                  toolCallId,
                  toolName,
                  args,
                  explanation,
                  approvalMeta,
                );
              }
            });
          return;
        }
      }

      approvalFlow.dispatch({ type: "approval_pending", toolId: toolCallId });
      if (callbacks.onToolPendingApproval) {
        callbacks.onToolPendingApproval(
          toolCallId,
          toolName,
          args,
          explanation,
          approvalMeta,
        );
      } else {
        callbacks.onToolStart(toolCallId, toolName, args, explanation);
      }
      return;
    }

    // 自动放行（完全访问）或用户批准后都会到这里
    if (type === 'approval-resolved') {
      applyApprovalResolved(event);
      return;
    }

    // 真正终态以 run-terminal 为准
    if (type === 'run-terminal' || type === 'run-completed' || type === 'run-failed') {
      const termParsed = safeParseRunTerminal(event);
      const termOk = termParsed.ok === true;
      const term = termOk
        ? termParsed.data.terminal
        : String((event as { terminal?: string }).terminal || '');
      const failed = termOk
        ? termParsed.data.failed
        : type === 'run-failed' ||
          term === 'failed' ||
          term === 'error' ||
          term === 'cancelled' ||
          term === 'canceled';
      if (failed) {
        const errPayload = termOk
          ? termParsed.data.error
          : event.error ?? event.message ?? event;
        surfaceFailure(errPayload ?? event, type === 'run-failed' ? 'run-failed' : 'run-terminal-failed');
      }
      approvalFlow.dispatch({ type: "run_terminal_seen" });
      if (approvalFlow.hasPending() && !failed) {
        approvalFlow.dispatch({ type: "defer_terminal" });
        return;
      }
      approvalFlow.dispatch({ type: "clear_all" });
      finish(failed);
      return;
    }

    // agent-end 不是最终权威：仅在长时间无 run-terminal 时兜底
    if (type === 'agent-end') {
      if (approvalFlow.hasPending()) {
        approvalFlow.dispatch({ type: "defer_terminal" });
        return;
      }
      const reason = String((event as { reason?: string }).reason || '');
      if (reason === 'error') {
        surfaceFailure((event as { error?: unknown }).error ?? event, 'agent-end-error');
        finish(true);
        return;
      }
      if (approvalFlow.snapshot().sawRunTerminal) {
        finish(false);
        return;
      }
      // 等 run-terminal；最久等 2.5s 再兜底收口
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(() => {
        if (!cancelled && !finished) finish(false);
      }, 2500);
    }
  };

  const onMsg = (msg: Record<string, unknown>) => {
    if (cancelled || finished) return;
    const envelope = resolveEventType(msg);
    if (!envelope) return;
    const type = envelope.type;
    msg = envelope.raw;

    // Event guard: foreign runId never drives this stream
    if (!messageBelongsToRun(msg.runId, runId)) return;

    // 子 agent 广播：runId 是父 run；与本流绑定
    if (type === 'subagent-started') {
      callbacks.onSubagentStarted?.({
        subagentId: String(msg.subagentId ?? ''),
        subagentRunId: String(msg.subagentRunId ?? ''),
        parentRunId: String(msg.runId ?? runId),
        parentToolCallId: msg.parentToolCallId ? String(msg.parentToolCallId) : undefined,
        description: String(msg.description ?? '协作 agent'),
        mode: String(msg.mode ?? 'research'),
      });
      return;
    }
    if (type === 'subagent-event') {
      const ev =
        msg.event && typeof msg.event === 'object' && !Array.isArray(msg.event)
          ? (msg.event as Record<string, unknown>)
          : {};
      callbacks.onSubagentEvent?.({
        subagentId: String(msg.subagentId ?? ''),
        subagentRunId: String(msg.subagentRunId ?? ''),
        event: ev,
      });
      return;
    }
    if (type === 'subagent-ended') {
      const raw = String(msg.status ?? '').toLowerCase();
      const st: 'completed' | 'failed' | 'stopped' =
        /cancel|stopp?ed|abort/i.test(raw)
          ? 'stopped'
          : /fail|error/i.test(raw)
            ? 'failed'
            : 'completed';
      callbacks.onSubagentEnded?.({
        subagentId: String(msg.subagentId ?? ''),
        subagentRunId: String(msg.subagentRunId ?? ''),
        status: st,
        summary: msg.summary ? String(msg.summary) : undefined,
      });
      return;
    }

    if (type === 'error') {
      surfaceFailure(msg.message ?? msg.error ?? msg, 'daemon-error');
      approvalFlow.dispatch({ type: 'clear_all' });
      finish(true);
      return;
    }

    if (type === 'event') {
      // Event guard: nested payload must be a plain object
      if (!msg.event || typeof msg.event !== 'object' || Array.isArray(msg.event)) return;
      handleAgentEvent(msg.event as Record<string, unknown>);
      return;
    }

    if (type === 'run-ended' || type === 'run-failed') {
      if (type === 'run-failed') {
        surfaceFailure(msg.error ?? msg.message ?? msg, 'run-ended-failed');
      }
      approvalFlow.dispatch({ type: 'run_terminal_seen' });
      approvalFlow.dispatch({ type: 'clear_all' });
      finish(type === 'run-failed');
      return;
    }

    if (type === 'approval-requested') {
      handleAgentEvent(msg);
      return;
    }

    // 广播的审批结果（不嵌在 event 里）— 与嵌套 AgentEvent 共用 parseApprovalResolvedFields
    if (type === 'approval-resolved') {
      applyApprovalResolved(msg);
    }
  };

  void (async () => {
    try {
      // Prefer waiting for keep-alive over instant fail — backend must not stall UX
      const ready = await client.waitUntilConnected(15_000);
      if (!ready || !client.isConnected()) {
        if (callbacks.onRunError) callbacks.onRunError(networkUserMessage(), 'network');
        else callbacks.onChunk(networkUserMessage());
        finish();
        return;
      }

      unsub = client.onMessage(onMsg);
      callbacks.onThought('正在处理…');

      // Project open sets workspace path; no project → engine uses its default cwd
      const { getWorkspacePath } = await import('./projectStore');
      const cwd = getWorkspacePath() || undefined;

      const mode = getPermissionMode();
      const permissionMode = toDaemonPermissionMode(mode);

      const hasImages = Boolean(options?.hasImages || options?.content?.some((p) => p.type === 'image_url'));
      // Empty-session safety: never ship blank/whitespace sessionId to daemon
      const safeSessionId = normalizeStreamSessionId(sessionId);

      // MCP 工具禁用 + 思考强度（映射 budgetDifficulty）：本机设置 → 引擎 run-task
      let mcpDisabledTools: Record<string, string[]> | undefined;
      let budgetDifficulty: string | undefined;
      try {
        const { clientApi } = await import('./clientApi');
        const sets = await clientApi.getSettingsEx(cwd || '__global__');
        if (sets?.mcpDisabledTools && Object.keys(sets.mcpDisabledTools).length > 0) {
          mcpDisabledTools = sets.mcpDisabledTools;
        }
        // 模型菜单思考档 → 引擎 budgetDifficulty（协议已允许该字段）
        const tl = String(sets?.defaultThinkingLevel || '').trim().toLowerCase();
        // 与模型菜单六档对齐：off 不传难度；其余映射到引擎 budgetDifficulty
        if (tl === 'off') budgetDifficulty = undefined;
        else if (tl === 'minimal') budgetDifficulty = 'easy';
        else if (tl === 'low') budgetDifficulty = 'easy';
        else if (tl === 'medium') budgetDifficulty = 'normal';
        else if (tl === 'high') budgetDifficulty = 'hard';
        else if (tl === 'xhigh') budgetDifficulty = 'hard';
      } catch {
        /* ignore */
      }

      await client.send({
        type: 'run-task',
        runId,
        prompt,
        sessionId: safeSessionId,
        permissionMode,
        ...(cwd ? { cwd } : {}),
        ...(mcpDisabledTools ? { mcpDisabledTools } : {}),
        ...(budgetDifficulty ? { budgetDifficulty } : {}),
        // 结构化多模态：引擎支持时走 vision；未知字段在旧校验下会被拒——与 daemon 轻量扩展对齐
        ...(options?.content?.length ? { content: options.content } : {}),
        ...(hasImages ? { hasImages: true } : {}),
        ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      });
    } catch (e) {
      // Stream start failures are connectivity/send path — user only sees network copy
      logInternalError('stream-start', e);
      if (callbacks.onRunError) callbacks.onRunError(networkUserMessage(), 'network');
      else callbacks.onChunk(networkUserMessage());
      finish();
    }
  })();

  return () => {
    if (finished) return;
    cancelled = true;
    approvalFlow.dispatch({ type: "clear_all" });
    approvalFlow.dispatch({ type: "force_finish" });
    if (endTimer) {
      clearTimeout(endTimer);
      endTimer = null;
    }
    unsub?.();
    unsub = null;
    void client.send({ type: 'cancel-run', runId }).catch(() => undefined);
    finished = true;
    try {
      callbacks.onComplete();
    } catch {
      /* ignore */
    }
  };
}

export async function ensureDaemonConnected(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const client = getDesktopDaemonClient();
  client.startKeepAlive();
  try {
    const ready = await client.waitUntilConnected(20_000);
    if (!ready) {
      return {
        ok: false,
        url: client.getUrl() ?? undefined,
        error: networkUserMessage(),
      };
    }
    await client.request({ type: 'get-status' }, 'status-response', 8_000);
    return { ok: true, url: client.getUrl() ?? undefined };
  } catch (e) {
    logInternalError('ensureDaemonConnected', e);
    return {
      ok: false,
      url: client.getUrl() ?? undefined,
      error: networkUserMessage(e),
    };
  }
}

/**
 * 批准工具：乐观 fire-and-forget，不阻塞 UI 8s。
 * 引擎若队列无此项会静默忽略；状态以 approval-resolved / tool-end 为准。
 */
export async function daemonApproveTool(toolCallId: string, scope?: string) {
  const client = getDesktopDaemonClient();
  await client.send({
    type: 'approve-tool',
    toolCallId,
    ...(scope ? { scope } : { scope: 'project' }),
  });
}

/** 拒绝工具：同样不阻塞 UI */
export async function daemonDenyTool(toolCallId: string) {
  const client = getDesktopDaemonClient();
  await client.send({ type: 'deny-tool', toolCallId });
}
