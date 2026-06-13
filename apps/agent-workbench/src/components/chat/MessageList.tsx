/**
 * MessageList - 消息列表组件
 *
 * 包含消息渲染、工具调用分组、文件编辑行、运行状态条等。
 */

import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { appState, type ChatMessage, type ToolCall, type ChangedFile } from '../../core/app-state';
import { eventBus, Events } from '../../core/event-bus';
import { MarkdownRenderer, CodeBlockCopyButton, ActionLinkHandler } from '../MarkdownRenderer';
import { ThinkingBlock } from './ThinkingBlock';
import { FileEditSummary } from './FileEditSummary';
import { DiagnosticBlock as DaemonErrorBlock } from './DiagnosticBlock';
import { UserMessageEditor } from './UserMessageEditor';
import { SubagentBar } from './SubAgentBar';
import { CompactionSummaryCard, type CompactionSummaryData } from './CompactionSummaryCard';
import {
  isFileEditTool,
  isFileModifyingTool,
  FILE_MODIFYING_TOOLS,
} from './utils';
import { timelineItemsFromRuntimeProjectionMessages } from '../../core/runtime-event-projector';
import { formatTime, truncatePath } from '../utils';
import {
  removeChatMessages,
  updateChatMessage,
  truncateChatMessages,
} from '../../core/message-pipeline';
import { showToast } from '../ToastContainer';
import {
  IconCopy,
  IconFolder,
  IconTerminal,
  IconFileCode,
  IconFilePlus,
  IconFileMinus,
  IconChevronRight,
  IconSpinner,
  IconInfo,
  IconCheck,
  IconEdit,
  IconTrash,
  IconX,
  IconRevert,
  IconMoreVertical,
  IconBot,
} from '../icons';

