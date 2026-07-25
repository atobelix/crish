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
import { getCommandPermissions, getPermissionMode } from './storeAccess';
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
import {
  extractEventSequence,
  orchestratorEventToAgentEvent,
  projectAssistantTextFromEvents,
  streamRecovery,
  suffixDelta,
  type ReplayEvent,
  type ReplayPayload,
} from '../services/StreamRecovery';

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
export function messageBelongsToRun(
  msgRunId: unknown,
  localRunId: string
): boolean {
  if (msgRunId == null) return true;
  const rid =
    typeof msgRunId === 'string' ? msgRunId.trim() : String(msgRunId).trim();
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
  event: unknown
): ParseResult<ApprovalResolvedFields> {
  const resolved = safeParseApprovalResolved(event);
  // Discriminant narrow: only read .error on ok === false (never !ok)
  if (resolved.ok === false) {
    return parseErr(resolved.error || 'approval-resolved parse failed');
  }
  const { toolCallId, denied, decision } = resolved.data;
  const id =
    typeof toolCallId === 'string'
      ? toolCallId.trim()
      : String(toolCallId ?? '').trim();
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
    if (fromCall.id && fromCall.name && fromCall.name !== 'tool')
      return fromCall;
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
  diffs?: FileDiff[] | undefined;
  filePath?: string | undefined;
} {
  const basics = safeParseToolResult(result);
  const id = basics.ok === true ? basics.data.id : '';
  const isError = basics.ok === true ? basics.data.isError : false;
  const text = basics.ok === true ? basics.data.text : '';

  const r =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const outputObj =
    r.output && typeof r.output === 'object' && !Array.isArray(r.output)
      ? (r.output as Record<string, unknown>)
      : null;

  // Resolve filePath: parsed basics → r.path → r.filePath → r.output.path
  const filePath: string | undefined = (() => {
    if (basics.ok === true && typeof basics.data.filePath === 'string' && basics.data.filePath.trim()) {
      return basics.data.filePath.trim();
    }
    if (typeof r.path === 'string' && r.path.trim()) return r.path.trim();
    if (typeof r.filePath === 'string' && r.filePath.trim()) return r.filePath.trim();
    if (outputObj && typeof outputObj.path === 'string' && outputObj.path.trim()) {
      return outputObj.path.trim();
    }
    return undefined;
  })();

  // Resolve diffs: engine-provided → output.diffs → detected unified diff in text
  const diffs: FileDiff[] | undefined = (() => {
    if (Array.isArray(r.diffs)) return r.diffs as FileDiff[];
    if (outputObj && Array.isArray(outputObj.diffs)) return outputObj.diffs as FileDiff[];
    if (text && !isError && (/\bdiff --git\b/.test(text) || /^@@\s+-\d/m.test(text))) {
      const parsed = parseUnifiedDiffs(text);
      if (parsed.length) return parsed;
    }
    return undefined;
  })();

  return {
    id,
    text,
    isError,
    ...(diffs !== undefined && { diffs }),
    ...(filePath !== undefined && { filePath }),
  };
}


/**
 * Resolve event type via zod envelope, then light parser, then raw field.
 * Rejects non-objects, arrays, and empty type strings (event guard).
 */
