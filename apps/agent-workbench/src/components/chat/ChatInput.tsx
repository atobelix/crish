/**
 * ChatInput - 聊天输入组件
 *
 * 包含输入框、斜杠命令、上下文选择、权限切换、模型选择、设置面板等。
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import { appState } from '../../core/app-state';
import { tauriBridge } from '../../core/tauri-bridge';
import { loadInputDraft, saveInputDraft } from './draft-store';
import { createDefaultWorkbenchSettings } from '../../shared/workbench-config';
import { ToolApprovalDeck } from './ApprovalDeck';
import { AskDeck, PendingInputDeck } from './AskDeck';
import { truncatePath } from '../utils';
import { showToast } from '../ToastContainer';
import {
  IconFolder,
  IconChat,
  IconChevronDown,
  IconShield,
  IconPlus,
  IconSend,
  IconKill,
  IconCheck,
  IconFileCode,
  IconFilePlus,
  IconFolderOpen,
} from '../icons';

const INPUT_MODEL_OPTIONS = createDefaultWorkbenchSettings().provider.models;

export function ChatInput({
  onSend,
  disabled,
  onCancel,
  sessionId,
  runId,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  onCancel?: () => void;
  sessionId?: string | null;
  runId?: string | null;
}) {
  const [text, setText] = useState(() => loadInputDraft(appState.getState().currentSession?.id));
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [permissionMode, setPermissionMode] = useState(appState.getState().permissionMode);
  const [workingDirectory, setWorkingDirectory] = useState(appState.getState().workingDirectory);
  const [openedFolders, setOpenedFolders] = useState(appState.getState().openedFolders);
  const [workspaceContext, setWorkspaceContext] = useState(appState.getCurrentWorkspaceContext());
  const [model, setModel] = useState(appState.getState().model);
  const [effort, setEffort] = useState<'Low' | 'Medium' | 'High'>('High');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);

  const PLACEHOLDERS = [
    '描述任务或提出问题...',
    '试着说：帮我分析这段代码',
    '试着说：生成一个 React 组件',
    '试着说：解释这个报错原因',
    '试着说：优化这段代码性能',
  ];
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  useEffect(() => {
    if (disabled || text) return;
    const timer = window.setInterval(() => {
      setPlaceholderIndex(i => (i + 1) % PLACEHOLDERS.length);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [disabled, text]);

  useEffect(() => {
    const u1 = appState.subscribe('permissionMode', setPermissionMode);
    const refreshWorkspaceContext = () => setWorkspaceContext(appState.getCurrentWorkspaceContext());
    const u2 = appState.subscribe('workingDirectory', (dir) => {
      setWorkingDirectory(dir);
      refreshWorkspaceContext();
    });
    const u3 = appState.subscribe('model', setModel);
    const u4 = appState.subscribe('openedFolders', (folders) => {
      setOpenedFolders(folders);
      refreshWorkspaceContext();
    });
    const u5 = appState.subscribe('currentSession', () => {
      refreshWorkspaceContext();
    });
    return () => { u1(); u2(); u3(); u4(); u5(); };
  }, []);

  // 输入草稿持久化：按会话保存，切换会话各自保留，发送或清空即清除
  useEffect(() => {
    saveInputDraft(appState.getState().currentSession?.id, text);
  }, [text]);

  // 切换会话时载入该会话的草稿
  useEffect(() => {
    return appState.subscribe('currentSession', (sess) => {
      setText(loadInputDraft(sess?.id));
    });
  }, []);

  // 挂载时若已恢复草稿，自适应输入框高度
  useEffect(() => {
    const el = textareaRef.current;
    if (el && text) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slashCommands = [
    { cmd: '/help', desc: '显示帮助信息' },
    { cmd: '/clear', desc: '清空当前对话' },
    { cmd: '/mode chat', desc: '切换到 Chat 模式' },
    { cmd: '/mode code', desc: '切换到 Code 模式' },
    { cmd: '/goal', desc: 'Goal 模式运行（多轮自动续跑）' },
    { cmd: '/continue', desc: '续跑已暂停的任务' },
    { cmd: '/open', desc: '打开文件夹（Code 模式）' },
    { cmd: '/permission ask', desc: '切换到询问模式' },
    { cmd: '/permission full', desc: '切换到完全允许模式' },
    { cmd: '/compact', desc: '压缩上下文' },
    { cmd: '/model', desc: '查看/切换模型' },
    { cmd: '/undo', desc: '撤销上一条消息' },
    { cmd: '/status', desc: '查看当前状态' },
    { cmd: '/sidebar', desc: '切换右侧面板' },
    { cmd: '/theme', desc: '切换深色/浅色主题' },
  ];

  const filteredCommands = slashFilter
    ? slashCommands.filter(c => c.cmd.includes(slashFilter.toLowerCase()))
    : slashCommands;

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      handleSlashCommand(trimmed);
      setText('');
      setSlashMenuOpen(false);
      return;
    }

    if (disabled) {
      appState.enqueuePendingInput({
        sessionId: sessionId ?? appState.getCurrentSessionId(),
        runId: runId ?? null,
        text: trimmed,
        mode: 'after-current-run',
      });
      setText('');
      setSlashMenuOpen(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      return;
    }

    onSend(trimmed);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleSlashCommand = async (cmd: string) => {
    const parts = cmd.split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (command) {
      case '/help':
        appState.addMessage({
          role: 'assistant',
          content: `可用命令:\n${slashCommands.map(c => `  ${c.cmd} - ${c.desc}`).join('\n')}`,
        });
        break;
      case '/clear': {
        const sess = appState.getState().currentSession;
        if (sess) {
          appState.clearSessionMessages(sess.id);
        }
        break;
      }
      case '/mode': {
        // workMode 由 currentSession.projectId 决定，切换模式需要切换会话
        if (arg === 'chat') {
          const chatSessions = appState.getState().sessions.filter(s => s.projectId === null);
          if (chatSessions.length > 0) appState.switchSession(chatSessions[0].id);
          else appState.createSession('新对话');
        } else if (arg === 'code') {
          const cwd = appState.getState().workingDirectory;
          if (cwd) {
            const projectSessions = appState.getProjectSessions(cwd);
            if (projectSessions.length > 0) appState.switchSession(projectSessions[0].id);
            else appState.createSession('新对话', cwd);
          }
        } else {
          appState.addMessage({ role: 'assistant', content: '用法: /mode 对话 或 /mode 代码' });
        }
        break;
      }
      case '/open':
        handleOpenFolder();
        break;
      case '/goal': {
        const goalPrompt = arg && !arg.startsWith('/') ? arg : '';
        if (!goalPrompt) {
          appState.addMessage({ role: 'assistant', content: '用法: /goal <目标描述>\nGoal 模式将自动多轮续跑直到目标完成。' });
          break;
        }
        const state = appState.getState();
        const cwd = state.workingDirectory || '';
        if (!cwd) {
          appState.addMessage({ role: 'assistant', content: '请先打开项目文件夹再使用 Goal 模式。' });
          break;
        }
        appState.addMessage({ role: 'user', content: `[Goal] ${goalPrompt}` });
        try {
          const result = await tauriBridge.runGoalStream({
            prompt: goalPrompt,
            cwd,
            permissionMode: state.permissionMode,
          });
          appState.registerRun({
            runId: result.runId,
            sessionId: result.sessionId,
            prompt: goalPrompt,
            mode: 'goal',
            cwd,
            permissionMode: state.permissionMode,
          });
          appState.addMessage({ role: 'system', content: 'Goal 模式已启动，AI 将自动续跑直到目标完成...' });
        } catch (e) {
          appState.addMessage({ role: 'assistant', content: `Goal 模式启动失败: ${e}` });
        }
        break;
      }
      case '/continue': {
        const runId = appState.getState().activeRunId;
        if (!runId) {
          appState.addMessage({ role: 'assistant', content: '当前没有可续跑的任务。' });
          break;
        }
        const continueReason = arg && !arg.startsWith('/') ? arg : '用户手动续跑';
        try {
          await tauriBridge.continuation(runId, { action: 'continue', reason: continueReason });
          appState.addMessage({ role: 'system', content: '任务已续跑...' });
        } catch (e) {
          appState.addMessage({ role: 'assistant', content: `续跑失败: ${e}` });
        }
        break;
      }
      case '/permission':
        if (arg === 'ask') appState.setState('permissionMode', 'ask');
        else if (arg === 'full') appState.setState('permissionMode', 'full-access');
        else appState.addMessage({ role: 'assistant', content: '用法: /permission ask 或 /permission full' });
        break;
      case '/compact': {
        const sess = appState.getState().currentSession;
        if (sess && sess.messages.length > 10) {
          const recentMessages = sess.messages.slice(-10);
          sess.messages = recentMessages;
          appState.setState('currentSession', { ...sess });
          appState.addMessage({ role: 'assistant', content: '已压缩上下文，保留最近 10 条消息。AI 侧的完整上下文将在下次交互时自动管理。' });
        } else {
          appState.addMessage({ role: 'assistant', content: '当前上下文较短，无需压缩。' });
        }
        break;
      }
      case '/model': {
        if (arg && !arg.startsWith('/')) {
          appState.setState('model', arg);
          const currentProvider = appState.getState().providerConfig;
          tauriBridge.updateDaemonConfig({
            model: arg,
            baseUrl: currentProvider.baseUrl || undefined,
            credentialMode: currentProvider.credentialMode,
          }).then((providerConfig) => {
            appState.setState('providerConfig', providerConfig);
            appState.addMessage({ role: 'assistant', content: `模型已切换为: ${arg}\n注意: 新模型将在下次对话时生效。` });
          }).catch(() => {
            appState.addMessage({ role: 'assistant', content: `模型已切换为: ${arg}，但保存配置失败。` });
          });
        } else {
          appState.addMessage({ role: 'assistant', content: `当前模型: ${appState.getState().model}\n用法: /model <模型名称>\n请在 Provider 设置中查看可用模型` });
        }
        break;
      }
      case '/undo': {
        const sess = appState.getState().currentSession;
        if (sess && sess.messages.length > 0) {
          const removed = sess.messages.pop();
          appState.setState('currentSession', { ...sess });
          appState.addMessage({ role: 'assistant', content: `已撤销消息: "${removed?.content?.slice(0, 30)}..."` });
        } else {
          appState.addMessage({ role: 'assistant', content: '没有可撤销的消息。' });
        }
        break;
      }
      case '/status': {
        const s = appState.getState();
        appState.addMessage({ role: 'assistant', content: `当前状态:\n- 工作模式: ${appState.workMode === 'agent' ? 'Code' : 'Chat'}\n- 权限模式: ${s.permissionMode === 'ask' ? '安全确认' : '完全允许'}\n- 工作目录: ${s.workingDirectory || '未设置'}\n- 模型: ${s.model}\n- 会话数: ${s.sessions.length}\n- 待审批: ${s.approvalQueue.length}\n- 文件变更: ${s.changedFiles.length}\n- 流式状态: ${s.isStreaming ? '进行中' : '空闲'}` });
        break;
      }
      case '/sidebar': {
        appState.setState('rightSidebarVisible', !appState.getState().rightSidebarVisible);
        break;
      }
      case '/theme': {
        const next = appState.getState().theme === 'dark' ? 'light' : 'dark';
        appState.setState('theme', next);
        document.documentElement.setAttribute('data-theme', next);
        appState.addMessage({ role: 'assistant', content: `主题已切换为: ${next === 'dark' ? '深色' : '浅色'}` });
        break;
      }
      default:
        appState.addMessage({ role: 'assistant', content: `未知命令: ${command}\n输入 /help 查看可用命令` });
    }
  };

  const handleOpenFolder = async () => {
    try {
      const folder = await tauriBridge.selectFolder();
      if (folder) {
        appState.setCurrentSessionWorkspace(folder);
        appState.addMessage({
          role: 'assistant',
          content: `已打开工作目录: \`${folder}\`\n现在可以在此目录中进行代码操作。`,
        });
        // workMode 由 currentSession.projectId 决定，setCurrentSessionWorkspace 已更新 projectId
      }
    } catch (e) {
      showToast('打开文件夹失败', 'error', 4500);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (slashMenuOpen && filteredCommands.length === 1) {
        const cmd = filteredCommands[0]!.cmd;
        setText(cmd + ' ');
        setSlashMenuOpen(false);
      } else {
        handleSend();
      }
    }
    if (e.key === 'Escape') {
      setSlashMenuOpen(false);
    }
  };

  const handleTextChange = (value: string) => {
    setText(value);
    if (value.startsWith('/') && !value.includes('\n')) {
      setSlashMenuOpen(true);
      setSlashFilter(value.slice(1));
    } else {
      setSlashMenuOpen(false);
    }
  };

  const togglePermissionMode = () => {
    const next = permissionMode === 'ask' ? 'full-access' : 'ask';
    appState.setState('permissionMode', next);
  };

  const applyWorkspaceContext = (projectId: string | null) => {
    appState.setCurrentSessionWorkspace(projectId);
    setWorkspaceContext(appState.getCurrentWorkspaceContext());
    setContextMenuOpen(false);
  };

  const handleChooseWorkspaceFolder = async () => {
    const folder = await tauriBridge.selectFolder();
    if (folder) {
      applyWorkspaceContext(folder);
    }
  };

  const contextProjects = [
    ...(workingDirectory ? [workingDirectory] : []),
    ...openedFolders.filter(folder => folder && folder !== workingDirectory),
  ].slice(0, 8);

  return (
    <div class="repl-chat-input-sticky-footer">
      <ToolApprovalDeck />
      <AskDeck />
      <PendingInputDeck />

      {/* 纯净输入框 */}
      <div class="repl-input-box-wrap">
        {/* 上下文栏 */}
        <div class="repl-input-context-bar">
          <div class="repl-input-context-tag-wrap">
            <button
              type="button"
              class="repl-input-context-tag"
              onClick={() => setContextMenuOpen(open => !open)}
              title={workspaceContext.cwd ? workspaceContext.cwd : '无项目对话'}
            >
              {workspaceContext.workspaceMode === 'project' ? <IconFolder /> : <IconChat />}
              <span>{workspaceContext.workspaceMode === 'project' ? workspaceContext.label : '无项目'}</span>
              <IconChevronDown />
            </button>
            {contextMenuOpen && (
              <div class="repl-input-context-menu">
                <button type="button" class="repl-input-context-menu-item" onClick={() => applyWorkspaceContext(null)}>
                  <IconChat />
                  <span>无项目对话</span>
                </button>
                {contextProjects.length > 0 && <div class="repl-input-context-menu-divider" />}
                {contextProjects.map(folder => (
                  <button
                    type="button"
                    class="repl-input-context-menu-item"
                    key={folder}
                    onClick={() => applyWorkspaceContext(folder)}
                    title={folder}
                  >
                    <IconFolder />
                    <span>{folder.split(/[\\/]/).pop() || truncatePath(folder, 32)}</span>
                  </button>
                ))}
                <div class="repl-input-context-menu-divider" />
                <button type="button" class="repl-input-context-menu-item" onClick={handleChooseWorkspaceFolder}>
                  <IconFolder />
                  <span>选择项目文件夹</span>
                </button>
              </div>
            )}
          </div>
        </div>
        <div class="repl-input-box-container">
          {/* 斜杠命令菜单 */}
          {slashMenuOpen && filteredCommands.length > 0 && (
            <div class="repl-slash-menu">
              {filteredCommands.map(c => (
                <div
                  class="repl-slash-menu-item"
                  onClick={() => { setText(c.cmd + ' '); setSlashMenuOpen(false); textareaRef.current?.focus(); }}
                >
                  <span class="repl-slash-menu-cmd">{c.cmd}</span>
                  <span class="repl-slash-menu-desc">{c.desc}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            class="repl-input-textarea"
            id="chat-input"
            placeholder={disabled ? '输入后将排队发送，也可以用 / 命令调整当前会话...' : PLACEHOLDERS[placeholderIndex]}
            rows={1}
            value={text}
            onInput={(e: Event) => {
              const value = (e.target as HTMLTextAreaElement).value;
              handleTextChange(value);
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = el.scrollHeight + 'px';
              }
            }}
            onKeyDown={handleKeyDown}
            aria-disabled={disabled ? 'true' : 'false'}
            aria-label="聊天输入框"
          />

          {/* 底部工具栏 */}
          <div class="repl-input-toolbar">
            <div class="repl-input-toolbar-left">
              <button
                class="repl-input-action-pill"
                onClick={togglePermissionMode}
                title={permissionMode === 'ask' ? '点击切换到完全允许模式' : '点击切换到询问模式'}
              >
                <IconShield />
                <span>{permissionMode === 'ask' ? 'Ask permissions' : 'Full access'}</span>
              </button>
              <button
                class="repl-input-add-btn"
                onClick={() => setAddMenuOpen(!addMenuOpen)}
                title="添加附件"
              >
                <IconPlus />
              </button>
            </div>
            <div class="repl-input-toolbar-right">
              <button
                class="repl-input-settings-pill"
                onClick={() => setSettingsOpen(!settingsOpen)}
                title={`模型: ${model || '未配置'} | 思考强度: ${effort}`}
              >
                <span class="settings-model-name">{model || '未配置'}</span>
                <span class={`settings-effort-dot ${effort.toLowerCase()}`} />
                <IconChevronDown />
              </button>
              {disabled ? (
                <>
                  <button class="repl-send-icon repl-send-icon-queue" id="btn-send" onClick={handleSend} title="加入待发送队列" aria-label="加入待发送队列">
                    <IconSend />
                  </button>
                  <button class="repl-send-icon repl-send-icon-cancel" id="btn-cancel" onClick={onCancel} title="取消运行" aria-label="取消运行">
                    <IconKill />
                  </button>
                </>
              ) : (
                <button class="repl-send-icon" id="btn-send" onClick={handleSend} title="发送消息" aria-label="发送消息">
                  <IconSend />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 添加菜单 - 放在输入框外部避免截断 */}
        {addMenuOpen && (
          <div class="repl-input-add-menu">
            <div class="repl-input-add-menu-item" onClick={() => { setAddMenuOpen(false); }}>
              <IconFileCode /> 添加文件
            </div>
            <div class="repl-input-add-menu-item" onClick={() => { setAddMenuOpen(false); }}>
              <IconFilePlus /> 添加图片
            </div>
            <div class="repl-input-add-menu-item" onClick={() => { setAddMenuOpen(false); }}>
              <IconFolderOpen /> 工作区文件
            </div>
          </div>
        )}

        {/* 设置面板 - 放在输入框外部避免截断 */}
        {settingsOpen && (
          <div class="repl-input-settings-panel">
            <div class="settings-panel-section">
              <div class="settings-panel-label">选择模型</div>
              <div class="settings-model-list">
                {INPUT_MODEL_OPTIONS.length === 0 && (
                  <div class="settings-model-empty">暂无可用模型</div>
                )}
                {INPUT_MODEL_OPTIONS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    class={`settings-model-item${model === m.id ? ' active' : ''}`}
                    onClick={() => setModel(m.id)}
                  >
                    <span class="model-item-name">{m.displayName || m.id}</span>
                    <span class="model-item-check"><IconCheck /></span>
                  </button>
                ))}
              </div>
            </div>
            <div class="settings-panel-section settings-effort-section">
              <div class="settings-panel-label">思考强度</div>
              <div class="settings-effort-row-compact">
                {(['Low', 'Medium', 'High'] as const).map(e => (
                  <button
                    key={e}
                    type="button"
                    class={`settings-effort-pill${e === effort ? ' active' : ''}`}
                    onClick={() => { setEffort(e); setSettingsOpen(false); }}
                  >
                    <span class={`settings-effort-dot-sm ${e.toLowerCase()}`} />
                    {e === 'Low' && '低'}
                    {e === 'Medium' && '中'}
                    {e === 'High' && '高'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
