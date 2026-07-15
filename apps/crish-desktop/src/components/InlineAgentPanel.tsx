/**
 * 主对话时间线内的协作 agent 块（像工具行一样嵌在流里，可展开）。
 */
import React, { useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import type { SessionAgent } from '../store/layoutStore';
import { useLayoutStore } from '../store/layoutStore';
import {
  buildAssistantTimeline,
  toolCommandPreview,
  toolResultPreview,
  toolSummaryLabel,
  truncateToolOutput,
} from '../api/toolPresentation';
import { parseMarkdownToHtml, stripThoughtPlaceholders } from '../api/markdownRender';
import { openAgentInNewWindow } from './AgentCard';
import {
  sendToSubagent,
  streamCollaboratorRun,
} from '../api/subagentApi';

interface InlineAgentPanelProps {
  agent: SessionAgent;
  parentSessionId: string;
  /** 默认折叠，运行中可默认展开 */
  defaultOpen?: boolean;
}

export const InlineAgentPanel: React.FC<InlineAgentPanelProps> = ({
  agent,
  parentSessionId,
  defaultOpen,
}) => {
  const [open, setOpen] = useState(Boolean(defaultOpen ?? agent.status === 'running'));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const setActiveAgentId = useLayoutStore((s) => s.setActiveAgentId);
  const setPanelAgentId = useLayoutStore((s) => s.setPanelAgentId);
  const patchSessionAgent = useLayoutStore((s) => s.patchSessionAgent);
  const appendSessionAgentMessage = useLayoutStore((s) => s.appendSessionAgentMessage);

  // 实时 agent 数据
  const live =
    useLayoutStore((s) =>
      s.sessions.find((x) => x.id === parentSessionId)?.agents?.find((a) => a.id === agent.id),
    ) || agent;

  useEffect(() => {
    if (live.status === 'running') setOpen(true);
  }, [live.status]);

  useEffect(() => {
    if (!open || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [open, live.messages?.length, live.status]);

  const statusLabel =
    live.status === 'running' ? '运行中' : live.status === 'failed' ? '失败' : '完成';

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    appendSessionAgentMessage(parentSessionId, live.id, {
      id: `iu-${Date.now().toString(36)}`,
      sender: 'user',
      text,
      timestamp: Date.now(),
      status: 'completed',
    });
    try {
      if (live.status === 'running' && live.subagentRunId) {
        const res = await sendToSubagent(live.subagentRunId, text);
        if (!res.ok || res.accepted === false) {
          // 降级新一轮
          startFollowUp(text);
        }
      } else {
        startFollowUp(text);
      }
    } finally {
      setSending(false);
    }
  };

  const startFollowUp = (text: string) => {
    patchSessionAgent(parentSessionId, live.id, { status: 'running' });
    const asstId = `ia-${Date.now().toString(36)}`;
    appendSessionAgentMessage(parentSessionId, live.id, {
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
        const ag = state.sessions
          .find((s) => s.id === parentSessionId)
          ?.agents?.find((a) => a.id === live.id);
        const m = ag?.messages?.find((x) => x.id === asstId);
        if (m) fn(m);
      });
    };
    streamCollaboratorRun(text, live.id, {
      onRunMeta: ({ runId }) => {
        patchSessionAgent(parentSessionId, live.id, { subagentRunId: runId, status: 'running' });
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
      onToolError: (toolId, err) => {
        patchAsst((m) => {
          const tc = m.toolCalls?.find((t) => t.id === toolId);
          if (tc) { tc.status = 'error'; tc.output = err || '失败'; }
        });
      },
      onComplete: () => {
        patchAsst((m) => {
          m.status = 'completed';
          if (m.thinking === '正在处理…') m.thinking = '';
        });
        patchSessionAgent(parentSessionId, live.id, { status: 'completed', endedAt: Date.now() });
      },
    });
  };

  return (
    <div className={`inline-agent ${open ? 'is-open' : ''} inline-agent--${live.status}`}>
      <button type="button" className="inline-agent-head" onClick={() => setOpen((v) => !v)}>
        {live.status === 'running' ? (
          <span className="tool-row-live" aria-hidden>
            <span className="loading-spinner" style={{ width: 8, height: 8, borderWidth: 1.5 }} />
          </span>
        ) : (
          <Lucide.Bot size={14} className="inline-agent-ico" />
        )}
        <span className="inline-agent-label">
          协作 · {live.description || live.mode || 'agent'}
        </span>
        <span className={`inline-agent-badge inline-agent-badge--${live.status}`}>{statusLabel}</span>
        {live.mode ? <span className="inline-agent-mode">{live.mode}</span> : null}
        <span className="inline-agent-meta">
          {(live.messages || []).length} 条
          {live.summary ? ` · ${live.summary.slice(0, 36)}` : ''}
        </span>
        <Lucide.ChevronRight size={14} className={`tool-row-chevron ${open ? 'rot' : ''}`} />
      </button>

      {open ? (
        <div className="inline-agent-body">
          <div className="inline-agent-toolbar">
            <button
              type="button"
              className="inline-agent-link"
              onClick={() => setActiveAgentId(live.id)}
            >
              全屏
            </button>
            <button
              type="button"
              className="inline-agent-link"
              onClick={() => {
                setPanelAgentId(live.id);
                window.dispatchEvent(
                  new CustomEvent('crish-open-agent-panel', { detail: { agentId: live.id } }),
                );
              }}
            >
              右侧
            </button>
            <button
              type="button"
              className="inline-agent-link"
              onClick={() => openAgentInNewWindow(live)}
            >
              新窗口
            </button>
          </div>

          <div className="inline-agent-stream" ref={bodyRef}>
            {(live.messages || []).length === 0 ? (
              <div className="inline-agent-empty">
                {live.status === 'running' ? '子 agent 执行中…' : '暂无消息'}
              </div>
            ) : (
              (live.messages || []).map((msg) => (
                <div key={msg.id} className={`inline-agent-msg inline-agent-msg--${msg.sender}`}>
                  {msg.sender === 'user' ? (
                    <div className="agent-prompt-bubble">{msg.text}</div>
                  ) : (
                    <>
                      {msg.thinking &&
                      msg.thinking.trim() &&
                      msg.thinking !== '正在处理…' &&
                      !looksLikeShellDump(msg.thinking) ? (
                        <details className="msg-thinking-fold">
                          <summary className="msg-thinking-fold-sum">
                            <span className="msg-thinking-fold-label">思考</span>
                          </summary>
                          <div className="msg-thinking-fold-body">{msg.thinking.slice(0, 3000)}</div>
                        </details>
                      ) : null}
                      {(() => {
                        const timeline = buildAssistantTimeline(msg);
                        if (!timeline.length && (msg.text || '').trim()) {
                          return (
                            <div
                              className="msg-assistant-text md-rendered"
                              dangerouslySetInnerHTML={{
                                __html: parseMarkdownToHtml(
                                  stripThoughtPlaceholders(msg.text || ''),
                                ),
                              }}
                            />
                          );
                        }
                        return timeline.map((item) => {
                          if (item.kind === 'text') {
                            const body = stripThoughtPlaceholders(item.content || '');
                            if (!body.trim()) return null;
                            return (
                              <div
                                key={item.key}
                                className="msg-assistant-text md-rendered"
                                dangerouslySetInnerHTML={{
                                  __html: parseMarkdownToHtml(body),
                                }}
                              />
                            );
                          }
                          return (
                            <div key={item.key} className="tool-stack">
                              {item.items.map((ti) => {
                                if (ti.kind === 'group') {
                                  return (
                                    <div key={ti.id} className="tool-row">
                                      <div className="tool-row-head tool-row-head--static">
                                        <span className="tool-row-summary">{ti.label}</span>
                                      </div>
                                    </div>
                                  );
                                }
                                const tc = ti.tc;
                                const out = truncateToolOutput(tc.output || '', 6, 600);
                                return (
                                  <div key={tc.id} className="tool-row">
                                    <div className="tool-row-head tool-row-head--static">
                                      <span className="tool-row-summary">
                                        {toolSummaryLabel(tc)}
                                      </span>
                                      {toolCommandPreview(tc) ? (
                                        <code className="tool-row-cmd">{toolCommandPreview(tc)}</code>
                                      ) : null}
                                      {toolResultPreview(tc) ? (
                                        <span className="tool-row-result-preview">
                                          {toolResultPreview(tc)}
                                        </span>
                                      ) : null}
                                    </div>
                                    {out ? (
                                      <div className="tool-result-body">
                                        <pre className="tool-result-pre">{out}</pre>
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        });
                      })()}
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          {/* 与主对话同风格的输入条 */}
          <div className="inline-agent-composer input-container">
            <textarea
              rows={1}
              placeholder={
                live.status === 'running'
                  ? '向子 agent 补充指示…'
                  : '继续向该 agent 发消息…'
              }
              value={input}
              disabled={sending}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (isComposing) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="send-btn"
              disabled={!input.trim() || sending}
              onClick={() => void handleSend()}
            >
              <Lucide.CornerDownLeft size={16} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

/** 避免把 shell 表格拉进「思考」折叠 */
function looksLikeShellDump(s: string): boolean {
  return (
    /FullName|LastWriteTime|Mode\s+Length|----/.test(s) ||
    (/^[A-Za-z]:\\/.test(s.trim()) && s.includes('\n') && s.split('\n').length > 4)
  );
}
