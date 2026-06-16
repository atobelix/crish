/**
 * Slash commands and demo flows.
 * /plan, /approve, /tool, /help
 * demoContinuousToolCalls, demoPlanFlow, demoApproval
 */
import { store } from './store.js';
import { eventBus } from './eventBus.js';
import { demoStore } from '../data/demoStore.js';
import { toolCallTemplates } from '../data/toolTemplates.js';
import { computeToolMetrics } from '../utils/diffHelper.js';
import { renderCurrentMessages } from '../components/Chat/chat.js';
import { roundManager } from './roundManager.js';

let toolUidCounter = 0;
let currentToolGroup = null;
const conversationDiffs = {};
let toolTimer = null;

const demoPlanSteps = [
  '分析项目目录结构及现有代码',
  '识别关键模块与数据流',
  '确定实现方案架构',
  '编写核心业务逻辑代码',
  '添加单元测试覆盖',
  '执行集成测试并修复问题'
];

export function initSlashCommands() {
  const textarea = document.querySelector('.chat-textarea');
  if (!textarea) return;

  textarea.addEventListener('input', () => {
    if (textarea.value.startsWith('/')) {
      showSlashPopup(textarea.value);
    } else {
      const popup = document.querySelector('.slash-popup');
      if (popup) popup.classList.remove('show');
    }
  });

  eventBus.on('slash:plan', () => demoPlanFlow());
  eventBus.on('slash:approve', () => demoApproval());
  eventBus.on('slash:tool', () => demoContinuousToolCalls());
  eventBus.on('slash:help', () => showSlashHelp());
}

function showSlashPopup(filter) {
  let popup = document.querySelector('.slash-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.className = 'slash-popup';
    document.querySelector('.input-card')?.appendChild(popup);
  }
  const commands = [
    { cmd: '/plan', label: '运行计划演示' },
    { cmd: '/approve', label: '显示审批面板' },
    { cmd: '/tool', label: '连续工具调用演示' },
    { cmd: '/help', label: '显示可用命令' }
  ];
  const filtered = commands.filter(c => !filter || c.cmd.startsWith(filter));
  if (!filtered.length) { popup.classList.remove('show'); return; }
  popup.innerHTML = filtered.map(c =>
    `<div class="slash-item" data-cmd="${c.cmd}"><span class="slash-cmd">${c.cmd}</span><span class="slash-label">${c.label}</span></div>`
  ).join('');
  popup.classList.add('show');
  popup.querySelectorAll('.slash-item').forEach(el => {
    el.addEventListener('click', () => {
      popup.classList.remove('show');
      const cmd = el.dataset.cmd;
      eventBus.emit(`slash:${cmd.replace('/', '')}`);
    });
  });
}

function showSlashHelp() {
  alert('可用斜杠命令:\n/plan — 运行计划演示\n/approve — 显示审批面板\n/tool — 连续工具调用\n/help — 显示帮助');
}

/* ── Tool call streaming ── */
function appendToolCall(name, args, result, options = {}) {
  const chatId = store.get('currentChatId');
  const conv = demoStore.getConversation(chatId);
  if (!conv) return null;
  const call = {
    name, args, result,
    uid: `call-${++toolUidCounter}`,
    expanded: options.expanded !== false,
    done: true,
    status: options.status || 'success',
    ...(options.label ? { label: options.label } : {}),
    ...(options.diff ? { diff: options.diff } : {})
  };
  if (currentToolGroup && currentToolGroup.status === 'streaming') {
    currentToolGroup.calls.push(call);
  } else {
      currentToolGroup = { role: 'tool_group', status: 'streaming', uid: `group-${++toolUidCounter}`, expanded: true, calls: [call] };
      conv.messages.push(currentToolGroup);
    }
  currentToolGroup.metrics = computeToolMetrics(currentToolGroup.calls);
  if (options.diff && options.diff.file) {
    if (!conversationDiffs[chatId]) conversationDiffs[chatId] = {};
    conversationDiffs[chatId][options.diff.file] = options.diff;
  }
  renderCurrentMessages();
  return currentToolGroup;
}

function finalizeToolGroup() {
  if (!currentToolGroup) return;
  currentToolGroup.status = currentToolGroup.calls.length > 1 ? 'summary' : 'expanded';
  currentToolGroup.expanded = currentToolGroup.calls.length <= 1;
  currentToolGroup = null;
  renderCurrentMessages();
}

export function demoContinuousToolCalls(options = {}) {
  const count = options.count || 8;
  const interval = options.interval || 1000;
  const chatId = store.get('currentChatId');
  if (!chatId || !demoStore.getConversation(chatId)) {
    eventBus.emit('chat:select', 'conv-1', 'build a todo list app');
    setTimeout(() => startToolStream(count, interval), 300);
    return;
  }
  startToolStream(count, interval);
}

function startToolStream(count, interval) {
  let i = 0;
  const existingTimer = toolTimer;
  if (existingTimer) clearInterval(existingTimer);
  toolTimer = setInterval(() => {
    if (i >= count) {
      clearInterval(toolTimer);
      toolTimer = null;
      finalizeToolGroup();
      const conv = demoStore.getConversation(store.get('currentChatId'));
      if (conv) conv.messages.push({ role: 'assistant', content: '连续工具调用演示结束，已处理所有请求。' });
      renderCurrentMessages();
      return;
    }
    const tpl = toolCallTemplates[Math.floor(Math.random() * toolCallTemplates.length)];
    const opts = { expanded: i > count - 3, label: tpl.label };
    if (tpl.diff) opts.diff = tpl.diff;
    opts.status = Math.random() < 0.12 ? 'failure' : 'success';
    appendToolCall(tpl.name, tpl.args, tpl.result, opts);
    i++;
  }, interval);
}

