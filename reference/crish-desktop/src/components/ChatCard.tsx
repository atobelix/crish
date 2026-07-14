import React, { useState, useEffect, useRef } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionMessage, FileDiff } from '../store/layoutStore';
import * as Lucide from 'lucide-react';
import { streamAssistantResponseApi } from '../api/chatApi';
import { piClientApi } from '../api/piClientApi';

// Helper to parse simple markdown to HTML (preserve the styling from CardPanel)
const parseMarkdownToHtml = (text: string): string => {
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  html = html.replace(/```(\w*)\n([\s\S]*?)\n```/g, (_, lang, code) => {
    return `<pre class="md-code-block"><code class="language-${lang}">${code.trim()}</code></pre>`;
  });
  
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  html = html.replace(/^(#{3,6})\s+(.+)$/gm, (_, hashes, content) => {
    const level = hashes.length;
    return `<h${level} class="md-h${level}">${content}</h${level}>`;
  });
  
  html = html.replace(/^>\s+\[!(NOTE|IMPORTANT|WARNING|TIP|CAUTION)\]\r?\n([\s\S]*?)(?=\r?\n\r?\n|\r?\n[^\s>])/g, (_, type, content) => {
    return `<div class="md-alert md-alert-${type.toLowerCase()}"><strong class="md-alert-title">${type}</strong><p class="md-alert-content">${content.trim().replace(/^>\s*/gm, '')}</p></div>`;
  });

  html = html.replace(/^---$/gm, '<hr class="md-hr" />');
  html = html.replace(/^(?:\s*)[-*]\s+\[ \]\s+(.+)$/gm, '<li class="md-li md-task-item"><input type="checkbox" disabled class="md-task-chk" /> $1</li>');
  html = html.replace(/^(?:\s*)[-*]\s+\[x\]\s+(.+)$/gm, '<li class="md-li md-task-item"><input type="checkbox" checked disabled class="md-task-chk" /> $1</li>');
  html = html.replace(/^(?:\s*)[-*]\s+(?!(?:\[ \]|\[x\]))\s*(.+)$/gm, '<li class="md-li">$1</li>');

  html = html.replace(/(<li class="md-li">[\s\S]*?<\/li>|<li class="md-li md-task-item">[\s\S]*?<\/li>)/g, (match) => {
    return `<ul class="md-ul">${match}</ul>`;
  });
  html = html.replace(/<\/ul>\s*<ul class="md-ul">/g, '');
  
  html = html.replace(/(?:^|\n)(\|[^\n]+\|\r?\n\|[^\n]+\|\r?\n(?:\|[^\n]+\|\r?\n?)+)/g, (match) => {
    const rows = match.trim().split('\n');
    const parsedRows = rows.map((row, index) => {
      const cells = row.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
      if (cells.every(c => /^:-*|-*:?|^-+$/.test(c))) {
        return '';
      }
      const isHeader = index === 0;
      const tag = isHeader ? 'th' : 'td';
      const innerHTML = cells.map(c => `<${tag} class="md-${tag}">${c}</${tag}>`).join('');
      return `<tr class="md-tr">${innerHTML}</tr>`;
    }).filter(Boolean).join('');
    return `<table class="md-table">${parsedRows}</table>`;
  });

  const blocks = html.split(/\n\n+/);
  html = blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('<pre') || trimmed.startsWith('<ul') || trimmed.startsWith('<h') || trimmed.startsWith('<table') || trimmed.startsWith('<div class="md-alert')) {
      return trimmed;
    }
    const formatted = trimmed.replace(/\n/g, '<br />');
    return `<p class="md-p">${formatted}</p>`;
  }).join('');
  
  return html;
};

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
    piSettings,
    setPiSettings,
    providers
  } = useLayoutStore();

  const getModelDisplayName = (modelId: string) => {
    if (!modelId) return '选择模型...';
    const map: Record<string, string> = {
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o Mini',
      'o1-pro': 'o1 Pro',
      'o1-mini': 'o1 Mini',
      'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
      'claude-3-5-haiku': 'Claude 3.5 Haiku',
      'gemini-1.5-pro': 'Gemini 1.5 Pro',
      'gemini-1.5-flash': 'Gemini 1.5 Flash',
      'gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)'
    };
    return map[modelId] || modelId;
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const messages = activeSession?.messages || [];

  // Scan active session messages for pending command approvals
  let pendingApprovalTc: any = null;
  let pendingApprovalMsgId = '';
  for (const m of messages) {
    if (m.toolCalls) {
      const found = m.toolCalls.find(tc => tc.status === 'pending_approval');
      if (found) {
        pendingApprovalTc = found;
        pendingApprovalMsgId = m.id;
        break;
      }
    }
  }

  const formatTime = (ts?: number) => {
    if (!ts) return '';
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [expandedUserMsgs, setExpandedUserMsgs] = useState<Record<string, boolean>>({});
  const [prVisible, setPrVisible] = useState(true);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelSelectorRef = useRef<HTMLDivElement>(null);

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
  const [goalActive, setGoalActive] = useState(true);

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

  // Auto-focus approval pill when a new approval request comes in
  useEffect(() => {
    if (pendingApprovalTc) {
      setActivePill('approval');
    } else {
      if (activePill === 'approval') {
        setActivePill(null);
      }
    }
  }, [pendingApprovalTc]);

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

  // Real-time AI response streaming helper
  const runStreamingAssistant = (input: string, userMsgId: string) => {
    const assistantMsgId = `assistant-msg-${Date.now()}`;
    const store = useLayoutStore.getState();
    const toolNames: Record<string, string> = {};
    const startTime = Date.now();

    setActiveDiffSource(null);

    store.addMessage(wsId, activeSessionId, {
      id: assistantMsgId,
      sender: 'assistant',
      text: '正在思考中...',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: []
    });

    streamAssistantResponseApi(input, {
      onThought: (thought) => {
        store.updateMessageText(activeSessionId, assistantMsgId, thought);
      },
      onToolStart: (toolId, name, args, explanation) => {
        toolNames[toolId] = name;
        store.addMessageToolCall(activeSessionId, assistantMsgId, {
          id: toolId,
          name,
          arguments: args,
          explanation,
          status: 'running'
        });

        if (name === 'run_command') {
          addTerminalLine(`\norange@Windows-PC MINGW64 /c/Software/conex`);
          addTerminalLine(`$ ${args}`);
        }
      },
      onToolPendingApproval: (toolId, name, args, explanation) => {
        toolNames[toolId] = name;
        store.addMessageToolCall(activeSessionId, assistantMsgId, {
          id: toolId,
          name,
          arguments: args,
          explanation,
          status: 'pending_approval'
        });

        if (name === 'run_command') {
          addTerminalLine(`\norange@Windows-PC MINGW64 /c/Software/conex`);
          addTerminalLine(`$ ${args}`);
        }
      },
      onTerminalLine: (line) => {
        addTerminalLine(line);
      },
      onToolSuccess: (toolId, output, diffs) => {
        store.updateMessageToolCall(activeSessionId, assistantMsgId, toolId, {
          status: 'success',
          output,
          diffs
        });

        const name = toolNames[toolId];
        if (name === 'run_command' && output) {
          output.split('\n').forEach(addTerminalLine);
        }

        if (diffs && diffs.length > 0) {
          setActiveDiffSource(diffs[0]);
          useLayoutStore.setState((state) => {
            const targetWs = state.workspaces.find((w) => w.id === wsId);
            if (targetWs) {
              for (const col of targetWs.columns) {
                for (const gp of col.groups) {
                  if (gp.cards.some(c => c.id === 'diff')) {
                    gp.activeCardId = 'diff';
                    break;
                  }
                }
              }
            }
          });
        }
      },
      onToolError: (toolId, error) => {
        store.updateMessageToolCall(activeSessionId, assistantMsgId, toolId, {
          status: 'error',
          output: error
        });
        addTerminalLine(`Error: ${error}`);
      },
      onChunk: (chunk) => {
        store.updateMessageText(activeSessionId, assistantMsgId, chunk);
      },
      onComplete: () => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        store.setSessionMessageStatus(activeSessionId, userMsgId, 'completed');
        store.setSessionMessageStatus(activeSessionId, assistantMsgId, 'completed', elapsed);
      }
    }, activeSessionId, assistantMsgId);
  };

  const handleSendChat = (isInsert: boolean = false) => {
    if (!chatInput.trim() || !activeSessionId) return;
    const input = chatInput.trim();
    setChatInput('');
    setSlashMenuOpen(false);

    const userMsgId = `user-msg-${Date.now()}`;
    const isAiBusy = messages.some(m => m.status === 'processing');

    useLayoutStore.setState((state) => {
      const sess = state.sessions.find(s => s.id === activeSessionId);
      if (sess && sess.messages) {
        const newMsg: SessionMessage = {
          id: userMsgId,
          sender: 'user',
          text: input,
          timestamp: Date.now(),
          status: isAiBusy ? 'queued' : 'processing'
        };

        if (isInsert && isAiBusy) {
          const processingIdx = sess.messages.findIndex(m => m.status === 'processing');
          if (processingIdx !== -1) {
            sess.messages.splice(processingIdx + 1, 0, newMsg);
          } else {
            sess.messages.push(newMsg);
          }
        } else {
          sess.messages.push(newMsg);
        }
      }
    });

    if (!isAiBusy) {
      runStreamingAssistant(input, userMsgId);
    } else {
      if (isInsert) {
        onShowToast('消息已插队，将在当前AI回复后优先执行');
      } else {
        onShowToast('消息已加入队列排队中');
      }
    }
  };

  const toggleTool = (toolId: string) => {
    setExpandedTools(prev => ({ ...prev, [toolId]: !prev[toolId] }));
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




  const renderToolCalls = (msg: SessionMessage) => {
    const toolCalls = (msg.toolCalls || []).filter(tc => tc.status !== 'pending_approval');
    if (toolCalls.length === 0) return null;

    return (
      <>
        {toolCalls.map((tc) => {
          const isToolExpanded = expandedTools[tc.id] ?? (tc.status === 'running');
          const statusIcon = tc.status === 'success' 
            ? <div className="tool-status-icon"><Lucide.CheckCircle2 size={11} style={{ color: 'var(--accent-green)' }} /></div> 
            : tc.status === 'error'
            ? <div className="tool-status-icon"><Lucide.XCircle size={11} style={{ color: 'var(--accent-red)' }} /></div>
            : <div className="tool-status-icon"><div className="loading-spinner" style={{ width: '10px', height: '10px', borderWidth: '1.5px' }} /></div>;

          return (
            <div className="tool-timeline-item" key={tc.id}>
              <div className="tool-timeline-item-header" onClick={() => toggleTool(tc.id)}>
                {statusIcon}
                <span style={{ color: 'var(--text-secondary)', fontWeight: 500, fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                  {tc.explanation || tc.arguments}
                </span>
                {isToolExpanded ? <Lucide.ChevronDown size={11} className="chevron-icon" /> : <Lucide.ChevronRight size={11} className="chevron-icon" />}
              </div>

              {isToolExpanded && (
                <div className="tool-timeline-item-body">
                  <div className="tool-command-inline">
                    <span className="prompt-char">$ </span>
                    {tc.name !== 'run_command' && <span className="cmd-name">{tc.name} </span>}
                    <span className="cmd-args">{tc.arguments}</span>
                  </div>

                  {tc.output && (
                    <div className="console-scroll-box" style={{ 
                      padding: '4px 0',
                      color: tc.status === 'success' ? '#16a34a' : tc.status === 'error' ? '#dc2626' : 'var(--text-secondary)', 
                      background: 'transparent', border: 'none',
                      fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: '1.5',
                      maxHeight: '200px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
                    }}>
                      {tc.output}
                    </div>
                  )}
                  {tc.diffs && tc.diffs.map(renderGitDiff)}
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  };

  const renderSingleToolCall = (_msg: SessionMessage, tc: any, key: any) => {
    const isToolExpanded = expandedTools[tc.id] ?? (tc.status === 'running' || tc.status === 'pending_approval');
    const statusIcon = tc.status === 'success' 
      ? <div className="tool-status-icon"><Lucide.CheckCircle2 size={11} style={{ color: 'var(--accent-green)' }} /></div> 
      : tc.status === 'error'
      ? <div className="tool-status-icon"><Lucide.XCircle size={11} style={{ color: 'var(--accent-red)' }} /></div>
      : <div className="tool-status-icon"><div className="loading-spinner" style={{ width: '10px', height: '10px', borderWidth: '1.5px' }} /></div>;

    // Don't render pending_approval in the conversation flow — only in the banner
    if (tc.status === 'pending_approval') return null;

    return (
      <div className="tool-timeline-item" key={key}>
        <div className="tool-timeline-item-header" onClick={() => toggleTool(tc.id)}>
          {statusIcon}
          <span style={{ color: 'var(--text-secondary)', fontWeight: 500, fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
            {tc.explanation || tc.arguments}
          </span>
          {isToolExpanded ? <Lucide.ChevronDown size={11} className="chevron-icon" /> : <Lucide.ChevronRight size={11} className="chevron-icon" />}
        </div>

        {isToolExpanded && (
          <div className="tool-timeline-item-body">
            <div className="tool-command-inline">
              <span className="prompt-char">$ </span>
              {tc.name !== 'run_command' && <span className="cmd-name">{tc.name} </span>}
              <span className="cmd-args">{tc.arguments}</span>
            </div>

            {tc.output && (
              <div className="console-scroll-box" style={{ 
                padding: '4px 0',
                color: tc.status === 'success' ? '#16a34a' : tc.status === 'error' ? '#dc2626' : 'var(--text-secondary)', 
                background: 'transparent', border: 'none',
                fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: '1.5',
                maxHeight: '200px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
              }}>
                {tc.output}
              </div>
            )}
            {tc.diffs && tc.diffs.map(renderGitDiff)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="chat-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {showScrollToBottom && (
        <button
          onClick={() => {
            userScrolledRef.current = false;
            setShowScrollToBottom(false);
            if (chatFlowRef.current) chatFlowRef.current.scrollTop = chatFlowRef.current.scrollHeight;
          }}
          style={{
            position: 'absolute', bottom: '8px', left: '50%', transform: 'translateX(-50%)',
            zIndex: 10, background: 'var(--bg-primary)', border: 'none',
            borderRadius: '12px', padding: '4px 12px', fontSize: '11px', color: 'var(--text-secondary)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
          }}
        >
          <Lucide.ChevronDown size={12} /><span>回到最新</span>
        </button>
      )}
      <div className="chat-doc-flow" ref={chatFlowRef} style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {messages.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '24px', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '48px', height: '48px', borderRadius: '12px', background: 'rgba(79, 70, 229, 0.08)', color: 'var(--accent-color)', marginBottom: '16px' }}>
              <Lucide.Cpu size={24} />
            </div>
            <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px 0' }}>开始使用 Conex Co-work Agent</h3>
            <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', textAlign: 'center', marginBottom: '24px', maxWidth: '320px' }}>
              智能体已准备就绪。选择下方快捷操作，或直接在输入框中输入命令开始开发。
            </p>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', width: '100%', maxWidth: '480px' }}>
              {[
                { icon: Lucide.SearchCode, label: '分析当前项目结构', prompt: '分析当前工作区项目结构，梳理核心依赖与潜在的代码统一性风险' },
                { icon: Lucide.GitBranch, label: '检查 Git 差异比对', prompt: '运行 git status 与 git diff，列出当前工作区修改的文件' },
                { icon: Lucide.Server, label: '查看 MCP 服务状态', prompt: '获取当前连接的所有的 Model Context Protocol (MCP) 服务及其工具列表' },
                { icon: Lucide.ShieldAlert, label: '检查已授权信任目录', prompt: '显示当前 Conex 信任的项目文件夹列表，并展示安全白名单配置' }
              ].map((item, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setChatInput(item.prompt);
                    const textInputEl = document.querySelector('.input-container textarea') as HTMLTextAreaElement;
                    if (textInputEl) textInputEl.focus();
                  }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    textAlign: 'left',
                    padding: '12px',
                    background: 'var(--bg-secondary)',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    gap: '6px'
                  }}
                  className="quick-prompt-card"
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-color)' }}>
                    <item.icon size={13} style={{ color: 'var(--accent-color)' }} />
                    <span style={{ fontSize: '11px', fontWeight: 600 }}>{item.label}</span>
                  </div>
                  <span style={{ fontSize: '9.5px', color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{item.prompt}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (() => {
          const lastAssistantMsgId = [...messages].reverse().find(m => m.sender === 'assistant')?.id;
          const thinkingMsgId = messages.find(m => m.sender === 'assistant' && m.status === 'processing')?.id;
          return messages.map((msg, index) => {
            const prevMsg = index > 0 ? messages[index - 1] : null;
            const nextMsg = index < messages.length - 1 ? messages[index + 1] : null;
            const isFollowUp = msg.sender === 'assistant' && prevMsg?.sender === 'assistant';
            const hasFollowUp = msg.sender === 'assistant' && nextMsg?.sender === 'assistant';
            if (msg.sender === 'user') {
              return (
                <div 
                  className="user-msg-container" 
                  key={msg.id}
                  onMouseLeave={() => {
                    if (expandedUserMsgs[msg.id]) {
                      setExpandedUserMsgs(prev => ({ ...prev, [msg.id]: false }));
                    }
                  }}
                >
                  <div 
                    className={`user-text-bubble ${expandedUserMsgs[msg.id] ? 'expanded' : ''}`}
                    onClick={() => {
                      const isLong = (msg.text || '').length > 260;
                      if (isLong) {
                        setExpandedUserMsgs(prev => ({ ...prev, [msg.id]: !expandedUserMsgs[msg.id] }));
                      }
                    }}
                    style={{ cursor: (msg.text || '').length > 260 ? 'pointer' : 'default' }}
                  >
                    {(() => {
                      const isLong = (msg.text || '').length > 260;
                      const isExpanded = !!expandedUserMsgs[msg.id];
                      const displayText = isLong && !isExpanded ? (msg.text || '').slice(0, 240) + '...' : msg.text;
                      return (
                        <span className="user-text-content" style={{ display: 'inline', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {displayText}
                        </span>
                      );
                    })()}
                    
                    <span className="bubble-meta-area" onClick={(e) => e.stopPropagation()}>
                      <span className="bubble-time">{formatTime(msg.timestamp)}</span>
                      
                      <span className="user-meta-actions">
                        <button className="meta-action-btn" title="复制" onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(msg.text || '');
                          onShowToast('已复制文本');
                        }}>
                          <Lucide.Copy size={10} />
                        </button>
                        <button className="meta-action-btn" title="撤回" onClick={(e) => {
                          e.stopPropagation();
                          setChatInput(msg.text || '');
                          withdrawMessage(wsId, activeSessionId, msg.id);
                          onShowToast('已撤回消息并填充至输入框');
                        }}>
                          <Lucide.Undo size={10} />
                        </button>
                      </span>

                      {/* Only show queued badge in bubble — processing is shown in sidebar spinner */}
                      {msg.status === 'queued' && (
                        <span className="msg-status-badge queued" style={{ fontSize: '9px', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', padding: '1px 4px', borderRadius: '3px', border: '1px solid #e5e5e5', marginLeft: '4px' }}>排队中</span>
                      )}
                    </span>
                  </div>
                </div>
              );
            } else {
              const isLastAssistantMsg = msg.id === lastAssistantMsgId;
              const isThinkingMsg = msg.id === thinkingMsgId;
              return (
                <div className="assistant-msg-container" key={msg.id} style={{ 
                  display: 'flex', flexDirection: 'column', gap: '2px', 
                  marginTop: isFollowUp ? '0px' : '8px',
                  marginBottom: hasFollowUp ? '0px' : '12px', 
                  alignItems: 'flex-start', width: '100%'
                }}>
                  {/* Thinking indicator shown above the message content */}
                  {isThinkingMsg && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                      <div className="loading-spinner" style={{ width: '9px', height: '9px', borderWidth: '1.5px', flexShrink: 0 }} />
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 500 }}>
                        正在思考 · {thinkingSeconds}s
                      </span>
                    </div>
                  )}
                  {!isThinkingMsg && msg.thinkingTime !== undefined && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                      <Lucide.CheckCircle2 size={10} style={{ color: 'var(--accent-green)' }} />
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 500 }}>
                        思考完成 · {msg.thinkingTime}秒
                      </span>
                    </div>
                  )}
                  <div className="assistant-text-bubble" style={{
                    alignSelf: 'flex-start', background: 'transparent', border: 'none',
                    padding: isFollowUp ? '0px 0 4px 0' : '4px 0 4px 0',
                    maxWidth: '100%', fontSize: '12.5px', lineHeight: '1.5',
                    color: 'var(--text-primary)', position: 'relative', width: '100%',
                    display: 'flex', flexDirection: 'column', gap: '6px'
                  }}>
                    {msg.blocks && msg.blocks.length > 0 ? (
                      msg.blocks.map((block, bIdx) => {
                        if (block.type === 'text') {
                          return (
                            <div 
                              key={bIdx}
                              className="assistant-text-content md-rendered"
                              dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(block.content || '') }}
                            />
                          );
                        } else {
                          const tc = msg.toolCalls?.find(t => t.id === block.id);
                          if (!tc) return null;
                          return renderSingleToolCall(msg, tc, bIdx);
                        }
                      })
                    ) : (
                      <>
                        {/* Skip the initial thinking placeholder text */}
                        {(msg.text && msg.text !== '正在思考中...') && (
                          <div 
                            className="assistant-text-content md-rendered"
                            dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(msg.text || '') }}
                          />
                        )}
                        {msg.toolCalls && msg.toolCalls.length > 0 && renderToolCalls(msg)}
                      </>
                    )}
                    
                    {isLastAssistantMsg && !isThinkingMsg && (
                      <div className="assistant-actions-row">
                        <span className="bubble-time">{formatTime(msg.timestamp)}</span>
                        <div className="assistant-meta-actions">
                          <button
                            className="meta-action-btn"
                            title="复制"
                            onClick={() => {
                              navigator.clipboard.writeText(msg.text || '');
                              onShowToast('已复制');
                            }}
                          >
                            <Lucide.Copy size={13} />
                          </button>
                          <button
                            className="meta-action-btn"
                            title="重新生成"
                            onClick={() => onShowToast('已请求重新生成')}
                          >
                            <Lucide.RefreshCw size={13} />
                          </button>
                          <button
                            className="meta-action-btn"
                            title="有帮助"
                            onClick={() => onShowToast('感谢反馈')}
                          >
                            <Lucide.ThumbsUp size={13} />
                          </button>
                          <button
                            className="meta-action-btn"
                            title="创建分支继续"
                            onClick={() => {
                              const newTitle = `${activeSession?.title || '会话'} - 分支`;
                              useLayoutStore.getState().branchSession(activeSessionId, newTitle);
                              onShowToast(`已创建分支：${newTitle}`);
                            }}
                          >
                            <Lucide.GitFork size={13} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            }
          });
        })()}
      </div>

      <div className="chat-footer">
        {/* Core status chips — minimal, expandable for details / right-panel deep dive */}
        <div className="chat-context-ribbon">
          {prVisible && (
            <button
              type="button"
              className={`context-pill git ${activePill === 'git' ? 'active' : ''}`}
              onClick={() => setActivePill(activePill === 'git' ? null : 'git')}
            >
              <Lucide.GitBranch size={12} />
              <span>分支 · schedule</span>
            </button>
          )}

          {pendingApprovalTc && (
            <button
              type="button"
              className={`context-pill approval ${activePill === 'approval' ? 'active' : ''}`}
              onClick={() => setActivePill(activePill === 'approval' ? null : 'approval')}
            >
              <Lucide.ShieldAlert size={12} />
              <span>待确认</span>
            </button>
          )}

          <button
            type="button"
            className={`context-pill server ${activePill === 'server' ? 'active' : ''}`}
            onClick={() => setActivePill(activePill === 'server' ? null : 'server')}
          >
            <Lucide.Globe size={12} />
            <span>本地预览</span>
          </button>

          {goalActive && (
            <button
              type="button"
              className={`context-pill goal ${activePill === 'goal' ? 'active' : ''} ${goalPaused ? 'paused' : ''}`}
              onClick={() => setActivePill(activePill === 'goal' ? null : 'goal')}
            >
              {goalPaused ? <Lucide.PauseCircle size={12} /> : <Lucide.Target size={12} />}
              <span>{goalPaused ? '目标已暂停' : '目标 45%'}</span>
            </button>
          )}
        </div>

        {activePill && (
          <div className="context-details-drawer">
            {activePill === 'git' && prVisible && (
              <div className="chat-input-overlay-banner pr-banner">
                <div className="pr-info" style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', minWidth: 0 }}>
                  <Lucide.GitBranch size={14} style={{ color: 'var(--accent-color)', flexShrink: 0 }} />
                  <span className="branch-text" style={{ fontSize: 12, fontWeight: 500 }} title="schedule-enhancements">
                    schedule-enhancements
                  </span>
                  <span className="pr-badge plus-minus">+16k −863</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => {
                      handleGlobalTabClick('diff');
                      setActivePill(null);
                      onShowToast('已在右侧打开变更对比');
                    }}
                  >
                    查看变更
                  </button>
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => {
                      setPrVisible(false);
                      setActivePill(null);
                      onShowToast('已创建 Pull Request');
                    }}
                  >
                    创建 PR
                  </button>
                  <button type="button" className="close-btn" onClick={() => setActivePill(null)}>
                    <Lucide.X size={14} />
                  </button>
                </div>
              </div>
            )}

            {activePill === 'approval' && pendingApprovalTc && (
              <div className="chat-input-overlay-banner approval-banner">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', minWidth: 0 }}>
                  <Lucide.ShieldAlert size={14} style={{ color: 'var(--accent-orange)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12 }}>
                    需要确认后执行：
                    <code>{pendingApprovalTc.arguments}</code>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  <button
                    type="button"
                    className="action-btn approve"
                    onClick={() => {
                      respondToApproval(wsId, activeSessionId, pendingApprovalMsgId, pendingApprovalTc.id, 'success');
                      setActivePill(null);
                      onShowToast('已批准并执行');
                    }}
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    className="action-btn reject"
                    onClick={() => {
                      respondToApproval(wsId, activeSessionId, pendingApprovalMsgId, pendingApprovalTc.id, 'error');
                      setActivePill(null);
                      onShowToast('已拒绝');
                    }}
                  >
                    拒绝
                  </button>
                </div>
              </div>
            )}

            {activePill === 'server' && (
              <div className="chat-input-overlay-banner server-banner">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                  <Lucide.Globe size={14} style={{ color: 'var(--accent-color)' }} />
                  <span style={{ fontSize: 12 }}>
                    本地服务运行中 <code>localhost:5174</code>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => {
                      handleGlobalTabClick('preview');
                      setActivePill(null);
                      onShowToast('已在右侧打开预览');
                    }}
                  >
                    打开预览
                  </button>
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => {
                      handleGlobalTabClick('terminal');
                      setActivePill(null);
                      onShowToast('已在右侧打开终端');
                    }}
                  >
                    打开终端
                  </button>
                  <button type="button" className="close-btn" onClick={() => setActivePill(null)}>
                    <Lucide.X size={14} />
                  </button>
                </div>
              </div>
            )}

            {activePill === 'goal' && goalActive && (
              <div className="drawer-expand-content goal-drawer-content" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>当前目标</span>
                    <span
                      className="ui-badge"
                      style={{
                        background: goalPaused ? 'var(--accent-orange-light)' : 'var(--accent-light)',
                        color: goalPaused ? '#c27803' : 'var(--accent-color)',
                      }}
                    >
                      {goalPaused ? '已暂停' : '进行中 · 45%'}
                    </span>
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
                      className="ui-btn ui-btn-ghost danger"
                      title="停止目标"
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
                      style={{ resize: 'none', minHeight: 56 }}
                      autoFocus
                    />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => setGoalEditMode(false)}>
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

                <div style={{ height: 4, background: 'var(--bg-tertiary)', borderRadius: 99, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: '45%',
                      background: goalPaused ? 'var(--accent-orange)' : 'var(--accent-color)',
                      borderRadius: 99,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)' }}>
                  <span>已运行 4h22m</span>
                  <span>预计剩余约 1 天</span>
                </div>
              </div>
            )}
          </div>
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
                  title="排队等待当前任务结束后发送"
                  onClick={() => handleSendChat(false)}
                >
                  <Lucide.ListOrdered size={13} />
                  <span>排队</span>
                </button>
                <button
                  type="button"
                  className="send-btn insert-btn"
                  title="优先发送"
                  onClick={() => handleSendChat(true)}
                >
                  <Lucide.Send size={13} />
                  <span>发送</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="send-btn"
                title="发送 (Enter)"
                onClick={() => handleSendChat(false)}
              >
                <Lucide.Send size={15} />
              </button>
            )}
          </div>
        </div>

        {/* Toolbar outside the input field */}
        <div className="footer-actions">
          <div className="left-actions">
            <div className="bypass-link" title="当前将跳过部分权限确认">
              <span className="orange-dot" />
              <span className="bypass-text">快捷模式</span>
            </div>
            <button type="button" className="plus-btn" title="添加文件">
              <Lucide.Paperclip size={14} />
            </button>
          </div>
          <div className="right-actions">
            <div
              ref={modelSelectorRef}
              className="model-badge"
              onClick={() => setShowModelDropdown((prev) => !prev)}
            >
              <Lucide.Sparkles size={13} style={{ color: 'var(--accent-color)' }} />
              <span className="model-text">
                {getModelDisplayName(piSettings?.defaultModel || 'gemini-1.5-flash')}
              </span>
              <Lucide.ChevronDown size={12} style={{ opacity: 0.55 }} />

              {showModelDropdown && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: '100%',
                    right: 0,
                    marginBottom: 8,
                    background: 'var(--bg-primary)',
                    borderRadius: 12,
                    boxShadow: 'var(--shadow-lg)',
                    zIndex: 20000,
                    width: 220,
                    maxHeight: 260,
                    overflowY: 'auto',
                    padding: 6,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {(providers.length > 0
                    ? providers
                    : [
                        { id: 'google', name: 'Google Gemini', models: ['gemini-1.5-pro', 'gemini-1.5-flash'] },
                        {
                          id: 'anthropic',
                          name: 'Anthropic Claude',
                          models: ['claude-3-5-sonnet', 'claude-3-5-haiku'],
                        },
                        { id: 'openai', name: 'OpenAI GPT', models: ['gpt-4o', 'gpt-4o-mini', 'o1-pro', 'o1-mini'] },
                      ]
                  ).map((p) => {
                    const validModels = p.models || [];
                    if (validModels.length === 0) return null;
                    return (
                      <div key={p.id} style={{ display: 'flex', flexDirection: 'column', padding: '2px 0' }}>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: 'var(--text-tertiary)',
                            padding: '6px 10px 4px',
                          }}
                        >
                          {p.name}
                        </div>
                        {validModels.map((m) => {
                          const isSelected = (piSettings?.defaultModel || 'gemini-1.5-flash') === m;
                          return (
                            <div
                              key={m}
                              onClick={async () => {
                                try {
                                  const updatedSettings = { ...piSettings, defaultModel: m, defaultProvider: p.id };
                                  await piClientApi.updateSettings(updatedSettings);
                                  setPiSettings(updatedSettings);
                                  setShowModelDropdown(false);
                                  onShowToast(`已切换模型为: ${getModelDisplayName(m)}`);
                                } catch (err) {
                                  onShowToast('切换模型失败：' + String(err));
                                }
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '5px 8px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '10.5px',
                                background: isSelected ? 'var(--bg-tertiary)' : 'transparent',
                                color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                                fontWeight: isSelected ? 600 : 'normal',
                                transition: 'background 0.1s'
                              }}
                              className="model-dropdown-item"
                            >
                              <span>{getModelDisplayName(m)}</span>
                              {isSelected && <Lucide.Check size={11} />}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
