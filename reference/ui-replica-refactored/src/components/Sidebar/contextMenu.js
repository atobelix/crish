/**
 * ContextMenu — full implementation with real actions.
 * Section → filter panel
 * Project → pin/rename/add-chat/fork/remove
 * Chat → open-in/pin/mark-unread/rename/fork/archive/delete
 */
import { store } from '../../services/store.js';
import { eventBus } from '../../services/eventBus.js';
import { escapeHTML } from '../../utils/escape.js';
import { togglePinItem } from './sidebar.js';
import { demoStore } from '../../data/demoStore.js';

const menuEl = document.getElementById('context-menu');
const menuList = document.getElementById('context-menu-list');
let activeTarget = null;

export function initContextMenu() {
  if (!menuEl || !menuList) return;
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  sidebar.addEventListener('contextmenu', (e) => {
    const target = e.target.closest('.project-item, .chat-item, .nested-item, .section-header');
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, target);
  });

  sidebar.addEventListener('click', (e) => {
    const btn = e.target.closest('.item-more-btn, .section-more-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const target = btn.closest('.project-item, .chat-item, .nested-item, .section-header');
    if (!target) return;
    const rect = btn.getBoundingClientRect();
    showMenu(rect.left, rect.bottom + 4, target);
  });

  document.addEventListener('click', closeMenu);
  document.addEventListener('contextmenu', closeMenu);
}

function showMenu(x, y, target) {
  activeTarget = target;
  const isSection = !!target.closest('.section-header');
  const isProject = target.closest('.project-item') && !target.closest('.nested-item');
  const isChat = target.closest('.chat-item') || target.closest('.nested-item');
  const isPinned = target.closest('#pinned-list') || target.dataset.pinnedId;

  if (isSection) {
    // Section context menu: open master filter
    document.getElementById('sf-trigger')?.click();
    closeMenu();
    return;
  } else {
    let html = '';
    if (isProject) {
      html = `
        <li class="menu-item-action" data-action="pin"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><circle cx="12" cy="12" r="3"></circle></svg><span>${isPinned ? '取消置顶' : '置顶项目'}</span></li>
        <li class="menu-item-action" data-action="rename"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg><span>重命名</span></li>
        <li class="menu-item-action" data-action="add-chat"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span>新建对话</span></li>
        <li class="menu-item-action" data-action="archive"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg><span>归档</span></li>
        <li class="menu-item-action menu-danger" data-action="remove"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg><span>移除</span></li>`;
    } else if (isChat) {
      html = `
        <li class="menu-item-action" data-action="open-in"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg><span>在新窗口打开</span></li>
        <li class="menu-item-action" data-action="pin"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><circle cx="12" cy="12" r="3"></circle></svg><span>${isPinned ? '取消置顶' : '置顶'}</span></li>
        <li class="menu-item-action" data-action="mark-unread"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg><span>标为未读</span></li>
        <li class="menu-item-action" data-action="rename"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg><span>重命名</span></li>
        <li class="menu-item-action" data-action="fork"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="6 3 6 15 12 15"></polyline><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="18" r="3"></circle></svg><span>分叉对话</span></li>
        <li class="menu-item-action" data-action="archive"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg><span>归档</span></li>
        <li class="menu-item-action menu-danger" data-action="delete"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg><span>删除</span></li>`;
    }
    menuList.innerHTML = html;
    menuEl.classList.add('show');
    menuEl.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - 200) + 'px';
    bindActions();
  }
}

function bindActions() {
  menuList.querySelectorAll('.menu-item-action').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      const action = item.dataset.action;
      if (!activeTarget) return;
      const textSpan = activeTarget.querySelector('.item-text, .nested-text, .chat-title');
      const name = textSpan?.textContent || '';
      switch (action) {
        case 'pin': togglePinItem(activeTarget); break;
        case 'rename': openRename(activeTarget); break;
        case 'remove':
        case 'delete':
          if (confirm(`确定要删除「${name}」吗？`)) {
            const id = activeTarget.dataset.id;
            if (id) demoStore.removeConversation(id);
            activeTarget.remove();
          }
          break;
        case 'add-chat': addChatToProject(activeTarget); break;
        case 'archive': {
          const id = activeTarget.dataset.id;
          if (id) demoStore.updateConversation(id, { archived: true });
          activeTarget.classList.add('archived');
          alert(`已归档「${name}」`);
          break;
        }
        case 'fork': {
          const newId = 'chat-' + Date.now();
          const parentList = activeTarget.closest('ul');
          if (parentList) {
            const li = activeTarget.cloneNode(true);
            li.dataset.id = newId;
            li.classList.remove('active');
            const t = li.querySelector('.nested-text, .chat-title');
            if (t) t.textContent = name + ' (副本)';
            parentList.insertBefore(li, activeTarget.nextSibling);
            eventBus.emit('chat:select', newId, name + ' (副本)', li);
          }
          break;
        }
        case 'mark-unread': alert(`已将「${name}」标为未读`); break;
        case 'open-in': alert(`在新窗口中打开「${name}」`); break;
        case 'collapse-all':
          activeTarget.closest('.sidebar-section')?.setAttribute('data-expanded', 'false');
          break;
        case 'expand-all':
          activeTarget.closest('.sidebar-section')?.setAttribute('data-expanded', 'true');
          break;
      }
    });
  });
}

function addChatToProject(projectItem) {
  const nestedList = projectItem.querySelector('.nested-list');
  if (!nestedList) return;
  const name = prompt('输入新对话名:', '新对话');
  if (!name) return;
  const id = 'chat-' + Date.now();
  const li = document.createElement('li');
  li.className = 'nested-item chat-item';
  li.dataset.id = id;
  li.innerHTML = `<span class="nested-text">${escapeHTML(name)}</span><span class="chat-time">1m</span>`;
  nestedList.appendChild(li);
  eventBus.emit('chat:select', id, name, li);
}

function openRename(element) {
  const modal = document.getElementById('rename-modal');
  const input = document.getElementById('rename-input');
  const textSpan = element.querySelector('.item-text, .nested-text, .chat-title');
  if (!modal || !input || !textSpan) return;
  const originalText = textSpan.textContent;
  input.value = originalText;
  modal.classList.add('show');
  setTimeout(() => { input.focus(); input.select(); }, 50);

  const doSave = () => {
    const val = input.value.trim();
    if (val && val !== originalText) {
      textSpan.textContent = val;
      if (element.classList.contains('active')) {
        const title = document.querySelector('.panel-title');
        if (title) title.textContent = `${store.get('activeProject')} / ${val}`;
      }
      const itemId = element.dataset.id;
      const clone = document.querySelector(`[data-original-id="${itemId}"]`);
      if (clone) clone.querySelector('.item-text').textContent = val;
    }
    modal.classList.remove('show');
  };

  const saveBtn = document.getElementById('btn-save-rename');
  const cancelBtn = document.getElementById('btn-cancel-rename');
  const closeBtn = document.getElementById('close-rename-modal-btn');

  saveBtn?.addEventListener('click', doSave, { once: true });
  cancelBtn?.addEventListener('click', () => modal.classList.remove('show'), { once: true });
  closeBtn?.addEventListener('click', () => modal.classList.remove('show'), { once: true });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } }, { once: true });
}

function closeMenu() {
  menuEl?.classList.remove('show', 'sf-show');
  activeTarget = null;
}
