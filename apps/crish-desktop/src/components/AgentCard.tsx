/**
 * 协作 agent 面板：时间线 + 可交互输入（运行中 steer / 结束后新 run 续聊）。
 */
import React, { useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionAgent, SessionMessage } from '../store/layoutStore';
import {
  buildAssistantTimeline,
  toolCommandPreview,
  toolResultPreview,
  toolSummaryLabel,
  truncateToolOutput,
} from '../api/toolPresentation';
import { parseMarkdownToHtml, stripThoughtPlaceholders } from '../api/markdownRender';
import {
  getSubagentStatus,
  sendToSubagent,
  streamCollaboratorRun,
} from '../api/subagentApi';
import { getWorkspacePath } from '../api/projectStore';

interface AgentCardProps {
  agentId?: string | null;
  /** 所属主会话；缺省取 activeSessionId */
  parentSessionId?: string | null;
  embedded?: boolean;
  onClose?: () => void;
  onOpenRight?: () => void;
  onOpenWindow?: () => void;
}

export const AgentCard: React.FC<AgentCardProps> = ({
  agentId,
  parentSessionId,
  embedded,
  onClose,
  onOpenRight,
  onOpenWindow,
}) => {
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const panelAgentId = useLayoutStore((s) => s.panelAgentId);
  const patchSessionAgent = useLayoutStore((s) => s.patchSessionAgent);
  const appendSessionAgentMessage = useLayoutStore((s) => s.appendSessionAgentMessage);

  const id = agentId ?? panelAgentId;
  const parentId = parentSessionId || activeSessionId;
  const sess =
    sessions.find((s) => s.id === parentId) ||
    sessions.find((s) => s.agents?.some((a) => a.id === id));
  const agent =
    sess?.agents?.find((a) => a.id === id) ||
    sessions.flatMap((s) => s.agents || []).find((a) => a.id === id);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const followUpCancelRef = useRef<null | (() => void)>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 自动滚到底
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [agent?.messages?.length, agent?.status, agent?.summary]);

  // 运行中轮询 daemon 状态（兜底 UI）
  useEffect(() => {
    if (!agent || agent.status !== 'running' || !agent.subagentRunId) return;
    const poll = async () => {
      const st = await getSubagentStatus(agent.subagentRunId);
      if (!st || !sess) return;
      if (st.status && st.status !== 'running' && st.status !== 'unknown') {
        // 仅当仍显示 running 时纠正
        const live = useLayoutStore
          .getState()
          .sessions.find((s) => s.id === sess.id)
          ?.agents?.find((a) => a.id === agent.id);
        if (live?.status === 'running' && /complete|success|failed|cancel|error/i.test(st.status)) {
          patchSessionAgent(sess.id, agent.id, {
            status: /fail|error|cancel/i.test(st.status) ? 'failed' : 'completed',
            endedAt: Date.now(),
            summary: live.summary || st.latestError || st.progress,
          });
        }
      }
    };
    void poll();
    statusPollRef.current = setInterval(() => void poll(), 4000);
    return () => {
      if (statusPollRef.current) clearInterval(statusPollRef.current);
    };
  }, [agent?.id, agent?.status, agent?.subagentRunId, sess?.id, patchSessionAgent]);

  useEffect(() => {
    return () => {
      followUpCancelRef.current?.();
    };
  }, []);

  if (!agent || !sess) {
    return (
      <div className="agent-card agent-card--empty">
        <Lucide.Bot size={22} style={{ opacity: 0.35 }} />
        <p>选择一个协作 agent 查看时间线</p>
        <p className="agent-card-empty-hint">
          主对话中模型调用 run_subagent，或点击「拉起协作者」即可创建
        </p>
      </div>
    );
  }

  const parentSessId = sess.id;
  const running = agent.status === 'running';
  const canSend = input.trim().length > 0 && !sending;

  const applyLocalUserMessage = (text: string) => {
    appendSessionAgentMessage(parentSessId, agent.id, {
      id: `agent-user-${Date.now().toString(36)}`,
      sender: 'user',
      text,
      timestamp: Date.now(),
      status: 'completed',
    });
  };

  /** 运行中：steer；已结束：新 run 续聊（同 agent session 恢复历史） */
  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSendError('');
    setSending(true);
    setInput('');

    try {
      if (running && agent.subagentRunId) {
        applyLocalUserMessage(text);
        const res = await sendToSubagent(agent.subagentRunId, text);
        if (!res.ok) {
          setSendError(res.error || '发送失败');
          // 若 run 已结束，降级为 follow-up run
          if (/not|unknown|unsupported|活跃|active/i.test(res.error || '') || res.accepted === false) {
            await startFollowUpRun(text);
          }
        } else if (res.accepted === false) {
          setSendError('当前无法注入消息（可能已结束），改为新一轮续聊…');
          await startFollowUpRun(text);
        }
      } else {
        applyLocalUserMessage(text);
        await startFollowUpRun(text);
      }
    } finally {
      setSending(false);
    }
  };

  const startFollowUpRun = (text: string): Promise<void> => {
    return new Promise((resolve) => {
      followUpCancelRef.current?.();
      patchSessionAgent(parentSessId, agent.id, { status: 'running' });

      // 用 subagent 自己的 session 续历史；若无独立 session 则用 agent.id
      const agentSessionId = agent.id;
      let asstId = `agent-asst-${Date.now().toString(36)}`;
      let localRunId: string | null = null;

      appendSessionAgentMessage(parentSessId, agent.id, {
        id: asstId,
        sender: 'assistant',
        text: '',
        thinking: '正在处理…',
        timestamp: Date.now(),
        status: 'processing',
        toolCalls: [],
        blocks: [],
      });

      const patchAsst = (fn: (m: SessionMessage) => void) => {
        useLayoutStore.setState((state) => {
          const s = state.sessions.find((x) => x.id === parentSessId);
          const ag = s?.agents?.find((a) => a.id === agent.id);
          const m = ag?.messages?.find((x) => x.id === asstId);
          if (m) fn(m);
        });
      };

      const cancel = streamCollaboratorRun(text, agentSessionId, {
        onRunMeta: ({ runId }) => {
          localRunId = runId;
          patchSessionAgent(parentSessId, agent.id, {
            subagentRunId: runId,
            status: 'running',
          });
        },
        onThought: (thought) => {
          patchAsst((m) => {
            m.thinking = thought;
          });
        },
        onChunk: (chunk) => {
          patchAsst((m) => {
            m.text = chunk;
            if (m.thinking === '正在处理…') m.thinking = '';
          });
        },
        onToolStart: (toolId, name, args, explanation) => {
          patchAsst((m) => {
            if (!m.toolCalls) m.toolCalls = [];
            if (!m.blocks) m.blocks = [];
            if (!m.toolCalls.some((t) => t.id === toolId)) {
              m.toolCalls.push({
                id: toolId,
                name,
                arguments: args,
                explanation,
                status: 'running',
              });
              m.blocks.push({ type: 'tool_call', id: toolId });
            }
          });
        },
        onToolSuccess: (toolId, output) => {
          patchAsst((m) => {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (tc) {
              tc.status = 'success';
              tc.output = output || '完成';
            }
          });
        },
        onToolError: (toolId, error) => {
          patchAsst((m) => {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (tc) {
              tc.status = 'error';
              tc.output = error || '失败';
            }
          });
        },
        onToolPendingApproval: (toolId, name, args, explanation) => {
          patchAsst((m) => {
            if (!m.toolCalls) m.toolCalls = [];
            const existing = m.toolCalls.find((t) => t.id === toolId);
            if (existing) {
              existing.status = 'pending_approval';
              existing.arguments = args || existing.arguments;
            } else {
              m.toolCalls.push({
                id: toolId,
                name,
                arguments: args,
                explanation,
                status: 'pending_approval',
              });
            }
          });
        },
        onApprovalResolved: (toolId, decision) => {
          patchAsst((m) => {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (!tc) return;
            if (decision === 'allow') {
              tc.status = 'running';
              tc.output = '执行中…';
            } else {
              tc.status = 'error';
              tc.output = '未获批准';
            }
          });
        },
        onSubagentEvent: () => {
          /* 嵌套子 agent 暂不展开 */
        },
        onComplete: () => {
          patchAsst((m) => {
            m.status = 'completed';
            if (m.thinking === '正在处理…') m.thinking = '';
          });
          patchSessionAgent(parentSessId, agent.id, {
            status: 'completed',
            endedAt: Date.now(),
            ...(localRunId ? { subagentRunId: localRunId } : {}),
          });
          followUpCancelRef.current = null;
          resolve();
        },
      });

      followUpCancelRef.current = cancel;
      void getWorkspacePath(); // 确保 cwd 已由主会话设定
    });
  };

  const handleStop = () => {
    followUpCancelRef.current?.();
    followUpCancelRef.current = null;
    if (agent.subagentRunId) {
      void getDesktopCancel(agent.subagentRunId);
    }
    patchSessionAgent(parentSessId, agent.id, {
      status: 'failed',
      summary: agent.summary || '已停止',
      endedAt: Date.now(),
    });
  };

  return (
    <div className={`agent-card ${embedded ? 'agent-card--embedded' : ''}`}>
      <header className="agent-card-header">
        <div className="agent-card-title-row">
          <Lucide.Bot size={14} />
          <span className="agent-card-title" title={agent.description}>
            {agent.description || '协作 agent'}
          </span>
          <span className={`agent-card-badge agent-card-badge--${agent.status}`}>
            {running ? '运行中' : agent.status === 'failed' ? '已停止/失败' : '已完成'}
          </span>
          {agent.mode ? <span className="agent-card-mode">{agent.mode}</span> : null}
        </div>
        <div className="agent-card-actions">
          {running ? (
            <button
              type="button"
              className="agent-card-btn agent-card-btn--danger"
              title="停止"
              onClick={handleStop}
            >
              <Lucide.Square size={12} fill="currentColor" />
            </button>
          ) : null}
          {onOpenRight ? (
            <button type="button" className="agent-card-btn" title="在右侧打开" onClick={onOpenRight}>
              <Lucide.PanelRight size={13} />
            </button>
          ) : null}
          {onOpenWindow ? (
            <button type="button" className="agent-card-btn" title="新窗口" onClick={onOpenWindow}>
              <Lucide.ExternalLink size={13} />
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className="agent-card-btn" title="关闭" onClick={onClose}>
              <Lucide.X size={13} />
            </button>
          ) : null}
        </div>
      </header>

      {agent.summary ? <div className="agent-card-summary">{agent.summary}</div> : null}

      <div className="agent-card-body" ref={bodyRef}>
        {(agent.messages || []).length === 0 ? (
          <div className="agent-card-empty-msgs">
            {running ? (
              <>
                <span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                <span>协作 agent 处理中…可在下方补充指示</span>
              </>
            ) : (
              <span>暂无消息。输入任务开始续聊。</span>
            )}
          </div>
        ) : (
          agent.messages.map((msg) => <AgentMessageRow key={msg.id} msg={msg} />)
        )}
      </div>

      <div className="agent-card-input-bar">
        {sendError ? <div className="agent-card-send-error">{sendError}</div> : null}
        <div className="agent-card-input-row">
          <textarea
            className="agent-card-textarea"
            rows={1}
            placeholder={
              running
                ? '向运行中的 agent 补充指示（Enter 发送）…'
                : '继续向该 agent 发消息（将开启新一轮）…'
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
          />
          <button
            type="button"
            className="agent-card-send"
            disabled={!canSend}
            onClick={() => void handleSend()}
            title="发送"
          >
            {sending ? (
              <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
            ) : (
              <Lucide.Send size={14} />
            )}
          </button>
        </div>
        <div className="agent-card-input-hint">
          {running
            ? '运行中：消息会注入当前回合（steer）'
            : '已结束：发送将基于该 agent 历史开启新一轮'}
          {getWorkspacePath() ? ` · ${shortPath(getWorkspacePath()!)}` : ''}
        </div>
      </div>
    </div>
  );
};

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/') || p;
}

