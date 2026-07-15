/**
 * 协作 agent 查看面板：与主对话相同的时间线渲染（只读）。
 */
import React from 'react';
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

interface AgentCardProps {
  agentId?: string | null;
  /** 紧凑模式（嵌在对话顶栏下） */
  embedded?: boolean;
  onClose?: () => void;
  onOpenRight?: () => void;
  onOpenWindow?: () => void;
}

export const AgentCard: React.FC<AgentCardProps> = ({
  agentId,
  embedded,
  onClose,
  onOpenRight,
  onOpenWindow,
}) => {
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const panelAgentId = useLayoutStore((s) => s.panelAgentId);
  const id = agentId ?? panelAgentId;
  const sess = sessions.find((s) => s.id === activeSessionId);
  const agent =
    sess?.agents?.find((a) => a.id === id) ||
    sessions.flatMap((s) => s.agents || []).find((a) => a.id === id);

  if (!agent) {
    return (
      <div className="agent-card agent-card--empty">
        <Lucide.Bot size={22} style={{ opacity: 0.35 }} />
        <p>选择一个协作 agent 查看时间线</p>
      </div>
    );
  }

  return (
    <div className={`agent-card ${embedded ? 'agent-card--embedded' : ''}`}>
      <header className="agent-card-header">
        <div className="agent-card-title-row">
          <Lucide.Bot size={14} />
          <span className="agent-card-title" title={agent.description}>
            {agent.description || '协作 agent'}
          </span>
          <span className={`agent-card-badge agent-card-badge--${agent.status}`}>
            {agent.status === 'running'
              ? '运行中'
              : agent.status === 'failed'
                ? '失败'
                : '已完成'}
          </span>
          {agent.mode ? <span className="agent-card-mode">{agent.mode}</span> : null}
        </div>
        <div className="agent-card-actions">
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
      {agent.summary ? (
        <div className="agent-card-summary">{agent.summary}</div>
      ) : null}
      <div className="agent-card-body">
        {(agent.messages || []).length === 0 ? (
          <div className="agent-card-empty-msgs">
            {agent.status === 'running' ? '协作 agent 处理中…' : '暂无消息'}
          </div>
        ) : (
          agent.messages.map((msg) => <AgentMessageRow key={msg.id} msg={msg} />)
        )}
      </div>
    </div>
  );
};

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
      </div>
    </div>
  );
}

/** 新窗口打开 agent 只读页（同会话渲染，不依赖路由） */
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
