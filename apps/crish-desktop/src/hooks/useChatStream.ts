import {
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionMessage } from '../store/layoutStore';
import {
  streamAssistantResponseApi,
  type ChatContentPart,
  type StreamAttachmentMeta,
  type StreamRequestOptions,
} from '../api/chatApi';
import {
  isShellToolName,
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../api/toolFeedback';
import { publishToolDiffs } from '../api/publishToolDiffs';
import { stripThoughtPlaceholders } from '../api/markdownRender';
import { normalizeAssistantTimeline } from '../api/toolPresentation';
import {
  formatSkillInjection,
  resolveSkillSlash,
} from '../api/skillsApi';
import {
  deriveSessionTitle,
  isDefaultSessionTitle,
} from '../api/sessionTitle';
import {
  formatAnnotationsForModel,
  takePendingFileAnnotations,
} from '../api/workspaceFsApi';
import {
  applyUsageDelta,
  fetchRunSnapshotUsage,
} from '../api/sessionEventHydrate';
import { estimateCostUsd } from '../api/pricingStore';
import { applySubagentEventToMessages } from '../api/subagentTimeline';
import { getActiveModelId } from '../api/providerProfiles';
import {
  StreamTextBatcher,
  streamBatchKey,
} from '../api/streamTextBatcher';
import { clientApi } from '../api/clientApi';
import { getWorkspacePath } from '../api/projectStore';
import { rulesLinesToText, syncRulesToDaemon } from '../api/rulesApi';
import {
  buildGoalModePrefix,
  createInitialGoalMode,
  decideGoalContinuation,
  GOAL_DEFAULT_MAX_ITERATIONS,
  mergeGoalTasksFromAssistantText,
} from '../api/goalModeController';
import { SessionStreamManager } from '../api/sessionStreamManager';
import type { SessionGoalMode } from '../store/types';

/** 从助手正文解析 checklist 并写回 session.goalMode.tasks */
function syncGoalTasksFromAssistantText(
  sid: string,
  assistantText: string,
  gm: SessionGoalMode,
): SessionGoalMode {
  const next = mergeGoalTasksFromAssistantText(gm, assistantText);
  if (next === gm) return gm;
  useLayoutStore.getState().patchSession(sid, { goalMode: next });
  return next;
}

/**
 * 从附件构建 OpenAI-style content parts + 文本兜底块 + 元数据。
 * 图片：结构化 image_url；文本协议仍在 prompt 中保留 dataUrl 备援。
 */
function buildMultimodalFromAttachments(
  modelText: string,
  attachments: ChatAttachment[],
): {
  promptAttachBlock: string;
  streamOptions: StreamRequestOptions | undefined;
} {
  if (!attachments.length) {
    return { promptAttachBlock: '', streamOptions: undefined };
  }

  const content: ChatContentPart[] = [];
  const meta: StreamAttachmentMeta[] = [];
  const promptChunks: string[] = [];
  let hasImages = false;

  const baseText = (modelText || '').trim();
  if (baseText) {
    content.push({ type: 'text', text: baseText });
  }

  for (const a of attachments) {
    if (a.dataUrl) {
      hasImages = true;
      const mime = a.mime || guessMimeFromDataUrl(a.dataUrl) || 'image/png';
      meta.push({ name: a.name, mime, kind: 'image' });
      content.push({
        type: 'image_url',
        image_url: { url: a.dataUrl, detail: 'auto' },
        name: a.name,
        mime,
      });
      // 文本协议备援：保留 dataUrl，兼容尚不读 content 的引擎
      const note = `用户粘贴了截图 ${a.name}，请结合 OCR/视觉理解分析（structured image_url 已一并下发）`;
      promptChunks.push(
        `[图片附件: ${a.name}]\ndataUrl: ${a.dataUrl}\n${note}\n![${a.name}](${a.dataUrl})`,
      );
    } else if (a.text) {
      meta.push({ name: a.name, kind: 'text' });
      const body = `${a.text.slice(0, 80_000)}${a.text.length > 80_000 ? '\n…(截断)' : ''}`;
      content.push({ type: 'text', text: `--- ${a.name} ---\n${body}` });
      promptChunks.push(`--- ${a.name} ---\n${body}`);
    } else {
      meta.push({ name: a.name, kind: 'file' });
      content.push({ type: 'text', text: `- ${a.name}` });
      promptChunks.push(`- ${a.name}`);
    }
  }

  const promptAttachBlock = `\n\n[附件]\n${promptChunks.join('\n\n')}`;
  const streamOptions: StreamRequestOptions = {
    content,
    hasImages,
    attachments: meta,
  };
  return { promptAttachBlock, streamOptions };
}

function guessMimeFromDataUrl(dataUrl: string): string | undefined {
  const m = /^data:([^;,]+)/i.exec(dataUrl || '');
  return m?.[1] || undefined;
}

const GRILL_ME_PREFIX = [
  '[对齐模式 · 系统指令]',
  '你是产品/技术对齐助手。针对用户主题只提问澄清（最多 5 个关键问题），暂不写代码、不改文件。',
  '等用户确认方案后再实施。问题应具体、可回答，避免一次抛出过多细节。',
  '---',
  '',
].join('\n');

export type ChatAttachment = {
  name: string;
  text?: string;
  /** data URL for images */
  dataUrl?: string;
  mime?: string;
};

export type RunNotice = { text: string; kind?: string };

export interface UseChatStreamOptions {
  wsId: string;
  onShowToast: (message: string) => void;
  handleGlobalTabClick: (cardId: string) => void;
  chatInput: string;
  setChatInput: (value: string) => void;
  setSlashMenuOpen: (open: boolean) => void;
  attachments: ChatAttachment[];
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  skillCommandsEnabled: boolean;
  needsKeySetup: boolean;
  setPickerInlineError: (msg: string) => void;
}

export interface UseChatStreamResult {
  runNotice: RunNotice | null;
  setRunNotice: Dispatch<SetStateAction<RunNotice | null>>;
  runStreamingAssistant: (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
  ) => void;
  handleSendChat: (isInsert?: boolean) => Promise<void>;
  handleStopGeneration: () => void;
}

/**
 * 主对话发送 / 流式回复 / 停止：按会话隔离 cancel，支持排队 drain。
 * UI 状态（输入框、附件等）由调用方持有，经 options 注入。
 */
export function useChatStream(options: UseChatStreamOptions): UseChatStreamResult {
  const {
    wsId,
    onShowToast,
    handleGlobalTabClick,
    chatInput,
    setChatInput,
    setSlashMenuOpen,
    attachments,
    setAttachments,
    skillCommandsEnabled,
    needsKeySetup,
    setPickerInlineError,
  } = options;

  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const setActiveDiffSource = useLayoutStore((s) => s.setActiveDiffSource);
  const addTerminalLine = useLayoutStore((s) => s.addTerminalLine);
  const upsertSessionAgent = useLayoutStore((s) => s.upsertSessionAgent);
  const renameSession = useLayoutStore((s) => s.renameSession);

  /** 按会话隔离流式 run：cancel / drain / 防幽灵 run */
  const streamManagerRef = useRef<SessionStreamManager | null>(null);
  if (!streamManagerRef.current) {
    streamManagerRef.current = new SessionStreamManager();
  }
  /** 用户点停止后的会话：跳过 /goal 自动续写，避免 cancel 仍触发 onComplete 时继续 */
  const goalCancelledSessionsRef = useRef(new Set<string>());
  /** 本轮 run 内是否已自动打开过侧栏，避免每个工具都抢焦点 */
  const openSidePanelOnceRef = useRef({ terminal: false, diff: false });
  /**
   * 始终指向最新的 runStreamingAssistant，供 drain / onComplete 异步回调使用。
   * 避免 drainQueuedAfterComplete 或旧闭包调用到过期的 options / store action 身份。
   */
  const runStreamingAssistantRef = useRef<
    (
      input: string,
      userMsgId: string,
      sessionIdOverride?: string,
      streamOptions?: StreamRequestOptions,
    ) => void
  >(null!);

  /**
   * 流式正文批合并：onChunk 高频覆盖，~48ms 刷一次 updateMessageText。
   * complete/stop 必须 flushNow，保证终态不丢。
   */
  const textBatcherRef = useRef<StreamTextBatcher | null>(null);
  if (!textBatcherRef.current) {
    textBatcherRef.current = new StreamTextBatcher((key, text) => {
      const sep = key.indexOf('::');
      if (sep < 0) return;
      const sessionId = key.slice(0, sep);
      const messageId = key.slice(sep + 2);
      useLayoutStore.getState().updateMessageText(sessionId, messageId, text);
    }, { intervalMs: 48 });
  }

  /** 运行级错误横幅（不进 AI 正文） */
  const [runNotice, setRunNotice] = useState<RunNotice | null>(null);

  /**
   * /goal 自动续写：无排队消息时，若 goalMode 仍 active 且未 DONE，则注入续写提示。
   * @returns true 表示已启动续写，调用方勿再 drain 排队
   */
  const maybeContinueGoalMode = (sid: string, assistantMsgId: string): boolean => {
    const cancelled = goalCancelledSessionsRef.current.has(sid);
    if (cancelled) goalCancelledSessionsRef.current.delete(sid);
    const st = useLayoutStore.getState();
    const sess = st.sessionsById[sid] || st.sessions.find((s) => s.id === sid);
    const asstText =
      sess?.messages.find((m) => m.id === assistantMsgId)?.text || '';
    // 先同步 checklist 到 store，再决策
    if (sess?.goalMode?.active) {
      syncGoalTasksFromAssistantText(sid, asstText, sess.goalMode);
    }
    const liveSess =
      useLayoutStore.getState().sessionsById[sid] ||
      useLayoutStore.getState().sessions.find((s) => s.id === sid);
    const decision = decideGoalContinuation({
      cancelled,
      session: liveSess,
      assistantText: asstText,
    });

    if (decision.action === 'stop') {
      if (decision.reason === 'done' || decision.reason === 'max_iter') {
        st.patchSession(sid, { goalMode: decision.goalMode });
      }
      if (decision.toast) onShowToast(decision.toast);
      return false;
    }

    st.patchSession(sid, { goalMode: decision.goalMode });
    const userMsgId = `user-msg-goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    useLayoutStore.setState((state) => {
      const s = state.sessionsById[sid] || state.sessions.find((x) => x.id === sid);
      if (!s) return;
      if (!s.messages) s.messages = [];
      s.messages.push({
        id: userMsgId,
        sender: 'user',
        text: decision.displayText,
        timestamp: Date.now(),
        status: 'processing',
      });
    });

    setTimeout(() => {
      runStreamingAssistantRef.current(decision.modelText, userMsgId, sid);
    }, 0);
    return true;
  };

  const drainQueuedAfterComplete = (sid: string) => {
    const mgr = streamManagerRef.current!;
    if (!mgr.beginDrain(sid)) return;
    try {
      const st = useLayoutStore.getState();
      const sess = st.sessionsById[sid] || st.sessions.find((s) => s.id === sid);
      const stillBusy = sess?.messages?.some(
        (m) => m.sender === 'assistant' && m.status === 'processing',
      );
      if (stillBusy) return;
      const next = sess?.messages.find((m) => m.sender === 'user' && m.status === 'queued');
      if (next?.text) {
        st.setSessionMessageStatus(sid, next.id, 'processing');
        let prompt = next.text;
        const gm = sess?.goalMode;
        if (gm?.active && gm.goal) {
          const maxIter = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
          prompt = `${buildGoalModePrefix(gm.goal, gm.iteration ?? 0, maxIter, gm.tasks)}${next.text}`;
        }
        runStreamingAssistantRef.current(prompt, next.id, sid);
      }
    } finally {
      mgr.endDrainNextTick(sid);
    }
  };

  // Real-time AI response streaming helper
  const runStreamingAssistant = (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions,
  ) => {
    const sid = sessionIdOverride || useLayoutStore.getState().activeSessionId;
    if (!sid) return;

    // 同会话已有流：先 cancel，避免旧 cancel 句柄被覆盖后幽灵 run
    const prevStream = streamManagerRef.current!.get(sid);
    if (prevStream) {
      streamManagerRef.current!.delete(sid);
      // 刷出旧流 pending 正文，再 cancel
      textBatcherRef.current?.flushNow();
      try {
        prevStream.cancel();
      } catch {
        /* ignore */
      }
    }

    const assistantMsgId = `assistant-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const store = useLayoutStore.getState();
    const toolNames: Record<string, string> = {};
    const startTime = Date.now();
    let gotRealText = false;
    let localRunId: string | null = null;
    // 仅当前查看会话时清 diff 焦点，避免后台会话抢右侧
    if (useLayoutStore.getState().activeSessionId === sid) {
      openSidePanelOnceRef.current = { terminal: false, diff: false };
      setActiveDiffSource(null);
    }

    store.addMessage(wsId, sid, {
      id: assistantMsgId,
      sender: 'assistant',
      text: '',
      thinking: '正在处理…',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: []
    });

    // find-or-add tool call on the streaming assistant message
    const upsertToolCall = (
      toolId: string,
      name: string,
      args: string | undefined,
      explanation: string | undefined,
      status: 'running' | 'pending_approval',
    ) => {
      toolNames[toolId] = name;
      const live = useLayoutStore.getState();
      const existing = live.sessions
        .find((s) => s.id === sid)
        ?.messages?.find((m) => m.id === assistantMsgId)
        ?.toolCalls?.find((t) => t.id === toolId);
      if (existing) {
        live.updateMessageToolCall(sid, assistantMsgId, toolId, {
          name,
          arguments: args,
          explanation,
          status,
        });
      } else {
        live.addMessageToolCall(sid, assistantMsgId, {
          id: toolId,
          name,
          arguments: args,
          explanation,
          status,
        });
      }
      if (isShellToolName(name) && args) {
        // 镜像到终端面板，但不自动抢开侧栏
        addTerminalLine(`$ ${args}`, sid);
      }
    };

    const cancel = streamAssistantResponseApi(input, {
      onRunMeta: ({ runId }) => {
        localRunId = runId;
        const entry = streamManagerRef.current!.get(sid);
        if (entry && entry.assistantMsgId === assistantMsgId) {
          entry.runId = runId;
        }
        // 记在会话上，便于 H3 事后拉 usage
        useLayoutStore.setState((state) => {
          const s = state.sessions.find((x) => x.id === sid);
          if (s) s.engineLastRunId = runId;
        });
      },
      onThought: (thought) => {
        store.updateMessageThinking(sid, assistantMsgId, thought);
      },
      onToolStart: (toolId, name, args, explanation) => {
        upsertToolCall(toolId, name, args, explanation, 'running');
      },
      onToolPendingApproval: (toolId, name, args, explanation) => {
        upsertToolCall(toolId, name, args, explanation, 'pending_approval');
      },
      onApprovalResolved: (toolId, decision) => {
        toolNames[toolId] = toolNames[toolId] || 'tool';
        if (decision === 'allow') {
          store.updateMessageToolCall(sid, assistantMsgId, toolId, {
            status: 'running',
            output: '执行中…',
          });
        } else {
          store.updateMessageToolCall(sid, assistantMsgId, toolId, {
            status: 'error',
            output: '未获批准',
          });
        }
      },
      onSubagentStarted: (info) => {
        if (!info.subagentId) return;
        upsertSessionAgent(sid, {
          id: info.subagentId,
          subagentRunId: info.subagentRunId,
          parentSessionId: sid,
          parentRunId: info.parentRunId,
          parentToolCallId: info.parentToolCallId,
          description: info.description || '协作 agent',
          mode: info.mode || 'research',
          status: 'running',
          messages: [
            {
              id: `agent-sys-${Date.now().toString(36)}`,
              sender: 'user',
              text: `（主 agent 已拉起协作：${info.description || info.mode || '任务'}）`,
              timestamp: Date.now(),
              status: 'completed',
            },
          ],
          startedAt: Date.now(),
        });
        // 父工具行标为进行中，便于时间线与子 agent 对齐
        if (info.parentToolCallId) {
          store.updateMessageToolCall(sid, assistantMsgId, info.parentToolCallId, {
            status: 'running',
            output: '协作进行中…',
          });
        }
      },
      onSubagentEvent: (info) => {
        if (!info.subagentId) return;
        useLayoutStore.setState((state) => {
          const sess = state.sessions.find((s) => s.id === sid);
          const ag = sess?.agents?.find((a) => a.id === info.subagentId);
          if (!ag) return;
          ag.messages = applySubagentEventToMessages(ag.messages || [], info.event);
        });
      },
      onSubagentEnded: (info) => {
        if (!info.subagentId) return;
        let parentToolCallId: string | undefined;
        let summary = info.summary || '';
        useLayoutStore.setState((state) => {
          const sess = state.sessions.find((s) => s.id === sid);
          const ag = sess?.agents?.find((a) => a.id === info.subagentId);
          if (!ag) return;
          ag.status = info.status;
          if (info.summary) ag.summary = info.summary;
          ag.endedAt = Date.now();
          parentToolCallId = ag.parentToolCallId;
          if (!summary) summary = ag.summary || '';
          for (const m of ag.messages || []) {
            if (m.status === 'processing') m.status = 'completed';
          }
          // 把结论写回父工具调用，主时间线可见协作结果
          const toolId = ag.parentToolCallId;
          if (toolId && sess?.messages) {
            for (const m of sess.messages) {
              const tc = m.toolCalls?.find((t) => t.id === toolId);
              if (!tc) continue;
              const st = String(info.status || '');
              const failed = /fail|error/i.test(st);
              const stopped = st === 'stopped' || /cancel|stopp?ed|abort/i.test(st);
              tc.status = failed || stopped ? 'error' : 'success';
              const body =
                summary.trim() ||
                (failed ? '协作未完成' : stopped ? '协作已停止' : '协作已完成');
              tc.output = body.length > 1200 ? body.slice(0, 1199) + '…' : body;
            }
          }
        });
        void parentToolCallId;
      },
      onTerminalLine: (line) => {
        addTerminalLine(line, sid);
      },
      onToolSuccess: (toolId, output, diffs) => {
        const name = toolNames[toolId] || '';
        const args =
          store.sessions
            .find((s) => s.id === sid)
            ?.messages?.find((m) => m.id === assistantMsgId)
            ?.toolCalls?.find((t) => t.id === toolId)?.arguments || '';

        // 展示用清洗；diff：有引擎结构化结果就保留，否则仅 edit / unified diff 才解析
        const displayOut = sanitizeToolDisplayOutput(output || '');
        const resolvedDiffs = resolveToolDiffs({
          name,
          args,
          output: displayOut,
          structuredDiffs: diffs,
        });

        store.updateMessageToolCall(sid, assistantMsgId, toolId, {
          status: 'success',
          output: displayOut || output || '完成',
          diffs: resolvedDiffs.length ? resolvedDiffs : undefined,
        });

        // shell：仅镜像到终端缓冲区，不自动 openSidePanel / crish-open-terminal（避免每条命令抢焦点）
        if (isShellToolName(name) && displayOut) {
          displayOut.split('\n').slice(0, 80).forEach((line) => addTerminalLine(line, sid));
        }

        // 有可展示 diff 才推右侧变更（set 外调用，避免 immer 嵌套丢弃）
        if (resolvedDiffs.length > 0) {
          publishToolDiffs(resolvedDiffs);
        }
      },
      onToolError: (toolId, error) => {
        const clean = sanitizeToolDisplayOutput(error || '');
        store.updateMessageToolCall(sid, assistantMsgId, toolId, {
          status: 'error',
          output: clean || error || '失败',
        });
        const name = toolNames[toolId];
        if (name && isShellToolName(name) && clean) {
          addTerminalLine(clean, sid);
        }
      },
      onChunk: (chunk) => {
        gotRealText = true;
        // 批合并写入 store，避免每 token 触发全树重绘
        textBatcherRef.current?.push(streamBatchKey(sid, assistantMsgId), chunk);
        // 有正文后清空占位思考，避免与正式输出叠在一起
        const cur = useLayoutStore
          .getState()
          .sessions.find((s) => s.id === sid)
          ?.messages.find((m) => m.id === assistantMsgId);
        if (cur?.thinking === '正在处理…') {
          store.updateMessageThinking(sid, assistantMsgId, '');
        }
      },
      onRunError: (message, kind) => {
        // 系统级提示：不写进助手气泡；横幅 + toast，避免一闪而过
        setRunNotice({ text: message, kind });
        onShowToast(message);
      },
      onComplete: () => {
        // 终态前强制 flush 批合并正文
        textBatcherRef.current?.flushNow();
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const st = useLayoutStore.getState();
        const asst = st.sessions
          .find((s) => s.id === sid)
          ?.messages.find((m) => m.id === assistantMsgId);
        // 禁止伪造「已结束。」进正文：会污染会话展示，也被用户当成模型失忆/胡说
        // 有工具无正文时保持空文案，时间线已有工具行；无工具则给一句诚实说明
        if (asst && !gotRealText && !(asst.text || '').trim()) {
          const hasTools = (asst.toolCalls || []).some(
            (t) => t.status === 'success' || t.status === 'error' || t.status === 'running',
          );
          if (!hasTools) {
            const tip = '这一轮没有文字回复。若刚改过配置，请检查模型与网络。';
            setRunNotice({ text: tip, kind: 'empty' });
            onShowToast(tip);
          }
        }
        // 收口诚实：未完成工具标 error，不伪造 success
        if (asst?.toolCalls?.length) {
          for (const tc of asst.toolCalls) {
            if (tc.status === 'pending_approval') {
              st.updateMessageToolCall(sid, assistantMsgId, tc.id, {
                status: 'error',
                output: tc.output || '回合结束时仍待确认',
              });
            } else if (tc.status === 'running') {
              const out = (tc.output || '').trim();
              const placeholder = !out || /^(执行中|运行中)…?$/.test(out);
              st.updateMessageToolCall(sid, assistantMsgId, tc.id, {
                status: 'error',
                output: placeholder ? '回合结束时工具未返回结果' : out,
              });
            }
          }
        }
        // 清理正文里的思考占位，避免与思考行重复；对齐 blocks 时间线
        try {
          const latest = useLayoutStore
            .getState()
            .sessions.find((s) => s.id === sid)
            ?.messages.find((m) => m.id === assistantMsgId);
          const raw = latest?.text || '';
          const cleaned = stripThoughtPlaceholders(raw);
          if (cleaned !== raw) st.updateMessageText(sid, assistantMsgId, cleaned);
          // 保留非占位思考内容供折叠查看
          const th = latest?.thinking || '';
          if (th === '正在处理…' || th === '正在思考中...') {
            st.updateMessageThinking(sid, assistantMsgId, '');
          }
          // 收口时规范化时间线，保证持久化/重渲染与 live 一致
          useLayoutStore.setState((state) => {
            const sess = state.sessions.find((s) => s.id === sid);
            const msg = sess?.messages.find((m) => m.id === assistantMsgId);
            if (!msg || msg.sender !== 'assistant') return;
            const n = normalizeAssistantTimeline({ ...msg });
            msg.blocks = n.blocks;
            msg.toolCalls = n.toolCalls;
          });
        } catch {
          /* ignore */
        }
        st.setSessionMessageStatus(sid, userMsgId, 'completed');
        st.setSessionMessageStatus(sid, assistantMsgId, 'completed', elapsed);
        const curStream = streamManagerRef.current!.get(sid);
        if (curStream?.assistantMsgId === assistantMsgId) {
          streamManagerRef.current!.delete(sid);
        }
        // H3：优先 run snapshot 真实 usage；无样本再字数估算
        void (async () => {
          try {
            const runId = localRunId;
            let applied = false;
            if (runId) {
              // 稍等引擎落盘 snapshot
              await new Promise((r) => setTimeout(r, 400));
              const usage = await fetchRunSnapshotUsage(runId);
              if (usage && (usage.sampleCount ?? 0) > 0 && (usage.promptTokens || usage.completionTokens)) {
                const model = getActiveModelId() || 'unknown';
                const cur = useLayoutStore.getState().tokenUsage;
                const next = applyUsageDelta(cur, usage, (i, o) => estimateCostUsd(model, i, o));
                useLayoutStore.getState().syncTelemetryData({ tokenUsage: next });
                applied = true;
              }
            }
            if (!applied) {
              const sess = useLayoutStore.getState().sessions.find((s) => s.id === sid);
              const userText = sess?.messages.find((m) => m.id === userMsgId)?.text || '';
              const asstText = sess?.messages.find((m) => m.id === assistantMsgId)?.text || '';
              const approxIn = Math.max(1, Math.ceil(userText.length / 4));
              const approxOut = Math.max(0, Math.ceil(asstText.length / 4));
              const model = getActiveModelId() || 'unknown';
              const cur = useLayoutStore.getState().tokenUsage;
              useLayoutStore.getState().syncTelemetryData({
                tokenUsage: {
                  ...cur,
                  input: cur.input + approxIn,
                  output: cur.output + approxOut,
                  cost: cur.cost + estimateCostUsd(model, approxIn, approxOut),
                },
              });
            }
          } catch {
            /* ignore */
          }
        })();
        // 目标模式：即使不续写也尝试从本轮 checklist 同步进度
        {
          const live = useLayoutStore.getState().sessions.find((s) => s.id === sid);
          const liveGm = live?.goalMode;
          if (liveGm?.active) {
            const t =
              live?.messages.find((m) => m.id === assistantMsgId)?.text || '';
            syncGoalTasksFromAssistantText(sid, t, liveGm);
          }
        }
        // 目标模式自动续写优先；否则 drain 排队
        if (!maybeContinueGoalMode(sid, assistantMsgId)) {
          drainQueuedAfterComplete(sid);
        }
      }
    }, sid, assistantMsgId, streamOptions);

    streamManagerRef.current!.set(sid, {
      cancel,
      userMsgId,
      assistantMsgId,
      runId: null,
    });
  };
  // 每轮渲染同步最新函数，确保 drain 经 ref 拿到当前闭包
  runStreamingAssistantRef.current = runStreamingAssistant;

  const handleStopGeneration = () => {
    // 只停当前会话，其它会话的并行 run 继续
    const sid = activeSessionId;
    if (!sid) return;
    const cur = streamManagerRef.current!.get(sid);
    if (!cur) return;
    // 停止前刷出批合并中的正文
    textBatcherRef.current?.flushNow();
    const st = useLayoutStore.getState();
    // 停止生成时中断目标自动续写
    if (st.sessions.find((s) => s.id === sid)?.goalMode?.active) {
      goalCancelledSessionsRef.current.add(sid);
      st.patchSession(sid, { goalMode: null });
    }
    const asst = st.sessions
      .find((s) => s.id === sid)
      ?.messages.find((m) => m.id === cur.assistantMsgId);
    if (asst && !(asst.text || '').trim()) {
      st.updateMessageText(sid, cur.assistantMsgId, '已停止。');
      st.updateMessageThinking(sid, cur.assistantMsgId, '');
    }
    // 立刻收成终态，避免 cancel 竞态下 UI 永久 processing
    st.setSessionMessageStatus(sid, cur.userMsgId, 'completed');
    st.setSessionMessageStatus(sid, cur.assistantMsgId, 'completed');
    // 运行中工具收成中断
    useLayoutStore.setState((state) => {
      const msg = state.sessions
        .find((s) => s.id === sid)
        ?.messages.find((m) => m.id === cur.assistantMsgId);
      if (!msg?.toolCalls) return;
      for (const tc of msg.toolCalls) {
        if (tc.status === 'running' || tc.status === 'pending_approval') {
          tc.status = 'error';
          tc.output = tc.output?.trim() ? tc.output : '已停止';
        }
      }
    });
    streamManagerRef.current!.delete(sid);
    cur.cancel();
  };

  const handleSendChat = async (_isInsert: boolean = false) => {
    // 允许仅发附件（截图/图片），不要求必须有文字
    if (!chatInput.trim() && attachments.length === 0) return;

    // 未配置密钥时软拦截
    if (needsKeySetup) {
      setPickerInlineError('请先在设置中配置服务商密钥与模型');
      useLayoutStore.getState().openSettings('models');
      return;
    }

    // Create session on first send if none active
    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = useLayoutStore.getState().createSession({ title: '新会话' });
    }
    const rawInput = chatInput.trim();

    // /schedule → 主对话区定时任务（与侧栏入口一致）
    if (rawInput && /^\/schedule\b/i.test(rawInput)) {
      setChatInput('');
      setSlashMenuOpen(false);
      try {
        window.dispatchEvent(new CustomEvent('crish-open-scheduled'));
      } catch {
        /* ignore */
      }
      onShowToast('已打开定时任务');
      return;
    }

    // /teamwork-preview → 打开协作 agent 面板（看板）
    if (rawInput && /^\/teamwork-preview\b/i.test(rawInput)) {
      setChatInput('');
      setSlashMenuOpen(false);
      useLayoutStore.getState().setPanelAgentId(null);
      useLayoutStore.getState().setActiveAgentId(null);
      handleGlobalTabClick('agent');
      try {
        window.dispatchEvent(
          new CustomEvent('crish-open-agent-panel', { detail: {} }),
        );
      } catch {
        /* ignore */
      }
      onShowToast('协作看板');
      return;
    }

    // /browser [url] → 打开右侧内置预览浏览器
    if (rawInput && /^\/browser\b/i.test(rawInput)) {
      const rest = rawInput.replace(/^\/browser\b/i, '').trim();
      setChatInput('');
      setSlashMenuOpen(false);
      handleGlobalTabClick('preview');
      if (rest) {
        void import('../api/previewBrowserStore').then(({ normalizeBrowseUrl, setPreviewUrl }) => {
          setPreviewUrl(normalizeBrowseUrl(rest));
        });
      }
      onShowToast(rest ? `预览浏览器 → ${rest}` : '已打开预览浏览器');
      return;
    }

    // /learn <rule> → 持久化用户规则，短确认，不跑完整 agent
    if (rawInput && /^\/learn\b/i.test(rawInput)) {
      const ruleText = rawInput.replace(/^\/learn\b/i, '').trim();
      setChatInput('');
      setSlashMenuOpen(false);
      if (!ruleText) {
        onShowToast('用法：/learn <要记住的规则>');
        return;
      }
      try {
        const cwd = getWorkspacePath() || '__global__';
        const sets = await clientApi.getSettingsEx(cwd);
        const prev = Array.isArray(sets.customRules) ? sets.customRules : [];
        if (prev.includes(ruleText)) {
          onShowToast('该规则已存在');
          return;
        }
        const next = [...prev, ruleText];
        await clientApi.saveSettingsEx(cwd, 'global', { customRules: next });
        // 仅同步全局规则，避免空 projectText 误删引擎侧项目规则
        const globalText = rulesLinesToText(next, '# 全局规则');
        void syncRulesToDaemon({ globalText });
        onShowToast('已记住规则');

        const userMsgId = `user-msg-${Date.now()}`;
        const asstMsgId = `assistant-msg-${Date.now()}-learn`;
        useLayoutStore.setState((state) => {
          const sess = state.sessions.find((s) => s.id === sessionId);
          if (!sess) return;
          if (!sess.messages) sess.messages = [];
          sess.messages.push({
            id: userMsgId,
            sender: 'user',
            text: `/learn ${ruleText}`,
            timestamp: Date.now(),
            status: 'completed',
          });
          sess.messages.push({
            id: asstMsgId,
            sender: 'assistant',
            text: `已记录用户偏好：${ruleText}`,
            timestamp: Date.now() + 1,
            status: 'completed',
          });
        });
      } catch (e) {
        onShowToast(`记住规则失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    // /skill:name [task] → 注入 SKILL.md 正文到模型上下文
    let modelText = rawInput;
    let displayText = rawInput;

    // /goal <task> → 会话目标模式 + 系统前缀
    if (rawInput && /^\/goal\b/i.test(rawInput)) {
      const goal = rawInput.replace(/^\/goal\b/i, '').trim();
      if (!goal) {
        setChatInput('');
        setSlashMenuOpen(false);
        onShowToast('用法：/goal <要完成的目标>');
        return;
      }
      goalCancelledSessionsRef.current.delete(sessionId);
      const gm = createInitialGoalMode(goal, GOAL_DEFAULT_MAX_ITERATIONS);
      useLayoutStore.getState().patchSession(sessionId, { goalMode: gm });
      displayText = `/goal ${goal}`;
      modelText = `${buildGoalModePrefix(goal, 0, gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS, gm.tasks)}${goal}`;
      onShowToast('已进入目标模式');
    }

    // /grill-me <topic> → 只提问澄清；切 plan 权限更安全
    if (rawInput && /^\/grill-me\b/i.test(rawInput)) {
      const topic = rawInput.replace(/^\/grill-me\b/i, '').trim();
      if (!topic) {
        setChatInput('');
        setSlashMenuOpen(false);
        onShowToast('用法：/grill-me <要对齐的主题>');
        return;
      }
      useLayoutStore.getState().setPermissionMode('plan');
      displayText = `/grill-me ${topic}`;
      modelText = `${GRILL_ME_PREFIX}主题：${topic}`;
      onShowToast('已进入对齐提问模式（计划权限）');
    }

    if (skillCommandsEnabled && rawInput && /^\/skill:/i.test(rawInput)) {
      try {
        const resolved = await resolveSkillSlash(rawInput);
        if (resolved) {
          modelText = formatSkillInjection(resolved.skill, resolved.rest);
          displayText = resolved.rest
            ? `/skill:${resolved.skill.name} ${resolved.rest}`
            : `使用技能：${resolved.skill.name}`;
          onShowToast(`已加载技能 ${resolved.skill.name}`);
        } else {
          onShowToast('未找到该技能，请在设置 → 技能 中确认名称与启用状态');
        }
      } catch {
        /* 回退原文 */
      }
    }

    // 若已在目标模式且本条不是 /goal 命令本身：仍为后续普通消息注入前缀
    if (rawInput && !/^\/goal\b/i.test(rawInput)) {
      const liveGm = useLayoutStore
        .getState()
        .sessions.find((s) => s.id === sessionId)?.goalMode;
      if (liveGm?.active && liveGm.goal) {
        const maxIter = liveGm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
        modelText = `${buildGoalModePrefix(liveGm.goal, liveGm.iteration ?? 0, maxIter, liveGm.tasks)}${modelText}`;
      }
    }

    // 附件 → 结构化 content parts + 文本 prompt 备援
    const { promptAttachBlock, streamOptions } = buildMultimodalFromAttachments(
      modelText,
      attachments,
    );
    // 文件面板选区批注：注入模型上下文；气泡只展示用户原文 + 轻量提示
    const fileAnns = takePendingFileAnnotations();
    const annBlock = formatAnnotationsForModel(fileAnns);
    const input = (annBlock ? `${annBlock}\n\n` : '') + modelText + promptAttachBlock;
    // 批注并入 content text part（若有多模态）
    let finalStreamOptions = streamOptions;
    if (finalStreamOptions?.content?.length && annBlock) {
      const parts = [...finalStreamOptions.content];
      const firstText = parts.findIndex((p) => p.type === 'text');
      const head = firstText >= 0 ? parts[firstText] : undefined;
      if (head && head.type === 'text') {
        parts[firstText] = {
          type: 'text',
          text: `${annBlock}\n\n${head.text}`,
        };
      } else {
        parts.unshift({ type: 'text', text: annBlock });
      }
      finalStreamOptions = { ...finalStreamOptions, content: parts };
    } else if (!finalStreamOptions && annBlock) {
      finalStreamOptions = {
        content: [{ type: 'text', text: `${annBlock}\n\n${modelText}` }],
        hasImages: false,
      };
    }
    if (fileAnns.length) {
      displayText = displayText
        ? `${displayText}\n\n（含 ${fileAnns.length} 条文件批注）`
        : `（${fileAnns.length} 条文件批注）`;
    }
    if (attachments.length > 0) {
      // 气泡仅轻量展示附件名（图片不把 dataUrl 塞进消息正文）
      displayText = `${displayText}${displayText ? '\n\n' : ''}📎 ${attachments.map((a) => a.name).join('、')}`;
    }

    setChatInput('');
    setSlashMenuOpen(false);
    setAttachments([]);
    setPickerInlineError('');

    const userMsgId = `user-msg-${Date.now()}`;
    const sessMsgs =
      useLayoutStore.getState().sessions.find((s) => s.id === sessionId)?.messages || [];
    const isAiBusy = sessMsgs.some((m) => m.status === 'processing');

    // 标题仍为默认时自动命名（首条优先；不覆盖用户手动 rename）
    {
      const sess = useLayoutStore.getState().sessions.find((s) => s.id === sessionId);
      if (sess && isDefaultSessionTitle(sess.title)) {
        const priorUser = sessMsgs.find((m) => m.sender === 'user' && (m.text || '').trim());
        const seed = (priorUser?.text || rawInput).trim();
        const nextTitle = deriveSessionTitle(seed);
        if (!isDefaultSessionTitle(nextTitle)) {
          renameSession(sessionId, nextTitle);
        }
      }
    }

    useLayoutStore.setState((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess && sess.messages) {
        const newMsg: SessionMessage = {
          id: userMsgId,
          sender: 'user',
          text: displayText,
          timestamp: Date.now(),
          status: isAiBusy ? 'queued' : 'processing',
        };
        // 正式版：不再支持「插入打断」，统一入队或立即发送
        // 侧栏时间由消息 timestamp 推算，不写死「刚刚」
        sess.messages.push(newMsg);
      }
    });

    if (!isAiBusy) {
      const store = useLayoutStore.getState();
      if (store.activeSessionId !== sessionId) {
        store.setActiveSessionId(sessionId);
      }
      runStreamingAssistant(input, userMsgId, sessionId, finalStreamOptions);
    }
  };

  return {
    runNotice,
    setRunNotice,
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
  };
}
