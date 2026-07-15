import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { FileDiff } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
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
import { ModelPicker } from './ModelPicker';
import { ChatMessageList } from './ChatMessageList';
import { ScheduledTasksPanel } from './ScheduledTasksPanel';
import { networkUserMessage } from '../api/userFacingErrors';
import { toolHumanLabel } from '../api/toolPresentation';
import {
  getSkillSlashCommandsCached,
  type SkillSlashCommand,
} from '../api/skillsApi';
import { clientApi } from '../api/clientApi';
import { openFileInPanel } from '../api/workspaceFsApi';
import { AgentCard } from './AgentCard';
import { useChatStream, type ChatAttachment } from '../hooks/useChatStream';
import { useChatAutoScroll } from '../hooks/useChatAutoScroll';
import { useThinkingTimer } from '../hooks/useThinkingTimer';
import { ChatDemoChrome } from './ChatDemoChrome';
import { onUiEvent } from '../api/uiEvents';
import { downloadSessionMarkdown } from '../api/sessionExport';
import { blobToImageAttachment, isImageFile } from '../api/imageProcessing';
import { ChatComposer } from './ChatComposer';

interface ChatCardProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: (message: string) => void;
  handleGlobalTabClick: (cardId: string) => void;
}

export const ChatCard: React.FC<ChatCardProps> = React.memo(({
  wsId,
  colIdx: _colIdx,
  groupIdx: _groupIdx,
  onShowToast,
  handleGlobalTabClick
}) => {
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const activeAgentId = useLayoutStore((s) => s.activeAgentId);
  const setActiveAgentId = useLayoutStore((s) => s.setActiveAgentId);
  const withdrawMessage = useLayoutStore((s) => s.withdrawMessage);
  const setActiveDiffSource = useLayoutStore((s) => s.setActiveDiffSource);
  const appSettings = useLayoutStore((s) => s.appSettings);

  const [engineModel, setEngineModel] = useState('');
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerInlineError, setPickerInlineError] = useState('');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  /** chat = 对话流；scheduled = 主区定时任务 */
  const [mainSurface, setMainSurface] = useState<'chat' | 'scheduled'>('chat');
  const [projectTick, setProjectTick] = useState(0);
  const [engineHint, setEngineHint] = useState<EngineStatus | null>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  /** 输入区旁「更多」：导出 / 本会话搜索等次要动作 */
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  /** 本会话消息客户端过滤（搜索本会话） */
  const [localMsgFilter, setLocalMsgFilter] = useState('');
  const [showMsgFilter, setShowMsgFilter] = useState(false);
  const msgFilterInputRef = useRef<HTMLInputElement>(null);

  const modelChoices = flattenModelChoices();

  useEffect(() => {
    const offs = [
      onUiEvent('project-changed', () => setProjectTick((n) => n + 1)),
      onUiEvent('open-project-picker', () => setShowProjectPicker(true)),
      onUiEvent('open-scheduled', () => setMainSurface('scheduled')),
      onUiEvent('open-chat', () => setMainSurface('chat')),
    ];
    return () => offs.forEach((off) => off());
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
  /** /goal 目标模式进行中时展示停止 */
  const goalModeActive = Boolean(activeSession?.goalMode?.active);

  // 切换会话时收起过滤，避免串会话
  useEffect(() => {
    setLocalMsgFilter('');
    setShowMsgFilter(false);
  }, [activeSessionId]);

  useEffect(() => {
    if (showMsgFilter) {
      // 打开后聚焦输入
      window.requestAnimationFrame(() => msgFilterInputRef.current?.focus());
    }
  }, [showMsgFilter]);

  /** 导出 Markdown：走 sessionExport（与侧栏/底栏导出一致） */
  const handleExportMarkdown = useCallback(() => {
    if (!activeSession) {
      onShowToast('没有可导出的会话');
      return;
    }
    try {
      downloadSessionMarkdown(activeSession);
      onShowToast('已导出 Markdown');
    } catch {
      onShowToast('导出失败');
    }
  }, [activeSession, onShowToast]);

  /** 本会话文本过滤（仅影响展示；钉栏 / 页眉工具条始终可见） */
  const displayMessages = useMemo(() => {
    const q = localMsgFilter.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => {
      const text = (m.text || '').toLowerCase();
      const thinking = (m.thinking || '').toLowerCase();
      if (text.includes(q) || thinking.includes(q)) return true;
      // 工具名/参数也可命中
      return (m.toolCalls || []).some((tc) => {
        const name = (tc.name || '').toLowerCase();
        const args = (tc.arguments || '').toLowerCase();
        const out = (tc.output || '').toLowerCase();
        return name.includes(q) || args.includes(q) || out.includes(q);
      });
    });
  }, [messages, localMsgFilter]);

  // 当前会话待审批工具（主会话 + 协作 agent；时间线内联卡 + 底部 sticky 条）
  let pendingApprovalMsgId = '';
  let pendingApprovalToolId = '';
  let pendingApprovalCount = 0;
  let pendingApprovalSummary = '';
  const scanPending = (msgs: typeof messages) => {
    for (const m of msgs) {
      if (!m.toolCalls) continue;
      for (const tc of m.toolCalls) {
        if (tc.status !== 'pending_approval') continue;
        pendingApprovalCount += 1;
        if (!pendingApprovalToolId) {
          pendingApprovalMsgId = m.id;
          pendingApprovalToolId = tc.id;
          pendingApprovalSummary = toolHumanLabel(tc);
        }
      }
    }
  };
  scanPending(messages);
  for (const ag of activeSession?.agents || []) {
    scanPending(ag.messages || []);
  }

  // Composer extras — permission mode is global so chatApi can read it
  // 状态须在依赖它的 useEffect 之前声明，避免 TDZ 白屏
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
  const planApproved = useLayoutStore((s) => s.planApproved);
  const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addAttachments = useCallback((items: ChatAttachment[]) => {
    if (!items.length) return;
    setAttachments((prev) => {
      const names = new Set(prev.map((p) => p.name));
      const next = items.filter((n) => !names.has(n.name));
      // 同名时给图片补唯一后缀，避免粘贴多张被吞
      const uniqued = items
        .filter((n) => names.has(n.name))
        .map((n, i) => {
          if (!n.dataUrl) return null;
          const base = n.name.replace(/(\.[^.]+)?$/, '');
          const ext = (n.name.match(/(\.[^.]+)$/) || [])[1] || '';
          return { ...n, name: `${base}-${Date.now()}-${i}${ext}` };
        })
        .filter(Boolean) as ChatAttachment[];
      return [...prev, ...next, ...uniqued];
    });
  }, []);

  const handlePasteImage = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
      if (!imageFiles.length) return;
      e.preventDefault();
      try {
        const next: ChatAttachment[] = [];
        for (const f of imageFiles) {
          next.push(await blobToImageAttachment(f, f.name || undefined));
        }
        addAttachments(next);
        onShowToast('已粘贴图片');
      } catch {
        onShowToast('图片粘贴失败');
      }
    },
    [addAttachments, onShowToast],
  );

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
    if (!showMoreMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMoreMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [showMoreMenu]);

  // Keyboard and Input states
  const [chatInput, setChatInput] = useState('');
  const [isComposing, setIsComposing] = useState(false); // IME Composition State
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  /** 有文字或附件（含截图）即可发送 */
  const canSend = Boolean(chatInput.trim() || attachments.length > 0);

  const openSidePanel = (panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files') => {
    handleGlobalTabClick(panelId);
  };



  const { chatFlowRef, showScrollToBottom, scrollToBottom } = useChatAutoScroll(messages);
  // Thinking timer: start when AI is processing, clear when done
  const isProcessing = messages.some((m) => m.status === 'processing');
  const thinkingSeconds = useThinkingTimer(isProcessing);

  // Slash commands：固定 + 技能（enableSkillCommands）
  // 正式模式含已实现命令；纯演示命令仅 demo
  const BASE_SLASH = useMemo(
    () => [
      { cmd: '/goal', desc: '长期目标模式：自动多轮推进直至完成' },
      { cmd: '/learn', desc: '记住一条偏好/规则到全局设置' },
      { cmd: '/grill-me', desc: '产品/技术对齐：只提问澄清，暂不实施' },
      { cmd: '/teamwork-preview', desc: '打开多代理协作看板' },
      { cmd: '/schedule', desc: '打开主区定时任务' },
      { cmd: '/browser', desc: '打开右侧内置预览浏览器' },
      ...(isDemoMode()
        ? [{ cmd: '/simulate', desc: '启动庞大的1分钟自动化流水线模拟演示' }]
        : []),
    ],
    [],
  );
  const [skillSlash, setSkillSlash] = useState<SkillSlashCommand[]>([]);
  const [skillCommandsEnabled, setSkillCommandsEnabled] = useState(true);

  // 技能斜杠命令：挂载时加载一次；设置变更（crish-skills-changed）时重载，不随会话切换重扫
  useEffect(() => {
    let cancelled = false;
    const load = async (force = false) => {
      try {
        const settings = await clientApi.getSettings();
        if (cancelled) return;
        const on = settings?.enableSkillCommands !== false;
        setSkillCommandsEnabled(on);
        if (!on) {
          setSkillSlash([]);
          return;
        }
        const { commands } = await getSkillSlashCommandsCached(force);
        if (!cancelled) setSkillSlash(commands);
      } catch {
        /* ignore */
      }
    };
    void load(false);
    const onSkillsChanged = () => {
      void load(true);
    };
    window.addEventListener('crish-skills-changed', onSkillsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('crish-skills-changed', onSkillsChanged);
    };
  }, []);

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

  const {
    runNotice,
    setRunNotice,
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
  } = useChatStream({
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
  });

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

  return (
    <div className="chat-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {activeAgent ? (
        <div className="agent-inline-shell" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* 全屏主区：顶栏仅 AgentCard 自带（状态 + 关闭），不再叠一层返回条 */}
          <AgentCard
            agentId={activeAgent.id}
            embedded
            onClose={() => setActiveAgentId(null)}
          />
        </div>
      ) : null}

      {/* 本会话消息过滤条：由「更多」菜单打开，钉在列表上方 */}
      {!activeAgent && mainSurface === 'chat' && showMsgFilter ? (
        <div className="chat-msg-filter-bar" role="search">
          <Lucide.Search size={14} className="chat-msg-filter-icon" aria-hidden />
          <input
            ref={msgFilterInputRef}
            type="search"
            className="chat-msg-filter-input"
            value={localMsgFilter}
            placeholder="搜索本会话消息…"
            aria-label="搜索本会话"
            onChange={(e) => setLocalMsgFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setLocalMsgFilter('');
                setShowMsgFilter(false);
              }
            }}
          />
          {localMsgFilter.trim() ? (
            <span className="chat-msg-filter-count">
              {displayMessages.length}/{messages.length}
            </span>
          ) : null}
          <button
            type="button"
            className="chat-msg-filter-clear"
            title="关闭搜索"
            aria-label="关闭搜索"
            onClick={() => {
              setLocalMsgFilter('');
              setShowMsgFilter(false);
            }}
          >
            <Lucide.X size={14} />
          </button>
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
        {mainSurface === 'scheduled' ? (
          <ScheduledTasksPanel
            onShowToast={onShowToast}
            onBackToChat={() => setMainSurface('chat')}
          />
        ) : localMsgFilter.trim() && displayMessages.length === 0 && messages.length > 0 ? (
          <div className="chat-msg-filter-empty" role="status">
            <Lucide.SearchX size={22} strokeWidth={1.5} />
            <p>本会话没有匹配「{localMsgFilter.trim()}」的消息</p>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => setLocalMsgFilter('')}
            >
              清除过滤
            </button>
          </div>
        ) : (
          <ChatMessageList
            messages={displayMessages}
            agents={activeSession?.agents || []}
            activeSessionId={activeSessionId || ''}
            thinkingSeconds={thinkingSeconds}
            showProjectPicker={showProjectPicker}
            onShowProjectPicker={setShowProjectPicker}
            onProjectChanged={() => setProjectTick((n) => n + 1)}
            onSetChatInput={setChatInput}
            onWithdraw={(msgId, text) => {
              // 撤回前停掉进行中的流，避免幽灵 run / 审批挂起
              handleStopGeneration();
              setChatInput(text);
              withdrawMessage(wsId, activeSessionId, msgId);
            }}
            onRegenerate={(userText, assistantMsgId) => {
              // 重生成前先停旧流，再从助手消息截断
              handleStopGeneration();
              withdrawMessage(wsId, activeSessionId, assistantMsgId);
              const msgs =
                useLayoutStore.getState().sessions.find((s) => s.id === activeSessionId)
                  ?.messages || [];
              let userMsgId = [...msgs].reverse().find((m) => m.sender === 'user')?.id;
              if (!userMsgId) {
                userMsgId = `user-msg-${Date.now()}`;
                useLayoutStore.getState().addMessage(wsId, activeSessionId, {
                  id: userMsgId,
                  sender: 'user',
                  text: userText,
                  timestamp: Date.now(),
                  status: 'processing',
                });
              } else {
                useLayoutStore
                  .getState()
                  .setSessionMessageStatus(activeSessionId, userMsgId, 'processing');
              }
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
            onOpenDiffPanel={() => openSidePanel('diff')}
            onApprovalAllow={handleApprovalAllow}
            onApprovalDeny={handleApprovalDeny}
          />
        )}
      </div>

      <div className="chat-footer" style={{ display: mainSurface === 'scheduled' ? 'none' : undefined }}>
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
        {inPlanMode && (
          <div className="plan-mode-ribbon plan-mode-ribbon--slim" role="status">
            <Lucide.ListChecks size={14} strokeWidth={1.75} aria-hidden />
            <span className="plan-mode-ribbon-text" title="计划模式：只规划不改文件">
              计划模式{planApproved ? ' · 已批准' : ' · 只规划'}
            </span>
            <button
              type="button"
              className="plan-mode-ribbon-icon-btn"
              title="批准执行"
              onClick={() => {
                setPermissionMode('ask');
                setPlanApproved(true);
                onShowToast('已批准执行，已切回需确认模式');
              }}
            >
              <Lucide.Check size={14} strokeWidth={2} />
            </button>
          </div>
        )}
        {goalModeActive && activeSession?.goalMode ? (
          <div className="plan-mode-ribbon goal-mode-ribbon plan-mode-ribbon--slim" role="status">
            <Lucide.Target size={14} strokeWidth={1.75} aria-hidden />
            <span
              className="plan-mode-ribbon-text"
              title={activeSession.goalMode.goal || '目标模式'}
            >
              目标 · 第 {(activeSession.goalMode.iteration ?? 0) + 1} 轮
              {activeSession.goalMode.goal
                ? ` · ${
                    activeSession.goalMode.goal.length > 36
                      ? `${activeSession.goalMode.goal.slice(0, 36)}…`
                      : activeSession.goalMode.goal
                  }`
                : ''}
            </span>
            <button
              type="button"
              className="plan-mode-ribbon-icon-btn is-danger"
              title="停止目标"
              aria-label="停止目标"
              onClick={() => {
                handleStopGeneration();
                if (activeSessionId) {
                  useLayoutStore.getState().patchSession(activeSessionId, {
                    goalMode: null,
                  });
                }
                onShowToast('已停止目标');
              }}
            >
              <Lucide.Square size={12} fill="currentColor" />
            </button>
          </div>
        ) : null}
        {/* 回到最新：浮在对话区右下角，仅图标 */}
        {showScrollToBottom && (
          <button
            type="button"
            className="chat-scroll-fab"
            title="回到最新"
            onClick={scrollToBottom}
          >
            <Lucide.ChevronDown size={16} strokeWidth={2} />
          </button>
        )}

        {/* Demo-only context chips + Goal playground；正式模式不挂载 */}
        {isDemoMode() ? (
          <ChatDemoChrome
            onShowToast={onShowToast}
            handleGlobalTabClick={handleGlobalTabClick}
          />
        ) : null}

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

        {/* 审批 sticky 条：固定在输入区上方；点击滚到首个待审批工具 */}
        {!activeAgent && pendingApprovalCount > 0 ? (
          <button
            type="button"
            className="approval-dock approval-dock--slim"
            title={pendingApprovalSummary || '有操作等待你确认'}
            onClick={() => {
              const byTool = pendingApprovalToolId
                ? document.querySelector(
                    `.approval-card[data-tool-id="${CSS.escape(pendingApprovalToolId)}"], [data-tool-id="${CSS.escape(pendingApprovalToolId)}"]`,
                  )
                : null;
              const byMsg = pendingApprovalMsgId
                ? document.querySelector(`.approval-card[data-msg="${CSS.escape(pendingApprovalMsgId)}"]`)
                : null;
              const el = byTool || byMsg || document.querySelector('.approval-card');
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (el instanceof HTMLElement) {
                  try {
                    el.focus({ preventScroll: true });
                  } catch {
                    /* ignore */
                  }
                }
                return;
              }
              const sess = useLayoutStore
                .getState()
                .sessions.find((s) => s.id === activeSessionId);
              const pendingAgent = (sess?.agents || []).find((ag) =>
                (ag.messages || []).some((m) =>
                  (m.toolCalls || []).some((tc) => tc.status === 'pending_approval'),
                ),
              );
              if (pendingAgent) {
                useLayoutStore.getState().setActiveAgentId(pendingAgent.id);
                onShowToast('已打开待确认的协作任务');
                return;
              }
              onShowToast('请在对话中确认权限');
            }}
          >
            <span className="approval-dock-dot" aria-hidden />
            <span className="approval-dock-label">
              {pendingApprovalCount} 待审批
              {pendingApprovalSummary ? ` · ${pendingApprovalSummary}` : ''}
            </span>
            <Lucide.ChevronRight size={14} className="approval-dock-go-icon" aria-hidden />
          </button>
        ) : null}

        {!activeAgent ? (
          <ChatComposer
            chatInput={chatInput}
            setChatInput={setChatInput}
            isComposing={isComposing}
            setIsComposing={setIsComposing}
            slashMenuOpen={slashMenuOpen}
            setSlashMenuOpen={setSlashMenuOpen}
            slashSelectedIndex={slashSelectedIndex}
            setSlashSelectedIndex={setSlashSelectedIndex}
            filteredCommands={filteredCommands}
            loadSkillSlash={loadSkillSlash}
            onPasteImage={handlePasteImage}
            onSend={() => { void handleSendChat(false); }}
            onStop={handleStopGeneration}
            canSend={canSend}
            isProcessing={messages.some((m) => m.status === 'processing')}
            attachments={attachments}
            setAttachments={setAttachments}
            fileInputRef={fileInputRef}
            onFilesSelected={async (files) => {
              const next: ChatAttachment[] = [];
              for (const f of files) {
                if (isImageFile(f)) {
                  try {
                    next.push(await blobToImageAttachment(f, f.name));
                  } catch {
                    next.push({ name: f.name, mime: f.type || undefined });
                  }
                  continue;
                }
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
              addAttachments(next);
            }}
            showPlusMenu={showPlusMenu}
            setShowPlusMenu={setShowPlusMenu}
            showMoreMenu={showMoreMenu}
            setShowMoreMenu={setShowMoreMenu}
            showMsgFilter={showMsgFilter}
            setShowMsgFilter={setShowMsgFilter}
            setLocalMsgFilter={setLocalMsgFilter}
            moreMenuRef={moreMenuRef}
            permissionMode={permissionMode}
            onPermissionChange={(m) => {
              setPermissionMode(m);
            }}
            onExportMarkdown={handleExportMarkdown}
            canExport={Boolean(activeSession)}
            onOpenSchedule={() => {
              setMainSurface('scheduled');
              onShowToast('已打开定时任务');
            }}
            onShowToast={onShowToast}
            onCloseSiblingMenus={() => setShowModelDropdown(false)}
            rightActions={
              showModelPicker ? (
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
              ) : null
            }
          />
        ) : null}
      </div>
    </div>
  );
});
