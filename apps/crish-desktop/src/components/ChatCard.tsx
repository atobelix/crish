import React, { useState, useEffect, useRef } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionMessage, FileDiff } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
import { streamAssistantResponseApi } from '../api/chatApi';
import { daemonApproveTool, daemonDenyTool } from '../api/daemonChatBridge';
import { getDesktopDaemonClient } from '../api/daemonClient';
import { isDemoMode } from '../api/appMode';
import { fetchEngineStatus, type EngineStatus } from '../api/engineConfig';
import {
  activateProfileModel,
  anyProfileHasKey,
  flattenModelChoices,
  getActiveModelId,
  getActiveProfile,
  getActiveProfileId,
  loadProfiles,
} from '../api/providerProfiles';
import {
  getActiveProject,
  getWorkspacePath,
  listProjects,
  openProject,
} from '../api/projectStore';
import { ProjectPickerMenu } from './ProjectPickerMenu';
import { networkUserMessage } from '../api/userFacingErrors';
import {
  isEditToolName,
  isShellToolName,
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../api/toolFeedback';
import { parseMarkdownToHtml, stripThoughtPlaceholders } from '../api/markdownRender';
import {
  assistantCopyText,
  buildAssistantTimeline,
  extractImageRefs,
  normalizeAssistantTimeline,
  toolCommandPreview,
  toolHasDisplayableResult,
  toolResultPreview,
  toolSummaryLabel,
  truncateToolOutput,
  type ToolRenderItem,
} from '../api/toolPresentation';
import {
  applyUsageDelta,
  fetchRunSnapshotUsage,
} from '../api/sessionEventHydrate';
import { estimateCostUsd } from '../api/pricingStore';
import { ApprovalSheet } from './ApprovalSheet';
import {
  PERMISSION_MODES,
  permissionModeMeta,
  type PermissionMode,
} from '../api/permissionModes';

interface ChatCardProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: (message: string) => void;
  handleGlobalTabClick: (cardId: string) => void;
}

