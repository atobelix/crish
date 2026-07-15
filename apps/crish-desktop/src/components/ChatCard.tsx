import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionMessage, FileDiff } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
import { streamAssistantResponseApi } from '../api/chatApi';
import { daemonApproveTool, daemonDenyTool } from '../api/daemonChatBridge';
import { isDemoMode } from '../api/appMode';
import { fetchEngineStatus, type EngineStatus } from '../api/engineConfig';
import {
  activateProfileModel,
  anyProfileHasKey,
  flattenModelChoices,
  getActiveModelId,
  getActiveProfile,
  getActiveProfileId,
} from '../api/providerProfiles';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import { ModelPicker } from './ModelPicker';
import { ChatMessageList } from './ChatMessageList';
import { networkUserMessage } from '../api/userFacingErrors';
import {
  isEditToolName,
  isShellToolName,
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../api/toolFeedback';
import { stripThoughtPlaceholders } from '../api/markdownRender';
import {
  normalizeAssistantTimeline,
  toolSummaryLabel,
} from '../api/toolPresentation';
import {
  formatSkillInjection,
  getSkillSlashCommandsCached,
  resolveSkillSlash,
  type SkillSlashCommand,
} from '../api/skillsApi';
import { clientApi } from '../api/clientApi';
import {
  deriveSessionTitle,
  isDefaultSessionTitle,
} from '../api/sessionTitle';
import {
  formatAnnotationsForModel,
  openFileInPanel,
  takePendingFileAnnotations,
} from '../api/workspaceFsApi';
import {
  applyUsageDelta,
  fetchRunSnapshotUsage,
} from '../api/sessionEventHydrate';
import { estimateCostUsd } from '../api/pricingStore';
import { applySubagentEventToMessages } from '../api/subagentTimeline';
import { AgentCard } from './AgentCard';
import {
  buildCollaboratorPrompt,
  COLLABORATOR_MODES,
  streamCollaboratorRun,
  type CollaboratorMode,
} from '../api/subagentApi';

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
    activeAgentId,
    setActiveAgentId,
    upsertSessionAgent,
    // patchSessionAgent reserved for future agent edits
    withdrawMessage,
    setActiveDiffSource,
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
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [collabMode, setCollabMode] = useState<CollaboratorMode>('research');
  const [collabDesc, setCollabDesc] = useState('');
  const [collabTask, setCollabTask] = useState('');
  const [collabBusy, setCollabBusy] = useState(false);

  const modelChoices = flattenModelChoices();

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

  // 进行中消息的待确认（时间线内 approval-card + 底部提示条）
  let pendingApprovalMsgId = '';
  let pendingApprovalCount = 0;
  let pendingApprovalSummary = '';
  for (const m of messages) {
    if (!m.toolCalls) continue;
    if (m.status === 'completed' || m.status === 'queued') continue;
    for (const tc of m.toolCalls) {
      if (tc.status !== 'pending_approval') continue;
      pendingApprovalCount += 1;
      if (!pendingApprovalMsgId) {
        pendingApprovalMsgId = m.id;
        pendingApprovalSummary = toolSummaryLabel(tc);
      }
    }
  }

  /** 运行级错误横幅（不进 AI 正文） */
  const [runNotice, setRunNotice] = useState<{ text: string; kind?: string } | null>(null);
  // Demo-only decorative pills; product mode stays quiet until real signals exist
  const [prVisible] = useState(() => isDemoMode());

  // Composer extras — permission mode is global so chatApi can read it
  // 状态须在依赖它的 useEffect 之前声明，避免 TDZ 白屏
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const renameSession = useLayoutStore((s) => s.renameSession);
  const [attachments, setAttachments] = useState<{ name: string; text?: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const openSidePanel = (panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files') => {
    handleGlobalTabClick(panelId);
  };



  // Smart auto-scroll refs
  const chatFlowRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Thinking timer
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const thinkingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Slash commands：固定 + 技能（enableSkillCommands）
  // 正式模式仅保留已实现或有明确动作的命令；演示命令仅 demo
  const BASE_SLASH = useMemo(
    () => [
      ...(isDemoMode()
        ? [
            { cmd: '/simulate', desc: '启动庞大的1分钟自动化流水线模拟演示' },
            { cmd: '/grill-me', desc: '进入详细设计对齐问答模式' },
            { cmd: '/teamwork-preview', desc: '启用多代理协作模式预览' },
            { cmd: '/goal', desc: '执行长期自动迭代任务（演示）' },
            { cmd: '/learn', desc: '记录最佳实践和对齐规则（演示）' },
          ]
        : []),
      { cmd: '/schedule', desc: '打开设置中的定时任务' },
      { cmd: '/browser', desc: '打开右侧内置预览浏览器' },
    ],
    [],
  );
  const [skillSlash, setSkillSlash] = useState<SkillSlashCommand[]>([]);
  const [skillCommandsEnabled, setSkillCommandsEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await clientApi.getSettings();
        if (cancelled) return;
        const on = settings?.enableSkillCommands !== false;
        setSkillCommandsEnabled(on);
        if (!on) {
          setSkillSlash([]);
          return;
        }
        const { commands } = await getSkillSlashCommandsCached();
        if (!cancelled) setSkillSlash(commands);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // AI 正文里的路径按钮 → 侧栏文件
  useEffect(() => {
    const root = chatFlowRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const btn = t?.closest?.('.md-path-link') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const path = btn.getAttribute('data-path') || btn.textContent || '';
      if (!path.trim()) return;
      openPathInFilesPanel(path.trim());
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [messages.length, activeSessionId]);

  const loadSkillSlash = useCallback(async () => {
    if (!skillCommandsEnabled) return;
    try {
      const { commands } = await getSkillSlashCommandsCached();
      setSkillSlash(commands);
    } catch {
      /* ignore */
    }
  }, [skillCommandsEnabled]);

  const allSlashCommands = useMemo(() => {
    const skillPart = skillCommandsEnabled
      ? skillSlash.map((s) => ({ cmd: s.cmd, desc: s.desc }))
      : [];
    return [...BASE_SLASH, ...skillPart];
  }, [BASE_SLASH, skillSlash, skillCommandsEnabled]);

  const filteredCommands = allSlashCommands.filter((c) =>
    c.cmd.toLowerCase().startsWith(chatInput.toLowerCase()),
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

  /** 在右侧文件管理器中打开路径（按需预览，不刷屏；相对路径由 openFileInPanel 接到工作区根） */
  const openPathInFilesPanel = (filePath: string) => {
    openSidePanel('files');
    openFileInPanel(filePath);
    onShowToast(`已打开文件：${filePath.replace(/^.*[\\/]/, '')}`);
  };

  const handleApprovalAllow = (toolId: string, msgId: string, remember = false) => {
    // 乐观：立刻从 pending 摘掉，避免幽灵条卡住后续审批
    setApprovalBusy(true);
    const st = useLayoutStore.getState();
    if (remember) {
      const tc = st.sessions
        .find((s) => s.id === activeSessionId)
        ?.messages.find((m) => m.id === msgId)
        ?.toolCalls?.find((t) => t.id === toolId);
      const raw = (tc?.arguments || tc?.name || '').trim();
      // 取命令首个 token 段作为可记忆前缀（至多前 3 段）
      const line = raw.replace(/\r?\n/g, ' ').trim();
      const parts = line.split(/\s+/).filter(Boolean);
      const prefix = parts.slice(0, Math.min(3, parts.length)).join(' ');
      if (prefix && !prefix.startsWith('{')) {
        st.addCommandPermission(prefix);
        onShowToast(`已加入白名单：${prefix}`);
      }
    }
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

  const activeAgent =
    activeAgentId &&
    sessions
      .find((s) => s.id === activeSessionId)
      ?.agents?.find((a) => a.id === activeAgentId);

  const handleSpawnCollaborator = () => {
    const sid = activeSessionId || useLayoutStore.getState().createSession({ title: '新会话' });
    if (!sid) return;
    const task = collabTask.trim();
    if (!task) {
      onShowToast('请填写协作任务');
      return;
    }
    const desc = collabDesc.trim() || COLLABORATOR_MODES.find((m) => m.id === collabMode)?.label || '协作者';
    const agentId = `collab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setCollabBusy(true);
    upsertSessionAgent(sid, {
      id: agentId,
      subagentRunId: '',
      parentSessionId: sid,
      parentRunId: '',
      description: desc,
      mode: collabMode,
      status: 'running',
      messages: [
        {
          id: `agent-user-${Date.now()}`,
          sender: 'user',
          text: task,
          timestamp: Date.now(),
          status: 'completed',
        },
      ],
      startedAt: Date.now(),
    });
    setShowPlusMenu(false);
    setCollabTask('');
    setActiveAgentId(agentId);

    const prompt = buildCollaboratorPrompt({
      mode: collabMode,
      description: desc,
      task,
      parentSessionTitle: sessions.find((s) => s.id === sid)?.title,
    });
    const asstId = `agent-asst-${Date.now().toString(36)}`;
    useLayoutStore.getState().appendSessionAgentMessage(sid, agentId, {
      id: asstId,
      sender: 'assistant',
      text: '',
      thinking: '正在处理…',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: [],
      blocks: [],
    });

    const patchAsst = (fn: (m: import('../store/layoutStore').SessionMessage) => void) => {
      useLayoutStore.setState((state) => {
        const ag = state.sessions.find((s) => s.id === sid)?.agents?.find((a) => a.id === agentId);
        const m = ag?.messages?.find((x) => x.id === asstId);
        if (m) fn(m);
      });
    };

    const cancel = streamCollaboratorRun(prompt, agentId, {
      onRunMeta: ({ runId }) => {
        useLayoutStore.getState().patchSessionAgent(sid, agentId, {
          subagentRunId: runId,
          parentRunId: runId,
          status: 'running',
        });
      },
      onRunError: (message) => {
        setRunNotice({ text: message, kind: 'collab' });
        onShowToast(message);
      },
      onThought: (t) => patchAsst((m) => { m.thinking = t; }),
      onChunk: (c) => patchAsst((m) => { m.text = c; if (m.thinking === '正在处理…') m.thinking = ''; }),
      onToolStart: (toolId, name, args, explanation) => {
        patchAsst((m) => {
          if (!m.toolCalls) m.toolCalls = [];
          if (!m.blocks) m.blocks = [];
          if (!m.toolCalls.some((t) => t.id === toolId)) {
            m.toolCalls.push({ id: toolId, name, arguments: args, explanation, status: 'running' });
            m.blocks.push({ type: 'tool_call', id: toolId });
          }
        });
      },
      onToolSuccess: (toolId, output) => {
        patchAsst((m) => {
          const tc = m.toolCalls?.find((t) => t.id === toolId);
          if (tc) { tc.status = 'success'; tc.output = output || '完成'; }
        });
      },
      onToolError: (toolId, error) => {
        patchAsst((m) => {
          const tc = m.toolCalls?.find((t) => t.id === toolId);
          if (tc) { tc.status = 'error'; tc.output = error || '失败'; }
        });
      },
      onComplete: () => {
        patchAsst((m) => {
          m.status = 'completed';
          if (m.thinking === '正在处理…') m.thinking = '';
        });
        useLayoutStore.getState().patchSessionAgent(sid, agentId, {
          status: 'completed',
          endedAt: Date.now(),
        });
        setCollabBusy(false);
      },
    });
    void cancel;
    onShowToast(`已拉起协作者：${desc}`);
  };

  return (
    <div className="chat-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {activeAgent ? (
        <div className="agent-inline-shell" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="agent-inline-bar">
            <button
              type="button"
              className="agent-inline-back"
              onClick={() => setActiveAgentId(null)}
            >
              <Lucide.ArrowLeft size={16} />
              返回主对话
            </button>
            <span className="agent-inline-hint">{activeAgent.description || '协作 agent'}</span>
          </div>
          {/* 已在主区全屏：不再显示「右侧/新窗口」（那些在时间线内联块上） */}
          <AgentCard
            agentId={activeAgent.id}
            embedded
            onClose={() => setActiveAgentId(null)}
          />
        </div>
      ) : null}
      <div
        className="chat-doc-flow"
        ref={chatFlowRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px 4px',
          display: activeAgent ? 'none' : undefined,
        }}
      >
        <ChatMessageList
          messages={messages}
          agents={activeSession?.agents || []}
          activeSessionId={activeSessionId || ''}
          thinkingSeconds={thinkingSeconds}
          showProjectPicker={showProjectPicker}
          onShowProjectPicker={setShowProjectPicker}
          onProjectChanged={() => setProjectTick((n) => n + 1)}
          onSetChatInput={setChatInput}
          onWithdraw={(msgId, text) => {
            setChatInput(text);
            withdrawMessage(wsId, activeSessionId, msgId);
          }}
          onRegenerate={(userText) => {
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
          onBranch={() => {
            const newTitle = `${activeSession?.title || '会话'} - 分支`;
            useLayoutStore.getState().branchSession(activeSessionId, newTitle);
            onShowToast(`已创建分支：${newTitle}`);
          }}
          onShowToast={onShowToast}
          approvalBusy={approvalBusy}
          pendingApprovalMsgId={pendingApprovalMsgId}
          onOpenDiff={openDiffInRightPanel}
          onOpenPath={openPathInFilesPanel}
          onOpenTerminal={() => openSidePanel('terminal')}
          onApprovalAllow={handleApprovalAllow}
          onApprovalDeny={handleApprovalDeny}
        />
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
        {permissionMode === 'plan' && (
          <div className="plan-mode-ribbon">
            <div className="plan-mode-ribbon-text">
              <strong>计划模式</strong>
              ：只读分析，不改项目文件。进度与步骤见右侧总览。
            </div>
            <div className="plan-mode-ribbon-actions">
              <button
                type="button"
                className="ui-btn ui-btn-ghost ui-btn-sm"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('crish-open-overview'));
                }}
              >
                总览
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                onClick={() => setPermissionMode('ask')}
              >
                退出
              </button>
            </div>
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
                <Lucide.GitBranch size={14} />
                <span>变更</span>
              </button>
            )}
            <button
              type="button"
              className="context-pill"
              title="终端"
              onClick={() => handleGlobalTabClick('terminal')}
            >
              <Lucide.Terminal size={14} />
              <span>终端</span>
            </button>
          </div>
        )}

        {/* Goal 抽屉：正式模式无引擎目标能力，隐藏假进度/暂停 UI；仅演示模式保留 playground */}
        {isDemoMode() && activePill === 'goal' && goalActive && (
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
                    {goalPaused ? <Lucide.Play size={14} /> : <Lucide.Pause size={14} />}
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
                    <Lucide.Square size={14} />
                  </button>
                  <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setActivePill(null)}>
                    <Lucide.X size={16} />
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
                  <Lucide.Pencil size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: 3 }} />
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

        {/* 系统提示：错误/空回复 — 明确非 AI 输出 */}
        {!activeAgent && runNotice ? (
          <div className="run-notice" role="status">
            <div className="run-notice-main">
              <span className="run-notice-kicker">系统提示</span>
              <span className="run-notice-text">{runNotice.text}</span>
            </div>
            <button
              type="button"
              className="run-notice-dismiss"
              aria-label="关闭提示"
              onClick={() => setRunNotice(null)}
            >
              <Lucide.X size={14} />
            </button>
          </div>
        ) : null}

        {/* 审批提示条：不是快捷功能；一点滚到时间线卡片 */}
        {!activeAgent && pendingApprovalCount > 0 && pendingApprovalMsgId ? (
          <button
            type="button"
            className="approval-dock"
            onClick={() => {
              const el = document.querySelector(
                `.approval-card[data-msg="${pendingApprovalMsgId}"], .approval-card`,
              );
              el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          >
            <span className="approval-dock-dot" aria-hidden />
            <span className="approval-dock-label">
              需要权限
              {pendingApprovalCount > 1 ? ` · ${pendingApprovalCount} 项` : ''}
            </span>
            <span className="approval-dock-summary" title={pendingApprovalSummary}>
              {pendingApprovalSummary || '有操作等待你确认'}
            </span>
            <span className="approval-dock-go">查看</span>
          </button>
        ) : null}

        <div
          className="input-container"
          style={{ position: 'relative', display: activeAgent ? 'none' : undefined }}
        >
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
                void loadSkillSlash();
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
                  <Lucide.Square size={16} fill="currentColor" />
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
                <Lucide.CornerDownLeft size={16} />
              </button>
            )}
          </div>
        </div>

        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 4px' }}>
            {attachments.map((a) => (
              <span key={a.name} className="ui-badge" style={{ padding: '4px 8px', fontSize: 11.5 }}>
                <Lucide.Paperclip size={14} style={{ marginRight: 4 }} />
                {a.name}
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost"
                  style={{ width: 18, height: 18, marginLeft: 2 }}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.name !== a.name))}
                >
                  <Lucide.X size={14} />
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
          <div className="left-actions" style={{ position: 'relative' }}>
            <button
              type="button"
              className={`plus-btn ${showPlusMenu ? 'is-open' : ''}`}
              title="添加"
              onClick={() => {
                if (showPlusMenu) {
                  setShowPlusMenu(false);
                } else {
                  setShowPlusMenu(true);
                  setShowModelDropdown(false);
                }
              }}
            >
              <Lucide.Plus size={16} />
            </button>
            <ComposePlusMenu
              open={showPlusMenu}
              onClose={() => setShowPlusMenu(false)}
              onAddFiles={() => fileInputRef.current?.click()}
              collabMode={collabMode}
              onCollabMode={setCollabMode}
              collabDesc={collabDesc}
              onCollabDesc={setCollabDesc}
              collabTask={collabTask}
              onCollabTask={setCollabTask}
              collabBusy={collabBusy}
              onSpawnCollaborator={handleSpawnCollaborator}
            />
            <PermissionModeMenu
              mode={permissionMode}
              onChange={(m) => {
                setPermissionMode(m);
                setShowPlusMenu(false);
                setShowModelDropdown(false);
              }}
            />
          </div>
          <div className="right-actions">
            {showModelPicker && (
            <div
              ref={modelSelectorRef}
              className="model-badge"
              title={
                getActiveProfile()
                  ? `${getActiveProfile()!.name} · ${engineModel || getActiveModelId() || '未选模型'}`
                  : '选择服务商与模型'
              }
              onClick={() => {
                setShowModelDropdown((prev) => !prev);
                setShowPlusMenu(false);
              }}
            >
              <span className="model-text">
                {getModelDisplayName(
                  engineModel || getActiveModelId() || '选择模型',
                )}
              </span>
              <Lucide.ChevronDown size={14} style={{ opacity: 0.55 }} />

              <ModelPicker
                open={showModelDropdown}
                onClose={() => setShowModelDropdown(false)}
                engineModel={engineModel}
                busy={pickerBusy}
                error={pickerInlineError}
                onSelect={(profileId, modelId) => {
                  void selectProfileModel(profileId, modelId);
                }}
                onOpenSettings={() => {
                  setShowModelDropdown(false);
                  useLayoutStore.getState().openSettings('models');
                }}
                onToast={onShowToast}
              />
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
