/**
 * 事件路由器 —— IPC 平铺事件直进 handleAgentEvent（C2.2 / C2.4）。
 *
 * - onMsg 仅处理信封级分支（subagent-* / error / approval-resolved），
 *   其余一律直进 handleAgentEvent 主路径（03 §5.2-1）；
 * - `event` 信封解包分支与 `run-ended` 别名收口分支已删（03 §5.2-2，
 *   终态唯一入口 = run-terminal 主路径，Rust 只发规范事件）；
 * - 四源失败统一收敛到 surfaceStreamFailure + finish（03 §2.4 表）。
 *
 * 事件载荷为 IPC 顶层平铺 `{ type, runId, sessionId, sequence, ... }`
 * （03 §3.1），不做二次归一；runId 过滤沿用 messageBelongsToRun。
 */
import type { Transport } from '../transport';
import type { StreamCallbacks } from '../chatApi';
import {
  commandMatchesWhitelist,
  extractCommandForMatch,
} from '../commandPermissions';
import { getCommandPermissions, getPermissionMode } from '../storeAccess';
import { logInternalError } from '../userFacingErrors';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import { parseApprovalRiskMeta } from '../approvalMeta';
import { extractApprovalCommandArgs } from '../daemonEventSchema';
import {
  safeParseApprovalRequest,
  safeParseRunTerminal,
} from '../daemonEventZod';
import {
  blockText,
  extractEventSequence,
  mergeAssistantTextPiece,
  messageBelongsToRun,
} from './handlers/eventUtils';
import { resolveEventType } from './handlers/eventType';
import { parseApprovalResolvedFields } from './ApprovalHandler';
import {
  toolCallFieldsFromEvent,
  toolResultFields,
} from './handlers/toolUtils';
import { surfaceStreamFailure } from './BridgeErrorPolicy';
import type { StreamState } from './handlers/streamState';

/** 白名单自动放行所需的最小发送面（生产传 TauriTransport） */
type SendLike = {
  send: (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
};

export class EventRouter {
  private state: StreamState;
  private approvalFlow: ApprovalFlowMachine;
  private callbacks: StreamCallbacks;
  private runId: string;
  private sessionId: string;
  private finish: (force?: boolean) => void;
  private tryResumeFinish: () => void;
  private client?: SendLike;
  private lastAppliedSequence = 0;

  constructor(
    state: StreamState,
    approvalFlow: ApprovalFlowMachine,
    callbacks: StreamCallbacks,
    runId: string,
    finish: (force?: boolean) => void,
    tryResumeFinish: () => void,
    client?: SendLike,
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

  private onRuntimeError(data: unknown): void {
    surfaceStreamFailure(data, 'runtime-error', this.callbacks, this.runId);
  }

  private onProviderDiagnostic(data: unknown): void {
    logInternalError('provider-diagnostic', data);
  }

  handleAgentEvent(event: Record<string, unknown>, knownType?: string): void {
    if (this.state.cancelled || this.state.finished) return;
    let type: string;
    if (knownType) {
      type = knownType;
    } else {
      const rawType = String(event.type ?? '').trim();
      if (rawType === 'message-delta' || rawType === 'text-delta') {
        type = rawType;
      } else {
        const envelope = resolveEventType(event);
        if (!envelope) return;
        type = envelope.type;
        event = envelope.raw;
      }
    }

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
          // 白名单自动放行：经 transport 直发 core_approve_tool（commandMap 翻译）
          void this.client
            ?.send('approve-tool', { toolCallId, scope: 'project' })
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
      type === 'run-failed' ||
      type === 'run-cancelled'
    ) {
      const termParsed = safeParseRunTerminal(event);
      const termOk = termParsed.ok === true;
      const term = termOk
        ? termParsed.data.terminal
        : String((event as { terminal?: string }).terminal || '');
      const failed = termOk
        ? termParsed.data.failed
        : type === 'run-failed' ||
          type === 'run-cancelled' ||
          term === 'failed' ||
          term === 'error' ||
          term === 'cancelled' ||
          term === 'canceled';
      if (failed && type !== 'run-cancelled') {
        // L3 cancel: keep partial assistant text; do not surface as stream failure toast
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
      // run-cancelled / failed both close the stream; failed only for true errors
      this.finish(failed && type !== 'run-cancelled');
      return;
    }

    if (type === 'runtime-error') {
      this.onRuntimeError(event.data);
      return;
    }
    if (type === 'provider-diagnostic') {
      this.onProviderDiagnostic(event.data);
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
      // L2 stop / L3 aborted / max-turns / stopped：立即收口，isProcessing 及时清除
      if (
        reason === 'stop' ||
        reason === 'aborted' ||
        reason === 'max-turns' ||
        reason === 'stopped'
      ) {
        this.approvalFlow.dispatch({ type: 'clear_all' });
        this.finish(false);
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

    const seq =
      extractEventSequence(msg) ??
      extractEventSequence(msg.event) ??
      (msg.event && typeof msg.event === 'object'
        ? extractEventSequence((msg.event as Record<string, unknown>).payload)
        : null);
    if (seq != null && seq > this.lastAppliedSequence) {
      this.lastAppliedSequence = seq;
    }

    if (type === 'subagent-started') {
      this.callbacks.onSubagentStarted?.({
        subagentId: String(msg.subagentId ?? ''),
        subagentRunId: String(msg.subagentRunId ?? ''),
        parentRunId: String(msg.runId ?? this.runId),
        parentToolCallId: msg.parentToolCallId
          ? String(msg.parentToolCallId)
          : undefined,
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
        summary: msg.summary ? String(msg.summary) : undefined,
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

    if (type === 'approval-resolved') {
      this.applyApprovalResolved(msg);
      return;
    }

    // C2.2：平铺事件直进主路径（event 信封 / run-ended 别名分支已删）
    this.handleAgentEvent(msg, type);
  };
}