export const ChatCard: React.FC<ChatCardProps> = ({
  wsId,
  colIdx: _colIdx,
  groupIdx: _groupIdx,
  onShowToast,
  handleGlobalTabClick
}) => {
  const {
    sessions,
    activeSessionId,
    withdrawMessage,
    setActiveDiffSource,
    respondToApproval,
    addTerminalLine,
    appSettings,
  } = useLayoutStore();

  const [engineModel, setEngineModel] = useState('');
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerInlineError, setPickerInlineError] = useState('');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projectTick, setProjectTick] = useState(0);
  const [engineHint, setEngineHint] = useState<EngineStatus | null>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
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
  const [approvalBusy, setApprovalBusy] = useState(false);

  const modelChoices = flattenModelChoices();
  const activeProject = getActiveProject();

  useEffect(() => {
    const onProj = () => setProjectTick((n) => n + 1);
    const onOpenPicker = () => setShowProjectPicker(true);
    window.addEventListener('crish-project-changed', onProj);
    window.addEventListener('crish-open-project-picker', onOpenPicker);
    return () => {
      window.removeEventListener('crish-project-changed', onProj);
      window.removeEventListener('crish-open-project-picker', onOpenPicker);
    };
  }, []);

  useEffect(() => {
    void fetchEngineStatus().then((s) => {
      setEngineHint(s);
      const localModel = getActiveModelId();
      if (s.model) setEngineModel(s.model);
      else if (localModel) setEngineModel(localModel);
      else if (appSettings?.defaultModel) setEngineModel(appSettings.defaultModel);
    });
    setActiveProfileId(getActiveProfileId());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectTick]);

  const selectProfileModel = async (profileId: string, modelId: string) => {
    if (pickerBusy) return;
    setPickerBusy(true);
    setPickerInlineError('');
    try {
      const res = await activateProfileModel(profileId, modelId);
      if (!res.ok) {
        setPickerInlineError(
          res.error === 'not_connected' ? networkUserMessage() : '切换失败，请到设置检查密钥与地址',
        );
        return;
      }
      setEngineModel(modelId);
      setActiveProfileId(profileId);
      setShowModelDropdown(false);
      // 刷新底部软提示（无本地密钥时会引导同步）
      setEngineHint(await fetchEngineStatus());
      void res.warning;
    } finally {
      setPickerBusy(false);
    }
  };

  const getModelDisplayName = (modelId: string) => {
    if (!modelId) return '选择模型';
    const profile = getActiveProfile();
    if (profile && activeProfileId === profile.id) {
      // Compact: model only when space is tight; profile name in title attribute
      return modelId;
    }
    return modelId;
  };

  const needsKeySetup =
    !anyProfileHasKey() &&
    !(engineHint?.ok && engineHint.hasApiKey === true);

  /** 未配置好密钥/模型时，主界面不展示模型选择器 */
  const showModelPicker =
    !needsKeySetup &&
    (modelChoices.some((c) => c.hasKey) ||
      Boolean(engineHint?.ok && engineHint.hasApiKey && (engineModel || getActiveModelId())));

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const messages = activeSession?.messages || [];

  // 仅统计「进行中」消息的待确认，避免已结束会话的幽灵条
  let pendingApprovalTc: any = null;
  let pendingApprovalMsgId = '';
  let pendingApprovalCount = 0;
  for (const m of messages) {
    if (!m.toolCalls) continue;
    if (m.status === 'completed' || m.status === 'queued') continue;
    for (const tc of m.toolCalls) {
      if (tc.status !== 'pending_approval') continue;
      pendingApprovalCount += 1;
      if (!pendingApprovalTc) {
        pendingApprovalTc = tc;
        pendingApprovalMsgId = m.id;
      }
    }
  }
  const pendingQueueRemaining = Math.max(0, pendingApprovalCount - 1);

  const formatTime = (ts?: number) => {
    if (!ts) return '';
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [expandedUserMsgs, setExpandedUserMsgs] = useState<Record<string, boolean>>({});
  // Demo-only decorative pills; product mode stays quiet until real signals exist
  const [prVisible] = useState(() => isDemoMode());

  // Composer extras — permission mode is global so chatApi can read it
  // 状态须在依赖它的 useEffect 之前声明，避免 TDZ 白屏
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const renameSession = useLayoutStore((s) => s.renameSession);
  const [attachments, setAttachments] = useState<{ name: string; text?: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showPermMenu, setShowPermMenu] = useState(false);
  const permMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (modelSelectorRef.current && !modelSelectorRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    if (showModelDropdown) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [showModelDropdown]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) {
        setShowPermMenu(false);
      }
    };
    if (showPermMenu) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [showPermMenu]);

  // Keyboard and Input states
  const [chatInput, setChatInput] = useState('');
  const [isComposing, setIsComposing] = useState(false); // IME Composition State
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [activePill, setActivePill] = useState<string | null>(null);

  // Goal mode states
  const [goalPaused, setGoalPaused] = useState(false);
  const [goalEditMode, setGoalEditMode] = useState(false);
  const [goalText, setGoalText] = useState('自动完成系统的交互式升级与界面美化工作，包括状态栏 Ribbon、浏览器和终端模拟器的对接及验证。');
  const [goalActive, setGoalActive] = useState(() => isDemoMode());

  const openSidePanel = (panelId: 'terminal' | 'diff' | 'preview' | 'tasks') => {
    handleGlobalTabClick(panelId);
  };

  const deriveSessionTitle = (text: string) => {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return '新会话';
    return cleaned.length > 28 ? `${cleaned.slice(0, 28)}…` : cleaned;
  };

  // Smart auto-scroll refs
  const chatFlowRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Thinking timer
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const thinkingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Slash commands list
  const SLASH_COMMANDS = [
    { cmd: '/simulate', desc: '启动庞大的1分钟自动化流水线模拟演示' },
    { cmd: '/goal', desc: '执行长期自动迭代任务' },
    { cmd: '/schedule', desc: '配置周期性定时或重复任务' },
    { cmd: '/browser', desc: '启动模拟浏览器交互' },
    { cmd: '/grill-me', desc: '进入详细设计对齐问答模式' },
    { cmd: '/teamwork-preview', desc: '启用多代理协作模式预览' },
    { cmd: '/learn', desc: '记录最佳实践和对齐规则' }
  ];

  const filteredCommands = SLASH_COMMANDS.filter(c =>
    c.cmd.toLowerCase().startsWith(chatInput.toLowerCase())
  );

  // Thinking timer: start when AI is processing, clear when done
  const isProcessing = messages.some(m => m.status === 'processing');
  useEffect(() => {
    if (isProcessing) {
      setThinkingSeconds(0);
      thinkingIntervalRef.current = setInterval(() => {
        setThinkingSeconds(prev => prev + 1);
      }, 1000);
    } else {
      if (thinkingIntervalRef.current) {
        clearInterval(thinkingIntervalRef.current);
        thinkingIntervalRef.current = null;
      }
    }
    return () => {
      if (thinkingIntervalRef.current) clearInterval(thinkingIntervalRef.current);
    };
  }, [isProcessing]);

  // Smart scroll: auto-scroll only when user hasn't manually scrolled up
  useEffect(() => {
    const el = chatFlowRef.current;
    if (!el || userScrolledRef.current) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollToBottom(false);
  }, [messages]);

  // Detect user scroll-up to stop auto-scroll
  useEffect(() => {
    const el = chatFlowRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      if (atBottom) {
        userScrolledRef.current = false;
        setShowScrollToBottom(false);
      } else {
        userScrolledRef.current = true;
        setShowScrollToBottom(true);
      }
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

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
      onComplete: () => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const st = useLayoutStore.getState();
        const asst = st.sessions
          .find((s) => s.id === sid)
          ?.messages.find((m) => m.id === assistantMsgId);
        if (asst && !gotRealText && !(asst.text || '').trim()) {
          // 不把思考提升为正文，避免与思考折叠重复
          if (!(asst.text || '').trim()) {
            st.updateMessageText(sid, assistantMsgId, '已结束。');
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

  const handleSendChat = (_isInsert: boolean = false) => {
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
    const input = rawInput + attachBlock;
    const displayText =
      attachments.length > 0
        ? `${rawInput}\n\n📎 ${attachments.map((a) => a.name).join('、')}`
        : rawInput;

    setChatInput('');
    setSlashMenuOpen(false);
    setAttachments([]);
    setPickerInlineError('');

    const userMsgId = `user-msg-${Date.now()}`;
    const sessMsgs =
      useLayoutStore.getState().sessions.find((s) => s.id === sessionId)?.messages || [];
    const isAiBusy = sessMsgs.some((m) => m.status === 'processing');

    // Auto-title empty / default sessions from first user turn
    const priorUserMsgs = sessMsgs.filter((m) => m.sender === 'user').length;
    if (priorUserMsgs === 0) {
      const sess = useLayoutStore.getState().sessions.find((s) => s.id === sessionId);
      if (sess && (!sess.title || sess.title === '新会话' || sess.title.startsWith('新会话'))) {
        renameSession(sessionId, deriveSessionTitle(rawInput));
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
        sess.messages.push(newMsg);
        sess.timestamp = '刚刚';
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

  /** 切换展开；须传入当前展示态，避免 defaultOpen=true 时首次点击仍为 true */
  const toggleTool = (toolId: string, currentlyOpen: boolean) => {
    setExpandedTools((prev) => ({ ...prev, [toolId]: !currentlyOpen }));
  };

  const openDiffInRightPanel = (diff: FileDiff) => {
    setActiveDiffSource(diff);
    handleGlobalTabClick('diff');
    useLayoutStore.setState((state) => {
      const targetWs = state.workspaces.find((w) => w.id === wsId);
      if (targetWs) {
        for (const col of targetWs.columns) {
          for (const gp of col.groups) {
            if (gp.cards.some((c) => c.id === 'diff')) {
              gp.activeCardId = 'diff';
              break;
            }
          }
        }
      }
    });
    onShowToast(`已在右侧打开完整改动：${diff.filePath}`);
  };

  const renderGitDiff = (diff: FileDiff) => {
    return (
      <div className="git-diff-card" key={diff.filePath}>
        <div className="git-diff-card-header" onClick={() => openDiffInRightPanel(diff)}>
          <div className="git-diff-file-info">
            <Lucide.FileCode size={14} style={{ color: 'var(--accent-color)' }} />
            <span className="git-diff-filename">{diff.filePath}</span>
            <span className="git-diff-preview-tag">在右侧查看</span>
          </div>
          <div className="git-diff-badge">
            <span className="git-diff-add">+{diff.additions}</span>
            <span className="git-diff-del">-{diff.deletions}</span>
          </div>
        </div>
        <div className="git-diff-lines-container">
          {diff.changes.slice(0, 8).map((change, i) => (
            <div key={i} className={`git-diff-line-row ${change.type}`}>
              <div className="line-num-col">
                {change.type === 'addition' ? '+' : change.type === 'deletion' ? '-' : ' '}
              </div>
              <pre className="line-content">{change.content}</pre>
            </div>
          ))}
          {diff.changes.length > 8 && (
            <div
              className="git-diff-more-indicator"
              onClick={() => openDiffInRightPanel(diff)}
            >
              还有 {diff.changes.length - 8} 行 · 点击在右侧查看完整 diff
            </div>
          )}
        </div>
      </div>
    );
  };




  const renderToolResultBody = (tc: {
    output?: string;
    diffs?: FileDiff[];
    name?: string;
    status?: string;
  }) => {
    const images = extractImageRefs(tc.output || '');
    const out = truncateToolOutput(tc.output || '');
    const hasDiffs = Boolean(tc.diffs && tc.diffs.length);
    if (!out && images.length === 0 && !hasDiffs) {
      // 空成功/失败也给可见终态，避免「展开了什么都没有」
      if (tc.status === 'success') {
        return (
          <div className="tool-result-body">
            <pre className="tool-result-pre">完成</pre>
          </div>
        );
      }
      if (tc.status === 'error') {
        return (
          <div className="tool-result-body">
            <pre className="tool-result-pre">失败</pre>
          </div>
        );
      }
      return null;
    }
    return (
      <div className="tool-result-body">
        {out ? <pre className="tool-result-pre">{out}</pre> : null}
        {images.length > 0 && (
          <div className="tool-result-images">
            {images.map((src) => (
              <img key={src} src={src} alt="" className="tool-result-img" loading="lazy" />
            ))}
          </div>
        )}
        {tc.diffs?.map(renderGitDiff)}
      </div>
    );
  };

  /** 短结果默认展开；长输出折叠 + 行内预览 */
  const shouldDefaultOpenTool = (tc: {
    status?: string;
    output?: string;
    diffs?: FileDiff[];
  }) => {
    if (tc.status === 'running') return false;
    if (tc.status === 'pending_approval') return false;
    if (tc.status === 'error') return true;
    if (tc.diffs && tc.diffs.length > 0) return true;
    const raw = (tc.output || '').trim();
    if (!raw || /^(执行中|运行中)…?$/.test(raw)) return false;
    const lines = raw.split('\n').filter((l) => l.trim());
    return lines.length <= 4 && raw.length <= 360;
  };

  const handleApprovalAllow = (toolId: string, msgId: string) => {
    // 乐观：立刻从 pending 摘掉，避免幽灵条卡住后续审批
    setApprovalBusy(true);
    const st = useLayoutStore.getState();
    st.updateMessageToolCall(activeSessionId, msgId, toolId, {
      status: 'running',
      output: '执行中…',
    });
    // 同步清掉同 id 的其它消息里残留 pending（防御）
    for (const m of st.sessions.find((s) => s.id === activeSessionId)?.messages || []) {
      const tc = m.toolCalls?.find((t) => t.id === toolId && t.status === 'pending_approval');
      if (tc && m.id !== msgId) {
        st.updateMessageToolCall(activeSessionId, m.id, toolId, {
          status: 'running',
          output: '执行中…',
        });
      }
    }
    void daemonApproveTool(toolId).finally(() => {
      window.setTimeout(() => setApprovalBusy(false), 200);
    });
  };

  const handleApprovalDeny = (toolId: string, msgId: string) => {
    setApprovalBusy(true);
    useLayoutStore.getState().updateMessageToolCall(activeSessionId, msgId, toolId, {
      status: 'error',
      output: '已拒绝',
    });
    void daemonDenyTool(toolId).finally(() => {
      window.setTimeout(() => setApprovalBusy(false), 200);
    });
  };

  /**
   * 工具行分层：
   * - 摘要（灰）：人读意图
   * - 命令（等宽更浅）：真实命令/路径
   * - 展开体：仅清洗后的结果输出
   * - 待确认：行内可批，不依赖底部 sticky
   */
  const renderCompactToolRow = (tc: any, key: string | number, msgId?: string) => {
    if (tc.status === 'pending_approval') {
      const summary = toolSummaryLabel(tc);
      const cmd = toolCommandPreview(tc);
      const mid = msgId || pendingApprovalMsgId;
      return (
        <div className="tool-row tool-row--pending" key={key}>
          <div className="tool-row-head tool-row-head--static">
            <span className="tool-row-summary">待确认 · {summary}</span>
            {cmd ? <code className="tool-row-cmd">{cmd}</code> : null}
          </div>
          <div className="tool-row-approve">
            <button
              type="button"
              className="tool-row-approve-btn deny"
              disabled={approvalBusy}
              onClick={() => handleApprovalDeny(tc.id, mid)}
            >
              拒绝
            </button>
            <button
              type="button"
              className="tool-row-approve-btn allow"
              disabled={approvalBusy}
              onClick={() => handleApprovalAllow(tc.id, mid)}
            >
              允许
            </button>
          </div>
        </div>
      );
    }
    const body = renderToolResultBody(tc);
    const preview = toolResultPreview(tc);
    const hasResult = toolHasDisplayableResult(tc);
    const defaultOpen = shouldDefaultOpenTool(tc);
    const isOpen = Object.prototype.hasOwnProperty.call(expandedTools, tc.id)
      ? expandedTools[tc.id]
      : defaultOpen;
    const summary = toolSummaryLabel(tc);
    const cmd = toolCommandPreview(tc);
    const running = tc.status === 'running';
    const canToggle = Boolean(body) || hasResult;
    return (
      <div className={`tool-row ${isOpen ? 'is-open' : ''} ${tc.status === 'error' ? 'is-error' : ''}`} key={key}>
        <button
          type="button"
          className="tool-row-head"
          onClick={() => canToggle && toggleTool(tc.id, isOpen)}
        >
          {running ? (
            <span className="tool-row-live" aria-hidden>
              <span className="loading-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
            </span>
          ) : null}
          <span className="tool-row-summary" title="摘要">
            {summary}
          </span>
          {cmd ? (
            <code className="tool-row-cmd" title="命令">
              {cmd}
            </code>
          ) : null}
          {!isOpen && preview ? (
            <span className="tool-row-result-preview" title={preview}>
              {preview}
            </span>
          ) : null}
          {canToggle ? (
            <Lucide.ChevronRight size={11} className={`tool-row-chevron ${isOpen ? 'rot' : ''}`} />
          ) : null}
        </button>
        {isOpen && body}
      </div>
    );
  };

  const renderToolItems = (items: ToolRenderItem[], msgId?: string) => (
    <div className="tool-stack">
      {items.map((item) => {
        if (item.kind === 'single') {
          return renderCompactToolRow(item.tc, item.tc.id, msgId);
        }
        const gid = item.id;
        const running = item.tools.some((t) => t.status === 'running');
        const anyError = item.tools.some((t) => t.status === 'error');
        const groupDefaultOpen = running || anyError;
        const isOpen = Object.prototype.hasOwnProperty.call(expandedTools, gid)
          ? expandedTools[gid]
          : groupDefaultOpen;
        const lastDone = [...item.tools]
          .reverse()
          .find((t) => toolHasDisplayableResult(t));
        const groupPreview = lastDone ? toolResultPreview(lastDone) : '';
        return (
          <div
            className={`tool-row tool-row-group ${isOpen ? 'is-open' : ''} ${anyError ? 'is-error' : ''}`}
            key={gid}
          >
            <button type="button" className="tool-row-head" onClick={() => toggleTool(gid, isOpen)}>
              {running ? (
                <span className="tool-row-live" aria-hidden>
                  <span className="loading-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
                </span>
              ) : null}
              <span className="tool-row-summary">{item.label}</span>
              {!isOpen && groupPreview ? (
                <span className="tool-row-result-preview" title={groupPreview}>
                  {groupPreview}
                </span>
              ) : null}
              <Lucide.ChevronRight size={11} className={`tool-row-chevron ${isOpen ? 'rot' : ''}`} />
            </button>
            {isOpen && (
              <div className="tool-group-body">
                {item.tools.map((tc) => renderCompactToolRow(tc, tc.id, msgId))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="chat-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      <div className="chat-doc-flow" ref={chatFlowRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 4px' }}>
        {messages.length === 0 ? (
          <div className="chat-empty-state">
            <h3 className="chat-empty-title">有什么可以帮你？</h3>
            <p className="chat-empty-sub">先选择项目，或在无项目模式下直接开始对话。</p>

            <div className="chat-empty-project-bar">
              <div className="chat-empty-project-anchor">
                <button
                  type="button"
                  className="chat-empty-project-btn"
                  onClick={() => setShowProjectPicker((v) => !v)}
                >
                  <Lucide.Folder size={14} />
                  <span>
                    {activeProject
                      ? activeProject.name
                      : getWorkspacePath()
                        ? '当前目录'
                        : '选择项目'}
                  </span>
                  <Lucide.ChevronDown size={13} style={{ opacity: 0.5 }} />
                </button>
                {showProjectPicker && (
                  <ProjectPickerMenu
                    open
                    onClose={() => setShowProjectPicker(false)}
                    onChanged={() => setProjectTick((n) => n + 1)}
                  />
                )}
              </div>
              {listProjects().length > 0 && !activeProject && (
                <button
                  type="button"
                  className="chat-empty-last-btn"
                  onClick={() => {
                    const last = listProjects()[0];
                    if (last) {
                      openProject(last.id);
                      setProjectTick((n) => n + 1);
                    }
                  }}
                >
                  打开最近：{listProjects()[0]?.name}
                </button>
              )}
            </div>

            <div className="chat-empty-prompts">
              {[
                { label: '分析项目结构', prompt: '分析当前工作区项目结构，梳理核心模块与依赖关系' },
                { label: '查看代码改动', prompt: '运行 git status 与 git diff，总结当前工作区修改' },
                { label: '检查开发服务', prompt: '检查本地开发服务器与相关工具是否正常运行' },
              ].map((item, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="quick-prompt-card"
                  onClick={() => {
                    setChatInput(item.prompt);
                    document.querySelector<HTMLTextAreaElement>('.input-container textarea')?.focus();
                  }}
                >
                  <span>{item.label}</span>
                  <Lucide.ArrowRight size={14} style={{ opacity: 0.4 }} />
                </button>
              ))}
            </div>
          </div>
        ) : (() => {
          const lastAssistantMsgId = [...messages].reverse().find(m => m.sender === 'assistant')?.id;
          const thinkingMsgId = messages.find(m => m.sender === 'assistant' && m.status === 'processing')?.id;
          return messages.map((msg, index) => {
            const prevMsg = index > 0 ? messages[index - 1] : null;
            const isFollowUp = msg.sender === 'assistant' && prevMsg?.sender === 'assistant';
            if (msg.sender === 'user') {
              const isLong = (msg.text || '').length > 260;
              const isExpanded = !!expandedUserMsgs[msg.id];
              const displayText =
                isLong && !isExpanded ? (msg.text || '').slice(0, 240) + '…' : msg.text;
              return (
                <div className="msg-row msg-row-user" key={msg.id}>
                  <div className="msg-user-stack">
                    <div
                      className={`msg-user-bubble ${isExpanded ? 'expanded' : ''}`}
                      onClick={() => {
                        if (isLong) {
                          setExpandedUserMsgs((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }));
                        }
                      }}
                      style={{ cursor: isLong ? 'pointer' : 'default' }}
                    >
                      <span className="msg-user-text">{displayText}</span>
                      {msg.status === 'queued' && (
                        <span className="msg-status-badge queued">排队中</span>
                      )}
                    </div>
                    <div className="msg-user-meta">
                      <span className="msg-time">{formatTime(msg.timestamp)}</span>
                      <button
                        type="button"
                        className="msg-icon-btn"
                        title="复制"
                        onClick={() => {
                          navigator.clipboard.writeText(msg.text || '');
                        }}
                      >
                        <Lucide.Copy size={13} />
                      </button>
                      <button
                        type="button"
                        className="msg-icon-btn"
                        title="撤回"
                        onClick={() => {
                          setChatInput(msg.text || '');
                          withdrawMessage(wsId, activeSessionId, msg.id);
                        }}
                      >
                        <Lucide.Undo2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            } else {
              const isLastAssistantMsg = msg.id === lastAssistantMsgId;
              const isThinkingMsg = msg.id === thinkingMsgId;
              return (
                <div
                  className={`msg-row msg-row-assistant ${isFollowUp ? 'is-followup' : ''}`}
                  key={msg.id}
                >
                  {/* 思考：浅色限高可滚；完成后可由用户展开，不强制 open 锁死 */}
                  {(isThinkingMsg ||
                    (msg.thinking &&
                      msg.thinking.trim() &&
                      msg.thinking !== '正在处理…' &&
                      msg.thinking !== '正在思考中...')) && (
                    <details
                      className={`msg-thinking-fold ${isThinkingMsg ? 'is-live' : ''}`}
                      key={`think-${msg.id}-${isThinkingMsg ? 'live' : 'done'}`}
                      defaultOpen={Boolean(isThinkingMsg)}
                    >
                      <summary className="msg-thinking-fold-sum">
                        {isThinkingMsg ? (
                          <span className="loading-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
                        ) : null}
                        <span className="msg-thinking-fold-label">
                          {isThinkingMsg ? '思考中' : '思考'}
                          {isThinkingMsg ? (
                            <span className="msg-thinking-sec"> · {thinkingSeconds}s</span>
                          ) : null}
                        </span>
                      </summary>
                      <div className="msg-thinking-fold-body">
                        {(msg.thinking &&
                        msg.thinking !== '正在处理…' &&
                        msg.thinking !== '正在思考中...'
                          ? msg.thinking
                          : '…'
                        ).slice(0, 4000)}
                      </div>
                    </details>
                  )}

                  <div className="msg-assistant-body">
                    {(() => {
                      try {
                        const timeline = buildAssistantTimeline(msg);
                        if (!timeline.length) {
                          const fallback = stripThoughtPlaceholders(msg.text || '');
                          if (!fallback.trim()) return null;
                          return (
                            <div className="msg-timeline-text">
                              <div
                                className="msg-assistant-text md-rendered"
                                dangerouslySetInnerHTML={{
                                  __html: parseMarkdownToHtml(fallback),
                                }}
                              />
                            </div>
                          );
                        }
                        return timeline.map((item) => {
                          if (item.kind === 'text') {
                            const bodyText = stripThoughtPlaceholders(item.content || '');
                            if (!bodyText.trim()) return null;
                            const imgs = extractImageRefs(bodyText);
                            return (
                              <div key={item.key} className="msg-timeline-text">
                                <div
                                  className="msg-assistant-text md-rendered"
                                  dangerouslySetInnerHTML={{
                                    __html: parseMarkdownToHtml(bodyText),
                                  }}
                                />
                                {imgs.length > 0 && (
                                  <div className="msg-inline-images">
                                    {imgs.map((src) => (
                                      <img key={src} src={src} alt="" className="md-img" loading="lazy" />
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          }
                          if (!item.items?.length) return null;
                          return (
                            <div key={item.key} className="msg-timeline-tools">
                              {renderToolItems(item.items, msg.id)}
                            </div>
                          );
                        });
                      } catch (err) {
                        console.error('[ChatCard] timeline render', err);
                        const fallback = stripThoughtPlaceholders(msg.text || '');
                        return fallback ? (
                          <div className="msg-assistant-text md-rendered">
                            {fallback}
                          </div>
                        ) : null;
                      }
                    })()}
                  </div>

                  {/* 完成态助手消息都显示操作栏（不限最新一条） */}
                  {!isThinkingMsg && msg.status !== 'processing' && (
                    <div className="msg-assistant-meta">
                      <button
                        type="button"
                        className="msg-icon-btn"
                        title="复制正文"
                        onClick={() => {
                          const text = assistantCopyText(msg);
                          if (!text.trim()) {
                            onShowToast('没有可复制的正文');
                            return;
                          }
                          navigator.clipboard.writeText(text);
                          onShowToast('已复制');
                        }}
                      >
                        <Lucide.Copy size={14} />
                      </button>
                      <button
                        type="button"
                        className="msg-icon-btn"
                        title="重新生成"
                        onClick={() => {
                          const idx = messages.findIndex((m) => m.id === msg.id);
                          let userText = '';
                          for (let i = idx - 1; i >= 0; i--) {
                            if (messages[i].sender === 'user') {
                              userText = messages[i].text || '';
                              break;
                            }
                          }
                          if (!userText.trim()) {
                            onShowToast('没有可重新生成的内容');
                            return;
                          }
                          if (messages.some((m) => m.status === 'processing')) {
                            onShowToast('请等待当前回复完成');
                            return;
                          }
                          const userMsgId = `user-msg-${Date.now()}`;
                          useLayoutStore.getState().addMessage(wsId, activeSessionId, {
                            id: userMsgId,
                            sender: 'user',
                            text: userText,
                            timestamp: Date.now(),
                            status: 'processing',
                          });
                          runStreamingAssistant(userText, userMsgId);
                          onShowToast('正在重新生成…');
                        }}
                      >
                        <Lucide.RefreshCw size={14} />
                      </button>
                      <button
                        type="button"
                        className="msg-icon-btn"
                        title="分支继续"
                        onClick={() => {
                          const newTitle = `${activeSession?.title || '会话'} - 分支`;
                          useLayoutStore.getState().branchSession(activeSessionId, newTitle);
                          onShowToast(`已创建分支：${newTitle}`);
                        }}
                      >
                        <Lucide.GitFork size={14} />
                      </button>
                    </div>
                  )}
                </div>
              );
            }
          });
        })()}
      </div>

      <div className="chat-footer">
        {engineHint && engineHint.ok === false && (
          <div className="chat-soft-hint">
            <span>服务尚未就绪，请稍候或检查网络</span>
            <button type="button" onClick={() => useLayoutStore.getState().openSettings('models')}>
              模型设置
            </button>
          </div>
        )}
        {engineHint?.ok !== false && needsKeySetup && (
          <div className="chat-soft-hint">
            <span>首次使用请先配置服务商密钥与模型</span>
            <button type="button" onClick={() => useLayoutStore.getState().openSettings('models')}>
              去配置
            </button>
          </div>
        )}
        {engineHint?.ok && engineHint.hasApiKey === false && anyProfileHasKey() && (
          <div className="chat-soft-hint">
            <span>本地已有密钥，点击下方模型名称同步到引擎</span>
            <button
              type="button"
              onClick={() => {
                setShowModelDropdown(true);
              }}
            >
              选择模型
            </button>
          </div>
        )}
        {/* 回到最新：浮在对话区右下角，仅图标 */}
        {showScrollToBottom && (
          <button
            type="button"
            className="chat-scroll-fab"
            title="回到最新"
            onClick={() => {
              userScrolledRef.current = false;
              setShowScrollToBottom(false);
              if (chatFlowRef.current) {
                chatFlowRef.current.scrollTop = chatFlowRef.current.scrollHeight;
              }
            }}
          >
            <Lucide.ChevronDown size={16} strokeWidth={2} />
          </button>
        )}

        {/* Demo-only context chips */}
        {isDemoMode() && (
          <div className="chat-context-ribbon">
            {prVisible && (
              <button
                type="button"
                className="context-pill git"
                title="在右侧查看代码变更"
                onClick={() => {
                  handleGlobalTabClick('diff');
                  setActivePill(null);
                }}
              >
                <Lucide.GitBranch size={12} />
                <span>变更</span>
              </button>
            )}
            <button
              type="button"
              className="context-pill"
              title="终端"
              onClick={() => handleGlobalTabClick('terminal')}
            >
              <Lucide.Terminal size={12} />
              <span>终端</span>
            </button>
          </div>
        )}

        {activePill === 'goal' && goalActive && (
          <div className="context-details-drawer">
            <div
              className="drawer-expand-content goal-drawer-content"
              style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>当前目标</span>
                  <span className="ui-badge">{goalPaused ? '已暂停' : '进行中 · 45%'}</span>
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    onClick={() => {
                      const next = !goalPaused;
                      setGoalPaused(next);
                      onShowToast(next ? '目标已暂停' : '目标已继续');
                    }}
                  >
                    {goalPaused ? <Lucide.Play size={12} /> : <Lucide.Pause size={12} />}
                    {goalPaused ? '继续' : '暂停'}
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost"
                    title="停止"
                    onClick={() => {
                      setGoalActive(false);
                      setActivePill(null);
                      onShowToast('目标已停止');
                    }}
                  >
                    <Lucide.Square size={12} />
                  </button>
                  <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setActivePill(null)}>
                    <Lucide.X size={14} />
                  </button>
                </div>
              </div>

              {goalEditMode ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <textarea
                    className="ui-input"
                    value={goalText}
                    onChange={(e) => setGoalText((e.target as HTMLTextAreaElement).value)}
                    rows={2}
                    style={{ resize: 'none', minHeight: 56, background: 'var(--bg-secondary)' }}
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary ui-btn-sm"
                      onClick={() => setGoalEditMode(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-primary ui-btn-sm"
                      onClick={() => {
                        setGoalEditMode(false);
                        onShowToast('目标已更新');
                      }}
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => setGoalEditMode(true)}
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'text' }}
                >
                  <span style={{ color: 'var(--text-secondary)', lineHeight: 1.5, flex: 1, fontSize: 12.5 }}>
                    {goalText}
                  </span>
                  <Lucide.Pencil size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: 3 }} />
                </div>
              )}

              <div style={{ height: 3, background: 'var(--bg-tertiary)', borderRadius: 99, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: '45%',
                    background: 'var(--text-secondary)',
                    borderRadius: 99,
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)' }}>
                <span>已运行 4h22m</span>
                <span>预计剩余约 1 天</span>
              </div>
            </div>
          </div>
        )}

        {/* 待确认 sticky：不抢焦点、无蒙层；与时间线内联条同步同一 tool id */}
        {pendingApprovalTc && (
          <ApprovalSheet
            variant="sticky"
            tool={{
              id: pendingApprovalTc.id,
              name: pendingApprovalTc.name,
              arguments: pendingApprovalTc.arguments,
              explanation: pendingApprovalTc.explanation,
            }}
            busy={approvalBusy}
            queueRemaining={pendingQueueRemaining}
            onAllow={() => handleApprovalAllow(pendingApprovalTc.id, pendingApprovalMsgId)}
            onDeny={() => handleApprovalDeny(pendingApprovalTc.id, pendingApprovalMsgId)}
          />
        )}

        <div className="input-container" style={{ position: 'relative' }}>
          {slashMenuOpen && filteredCommands.length > 0 && (
            <div
              className="slash-commands-popover"
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 8px)',
                left: 0,
                width: 260,
                background: 'var(--bg-primary)',
                borderRadius: 12,
                boxShadow: 'var(--shadow-lg)',
                padding: 6,
                zIndex: 15,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {filteredCommands.map((c, i) => (
                <div
                  key={c.cmd}
                  className={`slash-command-item ${i === slashSelectedIndex ? 'active' : ''}`}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '8px 10px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: i === slashSelectedIndex ? 'var(--accent-light)' : 'transparent',
                    color: i === slashSelectedIndex ? 'var(--accent-color)' : 'var(--text-secondary)',
                  }}
                  onClick={() => {
                    setChatInput(c.cmd + ' ');
                    setSlashMenuOpen(false);
                  }}
                  onMouseEnter={() => setSlashSelectedIndex(i)}
                >
                  <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)' }}>{c.cmd}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.desc}</span>
                </div>
              ))}
            </div>
          )}

          <textarea
            placeholder="输入消息，或键入 / 打开命令…"
            rows={1}
            value={chatInput}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onChange={(e) => {
              const val = (e.target as HTMLTextAreaElement).value;
              setChatInput(val);
              if (val.startsWith('/') && !val.includes(' ')) {
                setSlashMenuOpen(true);
              } else {
                setSlashMenuOpen(false);
              }
            }}
            onKeyDown={(e) => {
              if (isComposing) return;
              if (slashMenuOpen && filteredCommands.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSlashSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashSelectedIndex(
                    (prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length,
                  );
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const selectedCmd = filteredCommands[slashSelectedIndex].cmd;
                  setChatInput(selectedCmd + ' ');
                  setSlashMenuOpen(false);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setSlashMenuOpen(false);
                }
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendChat(false);
              }
            }}
            style={{ flex: 1 }}
          />

          <div className="chat-input-buttons">
            {messages.some((m) => m.status === 'processing') ? (
              <>
                <button
                  type="button"
                  className="send-btn queue-btn"
                  title="加入队列，当前回复结束后发送"
                  onClick={() => handleSendChat(false)}
                  disabled={!chatInput.trim()}
                >
                  排队
                </button>
                <button
                  type="button"
                  className="send-btn"
                  title="停止生成"
                  onClick={handleStopGeneration}
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                >
                  <Lucide.Square size={13} fill="currentColor" />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="send-btn"
                title="发送 (Enter)"
                onClick={() => handleSendChat(false)}
                disabled={!chatInput.trim()}
              >
                <Lucide.CornerDownLeft size={15} />
              </button>
            )}
          </div>
        </div>

        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 4px' }}>
            {attachments.map((a) => (
              <span key={a.name} className="ui-badge" style={{ padding: '4px 8px', fontSize: 11.5 }}>
                <Lucide.Paperclip size={11} style={{ marginRight: 4 }} />
                {a.name}
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost"
                  style={{ width: 18, height: 18, marginLeft: 2 }}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.name !== a.name))}
                >
                  <Lucide.X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={async (e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            if (!files.length) return;
            const next: { name: string; text?: string }[] = [];
            for (const f of files) {
              // Text-ish files: include content for the model; binaries: name only
              const isText =
                f.type.startsWith('text/') ||
                /\.(txt|md|json|ts|tsx|js|jsx|css|html|py|rs|go|java|c|cpp|h|yml|yaml|toml|xml|csv|log|sh|ps1)$/i.test(
                  f.name,
                );
              if (isText && f.size < 512_000) {
                try {
                  const text = await f.text();
                  next.push({ name: f.name, text });
                } catch {
                  next.push({ name: f.name });
                }
              } else {
                next.push({ name: f.name });
              }
            }
            setAttachments((prev) => {
              const names = new Set(prev.map((p) => p.name));
              return [...prev, ...next.filter((n) => !names.has(n.name))];
            });
          }}
        />

        {/* Toolbar outside the input field */}
        <div className="footer-actions">
          <div className="left-actions">
            <div ref={permMenuRef} className="perm-mode-wrap">
              <button
                type="button"
                className="bypass-link"
                title={permissionModeMeta(permissionMode).description}
                onClick={() => setShowPermMenu((v) => !v)}
                style={{ border: 'none', background: 'transparent', fontFamily: 'inherit' }}
              >
                <span
                  className="orange-dot"
                  style={{ background: permissionModeMeta(permissionMode).accent }}
                />
                <span
                  className="bypass-text"
                  style={{ color: permissionModeMeta(permissionMode).accent }}
                >
                  {permissionModeMeta(permissionMode).shortLabel}
                </span>
                <Lucide.ChevronDown size={11} style={{ opacity: 0.5 }} />
              </button>
              {showPermMenu && (
                <div className="perm-mode-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="perm-mode-popover-title">权限模式</div>
                  {PERMISSION_MODES.map((m) => {
                    const active = permissionMode === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className={`perm-mode-item${active ? ' active' : ''}`}
                        onClick={() => {
                          setPermissionMode(m.id as PermissionMode);
                          setShowPermMenu(false);
                        }}
                      >
                        <span className="perm-mode-item-row">
                          <span className="orange-dot" style={{ background: m.accent }} />
                          <span className="perm-mode-item-label">{m.label}</span>
                          {active && <Lucide.Check size={14} style={{ marginLeft: 'auto', opacity: 0.7 }} />}
                        </span>
                        <span className="perm-mode-item-desc">{m.description}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              type="button"
              className="plus-btn"
              title="添加文件"
              onClick={() => fileInputRef.current?.click()}
            >
              <Lucide.Plus size={14} />
            </button>
          </div>
          <div className="right-actions">
            {showModelPicker && (
            <div
              ref={modelSelectorRef}
              className="model-badge"
              title={
                getActiveProfile()
                  ? `${getActiveProfile()!.name} · ${engineModel || '未选模型'}`
                  : '选择服务商与模型'
              }
              onClick={() => setShowModelDropdown((prev) => !prev)}
            >
              <span className="model-text">
                {getModelDisplayName(
                  engineModel || getActiveModelId() || appSettings?.defaultModel || '选择模型',
                )}
              </span>
              <Lucide.ChevronDown size={12} style={{ opacity: 0.55 }} />

              {showModelDropdown && (
                <div className="model-picker-popover" onClick={(e) => e.stopPropagation()}>
                  {pickerInlineError && (
                    <div className="model-picker-error">{pickerInlineError}</div>
                  )}
                  {loadProfiles()
                    .filter((p) => p.hasKey || p.apiKey || engineHint?.hasApiKey)
                    .map((p) => (
                    <div key={p.id} className="model-picker-group">
                      <div className="model-picker-group-label">
                        {p.name}
                        {' · 已就绪'}
                      </div>
                      {(p.models || []).length === 0 && (
                        <div className="model-picker-empty" style={{ padding: '4px 10px' }}>
                          无模型，请到设置添加
                        </div>
                      )}
                      {(p.models || []).map((m) => {
                        const isSelected =
                          engineModel === m &&
                          (activeProfileId === p.id || (!activeProfileId && engineModel === m));
                        return (
                          <button
                            type="button"
                            key={`${p.id}-${m}`}
                            disabled={pickerBusy}
                            className={`model-dropdown-item ${isSelected ? 'is-selected' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void selectProfileModel(p.id, m);
                            }}
                          >
                            <span>{m}</span>
                            {isSelected && <Lucide.Check size={11} />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  {modelChoices.length === 0 && (
                    <div className="model-picker-empty">请在设置中添加服务商与模型</div>
                  )}
                  <div className="model-picker-footer">
                    <button
                      type="button"
                      className="model-picker-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowModelDropdown(false);
                        useLayoutStore.getState().openSettings('models');
                      }}
                    >
                      <Lucide.Settings size={13} />
                      <span>模型设置</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
