import { useState, useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import { appState } from '../../core/app-state';
import { tauriBridge, type McpServerRecord, type MemoryRecord } from '../../core/tauri-bridge';
import { isBackendNotWiredResult } from '../../core/tauri-command-registry';
import { eventBus } from '../../core/event-bus';
import { warnBridgeDiagnostic, isCommandUsable } from './shared';
import {
  IconChevronDown, IconChevronRight, IconRefresh, IconSpinner, IconSend, IconTrash,
} from '../icons';

export type ToolsSubTab = 'mcp' | 'subagents' | 'memory';

export default function ToolsTab() {
  const [subTab, setSubTab] = useState<ToolsSubTab>('mcp');

  useEffect(() => {
    const unsub = eventBus.on('tools:switch-subtab', (tab: ToolsSubTab) => {
      setSubTab(tab);
    });
    return () => unsub();
  }, []);

  return (
    <div class="repl-rs-tab-content-inner">
      <div class="repl-rs-sub-tabs">
        <button class={`repl-rs-sub-tab ${subTab === 'mcp' ? 'active' : ''}`} onClick={() => setSubTab('mcp')}>MCP</button>
        <button class={`repl-rs-sub-tab ${subTab === 'subagents' ? 'active' : ''}`} onClick={() => setSubTab('subagents')}>子智能体</button>
        <button class={`repl-rs-sub-tab ${subTab === 'memory' ? 'active' : ''}`} onClick={() => setSubTab('memory')}>记忆</button>
      </div>
      {subTab === 'mcp' && <McpSubTab />}
      {subTab === 'subagents' && <SubagentsSubTab />}
      {subTab === 'memory' && <MemorySubTab />}
    </div>
  );
}

// ==================== Mcp Sub-Tab ====================

export function McpSubTab() {
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [operating, setOperating] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadServers();
  }, []);

  async function loadServers() {
    setLoading(true);
    try {
      const result = await tauriBridge.listMcpServers();
      if (isBackendNotWiredResult(result)) {
        setServers([]);
        return;
      }
      setServers(Array.isArray(result) ? result : []);
    } catch (error) {
      warnBridgeDiagnostic(error);
      setServers([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleStart(serverId: string) {
    setOperating(prev => ({ ...prev, [serverId]: true }));
    try {
      await tauriBridge.startMcpServer(serverId);
      await loadServers();
    } catch (error) {
      console.error('启动 MCP 服务器失败:', error);
    } finally {
      setOperating(prev => ({ ...prev, [serverId]: false }));
    }
  }

  async function handleStop(serverId: string) {
    setOperating(prev => ({ ...prev, [serverId]: true }));
    try {
      await tauriBridge.stopMcpServer(serverId);
      await loadServers();
    } catch (error) {
      console.error('停止 MCP 服务器失败:', error);
    } finally {
      setOperating(prev => ({ ...prev, [serverId]: false }));
    }
  }

  const statusLabel = (status: string) => {
    const map: Record<string, string> = {
      running: '运行中', ready: '就绪', starting: '启动中', degraded: '降级',
      stopped: '已停止', failed: '出错', discovering: '发现中', reconnecting: '重连中', unknown: '未知',
    };
    return map[status] ?? status;
  };

  const statusClass = (status: string) => {
    const map: Record<string, string> = {
      running: 'active', ready: 'active', starting: 'starting', degraded: 'degraded',
      stopped: 'stopped', failed: 'failed', discovering: 'starting', reconnecting: 'starting', unknown: 'unknown',
    };
    return map[status] ?? 'unknown';
  };

  return (
    <div class="repl-rs-section">
      <div class="repl-rs-section-header">
        <span class="repl-rs-section-title">MCP 服务</span>
        <button class="repl-rs-btn-sm" onClick={loadServers} disabled={loading}>
          <IconRefresh /> 刷新
        </button>
      </div>
      {loading ? (
        <div class="repl-rs-loading"><IconSpinner /> 加载中...</div>
      ) : (() => {
        if (servers.length === 0) {
          return (
            <div class="repl-rs-empty-inline">
              <span class="repl-rs-item-meta">暂无 MCP 服务</span>
            </div>
          );
        }
        return (
          <div class="repl-rs-mcp-list">
            {servers.map(srv => {
              const isOperating = operating[srv.id] ?? false;
              const isActive = ['running', 'ready'].includes(srv.status);
              return (
                <div key={srv.id} class={`repl-rs-mcp-card ${statusClass(srv.status)}`}>
                  <div class="repl-rs-mcp-header">
                    <span class={`repl-rs-mcp-status-dot ${statusClass(srv.status)}`} />
                    <span class="repl-rs-mcp-name">{srv.name}</span>
                    <span class={`repl-rs-mcp-status ${statusClass(srv.status)}`}>{statusLabel(srv.status)}</span>
                  </div>
                  <div class="repl-rs-mcp-meta">
                    {srv.toolCount != null && <span class="repl-rs-mcp-tools">{srv.toolCount} 工具</span>}
                    {srv.transport && <span class="repl-rs-mcp-transport">{srv.transport}</span>}
                  </div>
                  {srv.error && <div class="repl-rs-mcp-error"><span>出现错误，请尝试重启</span></div>}
                  <div class="repl-rs-mcp-actions">
                    {isActive ? (
                      <button class="repl-rs-btn-sm danger" onClick={() => void handleStop(srv.id)} disabled={isOperating}>停止</button>
                    ) : (
                      <button class="repl-rs-btn-sm primary" onClick={() => void handleStart(srv.id)} disabled={isOperating}>启动</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

// ==================== Subagents Sub-Tab ====================

function SubagentsSubTab() {
  const [subAgents, setSubAgents] = useState(appState.getState().subAgents);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [sendInput, setSendInput] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    return appState.subscribe('subAgents', setSubAgents);
  }, []);

  async function handleSendToAgent(agentId: string) {
    const message = sendInput[agentId]?.trim();
    if (!message) return;
    setSending(prev => ({ ...prev, [agentId]: true }));
    try {
      await tauriBridge.sendToSubagent(agentId, message);
      setSendInput(prev => ({ ...prev, [agentId]: '' }));
    } catch (error) {
      console.error('发送消息到子 Agent 失败:', error);
    } finally {
      setSending(prev => ({ ...prev, [agentId]: false }));
    }
  }

  return (
    <div class="repl-rs-section">
      <div class="repl-rs-section-header">
        <span class="repl-rs-section-title">子智能体</span>
        {subAgents.length > 0 && <span class="repl-rs-badge">{subAgents.length}</span>}
      </div>
      {subAgents.length === 0 ? (
        <div class="repl-rs-empty-inline">
          <span class="repl-rs-item-meta">暂无子智能体</span>
        </div>
      ) : (
        <div class="repl-rs-subagent-list">
          {subAgents.map(agent => {
            const isExpanded = expandedAgentId === agent.id;
            const isSending = sending[agent.id] ?? false;
            return (
              <div key={agent.id} class={`repl-rs-subagent-card ${agent.status}`}>
                <div class="repl-rs-subagent-header" onClick={() => setExpandedAgentId(isExpanded ? null : agent.id)}>
                  <span class={`repl-rs-subagent-dot ${agent.status}`} />
                  <span class="repl-rs-subagent-name">{agent.name}</span>
                  <span class="repl-rs-subagent-status">{agent.status === 'active' ? '运行中' : agent.status === 'done' ? '已完成' : '空闲'}</span>
                  <span class="repl-rs-subagent-expand">{isExpanded ? <IconChevronDown /> : <IconChevronRight />}</span>
                </div>
                {isExpanded && (
                  <div class="repl-rs-subagent-detail">
                    <div class="repl-rs-subagent-messages">
                      {agent.messages.slice(-5).map(msg => (
                        <div key={msg.id} class={`repl-rs-subagent-msg ${msg.role}`}>
                          <span class="repl-rs-subagent-msg-role">{msg.role === 'user' ? '用户' : 'AI'}</span>
                          <span class="repl-rs-subagent-msg-content">{msg.content.slice(0, 200)}{msg.content.length > 200 ? '...' : ''}</span>
                        </div>
                      ))}
                    </div>
                    {isCommandUsable('workbench_send_to_subagent') ? (
                      <div class="repl-rs-subagent-input">
                        <input
                          type="text"
                          placeholder="发送消息给子智能体..."
                          value={sendInput[agent.id] ?? ''}
                          onInput={(e) => setSendInput(prev => ({ ...prev, [agent.id]: (e.target as HTMLInputElement).value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') void handleSendToAgent(agent.id); }}
                          disabled={isSending}
                        />
                        <button class="repl-rs-btn-sm primary" onClick={() => void handleSendToAgent(agent.id)} disabled={isSending}>
                          {isSending ? <IconSpinner /> : <IconSend />}
                        </button>
                      </div>
                    ) : (
                      <div class="repl-rs-empty-inline">
                        <span class="repl-rs-item-meta">子智能体为只读观测 · 消息下发未接入</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== Memory Sub-Tab ====================

export function MemorySubTab() {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadMemories();
  }, []);

  async function loadMemories() {
    setLoading(true);
    try {
      const result = await tauriBridge.listMemories();
      if (isBackendNotWiredResult(result)) {
        setMemories([]);
        return;
      }
      setMemories(Array.isArray(result) ? result : []);
    } catch (error) {
      warnBridgeDiagnostic(error);
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(memoryId: string) {
    try {
      await tauriBridge.deleteMemory(memoryId);
      setMemories(prev => prev.filter(m => m.id !== memoryId));
    } catch (error) {
      console.error('删除记忆失败:', error);
    }
  }

  return (
    <div class="repl-rs-section">
      <div class="repl-rs-section-header">
        <span class="repl-rs-section-title">记忆</span>
        <button class="repl-rs-btn-sm" onClick={loadMemories} disabled={loading}>
          <IconRefresh /> 刷新
        </button>
      </div>
      {loading ? (
        <div class="repl-rs-loading"><IconSpinner /> 加载中...</div>
      ) : (() => {
        if (memories.length === 0) {
          return (
            <div class="repl-rs-empty-inline">
              <span class="repl-rs-item-meta">暂无记忆条目</span>
            </div>
          );
        }
        return (
          <div class="repl-rs-memory-list">
            {memories.map(m => (
              <div key={m.id} class="repl-rs-memory-item">
                <div class="repl-rs-memory-header">
                  <span class="repl-rs-memory-scope">{m.scope === 'user' ? '全局' : m.scope === 'project' ? '项目' : m.scope === 'session' ? '会话' : m.scope}</span>
                  {m.tags.slice(0, 3).map(t => <span key={t} class="repl-rs-badge">{t}</span>)}
                  {isCommandUsable('workbench_delete_memory') && (
                    <button class="repl-rs-btn-icon danger repl-rs-btn-icon-end" onClick={() => void handleDelete(m.id)}>
                      <IconTrash />
                    </button>
                  )}
                </div>
                <div class="repl-rs-memory-value">{m.content.slice(0, 200)}{m.content.length > 200 ? '...' : ''}</div>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}