/* ── Plan flow ── */
export function demoPlanFlow() {
  const chatId = store.get('currentChatId');
  const conv = demoStore.getConversation(chatId);
  if (!chatId || !conv) return;
  let stepIdx = 0;
  const existingTimer = toolTimer;
  if (existingTimer) clearInterval(existingTimer);

  function pushPlan(completedUpTo) {
    const plans = demoPlanSteps.map((content, i) => ({
      id: `step-${i}`, content,
      status: i < completedUpTo ? 'completed' : (i === completedUpTo ? 'active' : 'pending')
    }));
    conv.messages.push({ role: 'plan_group', expanded: true, status: completedUpTo >= demoPlanSteps.length ? 'completed' : 'in_progress', plans });
    renderCurrentMessages();
  }
  pushPlan(0);
  stepIdx = 1;
  toolTimer = setInterval(() => {
    pushPlan(stepIdx);
    stepIdx++;
    if (stepIdx > demoPlanSteps.length) { clearInterval(toolTimer); toolTimer = null; }
  }, 1500);
}

/* ── Approval panel ── */
export function demoApproval() {
  const panel = document.getElementById('approval-panel');
  const list = document.getElementById('approval-list');
  const count = document.getElementById('approval-count');
  if (!panel || !list) return;
  const items = [
    { action: '读取文件', args: 'src/auth/login.js', icon: '<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>' },
    { action: '执行命令', args: 'npm run test --coverage', icon: '<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>' }
  ];
  list.innerHTML = items.map((item, idx) => `
    <div class="approval-item">
      <div class="approval-left">
        <svg class="approval-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${item.icon}</svg>
        <div class="approval-info"><span class="approval-action">${item.action}</span><code class="approval-args">${item.args}</code></div>
      </div>
      <div class="approval-right">
        <button class="approval-btn approve" data-idx="${idx}">允许</button>
        <button class="approval-btn reject" data-idx="${idx}">拒绝</button>
      </div>
    </div>`
  ).join('');
  if (count) count.textContent = items.length;
  panel.style.display = 'block';
  list.querySelectorAll('.approval-btn.approve').forEach(btn => {
    btn.addEventListener('click', () => { panel.style.display = 'none'; });
  });
  list.querySelectorAll('.approval-btn.reject').forEach(btn => {
    btn.addEventListener('click', () => { panel.style.display = 'none'; });
  });
}

/* ── View state switching ── */

/** Switch input card between empty (centered, with tags) and chat (docked, no tags) */
export function setInputMode(mode) {
  const wrapper = document.querySelector('.input-area-wrapper');
  const contextTags = document.querySelector('.input-context-tags');
  const textarea = wrapper?.querySelector('.chat-textarea');
  if (mode === 'empty') {
    if (contextTags) contextTags.style.display = 'flex';
    wrapper?.classList.remove('active-chat');
    if (textarea) textarea.placeholder = '随心输入';
  } else {
    if (contextTags) contextTags.style.display = 'none';
    wrapper?.classList.add('active-chat');
    if (textarea) textarea.placeholder = '要求后续变更';
  }
}

/** Empty state: no message area, centered input, no right sidebar */
export function activateEmptyState() {
  // Hide chat views
  const ml = document.querySelector('.message-list');
  if (ml) ml.style.display = 'none';
  const cb = document.querySelector('.command-bar');
  if (cb) cb.style.display = 'none';

  // Show input area centered
  const ic = document.querySelector('.input-panel-container');
  if (ic) ic.style.display = 'block';
  const iw = document.querySelector('.input-area-wrapper');
  if (iw) {
    const mainPanel = document.querySelector('.chat-area');
    if (mainPanel && !mainPanel.contains(iw)) mainPanel.appendChild(iw);
    setInputMode('empty');
  }

  // Hide right sidebar
  const rs = document.querySelector('.right-sidebar');
  if (rs) rs.classList.add('collapsed');

  // Reset panel title
  const pt = document.querySelector('.panel-title');
  if (pt) pt.textContent = 'MyCodex Studio';

  // Remove active from feature items
  document.querySelectorAll('.feature-item').forEach(i => i.classList.remove('active'));
  // Deactivate all chat items
  document.querySelectorAll('.chat-item, .nested-item').forEach(c => c.classList.remove('active'));
  document.querySelector('.quick-chat-btn')?.classList.add('active');
}

/** Active chat mode: show messages, docked input, right sidebar available */
export function activateChatMode() {
  const es = document.querySelector('.empty-chat-state');
  if (es) es.style.display = 'none';
  document.querySelector('.quick-chat-btn')?.classList.remove('active');
  const cb = document.querySelector('.command-bar');
  if (cb) cb.style.display = 'flex';
  const ml = document.querySelector('.message-list');
  if (ml) ml.style.display = 'flex';
  const ic = document.querySelector('.input-panel-container');
  if (ic) {
    ic.style.display = 'block';
    const iw = document.querySelector('.input-area-wrapper');
    const inputAreaContainer = ic;
    if (iw && !inputAreaContainer.contains(iw)) inputAreaContainer.appendChild(iw);
    setInputMode('chat');
    document.querySelectorAll('.attached-dropdown-menu').forEach(m => m.classList.remove('show'));
  }
  document.querySelectorAll('.feature-panel-view').forEach(v => v.style.display = 'none');
  document.querySelectorAll('.feature-item').forEach(i => i.classList.remove('active'));
}

/* ── Demo button override ── */
export function initDemoButton() {
  const btn = document.getElementById('demo-tool-calls-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      demoContinuousToolCalls({ count: 10, interval: 900 });
    });
  }
}

// Expose for window usage
window.demoContinuousToolCalls = demoContinuousToolCalls;
window.demoPlanFlow = demoPlanFlow;
window.demoApproval = demoApproval;
