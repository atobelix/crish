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
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
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
import { useChatStream } from '../hooks/useChatStream';
import { useChatAutoScroll } from '../hooks/useChatAutoScroll';
import { useThinkingTimer } from '../hooks/useThinkingTimer';
import { ChatDemoChrome } from './ChatDemoChrome';
import { emitUiEvent, onUiEvent } from '../api/uiEvents';

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

  const openSidePanel = (panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files') => {
    handleGlobalTabClick(panelId);
  };



  const { chatFlowRef, showScrollToBottom, scrollToBottom } = useChatAutoScroll(messages);
  // Thinking timer: start when AI is processing, clear when done
  const isProcessing = messages.some((m) => m.status === 'processing');
  const thinkingSeconds = useThinkingTimer(isProcessing);

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
      { cmd: '/schedule', desc: '打开主区定时任务' },
      { cmd: '/browser', desc: '打开右侧内置预览浏览器' },
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
        {mainSurface === 'scheduled' ? (
          <ScheduledTasksPanel
            onShowToast={onShowToast}
            onBackToChat={() => setMainSurface('chat')}
          />
        ) : (
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
                  emitUiEvent('open-overview');
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
            className="approval-dock"
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
              {pendingApprovalCount} 个操作待审批
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
                  setSlashMenuOpen(false);
                  if (selectedCmd === '/schedule') {
                    setChatInput('');
                    setMainSurface('scheduled');
                    return;
                  }
                  setChatInput(selectedCmd + ' ');
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
});
