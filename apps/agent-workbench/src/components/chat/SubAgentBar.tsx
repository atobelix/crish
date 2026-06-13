/**
 * SubAgentBar - 子 Agent 状态栏组件
 *
 * 展示活跃的子 Agent（以 pill 形式），点击可打开对话弹窗。
 */

import { useState, useEffect } from 'preact/hooks';
import type { ChatMessage, SubAgent } from '../../core/app-state';
import { appState } from '../../core/app-state';
import { tauriBridge } from '../../core/tauri-bridge';
import { reduceChatMessages } from '../../core/message-pipeline';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { IconBot, IconMaximize, IconX, IconSend } from '../icons';
import { showToast } from '../ToastContainer';

function SubagentPill({ agent, onClick }: { agent: SubAgent; onClick: () => void }) {
  return (
    <span class="repl-agent-pill" onClick={onClick}>
      <IconBot />
      <span>{agent.name}</span>
      {agent.status === 'active' && <span class="repl-agent-live-dot" />}
      <span class="repl-agent-pill-actions">
        <span class="pill-action-float" title="展开"><IconMaximize /></span>
      </span>
    </span>
  );
}

function SubagentModal({ agent, onClose }: { agent: SubAgent; onClose: () => void }) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const handleSendToSubagent = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    const content = input.trim();
    const newMsg: ChatMessage = { id: `msg-${Date.now()}`, role: 'user', content, timestamp: Date.now() };
    agent.messages = reduceChatMessages(agent.messages, [newMsg]);
    const subAgents = [...appState.getState().subAgents];
    appState.setState('subAgents', subAgents);
    setInput('');
    try {
      await tauriBridge.sendToSubagent(agent.id, content);
    } catch (error) {
      showToast('发送消息到子 Agent 失败', 'error', 4500);
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="repl-subagent-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="repl-subagent-dialog" onClick={(e) => e.stopPropagation()}>
        <div class="repl-subagent-header">
          <div class="repl-subagent-title">
            <IconBot />
            <span class="repl-subagent-name">{agent.name}</span>
            {agent.status === 'active' && <span class="repl-agent-live-dot" />}
          </div>
          <button class="repl-subagent-close-btn" onClick={onClose}><IconX /></button>
        </div>
        <div class="repl-subagent-messages">
          {agent.messages.length === 0 && <div class="repl-subagent-empty">暂无消息</div>}
          {agent.messages.map(msg => (
            <div class={`repl-agent-msg ${msg.role === 'user' ? 'user' : 'agent'}`} key={msg.id}>
              <div class="repl-agent-msg-bubble"><MarkdownRenderer content={msg.content} /></div>
            </div>
          ))}
        </div>
        <div class="repl-subagent-input-area">
          <div class="repl-agent-input-row">
            <textarea
              class="repl-agent-input"
              placeholder="向子智能体发送消息..."
              rows={1}
              value={input}
              onInput={(e: Event) => setInput((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSendToSubagent(); } }}
              disabled={sending}
            />
            <button class="repl-agent-send-btn" onClick={() => void handleSendToSubagent()} disabled={sending}><IconSend /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SubagentBar() {
  const [subAgents, setSubAgents] = useState(appState.getState().subAgents);
  const [activeModal, setActiveModal] = useState<string | null>(null);

  useEffect(() => {
    const unsub = appState.subscribe('subAgents', setSubAgents);
    return unsub;
  }, []);

  if (subAgents.length === 0) return null;

  const activeAgent = activeModal ? subAgents.find(a => a.id === activeModal) : null;

  return (
    <>
      <div class="repl-sub-agent-trigger-wrapper">
        {subAgents.map(agent => (
          <SubagentPill key={agent.id} agent={agent} onClick={() => setActiveModal(agent.id)} />
        ))}
      </div>
      {activeAgent && <SubagentModal agent={activeAgent} onClose={() => setActiveModal(null)} />}
    </>
  );
}