export function resolveEventType(
  event: unknown
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

/* ──────────────────────────────────────────── Stream state ─── */

export interface StreamState {
  cancelled: boolean;
  finished: boolean;
  assistantText: string;
  assistantThought: string;
  unsub: (() => void) | null;
  endTimer: ReturnType<typeof setTimeout> | null;
}

function cleanupStreamState(state: StreamState): void {
  state.unsub?.();
  state.unsub = null;
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
}

/* ── 5. surfaceStreamFailure ──────────────────────────────── */

export function surfaceStreamFailure(
  raw: unknown,
  scope: string,
  callbacks: StreamCallbacks,
  runId: string
): void {
  logInternalError(scope, raw);
  const kind = classifySoftFailure(raw);
  const formatted = formatRunFailureForUi(raw, scope);
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
}

/* ── 4. createFinishController ───────────────────────────── */

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

/* ── 3. EventRouter ──────────────────────────────────────── */

export class EventRouter {
  private state: StreamState;
  private approvalFlow: ApprovalFlowMachine;
  private callbacks: StreamCallbacks;
  private runId: string;
  private sessionId: string;
  private finish: (force?: boolean) => void;
  private tryResumeFinish: () => void;
  private client: ReturnType<typeof getDesktopDaemonClient>;
  /** 已应用到 UI 的最大 sequence（跳过 seq<=lastApplied） */
  private lastAppliedSequence = 0;

  constructor(
    state: StreamState,
    approvalFlow: ApprovalFlowMachine,
    callbacks: StreamCallbacks,
    runId: string,
    finish: (force?: boolean) => void,
    tryResumeFinish: () => void,
    client: ReturnType<typeof getDesktopDaemonClient>,
    sessionId = ''
  ) {
    this.state = state;
    this.approvalFlow = approvalFlow;
    this.callbacks = callbacks;
    this.runId = runId;
    this.sessionId = sessionId;
    this.finish = finish;
    this.tryResumeFinish = tryResumeFinish;
    this.client = client;
  }

  getLastAppliedSequence(): number {
    return this.lastAppliedSequence;
  }

  /**
   * 断线续流：按 sequence 排序，跳过已应用，message-delta 后缀累加（无重叠）。
   * 供 StreamRecovery.setReplayHandler 调用。
   */
  applyReplayEvents(payload: ReplayPayload | ReplayEvent[]): void {
    if (this.state.cancelled || this.state.finished) return;
    const events = Array.isArray(payload) ? payload : payload.events;
    if (!(events as unknown[]).length) return;

    const sorted = [...(events as unknown[])].sort((a, b) => {
      const sa = extractEventSequence(a) ?? 0;
      const sb = extractEventSequence(b) ?? 0;
      return sa - sb;
    });

    const fresh = sorted.filter((e) => {
      const seq = extractEventSequence(e);
      return seq == null || seq > this.lastAppliedSequence;
    });
    if (!fresh.length) return;

    // 文本：投影全文后与本地 assistantText 做后缀对齐（lastSeq=0 全量也不重叠）
    const projected = projectAssistantTextFromEvents(fresh);
    // 当 afterSequence=0 时 projected 是从 run 起点的全文；否则是新增段
    const afterSeq =
      !Array.isArray(payload) && typeof payload.afterSequence === 'number'
        ? payload.afterSequence
        : this.lastAppliedSequence;
    let textEmit = '';
    if (afterSeq <= 0 && this.state.assistantText) {
      // 全量投影：只 emit 超出已收正文的 suffix
      const fullProjected = projectAssistantTextFromEvents(sorted);
      textEmit = suffixDelta(this.state.assistantText, fullProjected);
      if (
        fullProjected.startsWith(this.state.assistantText) ||
        !this.state.assistantText
      ) {
        this.state.assistantText =
          fullProjected.length >= this.state.assistantText.length
            ? fullProjected
            : this.state.assistantText;
      } else if (textEmit) {
        this.state.assistantText += textEmit;
      }
    } else {
      textEmit = projected;
      if (textEmit) this.state.assistantText += textEmit;
    }
    if (textEmit) {
      this.callbacks.onChunk(textEmit);
      if (this.sessionId) {
        streamRecovery.updateHeartbeat(this.sessionId, {
          bytes: textEmit.length,
        });
      }
    }

    // 非文本事件（工具 / 审批 / 终态）仍走 handleAgentEvent；文本已处理则跳过 delta
    for (const raw of fresh) {
      const seq = extractEventSequence(raw);
      const agentOrNull = orchestratorEventToAgentEvent(raw);
      const agent: Record<string, unknown> | null =
        agentOrNull ??
        (raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null);
      if (agent) {
        const type = String(agent.type ?? '');
        if (
          type === 'message-delta' ||
          type === 'text-delta' ||
          type === 'message-end'
        ) {
          // 文本已 suffix 合并；message-end 若带来更多内容再走一遍 merge
          if (type === 'message-end') {
            this.handleAgentEvent(agent);
          }
        } else {
          this.handleAgentEvent(agent);
        }
      }
      if (seq != null && seq > this.lastAppliedSequence) {
        this.lastAppliedSequence = seq;
        if (this.sessionId) {
          streamRecovery.updateHeartbeat(this.sessionId, { sequence: seq });
        }
      }
    }


    if (
      !Array.isArray(payload) &&
      typeof payload.nextAfterSequence === 'number'
    ) {
      if (payload.nextAfterSequence > this.lastAppliedSequence) {
        this.lastAppliedSequence = payload.nextAfterSequence;
      }
      if (this.sessionId) {
        streamRecovery.setLastSequence(
          this.sessionId,
          payload.nextAfterSequence
        );
      }
    }
  }

  private applyApprovalResolved(payload: unknown): void {
    if (this.state.cancelled || this.state.finished) return;
    const resolved = parseApprovalResolvedFields(payload);
    if (resolved.ok === false) {
      logInternalError('daemon-protocol', resolved.error);
      return;
    }
    const {
      toolCallId: requestId,
      denied,
      decision: uiDecision,
    } = resolved.data;
    this.approvalFlow.dispatch({
      type: 'approval_resolved',
      toolId: requestId,
      denied,
    });
    if (this.callbacks.onApprovalResolved) {
      this.callbacks.onApprovalResolved(requestId, uiDecision);
    }
    if (
      denied &&
      this.approvalFlow.isDeferredTerminal() &&
      !this.approvalFlow.hasPending()
    ) {
      this.finish(false);
    } else if (this.approvalFlow.snapshot().sawRunTerminal) {
      this.tryResumeFinish();
    }
  }

  handleAgentEvent(event: Record<string, unknown>): void {
    if (this.state.cancelled || this.state.finished) return;
    const envelope = resolveEventType(event);
    if (!envelope) return;
    const type = envelope.type;
    event = envelope.raw;

    if (type === 'message-delta' || type === 'text-delta') {
      let t = '';
      let isThought = false;
      if (type === 'text-delta') {
        t = typeof event.text === 'string' ? event.text : blockText(event);
      } else {
        const block = event.block;
        t = blockText(block);
        const b =
          block && typeof block === 'object'
            ? (block as Record<string, unknown>)
            : null;
        isThought = Boolean(
          b && (b.type === 'thought' || b.kind === 'thought')
        );
      }
      if (!t) return;
      if (isThought) {
        this.state.assistantThought += t;
        this.callbacks.onThought(this.state.assistantThought);
      } else {
        let deltaToSend = t;
        if (event.message && typeof event.message === 'object') {
          const msg = event.message as Record<string, unknown>;
          if (
            typeof msg.content === 'string' &&
            msg.content.length >= this.state.assistantText.length
          ) {
            deltaToSend = msg.content.slice(this.state.assistantText.length);
            this.state.assistantText = msg.content;
          } else {
            this.state.assistantText += t;
          }
        } else {
          this.state.assistantText += t;
        }
        if (deltaToSend) {
          this.callbacks.onChunk(deltaToSend);
        }
      }
      return;
    }

    if (
      type === 'message-end' &&
      event.message &&
      typeof event.message === 'object'
    ) {
      const msg = event.message as Record<string, unknown>;
      if (msg.role === 'assistant') {
        const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
        let text = '';
        let thought = '';
        for (const bl of blocks) {
          if (bl && typeof bl === 'object') {
            const b = bl as Record<string, unknown>;
            if (b.type === 'thought' || b.kind === 'thought')
              thought += blockText(b);
            else if (b.type === 'text') text += blockText(b);
          }
        }
        if (typeof msg.content === 'string' && msg.content && !text)
          text = msg.content;
        if (thought.trim()) {
          if (
            this.state.assistantThought &&
            !this.state.assistantThought.includes(thought.trim())
          ) {
            this.state.assistantThought = `${this.state.assistantThought}\n${thought.trim()}`;
          } else {
            this.state.assistantThought = thought.trim();
          }
          this.callbacks.onThought(this.state.assistantThought);
        }
        if (text.trim()) {
          const piece = text.trim();
          const prevLen = this.state.assistantText.length;
          this.state.assistantText = mergeAssistantTextPiece(
            this.state.assistantText,
            piece
          );
          if (this.state.assistantText.length > prevLen) {
            const addedDelta = this.state.assistantText.slice(prevLen);
            this.callbacks.onChunk(addedDelta);
          }
        }
      }
      return;
    }

    if (type === 'tool-start') {
      const { id, name, args, explanation } = toolCallFieldsFromEvent(event);
      if (id && id.trim()) {
        const toolId = id.trim();
        this.approvalFlow.dispatch({ type: 'tool_start', toolId });
        this.callbacks.onToolStart(toolId, name, args, explanation);
      }
      return;
    }
    if (type === 'tool-batch-start') {
      return;
    }

    if (type === 'tool-end') {
      const resultPayload = event.result ?? event;
      const { id, text, isError, diffs } = toolResultFields(resultPayload);
      if (!id || !id.trim()) return;
      const toolId = id.trim();
      this.approvalFlow.dispatch({ type: 'tool_end', toolId });
      if (isError) this.callbacks.onToolError(toolId, text || 'failed');
      else this.callbacks.onToolSuccess(toolId, text || '', diffs);
      this.tryResumeFinish();
      return;
    }

    if (type === 'tool-batch-end') {
      return;
    }

    if (type === 'approval-requested') {
      const parsed = safeParseApprovalRequest(event);
      const parsedOk = parsed.ok === true;
      const req = (
        parsedOk
          ? parsed.data.raw
          : event.request &&
              typeof event.request === 'object' &&
              !Array.isArray(event.request)
            ? event.request
            : event
      ) as Record<string, unknown>;
      const toolCallId = (
        parsedOk
          ? parsed.data.toolCallId
          : String(req.toolCallId ?? req.id ?? req.requestId ?? '')
      ).trim();
      if (!toolCallId) {
        if (parsed.ok === false) {
          logInternalError('daemon-protocol', parsed.error);
        } else {
          logInternalError(
            'daemon-protocol',
            'approval-requested missing toolCallId'
          );
        }
        return;
      }
      const toolName =
        (parsedOk
          ? parsed.data.toolName
          : String(req.toolName ?? req.name ?? 'command')
        ).trim() || 'command';
      const args = extractApprovalCommandArgs(
        parsedOk && parsed.data.parameters
          ? { ...req, parameters: parsed.data.parameters }
          : req
      );
      const explanation = parsedOk
        ? parsed.data.explanation
        : String(
            req.summary ?? req.reason ?? req.message ?? toolName ?? '需要确认'
          );
      const approvalMeta = parseApprovalRiskMeta(event);

      if (this.approvalFlow.debugSets().pending.includes(toolCallId)) {
        return;
      }

      const perm = getPermissionMode();
      if (perm === 'plan') {
        this.callbacks.onToolStart(toolCallId, toolName, args, explanation);
        return;
      }

      {
        const line = extractCommandForMatch(toolName, args);
        if (commandMatchesWhitelist(line, getCommandPermissions())) {
          this.callbacks.onToolStart(
            toolCallId,
            toolName,
            args,
            explanation ? `${explanation}（白名单自动允许）` : '白名单自动允许'
          );
          void this.client
            .send({ type: 'approve-tool', toolCallId, scope: 'project' })
            .catch(() => {
              this.approvalFlow.dispatch({
                type: 'approval_pending',
                toolId: toolCallId,
              });
              if (this.callbacks.onToolPendingApproval) {
                this.callbacks.onToolPendingApproval(
                  toolCallId,
                  toolName,
                  args,
                  explanation,
                  approvalMeta
                );
              }
            });
          return;
        }
      }

      this.approvalFlow.dispatch({
        type: 'approval_pending',
        toolId: toolCallId,
      });
      if (this.callbacks.onToolPendingApproval) {
        this.callbacks.onToolPendingApproval(
          toolCallId,
          toolName,
          args,
          explanation,
          approvalMeta
        );
      } else {
        this.callbacks.onToolStart(toolCallId, toolName, args, explanation);
      }
      return;
    }

    if (type === 'approval-resolved') {
      this.applyApprovalResolved(event);
      return;
    }

    if (
      type === 'run-terminal' ||
      type === 'run-completed' ||
      type === 'run-failed'
    ) {
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
          : (event.error ?? event.message ?? event);
        surfaceStreamFailure(
          errPayload ?? event,
          type === 'run-failed' ? 'run-failed' : 'run-terminal-failed',
          this.callbacks,
          this.runId
        );
      }
      this.approvalFlow.dispatch({ type: 'run_terminal_seen' });
      if (this.approvalFlow.hasPending() && !failed) {
        this.approvalFlow.dispatch({ type: 'defer_terminal' });
        return;
      }
      this.approvalFlow.dispatch({ type: 'clear_all' });
      this.finish(failed);
      return;
    }

    if (type === 'agent-end') {
      if (this.approvalFlow.hasPending()) {
        this.approvalFlow.dispatch({ type: 'defer_terminal' });
        return;
      }
      const reason = String((event as { reason?: string }).reason || '');
      if (reason === 'error') {
        surfaceStreamFailure(
          (event as { error?: unknown }).error ?? event,
          'agent-end-error',
          this.callbacks,
          this.runId
        );
        this.finish(true);
        return;
      }
      if (this.approvalFlow.snapshot().sawRunTerminal) {
        this.finish(false);
        return;
      }
      if (this.state.endTimer) clearTimeout(this.state.endTimer);
      this.state.endTimer = setTimeout(() => {
        if (!this.state.cancelled && !this.state.finished) this.finish(false);
      }, 8000);
    }
  }

  onMsg = (msg: Record<string, unknown>): void => {
    if (this.state.cancelled || this.state.finished) return;
    const envelope = resolveEventType(msg);
    if (!envelope) return;
    const type = envelope.type;
    msg = envelope.raw;

    if (!messageBelongsToRun(msg.runId, this.runId)) return;

    // 序号心跳：外层帧 / 嵌套 event / runtime-event 均尝试提取
    const seq =
      extractEventSequence(msg) ??
      extractEventSequence(msg.event as Record<string, unknown>) ??
      (msg.event && typeof msg.event === 'object'
        ? extractEventSequence((msg.event as Record<string, unknown>).payload as Record<string, unknown>)
        : null);
    if (seq != null && seq > this.lastAppliedSequence) {
      this.lastAppliedSequence = seq;
    }
    if (this.sessionId) {
      streamRecovery.updateHeartbeat(this.sessionId, {
        ...(seq != null ? { sequence: seq } : {}),
      });
    }

    if (type === 'subagent-started') {
      this.callbacks.onSubagentStarted?.({
        subagentId: String(msg.subagentId ?? ''),
        subagentRunId: String(msg.subagentRunId ?? ''),
        parentRunId: String(msg.runId ?? this.runId),
        ...(msg.parentToolCallId !== undefined && {
          parentToolCallId: String(msg.parentToolCallId),
        }),
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
      this.callbacks.onSubagentEvent?.({
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
      this.callbacks.onSubagentEnded?.({
        subagentId: String(msg.subagentId ?? ''),
        subagentRunId: String(msg.subagentRunId ?? ''),
        status: st,
        ...(msg.summary !== undefined && { summary: String(msg.summary) }),
      });
      return;
    }

    if (type === 'error') {
      surfaceStreamFailure(
        msg.message ?? msg.error ?? msg,
        'daemon-error',
        this.callbacks,
        this.runId
      );
      this.approvalFlow.dispatch({ type: 'clear_all' });
      this.finish(true);
      return;
    }

    if (type === 'event') {
      if (
        !msg.event ||
        typeof msg.event !== 'object' ||
        Array.isArray(msg.event)
      )
        return;
      this.handleAgentEvent(msg.event as Record<string, unknown>);
      return;
    }

    if (type === 'run-ended' || type === 'run-failed') {
      if (type === 'run-failed') {
        surfaceStreamFailure(
          msg.error ?? msg.message ?? msg,
          'run-ended-failed',
          this.callbacks,
          this.runId
        );
      }
      this.approvalFlow.dispatch({ type: 'run_terminal_seen' });
      this.approvalFlow.dispatch({ type: 'clear_all' });
      this.finish(type === 'run-failed');
      return;
    }

    if (type === 'approval-requested') {
      this.handleAgentEvent(msg);
      return;
    }

    if (type === 'approval-resolved') {
      this.applyApprovalResolved(msg);
    }
  };
}

/* ── 2. createStreamCancel ───────────────────────────────── */

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
    void client.send({ type: 'cancel-run', runId }).catch(() => undefined);
    state.finished = true;
    try {
      callbacks.onComplete();
    } catch {
      /* ignore */
    }
  };
}

/* ── 1. createStreamSession ──────────────────────────────── */

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
      // 当 Daemon 未连接时，自动降级到 HTTP SSE Direct Fetch，直接与服务商 API (DeepSeek/OpenAI/OpenCode 等) 通信
      const { streamViaDirectFetch } = await import('./directFetchBridge');
      streamViaDirectFetch(prompt, callbacks, sessionId, runId, options);
      return;
    }

    state.unsub = client.onMessage(onMessage);
    callbacks.onThought('正在处理…');

    const { getWorkspacePath } = await import('./projectStore');
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
      const { clientApi } = await import('./clientApi');
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

      // responseStyle → systemPrompt（设置不再是死配置）
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

    // Goal / long-run：透传 mode/visibleGoal/maxRounds/maxStalledRounds → 引擎 startGoalRun
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

/* ── 6. streamViaDaemon (recomposed) ─────────────────────── */

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

  // 主路径：真实 runId 到手即 register（createStreamSession 不替换 runId）
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

  // 若 onMessage 曾 unsub，重连后 ensure 重新订阅 live
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
    return { ok: true, ...(client.getUrl() !== undefined && { url: client.getUrl()! }) };
  } catch (e) {
    logInternalError('ensureDaemonConnected', e);
    return {
      ok: false,
      ...(client.getUrl() !== undefined && { url: client.getUrl()! }),
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
