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
  isEditToolName,
  isShellToolName,
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../api/toolFeedback';
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

export type ChatAttachment = { name: string; text?: string };

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

  const {
    activeSessionId,
    setActiveDiffSource,
    addTerminalLine,
    upsertSessionAgent,
    renameSession,
  } = useLayoutStore();

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
  /** 本轮 run 内是否已自动打开过侧栏，避免每个工具都抢焦点 */
  const openSidePanelOnceRef = useRef({ terminal: false, diff: false });

  /** 运行级错误横幅（不进 AI 正文） */
  const [runNotice, setRunNotice] = useState<RunNotice | null>(null);

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
        runStreamingAssistant(next.text, next.id, sid);
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
        toolNames[toolId] = name;
        store.addMessageToolCall(sid, assistantMsgId, {
          id: toolId,
          name,
          arguments: args,
          explanation,
          status: 'running'
        });

        if (isShellToolName(name) && args) {
          // 镜像到终端面板，但不自动抢开侧栏
          addTerminalLine(`$ ${args}`, sid);
        }
      },
      onToolPendingApproval: (toolId, name, args, explanation) => {
        toolNames[toolId] = name;
        // 若已有同 id 工具则更新，否则新增
        const existing = store.sessions
          .find((s) => s.id === sid)
          ?.messages?.find((m) => m.id === assistantMsgId)
          ?.toolCalls?.find((t) => t.id === toolId);
        if (existing) {
          store.updateMessageToolCall(sid, assistantMsgId, toolId, {
            name,
            arguments: args,
            explanation,
            status: 'pending_approval',
          });
        } else {
          store.addMessageToolCall(sid, assistantMsgId, {
            id: toolId,
            name,
            arguments: args,
            explanation,
            status: 'pending_approval',
          });
        }
        if (isShellToolName(name) && args) {
          addTerminalLine(`$ ${args}`, sid);
        }
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
          messages: [],
          startedAt: Date.now(),
        });
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
        useLayoutStore.setState((state) => {
          const sess = state.sessions.find((s) => s.id === sid);
          const ag = sess?.agents?.find((a) => a.id === info.subagentId);
          if (!ag) return;
          ag.status = info.status;
          if (info.summary) ag.summary = info.summary;
          ag.endedAt = Date.now();
          for (const m of ag.messages || []) {
            if (m.status === 'processing') m.status = 'completed';
          }
        });
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

        // 展示用清洗结果；shell 查看类绝不解析成 diff
        const displayOut = sanitizeToolDisplayOutput(output || '');
        const resolvedDiffs =
          isEditToolName(name) && !isShellToolName(name)
            ? resolveToolDiffs({
                name,
                args,
                output: displayOut,
                structuredDiffs: diffs,
              })
            : [];

        store.updateMessageToolCall(sid, assistantMsgId, toolId, {
          status: 'success',
          output: displayOut || output || '完成',
          diffs: resolvedDiffs.length ? resolvedDiffs : undefined,
        });

        // shell：仅镜像到终端缓冲区，不自动 openSidePanel / crish-open-terminal（避免每条命令抢焦点）
        if (isShellToolName(name) && displayOut) {
          displayOut.split('\n').slice(0, 80).forEach((line) => addTerminalLine(line, sid));
        }

        // 仅真实编辑 diff 才推右侧变更；不自动抢焦点展开
        if (resolvedDiffs.length > 0 && isEditToolName(name)) {
          const push = useLayoutStore.getState().pushDiffFile;
          if (push) resolvedDiffs.forEach((d) => push(d));
          else setActiveDiffSource(resolvedDiffs[0]);
          // 不自动 openSidePanel('diff')，避免「看了下目录就弹变更」
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
        drainQueuedAfterComplete(sid);
      }
    }, sid, assistantMsgId);

    streamsBySessionRef.current.set(sid, {
      cancel,
      userMsgId,
      assistantMsgId,
      runId: null,
    });
  };

  const handleStopGeneration = () => {
    // 只停当前会话，其它会话的并行 run 继续
    const sid = activeSessionId;
    if (!sid) return;
    const cur = streamsBySessionRef.current.get(sid);
    if (!cur) return;
    const st = useLayoutStore.getState();
    const asst = st.sessions
      .find((s) => s.id === sid)
      ?.messages.find((m) => m.id === cur.assistantMsgId);
    if (asst && !(asst.text || '').trim()) {
      st.updateMessageText(sid, cur.assistantMsgId, '已停止。');
      st.updateMessageThinking(sid, cur.assistantMsgId, '');
    }
    streamsBySessionRef.current.delete(sid);
    cur.cancel();
  };

  const handleSendChat = async (_isInsert: boolean = false) => {
    if (!chatInput.trim()) return;

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

    // /schedule → 打开设置「定时任务」页（不伪装为引擎内联调度命令）
    if (/^\/schedule\b/i.test(rawInput)) {
      setChatInput('');
      setSlashMenuOpen(false);
      useLayoutStore.getState().openSettings('schedule');
      onShowToast('已打开定时任务设置');
      return;
    }

    // /browser [url] → 打开右侧内置预览浏览器
    if (/^\/browser\b/i.test(rawInput)) {
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

    // /skill:name [task] → 注入 SKILL.md 正文到模型上下文
    let modelText = rawInput;
    let displayText = rawInput;
    if (skillCommandsEnabled && /^\/skill:/i.test(rawInput)) {
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

    // Fold attachments into the prompt so the model path sees them
    const attachBlock =
      attachments.length > 0
        ? `\n\n[附件]\n${attachments
            .map((a) =>
              a.text
                ? `--- ${a.name} ---\n${a.text.slice(0, 80_000)}${a.text.length > 80_000 ? '\n…(截断)' : ''}`
                : `- ${a.name}`,
            )
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
