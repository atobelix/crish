/**
 * DualChat — right sidebar chat panel.
 * Reuses main chat's renderMessage() function.
 * Independent message list + input, but context-aware.
 */
import { renderMessage, bindToolToggles } from '../../Chat/chat.js';
import { highlightCode } from '../../../utils/highlight.js';
import { escapeHTML } from '../../../utils/escape.js';

let messageHistory = [];

const aiResponses = [
  '这确实是一个很好的角度！我已经同步了当前的上下文，你可以继续在主会话中开发。',
  '收到！我建议将这部分逻辑重构为独立的工具函数，便于后续复用。',
  '好的，已经记录。根据上下文，刚才的修改可以进一步优化性能。',
  '明白，我整理了以下要点供你参考。你可以在主面板中继续推进主要任务。',
  '已分析当前上下文。副面板将专注于辅助整理和代码片段优化。'
];

export function initDualChat() {
  const container = document.getElementById('tab-dual-chat');
  if (!container) return;

  container.innerHTML = `
    <div class="dc-chat-container">
      <div class="dc-chat-messages" id="dc-chat-messages">
        <div class="chat-message assistant-message">副面板就绪，可在此与 AI 并行讨论。</div>
      </div>
      <div class="dc-chat-input-bar">
        <textarea class="dc-chat-input" id="dc-chat-input" placeholder="输入辅助命令或提示词... (Ctrl+Enter 发送)" rows="1"></textarea>
        <button class="dc-chat-send" id="dc-chat-send" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
            <line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline>
          </svg>
        </button>
      </div>
    </div>
  `;

  bindEvents(container);
}

function bindEvents(container) {
  const textarea = container.querySelector('#dc-chat-input');
  const sendBtn = container.querySelector('#dc-chat-send');
  const messagesEl = container.querySelector('#dc-chat-messages');

  if (textarea && sendBtn) {
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = (textarea.scrollHeight - 6) + 'px';
      const hasText = textarea.value.trim() !== '';
      sendBtn.disabled = !hasText;
      sendBtn.style.opacity = hasText ? '1' : '0.4';
    });

    const sendMessage = () => {
      const text = textarea.value.trim();
      if (!text) return;

      // Render user message (reusing main chat's structure)
      const userHtml = renderMessage({ role: 'user', content: escapeHTML(text) });
      messagesEl.insertAdjacentHTML('beforeend', userHtml);
      textarea.value = '';
      textarea.style.height = 'auto';
      sendBtn.disabled = true;
      sendBtn.style.opacity = '0.4';
      messagesEl.scrollTop = messagesEl.scrollHeight;

      // Mock AI response
      setTimeout(() => {
        const reply = aiResponses[Math.floor(Math.random() * aiResponses.length)];
        const aiHtml = renderMessage({ role: 'assistant', content: reply });
        messagesEl.insertAdjacentHTML('beforeend', aiHtml);
        bindToolToggles(messagesEl);
        highlightCode(messagesEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }, 800);
    };

    sendBtn.addEventListener('click', sendMessage);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }
}