interface ToolCallGroup {
  key: string;
  label: string;
  icon: 'file-edit' | 'search' | 'terminal' | 'network' | 'other';
  toolCalls: ToolCall[];
  summary: string;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function categorizeTool(name: string): ToolCallGroup['icon'] {
  if (FILE_MODIFYING_TOOLS.has(name) || isFileEditTool(name)) return 'file-edit';
  if (['search', 'grep', 'find', 'glob', 'list_directory', 'read_file', 'read_multiple_files'].includes(name)) return 'search';
  if (['bash', 'shell', 'exec', 'run_command'].includes(name)) return 'terminal';
  if (['fetch', 'curl', 'wget', 'http_request'].includes(name)) return 'network';
  return 'other';
}

function groupToolCalls(toolCalls: ToolCall[]): ToolCallGroup[] {
  if (!toolCalls || toolCalls.length === 0) return [];

  const groups: ToolCallGroup[] = [];
  let currentGroup: ToolCallGroup | null = null;

  for (const tc of toolCalls) {
    const category = categorizeTool(tc.name);
    const groupKey = `${category}-${tc.name}`;

    // 同类同名的工具合并为一组
    if (currentGroup && currentGroup.key === groupKey) {
      currentGroup.toolCalls.push(tc);
    } else {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = {
        key: groupKey,
        label: tc.name,
        icon: category,
        toolCalls: [tc],
        summary: '',
      };
    }
  }
  if (currentGroup) groups.push(currentGroup);

  // 生成每组摘要
  for (const group of groups) {
    group.summary = buildGroupSummary(group);
  }

  return groups;
}

function buildGroupSummary(group: ToolCallGroup): string {
  const { icon, toolCalls } = group;
  const count = toolCalls.length;

  if (icon === 'file-edit') {
    const paths = toolCalls
      .map(tc => {
        const input = tc.input;
        if (typeof input === 'object' && input !== null) {
          return input.file_path || input.path || input.filePath || null;
        }
        return null;
      })
      .filter(Boolean) as string[];

    if (paths.length > 0) {
      const uniquePaths = [...new Set(paths)];
      if (uniquePaths.length === 1) {
        return uniquePaths[0]!.split(/[\\/]/).pop()!;
      }
      return `${uniquePaths.length} 个文件`;
    }
    return `${count} 次文件编辑`;
  }

  if (icon === 'search') {
    return `${count} 次搜索`;
  }

  if (icon === 'terminal') {
    const commands = toolCalls
      .map(tc => {
        const input = tc.input;
        if (typeof input === 'object' && input !== null) {
          return input.command || input.cmd || null;
        }
        if (typeof input === 'string') {
          return input.length > 40 ? input.slice(0, 40) + '...' : input;
        }
        return null;
      })
      .filter(Boolean) as string[];

    if (commands.length === 1) {
      return commands[0]!.length > 50 ? commands[0]!.slice(0, 50) + '...' : commands[0]!;
    }
    return `${count} 条命令`;
  }

  if (icon === 'network') {
    return `${count} 次网络请求`;
  }

  return `${count} 次调用`;
}

function GroupIcon({ icon }: { icon: ToolCallGroup['icon'] }) {
  switch (icon) {
    case 'file-edit': return <IconFileCode />;
    case 'search': return <IconFolder />;
    case 'terminal': return <IconTerminal />;
    case 'network': return <IconInfo />;
    default: return <IconTerminal />;
  }
}

// ==================== ToolCallBlock 组件（分组折叠） ====================

function ToolCallBlock({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>({});
  const [cmdExpanded, setCmdExpanded] = useState<Set<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);

  const groups = useMemo(() => groupToolCalls(toolCalls), [toolCalls]);

  if (!toolCalls || toolCalls.length === 0) return null;

  const toggleGroup = (key: string) => {
    setGroupExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleCmd = (id: string) => {
    setCmdExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allExpanded) {
      setGroupExpanded({});
      setCmdExpanded(new Set());
    } else {
      const expanded: Record<string, boolean> = {};
      groups.forEach(g => { expanded[g.key] = true; });
      setGroupExpanded(expanded);
      setCmdExpanded(new Set(toolCalls.map(tc => tc.id)));
    }
    setAllExpanded(!allExpanded);
  };

  // 单组时默认折叠
  if (groups.length === 1) {
    const group = groups[0];
    const isExpanded = groupExpanded[group.key] === true;
    return (
      <div class="repl-chat-tool-group">
        <div class="repl-chat-tool-header" onClick={() => toggleGroup(group.key)}>
          <div class="repl-chat-tool-title">
            <GroupIcon icon={group.icon} />
            <span>{group.label}</span>
            {group.toolCalls.length > 1 && (
              <span class="repl-chat-tool-count-badge">x{group.toolCalls.length}</span>
            )}
            <span class="repl-chat-tool-summary">{group.summary}</span>
          </div>
          <span class={`repl-chat-tool-arrow${isExpanded ? ' expanded' : ''}`}><IconChevronRight /></span>
        </div>
        <div class={`repl-chat-tool-body${isExpanded ? '' : ' collapsed'}`}>
          {group.toolCalls.map(tool => (
            <ToolCallItem key={tool.id} tool={tool} expanded={cmdExpanded.has(tool.id)} onToggle={() => toggleCmd(tool.id)} />
          ))}
        </div>
      </div>
    );
  }

  // 多组时折叠显示
  return (
    <div class="repl-chat-tool-group-container">
      <div class="repl-chat-tool-group-header">
        <div class="repl-chat-tool-group-title">
          <IconTerminal />
          <span>{toolCalls.length} 次工具调用</span>
        </div>
        <button class="repl-chat-tool-toggle-all" onClick={toggleAll}>
          {allExpanded ? '全部折叠' : '全部展开'}
        </button>
      </div>
      {groups.map(group => {
        const isExpanded = groupExpanded[group.key] ?? false;
        const hasRunning = group.toolCalls.some(tc => tc.status === 'running' || tc.status === 'pending');

        return (
          <div class="repl-chat-tool-group" key={group.key}>
            <div class="repl-chat-tool-header" onClick={() => toggleGroup(group.key)}>
              <div class="repl-chat-tool-title">
                <GroupIcon icon={group.icon} />
                <span>{group.label}</span>
                {group.toolCalls.length > 1 && (
                  <span class="repl-chat-tool-count-badge">x{group.toolCalls.length}</span>
                )}
                <span class="repl-chat-tool-summary">{group.summary}</span>
                {hasRunning && (
                  <span class="repl-chat-tool-group-status running"><span class="spin-icon"><IconSpinner /></span></span>
                )}
              </div>
              <span class={`repl-chat-tool-arrow${isExpanded ? ' expanded' : ''}`}><IconChevronRight /></span>
            </div>
            <div class={`repl-chat-tool-body${isExpanded ? '' : ' collapsed'}`}>
              {group.toolCalls.map(tool => (
                <ToolCallItem key={tool.id} tool={tool} expanded={cmdExpanded.has(tool.id)} onToggle={() => toggleCmd(tool.id)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== 单个工具调用项 ====================

function approvalRiskLabel(level?: string): string {
  const map: Record<string, string> = {
    low: '低风险',
    medium: '中风险',
    high: '高风险',
    unknown: '未知风险',
  };
  return map[level ?? ''] ?? '未知风险';
}

function approvalRiskTitle(tool: Pick<ToolCall, 'riskLevel' | 'riskDetail' | 'riskRule' | 'riskSource'>): string {
  if (tool.riskDetail) return tool.riskDetail;
  if (tool.riskRule) return tool.riskRule;
  if (tool.riskSource === 'unknown' || tool.riskLevel === 'unknown') return '后端未提供风险元数据';
  return approvalRiskLabel(tool.riskLevel);
}

// 把工具入参压成一行内联摘要，跟在工具名后面（命令 / 查询 / 路径等）
function toolInputSummary(tool: ToolCall): string {
  const input = tool.input;
  if (input == null) return '';
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim();
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.cmd ?? o.query ?? o.pattern ?? o.url ?? o.path ?? o.file_path ?? o.filePath;
    if (typeof pick === 'string' && pick.trim()) {
      const s = pick.replace(/\s+/g, ' ').trim();
      return s.length > 160 ? s.slice(0, 159) + '…' : s;
    }
    try {
      const s = JSON.stringify(input);
      return s.length > 120 ? s.slice(0, 119) + '…' : s;
    } catch {
      return '';
    }
  }
  return String(input);
}

function ToolCallItem({ tool, expanded, onToggle }: { tool: ToolCall; expanded: boolean; onToggle: () => void }) {
  const inputSummary = useMemo(() => toolInputSummary(tool), [tool.input, tool.name]);
  const riskTitle = approvalRiskTitle(tool);
  const hasOutput = tool.output != null && tool.output !== '';
  const failed = tool.status === 'failed';
  const running = tool.status === 'running' || tool.status === 'pending';

  return (
    <div class={`repl-chat-tool-cmd-row${failed ? ' failed' : ''}`}>
      <div class="repl-chat-tool-cmd-header" onClick={onToggle}>
        <span class="repl-chat-tool-cmd-name">{tool.name}</span>
        {inputSummary && (
          <span class="repl-chat-tool-cmd-input" title={inputSummary}>{inputSummary}</span>
        )}
        {tool.riskLevel && tool.riskLevel !== 'low' && (
          <span class={`repl-chat-tool-risk-badge ${tool.riskLevel}`} title={riskTitle}>
            {tool.riskLevel === 'high' ? '!' : tool.riskLevel === 'unknown' ? '?' : '~'}
          </span>
        )}
        {running && <span class="repl-chat-tool-cmd-spin spin-icon"><IconSpinner /></span>}
        {hasOutput && (
          <span class={`repl-chat-tool-cmd-arrow${expanded ? ' expanded' : ''}`}><IconChevronRight /></span>
        )}
      </div>
      {hasOutput && (
        <div class={`repl-chat-tool-cmd-output${expanded ? '' : ' collapsed'}`}>
          <pre><code>{typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}</code></pre>
        </div>
      )}
    </div>
  );
}

// ==================== FileEditRow 组件 ====================

function FileEditRow({ file, onClick }: { file: ChangedFile; onClick: () => void }) {
  const fileName = file.path.split(/[\\/]/).pop() || file.path;
  const dirPath = file.path.split(/[\\/]/).slice(0, -1).join('/');

  return (
    <div
      class="repl-file-edit-row"
      onClick={onClick}
    >
      <div class="repl-file-edit-row-left">
        <span class="repl-file-edit-row-icon">
          {file.status === 'created' ? <IconFilePlus /> : file.status === 'deleted' ? <IconFileMinus /> : <IconFileCode />}
        </span>
        <span class="repl-file-edit-row-path">
          {fileName}
        </span>
        {dirPath && (
          <span class="repl-file-edit-dir">
            {truncatePath(dirPath, 30)}
          </span>
        )}
      </div>
      <div class="repl-file-edit-row-changes">
        {file.addedLines > 0 && <span class="repl-file-edit-add">+{file.addedLines}</span>}
        {file.removedLines > 0 && <span class="repl-file-edit-del">-{file.removedLines}</span>}
      </div>
    </div>
  );
}

// ==================== MessageList 组件 ====================

export function MessageList({
  sessionId,
  messages,
  onSendFromSuggestion,
}: {
  sessionId?: string | null;
  messages: ChatMessage[];
  onSendFromSuggestion?: (text: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [workingDirectory, setWorkingDirectory] = useState(appState.getState().workingDirectory);
  const [changedFiles, setChangedFiles] = useState(appState.getState().changedFiles);
  const [isStreaming, setIsStreaming] = useState(appState.getState().isStreaming);
  const [activeRunId, setActiveRunId] = useState(appState.getState().activeRunId);
  const [activeRunSessionId, setActiveRunSessionId] = useState(appState.getState().activeRunSessionId);
  const [daemonStatus, setDaemonStatus] = useState(appState.getState().daemonStatus);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [msgMoreOpen, setMsgMoreOpen] = useState<{ id: string; x: number; y: number } | null>(null);

  // 点击外部关闭消息More菜单
  useEffect(() => {
    if (!msgMoreOpen) return;
    const close = () => setMsgMoreOpen(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [msgMoreOpen]);

  useEffect(() => {
    const u1 = appState.subscribe('workingDirectory', setWorkingDirectory);
    const u2 = appState.subscribe('changedFiles', setChangedFiles);
    const u3 = appState.subscribe('isStreaming', setIsStreaming);
    const u4 = appState.subscribe('activeRunId', setActiveRunId);
    const u5 = appState.subscribe('activeRunSessionId', setActiveRunSessionId);
    const u6 = appState.subscribe('daemonStatus', setDaemonStatus);
    return () => { u1(); u2(); u3(); u4(); u5(); u6(); };
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      showToast('复制失败', 'error', 4500);
    }
  };

  const undoMessage = (msgId: string) => {
    const sess = appState.getState().currentSession;
    if (sess) {
      const updated = removeChatMessages(sess.messages, msgId);
      if (updated.length !== sess.messages.length) {
        appState.setState('currentSession', { ...sess, messages: updated, updatedAt: Date.now() });
      }
    }
  };

  // 编辑用户消息并重发
  const handleEditAndResend = (msgId: string, newText: string) => {
    const sess = appState.getState().currentSession;
    if (!sess) return;

    // 更新消息内容并截断后续消息（模拟"重发"）
    const updated = updateChatMessage(sess.messages, msgId, { content: newText, timestamp: Date.now() });
    const truncated = truncateChatMessages(updated, msgId);
    appState.setState('currentSession', { ...sess, messages: truncated, updatedAt: Date.now() });

    // 退出编辑模式
    setEditingMsgId(null);

    // 触发重新发送
    eventBus.emit(Events.MESSAGE_SENT, newText);
  };

  // 判断是否为最后一条用户消息
  const getLastUserMsgId = (): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return null;
  };

  // 判断是否为最后一条 AI 消息（用于显示建议回复）
  const getLastAssistantMsgId = (): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && !messages[i].streaming) return messages[i].id;
    }
    return null;
  };

  // 判断 AI 消息是否包含文件编辑
  const hasFileEdits = (msg: ChatMessage): boolean => {
    return msg.role === 'assistant' && msg.toolCalls?.some(tc => tc.status === 'completed' && isFileEditTool(tc.name)) === true;
  };

  const handleFileClick = (filePath: string) => {
    appState.openRightTab('project');
    appState.setState('rightSidebarVisible', true);
    eventBus.emit('explorer:open-file', filePath);
  };

  const handleSuggestionSend = (text: string) => {
    if (onSendFromSuggestion) {
      onSendFromSuggestion(text);
    } else {
      eventBus.emit(Events.MESSAGE_SENT, text);
    }
  };

  // 空状态：简洁提示
  if (messages.length === 0) {
    return (
      <div class="repl-chat-messages-scroll-area" id="chat-messages" ref={containerRef}>
        <div class="repl-chat-empty">
          <div class="repl-chat-empty-icon"><IconBot /></div>
          <p class="repl-chat-empty-hint">有什么可以帮你的？</p>
          <p class="repl-chat-empty-sub">输入问题，AI 助手将为你解答</p>
        </div>
      </div>
    );
  }

  const lastAssistantMsgId = getLastAssistantMsgId();
  const lastUserMsgId = getLastUserMsgId();
  const timelineItems = useMemo(
    () => sessionId ? appState.getSessionTimeline(sessionId) : timelineItemsFromRuntimeProjectionMessages(messages),
    [messages, sessionId]
  );
  const session = sessionId ? appState.getSession(sessionId) : null;
  const sessionActiveRunId = session?.activeRunId ?? (activeRunSessionId === sessionId ? activeRunId : null);
  const sessionIsStreaming = Boolean(sessionId && isStreaming && activeRunSessionId === sessionId && sessionActiveRunId);
  const showStreamPlaceholder = sessionIsStreaming && !timelineItems.some(item => item.kind === 'message' && item.message.streaming);

  return (
    <div class="repl-chat-messages-scroll-area" id="chat-messages" ref={containerRef}>
      {sessionActiveRunId && (
        <ChatRunStatusStrip
          runId={sessionActiveRunId}
          isStreaming={sessionIsStreaming}
          daemonStatus={typeof daemonStatus?.statusText === 'string' ? daemonStatus.statusText : undefined}
        />
      )}
      {timelineItems.map(item => {
        if (item.kind === 'diagnostic') {
          return (
            <div
              key={item.id}
              class="repl-chat-msg-row system"
              data-message-id={item.sourceMessage.id}
            >
              <DaemonErrorBlock title={item.diagnostic.title} content={item.diagnostic.content} />
            </div>
          );
        }

        const msg = item.message as ChatMessage;
        const isThinking = msg.role === 'assistant' && msg.content.startsWith('[思考]');
        const isSystem = msg.role === 'system';
        const interventionActions = isSystem ? (msg as any)._interventionActions : null;
        const isLastUserMsg = lastUserMsgId === msg.id;
        const isLastAssistantMsg = lastAssistantMsgId === msg.id;
        const isEditing = editingMsgId === msg.id;
        const showFileEditSummary = isLastAssistantMsg && hasFileEdits(msg) && !msg.streaming;

        return (
          <div
            key={item.id}
            class={`repl-chat-msg-row ${msg.role === 'assistant' ? 'agent' : msg.role}`}
            data-message-id={msg.id}
          >
            {isSystem ? (
              <div class="repl-chat-msg-bubble">
                {msg.systemType === 'compression' && msg.compactionData && (msg.compactionData as Record<string, unknown>).compactionId ? (
                  <CompactionSummaryCard
                    data={msg.compactionData as unknown as CompactionSummaryData}
                  />
                ) : (
                  <>
                    <span>{msg.content}</span>
                    {interventionActions && (
                      <div class="repl-intervention-actions">
                        <button class="repl-chat-msg-tool-btn" onClick={interventionActions.rollback}>回滚</button>
                        <button class="repl-chat-msg-tool-btn" onClick={interventionActions.pause}>暂停</button>
                        <button class="repl-chat-msg-tool-btn" onClick={interventionActions.userInstruction}>用户指令</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : msg.role === 'assistant' ? (
              <>
                <div class="repl-chat-msg-bubble">
                  {isThinking ? (
                    <ThinkingBlock content={msg.content} />
                  ) : (
                    <MarkdownRenderer content={msg.content} streaming={msg.streaming} />
                  )}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <ToolCallBlock toolCalls={msg.toolCalls} />
                  )}
                </div>
                {/* 文件编辑总览 */}
                {showFileEditSummary && (
                  <FileEditSummary
                    changedFiles={changedFiles}
                    onFileClick={handleFileClick}
                  />
                )}
                {!msg.streaming && (
                  <div class="repl-chat-msg-tools">
                    <button class="repl-chat-msg-tool-btn" onClick={() => copyToClipboard(msg.content)} title="复制">
                      <IconCopy />
                    </button>
                    <div class="repl-msg-more-wrap">
                      <button class="repl-chat-msg-tool-btn" onClick={(e) => { e.stopPropagation(); const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMsgMoreOpen(msgMoreOpen?.id === msg.id ? null : { id: msg.id, x: rect.left, y: rect.bottom + 4 }); }} title="更多">
                        <IconMoreVertical />
                      </button>
                      {msgMoreOpen?.id === msg.id && (
                        <div class="repl-context-menu repl-msg-more-menu" style={{ position: 'fixed', left: `${msgMoreOpen.x}px`, top: `${msgMoreOpen.y}px` }} onClick={(e) => e.stopPropagation()}>
                          <div class="repl-context-menu-item" onClick={() => { copyToClipboard(msg.content); setMsgMoreOpen(null); }}>
                            <IconCopy /> 复制
                          </div>
                          <div class="repl-context-menu-item" onClick={() => { setMsgMoreOpen(null); }}>
                            <IconEdit /> 重新生成
                          </div>
                          <div class="repl-context-menu-divider" />
                          <div class="repl-context-menu-item danger" onClick={() => { setMsgMoreOpen(null); }}>
                            <IconX /> 删除
                          </div>
                        </div>
                      )}
                    </div>
                    <span class="repl-chat-msg-time">{formatTime(msg.timestamp)}</span>
                  </div>
                )}
              </>
            ) : (
              <div class="repl-chat-msg-user-wrap">
                <div class="repl-chat-msg-tools reverse">
                  <button class="repl-chat-msg-tool-btn" onClick={() => setEditingMsgId(isEditing ? null : msg.id)} title="编辑">
                    <IconEdit />
                  </button>
                  {isLastUserMsg && (
                    <button class="repl-chat-msg-tool-btn" onClick={() => undoMessage(msg.id)} title="撤回">
                      <IconRevert />
                    </button>
                  )}
                  <button class="repl-chat-msg-tool-btn" onClick={() => copyToClipboard(msg.content)} title="复制">
                    <IconCopy />
                  </button>
                  <div class="repl-msg-more-wrap">
                    <button class="repl-chat-msg-tool-btn" onClick={(e) => { e.stopPropagation(); const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMsgMoreOpen(msgMoreOpen?.id === msg.id ? null : { id: msg.id, x: rect.right - 180, y: rect.bottom + 4 }); }} title="更多">
                      <IconMoreVertical />
                    </button>
                    {msgMoreOpen?.id === msg.id && (
                      <div class="repl-context-menu repl-msg-more-menu" style={{ position: 'fixed', left: `${msgMoreOpen.x}px`, top: `${msgMoreOpen.y}px` }} onClick={(e) => e.stopPropagation()}>
                        <div class="repl-context-menu-item" onClick={() => { copyToClipboard(msg.content); setMsgMoreOpen(null); }}>
                          <IconCopy /> 复制
                        </div>
                        <div class="repl-context-menu-item" onClick={() => { setEditingMsgId(msg.id); setMsgMoreOpen(null); }}>
                          <IconEdit /> 编辑
                        </div>
                        {isLastUserMsg && (
                          <div class="repl-context-menu-item" onClick={() => { undoMessage(msg.id); setMsgMoreOpen(null); }}>
                            <IconRevert /> 撤回
                          </div>
                        )}
                        <div class="repl-context-menu-divider" />
                        <div class="repl-context-menu-item danger" onClick={() => { setMsgMoreOpen(null); }}>
                          <IconX /> 删除
                        </div>
                      </div>
                    )}
                  </div>
                  <span class="repl-chat-msg-time">{formatTime(msg.timestamp)}</span>
                </div>
                {isEditing ? (
                  <UserMessageEditor
                    initialText={msg.content}
                    onSave={(newText) => handleEditAndResend(msg.id, newText)}
                    onCancel={() => setEditingMsgId(null)}
                  />
                ) : (
                  <div class="repl-chat-msg-bubble">
                    <span>{msg.content}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {showStreamPlaceholder && <StreamingPlaceholder />}
    </div>
  );
}


function ChatRunStatusStrip({
  runId,
  isStreaming,
  daemonStatus,
}: {
  runId: string;
  isStreaming: boolean;
  daemonStatus?: string;
}) {
  const [snapshot, setSnapshot] = useState(appState.getState().taskSnapshot);
  useEffect(() => appState.subscribe('taskSnapshot', setSnapshot), []);

  const rawPct = snapshot?.completionPercent;
  const pct = typeof rawPct === 'number' ? Math.max(0, Math.min(100, Math.round(rawPct))) : null;
  const budget = snapshot?.tokenBudget;
  const usedTokens = budget?.usedTotalTokens;
  const cacheTokens = budget?.cacheReadTokens;

  return (
    <div class="repl-chat-run-strip">
      {isStreaming ? <span class="spin-icon"><IconSpinner /></span> : <IconCheck />}
      <span class="repl-chat-run-strip-main">{isStreaming ? '正在生成' : '运行已同步'}</span>
      {snapshot?.progressLabel ? (
        <span class="repl-chat-run-strip-meta">{snapshot.progressLabel}</span>
      ) : null}
      {pct != null && pct > 0 ? (
        <span class="repl-chat-run-strip-meta repl-chat-pct-wrap">
          <span class="repl-chat-pct-bar">
            <span class="repl-chat-pct-fill" style={{ width: `${pct}%` }} />
          </span>
          {pct}%
        </span>
      ) : null}
      {typeof usedTokens === 'number' && usedTokens > 0 ? (
        <span class="repl-chat-run-strip-meta">
          {formatTokenCount(usedTokens)} tokens{typeof cacheTokens === 'number' && cacheTokens > 0 ? ` · 缓存 ${formatTokenCount(cacheTokens)}` : ''}
        </span>
      ) : null}
      <span class="repl-chat-run-strip-meta">{daemonStatus || shortRunId(runId)}</span>
    </div>
  );
}

function StreamingPlaceholder() {
  return (
    <div class="repl-chat-msg-row agent">
      <div class="repl-chat-stream-placeholder">
        <div class="repl-chat-stream-head">
          <span class="spin-icon"><IconSpinner /></span>
          <span>等待首条内容</span>
        </div>
        <div class="repl-chat-stream-lines">
          <span class="repl-skeleton-text medium" />
          <span class="repl-skeleton-text short" />
        </div>
      </div>
    </div>
  );
}

function shortRunId(id: string): string {
  return id.length > 10 ? id.slice(-10) : id;
}