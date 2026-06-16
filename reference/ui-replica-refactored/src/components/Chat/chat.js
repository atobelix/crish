/**
 * Chat module — renders messages, tool calls, manages chat state.
 */
import { store } from '../../services/store.js';
import { eventBus } from '../../services/eventBus.js';
import { demoStore } from '../../data/demoStore.js';
import { highlightCode } from '../../utils/highlight.js';
import { escapeHTML } from '../../utils/escape.js';
import { computeToolMetrics, renderDiffView } from '../../utils/diffHelper.js';

const toolNameLabels = {
  'bash': '调用', 'read_file': '读取', 'edit_file': '编辑',
  'edit': '编辑', 'grep_search': '搜索', 'run_test': '测试',
  'simulate_reply': '调用', 'node_repl': '执行'
};

function renderToolCall(call, index) {
  const expanded = call.expanded !== false;
  const safeArgs = escapeHTML(call.args);
  const friendlyLabel = call.label || safeArgs;
  const displayName = toolNameLabels[call.name] || call.name;
  const status = call.status || 'success';
  const isEditTool = call.name === 'edit_file' || call.name === 'edit';
  const hasFailed = status === 'failure';
  const uid = call.uid || `call-${index}-${Date.now()}`;

  const statusIcon = hasFailed
    ? `<svg class="icon tool-status-icon tool-status-icon-fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`
    : `<svg class="icon tool-status-icon tool-status-icon-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  let editStatsHtml = '';
  if (isEditTool && call.diff) {
    editStatsHtml = `<span class="tool-edit-stats">
      <span class="diff-stat-added">+${call.diff.added}</span>
      <span class="diff-stat-removed">-${call.diff.removed}</span>
      <svg class="tool-open-files-btn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" title="在资源管理器中打开"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
    </span>`;
  }

  const outputContent = hasFailed
    ? `<pre style="font-style: italic;">调用超时，内容不可用。</pre>`
    : (isEditTool && call.diff ? renderDiffView(call.diff) : `<pre><code>${escapeHTML(call.result)}</code></pre>`);

  return `<div class="tool-invocation" data-call-uid="${uid}" data-expanded="${expanded}" data-status="${status}">
    <div class="tool-call-row">
      ${statusIcon}
      <span class="tool-name">${escapeHTML(displayName)}</span>
      <code class="tool-args">${escapeHTML(friendlyLabel)}</code>
      ${editStatsHtml}
      <svg class="icon tool-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </div>
    <div class="tool-result-window">
      <div class="output-box tool-output">${outputContent}</div>
    </div>
  </div>`;
}

function renderToolGroup(group) {
  const metrics = group.metrics || computeToolMetrics(group.calls);
  const summaryParts = [`${metrics.tools} 个工具`];
  if (metrics.viewed > 0) summaryParts.push(`${metrics.viewed} 个文件查看`);
  if (metrics.edited > 0) summaryParts.push(`${metrics.edited} 个文件编辑`);

  if (group.status === 'summary') {
    const expanded = group.expanded === true;
    return `<div class="tool-summary" data-expanded="${expanded}">
      <div class="tool-summary-row">
        <svg class="icon tool-terminal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
        <span class="tool-summary-text">${summaryParts.join(' · ')}</span>
        <svg class="icon tool-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
      <div class="tool-summary-body">${group.calls.map((c, i) => renderToolCall(c, i)).join('')}</div>
    </div>`;
  }
  return group.calls.map((c, i) => renderToolCall(c, i)).join('');
}

function renderPlanGroup(group) {
  const expanded = group.expanded !== false;
  const total = group.plans.length;
  const done = group.plans.filter(p => p.status === 'completed').length;
  const activeTask = group.plans.find(p => p.status === 'active');
  const headerText = done === total
    ? `计划 · 全部完成 (${total}/${total})`
    : `计划 · ${activeTask?.content || `${done}/${total} 已完成`}`;
  const items = group.plans.map(p => {
    const cls = p.status === 'completed' ? 'completed' : (p.status === 'active' ? 'active' : '');
    const icon = p.status === 'completed'
      ? '<svg class="plan-icon completed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>'
      : (p.status === 'active'
        ? '<svg class="plan-icon active" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle></svg>'
        : '<svg class="plan-icon pending" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle></svg>');
    return `<div class="plan-item ${cls}">${icon}<span class="plan-content">${escapeHTML(p.content)}</span></div>`;
  }).join('');
  return `<div class="plan-group" data-expanded="${expanded}">
    <div class="plan-group-header">
      <svg class="icon plan-terminal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
      </svg>
      <span class="plan-group-text">${escapeHTML(headerText)}</span>
      <svg class="icon chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </div>
    <div class="plan-group-body">${items}</div>
  </div>`;
}

function renderMessage(msg) {
  if (msg.role === 'user') return `<div class="chat-message user-message"><div class="message-bubble">${msg.content}</div></div>`;
  if (msg.role === 'assistant') return `<div class="chat-message assistant-message">${msg.content}</div>`;
  if (msg.role === 'tool_group') return renderToolGroup(msg);
  if (msg.role === 'plan_group') return `<div class="chat-message">${renderPlanGroup(msg)}</div>`;
  return '';
}

function renderMessages(messages) {
  return messages.map(renderMessage).join('');
}

function bindToolToggles(container) {
  container.querySelectorAll('.tool-call-row').forEach(row => {
    row.addEventListener('click', () => {
      const inv = row.closest('.tool-invocation');
      const expanded = inv.getAttribute('data-expanded') === 'true';
      inv.setAttribute('data-expanded', String(!expanded));
    });
  });
  container.querySelectorAll('.tool-summary-row').forEach(row => {
    row.addEventListener('click', () => {
      const summary = row.closest('.tool-summary');
      const expanded = summary.getAttribute('data-expanded') === 'true';
      summary.setAttribute('data-expanded', String(!expanded));
    });
  });
}

export { renderMessage, bindToolToggles };

export function renderCurrentMessages() {
  const messageList = document.querySelector('.message-list');
  const currentChatId = store.get('currentChatId');
  if (!messageList || !currentChatId) return;
  const conv = demoStore.getConversation(currentChatId);
  const msgs = conv ? conv.messages : [];
  if (!msgs) return;
  messageList.innerHTML = renderMessages(msgs);
  bindToolToggles(messageList);
  highlightCode(messageList);
}

export function activateChat(chatId, title, element) {
  store.set('currentChatId', chatId);
  document.querySelectorAll('.chat-item, .nested-item').forEach(c => c.classList.remove('active'));
  if (element) element.classList.add('active');
  const proj = document.getElementById('breadcrumb-project');
  const conv = document.getElementById('breadcrumb-conv');
  if (proj) proj.textContent = store.get('activeProject') || '无项目';
  if (conv) conv.textContent = title;
  renderCurrentMessages();
}

export function initChat() {
  eventBus.on('chat:select', (chatId, title, el) => activateChat(chatId, title, el));
}