async function getDesktopCancel(runId: string): Promise<void> {
  try {
    const { getDesktopDaemonClient } = await import('../api/daemonClient');
    const client = getDesktopDaemonClient();
    await client.send({ type: 'cancel-run', runId });
  } catch {
    /* ignore */
  }
}

function AgentMessageRow({ msg }: { msg: SessionMessage }) {
  if (msg.sender === 'user') {
    return (
      <div className="msg-row msg-row-user agent-msg">
        <div className="msg-user-bubble">{msg.text}</div>
      </div>
    );
  }
  const timeline = buildAssistantTimeline(msg);
  return (
    <div className="msg-row msg-row-assistant agent-msg">
      {msg.thinking && msg.thinking.trim() && msg.thinking !== '正在处理…' ? (
        <details className="msg-thinking-fold">
          <summary className="msg-thinking-fold-sum">
            <span className="msg-thinking-fold-label">思考</span>
          </summary>
          <div className="msg-thinking-fold-body">{msg.thinking.slice(0, 4000)}</div>
        </details>
      ) : null}
      <div className="msg-assistant-body">
        {timeline.length === 0 && (msg.text || '').trim() ? (
          <div
            className="msg-assistant-text md-rendered"
            dangerouslySetInnerHTML={{
              __html: parseMarkdownToHtml(stripThoughtPlaceholders(msg.text || '')),
            }}
          />
        ) : null}
        {timeline.map((item) => {
          if (item.kind === 'text') {
            const body = stripThoughtPlaceholders(item.content || '');
            if (!body.trim()) return null;
            return (
              <div
                key={item.key}
                className="msg-assistant-text md-rendered"
                dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(body) }}
              />
            );
          }
          return (
            <div key={item.key} className="tool-stack agent-tool-stack">
              {item.items.map((ti) => {
                if (ti.kind === 'group') {
                  return (
                    <div key={ti.id} className="tool-row tool-row-group">
                      <div className="tool-row-head tool-row-head--static">
                        <span className="tool-row-summary">{ti.label}</span>
                      </div>
                    </div>
                  );
                }
                const tc = ti.tc;
                const summary = toolSummaryLabel(tc);
                const cmd = toolCommandPreview(tc);
                const preview = toolResultPreview(tc);
                const out = truncateToolOutput(tc.output || '', 8, 800);
                return (
                  <div key={tc.id} className="tool-row">
                    <div className="tool-row-head tool-row-head--static">
                      <span className="tool-row-summary">{summary}</span>
                      {cmd ? <code className="tool-row-cmd">{cmd}</code> : null}
                      {preview ? (
                        <span className="tool-row-result-preview">{preview}</span>
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
        })}
        {msg.status === 'processing' && !(msg.text || '').trim() ? (
          <div className="agent-msg-live">
            <span className="loading-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
            生成中…
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 新窗口打开 agent 只读快照 */
export function openAgentInNewWindow(agent: SessionAgent): void {
  const w = window.open('', '_blank', 'noopener,noreferrer,width=720,height=900');
  if (!w) return;
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const lines: string[] = [];
  lines.push(`<h1>${esc(agent.description || '协作 agent')}</h1>`);
  lines.push(
    `<p class="meta">${esc(agent.mode)} · ${esc(agent.status)}${
      agent.summary ? ' · ' + esc(agent.summary) : ''
    }</p>`,
  );
  for (const m of agent.messages || []) {
    if (m.sender === 'user') {
      lines.push(`<div class="u">${esc(m.text || '')}</div>`);
    } else {
      lines.push(`<div class="a">${esc(m.text || '')}</div>`);
      for (const tc of m.toolCalls || []) {
        lines.push(
          `<div class="t"><b>${esc(tc.name)}</b> ${esc(tc.status)}<pre>${esc(
            (tc.output || '').slice(0, 2000),
          )}</pre></div>`,
        );
      }
    }
  }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"/><title>${esc(
    agent.description || 'agent',
  )}</title>
<style>
body{font-family:system-ui,sans-serif;padding:20px;max-width:720px;margin:0 auto;color:#222;background:#fafafa}
h1{font-size:18px;margin:0 0 8px}.meta{color:#888;font-size:12px;margin:0 0 20px}
.u{background:#e8eef8;padding:10px 12px;border-radius:12px;margin:10px 0 10px auto;max-width:85%;width:fit-content}
.a{background:#fff;border:1px solid #eee;padding:10px 12px;border-radius:12px;margin:10px 0;white-space:pre-wrap}
.t{font-size:12px;color:#666;margin:6px 0 6px 8px}pre{white-space:pre-wrap;font-size:11px;background:#f4f4f5;padding:8px;border-radius:6px}
</style></head><body>${lines.join('\n')}</body></html>`);
  w.document.close();
}

