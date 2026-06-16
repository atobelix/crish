/**
 * Sidebar module — handles sidebar interactions, context menus, pinning.
 */
import { store } from '../../services/store.js';
import { eventBus } from '../../services/eventBus.js';
import { demoStore } from '../../data/demoStore.js';
import { activateEmptyState, activateChatMode } from '../../services/demos.js';
import { bindFilterCascading } from '../../services/sidebarFilter.js';

const pinnedList = document.getElementById('pinned-list');
const sectionPinned = document.getElementById('section-pinned');
const projectsList = document.getElementById('projects-list');
const chatsList = document.getElementById('chats-list');

function updatePinnedVisibility() {
  const hasItems = pinnedList?.children.length > 0;
  if (sectionPinned) sectionPinned.style.display = hasItems ? '' : 'none';
}

function togglePinItem(element) {
  const isPinned = element.closest('#pinned-list') || element.dataset.pinnedId;
  if (isPinned) {
    const pinnedId = element.dataset.pinnedId || element.getAttribute('data-id');
    const clone = pinnedList?.querySelector(`[data-original-id="${pinnedId}"]`);
    if (clone) clone.remove();
    if (element.closest('#pinned-list')) element.remove();
    const orig = document.querySelector(`[data-id="${pinnedId}"]`);
    if (orig) delete orig.dataset.pinnedId;
  } else {
    const id = element.getAttribute('data-id') || 'pin-' + Date.now();
    element.dataset.pinnedId = id;
    const text = element.querySelector('.item-text, .nested-text, .chat-title')?.textContent || 'Item';
    const li = document.createElement('li');
    li.className = 'list-item chat-item pinned-clone';
    li.dataset.originalId = id;
    li.dataset.id = id;
    li.innerHTML = `<div class="item-main">
      <span class="item-text">${text}</span>
      <div class="item-actions">
        <button class="item-action-btn" title="更多">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="1.25"></circle><circle cx="18" cy="12" r="1.25"></circle><circle cx="6" cy="12" r="1.25"></circle>
          </svg>
        </button>
      </div>
    </div>`;
    pinnedList?.appendChild(li);
  }
  updatePinnedVisibility();
  eventBus.emit('sidebar:filter');
}

function activateProjectItem(projectLi) {
  const projName = projectLi.querySelector('.item-text').textContent;
  store.set('activeProject', projName);
  demoStore.updateUI({ activeProject: projName });
}

export function initSidebar() {
  eventBus.on('sidebar:toggle', () => {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.classList.toggle('collapsed');
  });

  eventBus.on('chat:new', () => addNewChat());

  // Initialize filter cascading menu
  bindFilterCascading();

  document.addEventListener('click', (e) => {
    // Quick chat button → empty state
    if (e.target.closest('.quick-chat-btn')) {
      e.stopPropagation();
      activateEmptyState();
      return;
    }

    // Master add button
    if (e.target.closest('.master-add-btn')) {
      e.stopPropagation();
      const addType = e.target.closest('.master-add-btn').dataset.addType;
      if (addType === 'folder') {
        const name = prompt('请输入新项目名称:', '新项目');
        if (!name) return;
        const id = 'project-' + Date.now();
        demoStore.addConversation({ id, title: name, project: name, created: Date.now(), lastActive: Date.now(), archived: false, pinned: false, messages: [], rounds: [] });
        eventBus.emit('sidebar:filter');
      } else {
        addNewChat();
      }
      return;
    }

    // Section add-folder button
    if (e.target.closest('.header-add-folder-btn')) {
      e.stopPropagation();
      const name = prompt('请输入新项目名称:', '新项目');
      if (!name) return;
      const id = 'project-' + Date.now();
      demoStore.addConversation({ id, title: name, project: name, created: Date.now(), lastActive: Date.now(), archived: false, pinned: false, messages: [], rounds: [] });
      eventBus.emit('sidebar:filter');
      return;
    }

    // Section add-chat button
    if (e.target.closest('.header-add-chat-btn')) {
      e.stopPropagation();
      addNewChat();
      return;
    }

    // Project folder click — toggle + activate
    const projItem = e.target.closest('.project-item > .accordion-header');
    if (projItem) {
      const item = projItem.closest('.project-item');
      const expanded = item.getAttribute('data-expanded') !== 'false';
      item.setAttribute('data-expanded', String(!expanded));
      const name = item.querySelector('.item-text')?.textContent;
      if (name) demoStore.updateUI({ activeProject: name });
      return;
    }

    // Project add-chat button inside folder
    if (e.target.closest('.project-add-chat-btn')) {
      e.stopPropagation();
      const projectItem = e.target.closest('.project-item');
      const projName = projectItem?.querySelector('.item-text')?.textContent || '未知项目';
      const name = prompt('输入新对话名:', '新对话');
      if (!name) return;
      const convId = 'conv-' + Date.now();
      demoStore.addConversation({ id: convId, title: name, project: projName, created: Date.now(), lastActive: Date.now(), archived: false, pinned: false, messages: [], rounds: [] });
      demoStore.updateUI({ currentConversationId: convId });
      eventBus.emit('sidebar:filter');
      eventBus.emit('chat:select', convId, name, null);
      return;
    }

    // Chat item click
    const chatItem = e.target.closest('.chat-item, .nested-item');
    if (chatItem && !e.target.closest('.item-actions')) {
      const chatId = chatItem.getAttribute('data-id');
      const title = chatItem.querySelector('.chat-title, .nested-text')?.textContent || 'Chat';
      document.querySelectorAll('.chat-item, .nested-item').forEach(c => c.classList.remove('active'));
      chatItem.classList.add('active');
      store.set('currentChatId', chatId);
      demoStore.updateUI({ currentConversationId: chatId });
      activateChatMode();
      eventBus.emit('chat:select', chatId, title, chatItem);
      return;
    }

    // More button — handled by contextMenu.js
    // (skip duplicate handling here)
  });
}

function addNewChat() {
  const name = prompt('请输入新对话名称:', '新对话');
  if (!name) return;
  const convId = 'conv-' + Date.now();
  demoStore.addConversation({ id: convId, title: name, project: null, created: Date.now(), lastActive: Date.now(), archived: false, pinned: false, messages: [], rounds: [] });
  demoStore.updateUI({ currentConversationId: convId });
  eventBus.emit('sidebar:filter');
  eventBus.emit('chat:select', convId, name, null);
  document.getElementById('breadcrumb-project').textContent = demoStore.ui.activeProject || '无项目';
  document.getElementById('breadcrumb-conv').textContent = name;
  activateChatMode();
  // Also show it as active in the sidebar
  document.querySelectorAll('.chat-item, .nested-item').forEach(c => c.classList.remove('active'));
  const el = document.querySelector(`[data-id="${convId}"]`);
  if (el) el.classList.add('active');
}

export { togglePinItem, activateProjectItem, updatePinnedVisibility };
