/**
 * ToolCallCard - 工具调用卡片组件
 *
 * 包含分组折叠的工具调用块、单个工具调用项、文件编辑行。
 */

import { useState, useMemo } from 'preact/hooks';
import type { ToolCall, ChangedFile } from '../../core/app-state';
import { groupToolCalls, approvalRiskLabel, approvalRiskTitle, toolInputSummary, type ToolCallGroup } from './utils';
import { truncatePath } from '../utils';
import {
  IconChevronRight,
  IconSpinner,
  IconTerminal,
  IconFileCode,
  IconFilePlus,
  IconFileMinus,
  IconFolder,
  IconInfo,
} from '../icons';

// ==================== GroupIcon ====================

function GroupIcon({ icon }: { icon: ToolCallGroup['icon'] }) {
  switch (icon) {
    case 'file-edit': return <IconFileCode />;
    case 'search': return <IconFolder />;
    case 'terminal': return <IconTerminal />;
    case 'network': return <IconInfo />;
    default: return <IconTerminal />;
  }
}

// ==================== FileEditRow ====================

function FileEditRow({ file, onClick }: { file: ChangedFile; onClick: () => void }) {
  const fileName = file.path.split(/[\\/]/).pop() || file.path;
  const dirPath = file.path.split(/[\\/]/).slice(0, -1).join('/');
  return (
    <div class="repl-file-edit-row" onClick={onClick}>
      <div class="repl-file-edit-row-left">
        <span class="repl-file-edit-row-icon">
          {file.status === 'created' ? <IconFilePlus /> : file.status === 'deleted' ? <IconFileMinus /> : <IconFileCode />}
        </span>
        <span class="repl-file-edit-row-path">{fileName}</span>
        {dirPath && <span class="repl-file-edit-dir">{truncatePath(dirPath, 30)}</span>}
      </div>
      <div class="repl-file-edit-row-changes">
        {file.addedLines > 0 && <span class="repl-file-edit-add">+{file.addedLines}</span>}
        {file.removedLines > 0 && <span class="repl-file-edit-del">-{file.removedLines}</span>}
      </div>
    </div>
  );
}

// ==================== ToolCallItem ====================

export function ToolCallItem({ tool, expanded, onToggle }: { tool: ToolCall; expanded: boolean; onToggle: () => void }) {
  const inputSummary = useMemo(() => toolInputSummary(tool), [tool.input, tool.name]);
  const riskTitle = approvalRiskTitle(tool);
  const hasOutput = tool.output != null && tool.output !== '';
  const failed = tool.status === 'failed';
  const running = tool.status === 'running' || tool.status === 'pending';

  return (
    <div class={`repl-chat-tool-cmd-row${failed ? ' failed' : ''}`}>
      <div class="repl-chat-tool-cmd-header" onClick={onToggle}>
        <span class="repl-chat-tool-cmd-name">{tool.name}</span>
        {inputSummary && <span class="repl-chat-tool-cmd-input" title={inputSummary}>{inputSummary}</span>}
        {tool.riskLevel && tool.riskLevel !== 'low' && (
          <span class={`repl-chat-tool-risk-badge ${tool.riskLevel}`} title={riskTitle}>
            {tool.riskLevel === 'high' ? '!' : tool.riskLevel === 'unknown' ? '?' : '~'}
          </span>
        )}
        {running && <span class="repl-chat-tool-cmd-spin spin-icon"><IconSpinner /></span>}
        {hasOutput && <span class={`repl-chat-tool-cmd-arrow${expanded ? ' expanded' : ''}`}><IconChevronRight /></span>}
      </div>
      {hasOutput && (
        <div class={`repl-chat-tool-cmd-output${expanded ? '' : ' collapsed'}`}>
          <pre><code>{typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}</code></pre>
        </div>
      )}
    </div>
  );
}

// ==================== ToolCallBlock ====================

export function ToolCallBlock({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>({});
  const [cmdExpanded, setCmdExpanded] = useState<Set<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);

  const groups = useMemo(() => groupToolCalls(toolCalls), [toolCalls]);

  if (!toolCalls || toolCalls.length === 0) return null;

  const toggleGroup = (key: string) => setGroupExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  const toggleCmd = (id: string) => {
    setCmdExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (allExpanded) { setGroupExpanded({}); setCmdExpanded(new Set()); }
    else {
      const expanded: Record<string, boolean> = {};
      groups.forEach(g => { expanded[g.key] = true; });
      setGroupExpanded(expanded);
      setCmdExpanded(new Set(toolCalls.map(tc => tc.id)));
    }
    setAllExpanded(!allExpanded);
  };

  if (groups.length === 1) {
    const group = groups[0];
    const isExpanded = groupExpanded[group.key] !== false;
    return (
      <div class="repl-chat-tool-group">
        <div class="repl-chat-tool-header" onClick={() => toggleGroup(group.key)}>
          <div class="repl-chat-tool-title">
            <GroupIcon icon={group.icon} />
            <span>{group.label}</span>
            {group.toolCalls.length > 1 && <span class="repl-chat-tool-count-badge">x{group.toolCalls.length}</span>}
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
                {group.toolCalls.length > 1 && <span class="repl-chat-tool-count-badge">x{group.toolCalls.length}</span>}
                <span class="repl-chat-tool-summary">{group.summary}</span>
                {hasRunning && <span class="repl-chat-tool-group-status running"><span class="spin-icon"><IconSpinner /></span></span>}
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

export { approvalRiskLabel, approvalRiskTitle }; // re-export for ApprovalDeck