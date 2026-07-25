import { getDesktopDaemonClient } from '../daemonClient';
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
  extractEventSequence,
  orchestratorEventToAgentEvent,
  projectAssistantTextFromEvents,
  streamRecovery,
  suffixDelta,
  type ReplayEvent,
  type ReplayPayload,
} from '../services/StreamRecovery';
import {
  blockText,
  mergeAssistantTextPiece,
  messageBelongsToRun,
} from './handlers/eventUtils';
import { resolveEventType } from './handlers/eventType';
import { parseApprovalResolvedFields } from './handlers/approval';
import {
  toolCallFieldsFromEvent,
  toolResultFields,
} from './handlers/toolUtils';
import {
  StreamState,
  surfaceStreamFailure,
} from './handlers/streamState';

export class EventRouter {
  private state: StreamState;
  private approvalFlow: ApprovalFlowMachine;
  private callbacks: StreamCallbacks;
  private runId: string;
  private sessionId: string;
  private finish: (force?: boolean) => void;
  private tryResumeFinish: () => void;
  private client: ReturnType<typeof getDesktopDaemonClient>;
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

  applyReplayEvents(payload: ReplayPayload | ReplayEvent[]): void {
    if (this.state.cancelled || this.state.finished) return;
    const events = Array.isArray(payload) ? payload : payload.events;
    if (!events.length) return;

    const sorted = [...events].sort((a, b) => {
      const sa = extractEventSequence(a) ?? 0;
      const sb = extractEventSequence(b) ?? 0;
      return sa - sb;
    });

    const fresh = sorted.filter((e) => {
      const seq = extractEventSequence(e);
      return seq == null || seq > this.lastAppliedSequence;
    });
    if (!fresh.length) return;

    const projected = projectAssistantTextFromEvents(fresh);
    const afterSeq =
      !Array.isArray(payload) && typeof payload.afterSequence === 'number'
        ? payload.afterSequence
        : this.lastAppliedSequence;
    let textEmit = '';
    if (afterSeq <= 0 && this.state.assistantText) {
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
    }

    for (const raw of fresh) {
      const seq = extractEventSequence(raw);
      const agent = orchestratorEventToAgentEvent(raw) ?? raw;
      const type = String(agent.type ?? '');
      if (
        type === 'message-delta' ||
        type === 'text-delta' ||
        type === 'message-end'
      ) {
        if (type === 'message-end') {
          this.handleAgentEvent(agent);
        }
      } else {
        this.handleAgentEvent(agent);
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

    if (type === 'event') {
      if (
        !msg.event ||
        typeof msg.event !== 'object' ||
        Array.isArray(msg.event)
      )
        return;
      const inner = msg.event as Record<string, unknown>;
      const innerType = String(inner.type ?? inner.event ?? inner.kind ?? '').trim();
      this.handleAgentEvent(inner, innerType || undefined);
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
