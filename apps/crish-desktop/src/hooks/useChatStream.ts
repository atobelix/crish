import {
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionMessage } from '../store/layoutStore';
import { streamAssistantResponseApi } from '../api/chatApi';
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
import { clientApi } from '../api/clientApi';
import { getWorkspacePath } from '../api/projectStore';
import { rulesLinesToText, syncRulesToDaemon } from '../api/rulesApi';

/** /goal 默认自动续写轮次上限 */
const GOAL_DEFAULT_MAX_ITERATIONS = 5;

/** 助手回复是否声明目标已完成 */
function replyLooksGoalDone(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return /\bDONE\b/i.test(t) || /目标已完成/.test(t);
}

/** 构造目标模式注入到模型的前缀（不展示在用户气泡） */
function buildGoalModePrefix(goal: string, iteration: number, maxIterations: number): string {
  return [
    '[目标模式 · 系统指令]',
    `你正在执行长期目标，请持续推进直至完成，并在每轮结束前自检进度。`,
    `目标：${goal}`,
    `当前第 ${iteration + 1} 轮（自动续写上限 ${maxIterations} 轮；请尽量在 8 轮内完成）。`,
    '请工作直至目标实质完成；不要半途停下或只列计划而不执行。',
    '若目标已完成，请在回复末尾明确写出 DONE 或「目标已完成」。',
    '---',
    '',
  ].join('\n');
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

  /**
   * 按会话隔离流式 run：多会话可并行，互不覆盖 cancel。
   * key = sessionId
   */
  const streamsBySessionRef = useRef(
    new Map<
      string,
      {
        cancel: () => void;
        userMsgId: string;
        assistantMsgId: string;
        runId: string | null;
      }
    >(),
  );
  /** 防止同会话 onComplete 重入 drain */
  const drainingSessionsRef = useRef(new Set<string>());
  /** 用户点停止后的会话：跳过 /goal 自动续写，避免 cancel 仍触发 onComplete 时继续 */
  const goalCancelledSessionsRef = useRef(new Set<string>());
  /** 本轮 run 内是否已自动打开过侧栏，避免每个工具都抢焦点 */
  const openSidePanelOnceRef = useRef({ terminal: false, diff: false });
  /**
   * 始终指向最新的 runStreamingAssistant，供 drain / onComplete 异步回调使用。
   * 避免 drainQueuedAfterComplete 或旧闭包调用到过期的 options / store action 身份。
   */
  const runStreamingAssistantRef = useRef<
    (input: string, userMsgId: string, sessionIdOverride?: string) => void
  >(null!);

  /** 运行级错误横幅（不进 AI 正文） */
  const [runNotice, setRunNotice] = useState<RunNotice | null>(null);

  /**
   * /goal 自动续写：无排队消息时，若 goalMode 仍 active 且未 DONE，则注入续写提示。
   * @returns true 表示已启动续写，调用方勿再 drain 排队
   */
  const maybeContinueGoalMode = (sid: string, assistantMsgId: string): boolean => {
    if (goalCancelledSessionsRef.current.has(sid)) {
      goalCancelledSessionsRef.current.delete(sid);
      return false;
    }
    const st = useLayoutStore.getState();
    const sess = st.sessions.find((s) => s.id === sid);
    const gm = sess?.goalMode;
    if (!gm?.active) return false;

    // 有用户排队消息时优先 drain，不抢目标续写
    const hasQueued = sess?.messages?.some(
      (m) => m.sender === 'user' && m.status === 'queued',
    );
    if (hasQueued) return false;

    const asstText =
      sess?.messages.find((m) => m.id === assistantMsgId)?.text || '';
    if (replyLooksGoalDone(asstText)) {
      st.patchSession(sid, {
        goalMode: { ...gm, active: false },
      });
      onShowToast('目标已完成');
      return false;
    }

    const maxIter = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
    const nextIter = (gm.iteration ?? 0) + 1;
    if (nextIter >= maxIter) {
      st.patchSession(sid, {
        goalMode: { ...gm, active: false, iteration: nextIter },
      });
      onShowToast(`目标模式已达上限（${maxIter} 轮），已停止自动续写`);
      return false;
    }

    st.patchSession(sid, {
      goalMode: { ...gm, active: true, iteration: nextIter, maxIterations: maxIter },
    });

    const contDisplay = '继续推进目标，若已完成请明确说明 DONE';
    const contModel = [
      buildGoalModePrefix(gm.goal, nextIter, maxIter),
      contDisplay,
    ].join('\n');

    const userMsgId = `user-msg-goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    useLayoutStore.setState((state) => {
      const s = state.sessions.find((x) => x.id === sid);
      if (!s) return;
      if (!s.messages) s.messages = [];
      s.messages.push({
        id: userMsgId,
        sender: 'user',
        text: contDisplay,
        timestamp: Date.now(),
        status: 'processing',
      });
    });

    // 下一帧再开流，避开 onComplete 同步栈
    setTimeout(() => {
      runStreamingAssistantRef.current(contModel, userMsgId, sid);
    }, 0);
    return true;
  };

  const drainQueuedAfterComplete = (sid: string) => {
    if (drainingSessionsRef.current.has(sid)) return;
    drainingSessionsRef.current.add(sid);
    try {
      const st = useLayoutStore.getState();
      const sess = st.sessions.find((s) => s.id === sid);
      // 同会话仍有在跑的助手时不抢跑排队消息
      const stillBusy = sess?.messages?.some(
        (m) => m.sender === 'assistant' && m.status === 'processing',
      );
      if (stillBusy) return;
      const next = sess?.messages.find((m) => m.sender === 'user' && m.status === 'queued');
      if (next?.text) {
        st.setSessionMessageStatus(sid, next.id, 'processing');
        // 排队消息的 text 即当时展示文案（含附件摘要）；作为下一轮 prompt
        // 经 ref 调最新实现，避免 drain 闭包里的函数身份过期
        // 排队文案不含目标前缀：若仍在目标模式，补前缀
        let prompt = next.text;
        const gm = sess?.goalMode;
        if (gm?.active && gm.goal) {
          const maxIter = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
          prompt = `${buildGoalModePrefix(gm.goal, gm.iteration ?? 0, maxIter)}${next.text}`;
        }
        runStreamingAssistantRef.current(prompt, next.id, sid);
      }
    } finally {
      // 下一帧再允许，避免与本次 onComplete 叠压
      setTimeout(() => {
        drainingSessionsRef.current.delete(sid);
      }, 0);
    }
  };

  // Real-time AI response streaming helper
  const runStreamingAssistant = (input: string, userMsgId: string, sessionIdOverride?: string) => {
    const sid = sessionIdOverride || useLayoutStore.getState().activeSessionId;
    if (!sid) return;

    // 同会话已有流：先 cancel，避免旧 cancel 句柄被覆盖后幽灵 run
    const prevStream = streamsBySessionRef.current.get(sid);
    if (prevStream) {
      streamsBySessionRef.current.delete(sid);
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
        const entry = streamsBySessionRef.current.get(sid);
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
        store.updateMessageText(sid, assistantMsgId, chunk);
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
        const curStream = streamsBySessionRef.current.get(sid);
        if (curStream?.assistantMsgId === assistantMsgId) {
          streamsBySessionRef.current.delete(sid);
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
        // 目标模式自动续写优先；否则 drain 排队
        if (!maybeContinueGoalMode(sid, assistantMsgId)) {
          drainQueuedAfterComplete(sid);
        }
      }
    }, sid, assistantMsgId);

    streamsBySessionRef.current.set(sid, {
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
    const cur = streamsBySessionRef.current.get(sid);
    if (!cur) return;
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
    streamsBySessionRef.current.delete(sid);
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
      useLayoutStore.getState().patchSession(sessionId, {
        goalMode: {
          active: true,
          goal,
          iteration: 0,
          maxIterations: GOAL_DEFAULT_MAX_ITERATIONS,
        },
      });
      displayText = `/goal ${goal}`;
      modelText = `${buildGoalModePrefix(goal, 0, GOAL_DEFAULT_MAX_ITERATIONS)}${goal}`;
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
        modelText = `${buildGoalModePrefix(liveGm.goal, liveGm.iteration ?? 0, maxIter)}${modelText}`;
      }
    }

    // Fold attachments into the prompt so the model path sees them
    const attachBlock =
      attachments.length > 0
        ? `\n\n[附件]\n${attachments
            .map((a) => {
              if (a.dataUrl) {
                const note = `用户粘贴了截图 ${a.name}，请结合 OCR/视觉理解分析`;
                return `[图片附件: ${a.name}]\ndataUrl: ${a.dataUrl}\n${note}\n![${a.name}](${a.dataUrl})`;
              }
              if (a.text) {
                return `--- ${a.name} ---\n${a.text.slice(0, 80_000)}${a.text.length > 80_000 ? '\n…(截断)' : ''}`;
              }
              return `- ${a.name}`;
            })
            .join('\n\n')}`
        : '';
    // 文件面板选区批注：注入模型上下文；气泡只展示用户原文 + 轻量提示
    const fileAnns = takePendingFileAnnotations();
    const annBlock = formatAnnotationsForModel(fileAnns);
    const input = (annBlock ? `${annBlock}\n\n` : '') + modelText + attachBlock;
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
      runStreamingAssistant(input, userMsgId, sessionId);
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
