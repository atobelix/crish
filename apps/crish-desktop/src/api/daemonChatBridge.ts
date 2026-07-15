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
import { useLayoutStore } from '../store/layoutStore';
import { parseUnifiedDiffs } from './toolFeedback';
import { toDaemonPermissionMode } from './permissionModes';
import {
  commandMatchesWhitelist,
  extractCommandForMatch,
} from './commandPermissions';
import {
  assistantBubbleForFailure,
  classifySoftFailure,
  logInternalError,
  networkUserMessage,
  softFailureMessage,
} from './userFacingErrors';
import { ApprovalFlowMachine } from './approvalFlowMachine';
import {
  extractApprovalCommandArgs,
  parseToolCallFields,
} from './daemonEventSchema';

function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as Record<string, unknown>;
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  return '';
}

function toolCallFields(call: unknown): { id: string; name: string; args: string; explanation: string } {
  const parsed = parseToolCallFields(call);
  if (parsed.ok === false) {
    logInternalError('daemon-protocol', parsed.error);
    return { id: `tc-${Date.now()}`, name: 'tool', args: '', explanation: '' };
  }
  return parsed.data;
}

function toolResultFields(result: unknown): {
  id: string;
  text: string;
  isError: boolean;
  diffs?: Array<{
    filePath: string;
    additions: number;
    deletions: number;
    changes: Array<{ type: 'addition' | 'deletion' | 'normal'; content: string }>;
  }>;
  filePath?: string;
} {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const id = String(r.toolCallId ?? r.id ?? '');
  const isError = Boolean(r.isError ?? r.error);
  let text = '';
  if (typeof r.output === 'string') text = r.output;
  else if (r.output && typeof r.output === 'object') {
    const o = r.output as Record<string, unknown>;
    text = typeof o.text === 'string' ? o.text : JSON.stringify(o);
  } else if (typeof r.text === 'string') text = r.text;
  else if (r.error) text = String(r.error);

  // 仅信任引擎结构化 diffs 或明确的 git unified diff 头，禁止用 path+输出瞎合成
  let diffs: ReturnType<typeof toolResultFields>['diffs'];
  if (Array.isArray(r.diffs)) {
    diffs = r.diffs as NonNullable<typeof diffs>;
  } else if (r.output && typeof r.output === 'object') {
    const o = r.output as Record<string, unknown>;
    if (Array.isArray(o.diffs)) diffs = o.diffs as NonNullable<typeof diffs>;
  }

  const filePath =
    (typeof r.path === 'string' && r.path) ||
    (typeof r.filePath === 'string' && r.filePath) ||
    (r.output && typeof r.output === 'object' && typeof (r.output as { path?: string }).path === 'string'
      ? String((r.output as { path: string }).path)
      : undefined);

  if (!diffs && text && !isError && (/\bdiff --git\b/.test(text) || /^@@\s+-\d/m.test(text))) {
    const parsed = parseUnifiedDiffs(text);
    if (parsed.length) diffs = parsed;
  }

  return { id, text, isError, diffs, filePath };
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
  /** 本轮是否收到过正文 delta（无 delta 时 message-end 做渐进展示） */
  let receivedTextDelta = false;
  let progressiveTimer: ReturnType<typeof setTimeout> | null = null;
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

  const clearProgressive = () => {
    if (progressiveTimer) {
      clearTimeout(progressiveTimer);
      progressiveTimer = null;
    }
  };

  const revealProgressively = (full: string, done: () => void) => {
    clearProgressive();
    // 调用方已判断「本段无 delta」；短文直接落地
    if (!full || full.length < 24) {
      callbacks.onChunk(full);
      done();
      return;
    }
    // 无流式 delta 时，本地按块推进，避免「整段砸下来」
    let i = 0;
    const step = Math.max(12, Math.ceil(full.length / 48));
    const tick = () => {
      if (cancelled || finished) {
        callbacks.onChunk(full);
        done();
        return;
      }
      i = Math.min(full.length, i + step);
      callbacks.onChunk(full.slice(0, i));
      if (i >= full.length) {
        progressiveTimer = null;
        done();
        return;
      }
      progressiveTimer = setTimeout(tick, 16);
    };
    tick();
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
    clearProgressive();
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
   * 通过 onRunError 回调给 UI toast / 系统提示。
   */
  const surfaceFailure = (raw: unknown, scope: string) => {
    logInternalError(scope, raw);
    const kind = classifySoftFailure(raw);
    const msg =
      softFailureMessage(kind) ??
      assistantBubbleForFailure(raw) ??
      '这一轮没有顺利完成。请稍后重试，或检查网络与模型配置。';
    if (callbacks.onRunError) {
      callbacks.onRunError(msg, kind || 'ended');
    }
  };

  const handleAgentEvent = (event: Record<string, unknown>) => {
    if (cancelled || finished) return;
    const type = String(event.type ?? '');

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
        receivedTextDelta = true;
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
          const hadStream = receivedTextDelta && Boolean(assistantText);
          if (!assistantText) {
            assistantText = piece;
          } else if (
            assistantText === piece ||
            piece.startsWith(assistantText) ||
            assistantText.endsWith(piece) ||
            piece.includes(assistantText)
          ) {
            assistantText = piece.length >= assistantText.length ? piece : assistantText;
          } else {
            assistantText = `${assistantText}\n\n${piece}`;
          }
          const full = assistantText;
          if (hadStream) {
            callbacks.onChunk(full);
          } else {
            revealProgressively(full, () => {
              assistantText = full;
            });
          }
          receivedTextDelta = false;
        }
      }
      return;
    }

    // 只认单条 tool-start，忽略 batch-start，避免同一工具进两次
    if (type === 'tool-start') {
      const { id, name, args, explanation } = toolCallFields(event.call);
      if (id) {
        approvalFlow.dispatch({ type: "tool_start", toolId: id });
        callbacks.onToolStart(id, name, args, explanation);
      }
      return;
    }
    if (type === 'tool-batch-start') {
      return;
    }

    if (type === 'tool-end') {
      const { id, text, isError, diffs } = toolResultFields(event.result);
      if (!id) return;
      approvalFlow.dispatch({ type: "tool_end", toolId: id });
      if (isError) callbacks.onToolError(id, text || 'failed');
      else callbacks.onToolSuccess(id, text || '', diffs);
      // 曾 defer 的终态：在飞工具归零后立即收口，不靠超时
      tryResumeFinish();
      return;
    }

    // batch-end 与逐条 tool-end 重复，忽略以免双写
    if (type === 'tool-batch-end') {
      return;
    }

    if (type === 'approval-requested') {
      const req = (event.request && typeof event.request === 'object' ? event.request : event) as Record<
        string,
        unknown
      >;
      const toolCallId = String(req.toolCallId ?? req.id ?? `approval-${Date.now()}`);
      const toolName = String(req.toolName ?? req.name ?? 'command');
      // 协议字段是 parameters（含 command），勿把整份 request 序列化成 JSON
      const args = extractApprovalCommandArgs(req);
      const explanation = String(
        req.summary ?? req.reason ?? req.message ?? toolName ?? '需要确认',
      );

      // 引擎发来 approval-requested 说明策略要求确认——必须弹窗并挂起，
      // 否则 run 会一直等批准。full 的非极危由引擎直接 allow，不会到这里。
      // plan 写操作由引擎 deny，同样不会 ask。
      const perm = useLayoutStore.getState().permissionMode;
      if (perm === 'plan') {
        // 防御：计划模式不应 ask；若不慎收到则记 running 不拦用户
        callbacks.onToolStart(toolCallId, toolName, args, explanation);
        return;
      }

      // 命令白名单：自动 approve，不伪造输出（等引擎 tool-end）
      {
        const st = useLayoutStore.getState();
        const line = extractCommandForMatch(toolName, args);
        if (commandMatchesWhitelist(line, st.commandPermissions || [])) {
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
                callbacks.onToolPendingApproval(toolCallId, toolName, args, explanation);
              }
            });
          return;
        }
      }

      approvalFlow.dispatch({ type: "approval_pending", toolId: toolCallId });
      if (callbacks.onToolPendingApproval) {
        callbacks.onToolPendingApproval(toolCallId, toolName, args, explanation);
      } else {
        callbacks.onToolStart(toolCallId, toolName, args, explanation);
      }
      return;
    }

    // 自动放行（完全访问）或用户批准后都会到这里
    if (type === 'approval-resolved') {
      const requestId = String(event.requestId ?? event.toolCallId ?? '');
      const decision = event.decision;
      const allowed =
        decision === 'approved' ||
        decision === 'allow' ||
        (decision &&
          typeof decision === 'object' &&
          (decision as { behavior?: string }).behavior === 'allow');
      const denied =
        decision === 'denied' ||
        decision === 'expired' ||
        decision === 'deny' ||
        (decision &&
          typeof decision === 'object' &&
          (decision as { behavior?: string }).behavior === 'deny');
      if (requestId) {
        approvalFlow.dispatch({ type: "approval_resolved", toolId: requestId });
        if (callbacks.onApprovalResolved) {
          callbacks.onApprovalResolved(requestId, allowed ? 'allow' : 'deny');
        }
        // allow 后引擎还会继续，勿提前收口；
        // deny：若此前因审批 defer 过终态则收口；已见 run 终态时同样 tryResume
        if (denied && approvalFlow.isDeferredTerminal() && !approvalFlow.hasPending()) {
          finish(false);
        } else if (approvalFlow.snapshot().sawRunTerminal) {
          tryResumeFinish();
        }
      }
      return;
    }

    // 真正终态以 run-terminal 为准
    if (type === 'run-terminal' || type === 'run-completed' || type === 'run-failed') {
      if (type === 'run-failed') {
        surfaceFailure(event.error ?? event.message ?? event, 'run-failed');
      }
      const term = String((event as { terminal?: string }).terminal || '');
      if (type === 'run-terminal' && term === 'failed') {
        surfaceFailure(event.error ?? event, 'run-terminal-failed');
      }
      approvalFlow.dispatch({ type: "run_terminal_seen" });
      if (approvalFlow.hasPending() && type !== 'run-failed' && term !== 'failed' && term !== 'cancelled') {
        approvalFlow.dispatch({ type: "defer_terminal" });
        return;
      }
      approvalFlow.dispatch({ type: "clear_all" });
      finish(term === 'failed' || term === 'cancelled' || type === 'run-failed');
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
    const type = String(msg.type ?? '');

    // 子 agent 广播：runId 是父 run；与本流绑定
    if (type === 'subagent-started') {
      if (msg.runId && msg.runId !== runId) return;
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
      if (msg.runId && msg.runId !== runId) return;
      const ev =
        msg.event && typeof msg.event === 'object'
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
      if (msg.runId && msg.runId !== runId) return;
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
      if (msg.runId && msg.runId !== runId) return;
      surfaceFailure(msg.message ?? msg.error ?? msg, 'daemon-error');
      approvalFlow.dispatch({ type: "clear_all" });
      finish(true);
      return;
    }

    if (type === 'event' && msg.event && typeof msg.event === 'object') {
      if (msg.runId && msg.runId !== runId) return;
      handleAgentEvent(msg.event as Record<string, unknown>);
      return;
    }

    if (type === 'run-ended' || type === 'run-failed') {
      if (msg.runId && msg.runId !== runId) return;
      if (type === 'run-failed') {
        surfaceFailure(msg.error ?? msg.message ?? msg, 'run-ended-failed');
      }
      approvalFlow.dispatch({ type: "run_terminal_seen" });
      approvalFlow.dispatch({ type: "clear_all" });
      finish(type === 'run-failed');
      return;
    }

    if (type === 'approval-requested') {
      if (msg.runId && msg.runId !== runId) return;
      handleAgentEvent(msg);
      return;
    }

    // 广播的审批结果（不嵌在 event 里）
    if (type === 'approval-resolved') {
      if (msg.runId && msg.runId !== runId) return;
      const toolCallId = String(msg.toolCallId ?? msg.requestId ?? '');
      const decision = msg.decision;
      const allowed =
        decision === 'approved' ||
        decision === 'allow' ||
        (decision &&
          typeof decision === 'object' &&
          (decision as { behavior?: string }).behavior === 'allow');
      const denied =
        decision === 'denied' ||
        decision === 'expired' ||
        decision === 'deny' ||
        (decision &&
          typeof decision === 'object' &&
          (decision as { behavior?: string }).behavior === 'deny');
      if (toolCallId) {
        approvalFlow.dispatch({ type: "approval_resolved", toolId: toolCallId });
        if (callbacks.onApprovalResolved) {
          // 未知决策按 deny，避免伪造 allow
          callbacks.onApprovalResolved(toolCallId, allowed ? 'allow' : 'deny');
        }
        if (denied && approvalFlow.isDeferredTerminal() && !approvalFlow.hasPending()) {
          finish(false);
        } else if (approvalFlow.snapshot().sawRunTerminal) {
          tryResumeFinish();
        }
      }
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

      const mode = useLayoutStore.getState().permissionMode;
      const permissionMode = toDaemonPermissionMode(mode);

      const hasImages = Boolean(options?.hasImages || options?.content?.some((p) => p.type === 'image_url'));
      await client.send({
        type: 'run-task',
        runId,
        prompt,
        sessionId,
        permissionMode,
        ...(cwd ? { cwd } : {}),
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
