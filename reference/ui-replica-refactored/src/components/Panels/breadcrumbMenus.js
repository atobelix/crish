/**
 * BreadcrumbMenus — cascading menus for project/conversation breadcrumbs.
 *
 * Project click → 打开在 (submenu: editors) + 文件浏览器中打开
 * Conv click   → 置顶, 重命名, 分支 (submenu), 新建 (submenu), 新窗口
 */
import { store } from '../../services/store.js';
import { eventBus } from '../../services/eventBus.js';
import { demoStore } from '../../data/demoStore.js';

const menuContainer = document.createElement('div');
menuContainer.className = 'sf-cascading-menu';
menuContainer.id = 'breadcrumb-menu';
document.body.appendChild(menuContainer);

function showMenu(x, y, html) {
  const existing = document.getElementById('breadcrumb-menu');
  existing.innerHTML = html;
  existing.style.left = x + 'px';
  existing.style.top = y + 'px';
  existing.classList.add('show');
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', () => { existing.classList.remove('show'); }, { once: true });
  }, 10);
}

export function initBreadcrumbMenus() {
  // ── Project name click ──
  document.getElementById('breadcrumb-project')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    const rect = e.target.getBoundingClientRect();
    const activeProject = demoStore.ui.activeProject || 'mycodex-demo';
    showMenu(rect.left, rect.bottom + 4, `
      <div class="sf-cascading-header">${activeProject}</div>
      <div class="sf-cascading-item menu-has-sub-right" data-action="open-in">
        <span>打开在</span>
        <span class="sf-cascading-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
        <div class="sf-cascading-submenu">
          <div class="sf-cascading-item" data-action="open-vscode">VS Code</div>
          <div class="sf-cascading-item" data-action="open-notepad">记事本</div>
          <div class="sf-cascading-item" data-action="open-explorer">资源管理器</div>
        </div>
      </div>
      <div class="sf-cascading-item" data-action="open-filebrowser">文件浏览器中打开</div>
    `);
    bindMenuActions();
  });

  // ── Conversation name click ──
  document.getElementById('breadcrumb-conv')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    const rect = e.target.getBoundingClientRect();
    const convId = store.get('currentChatId');
    const conv = demoStore.getConversation(convId);
    const title = conv ? conv.title : '';
    const isPinned = document.querySelector(`.pinned-clone[data-original-id="${convId}"], [data-pinned-id="${convId}"]`);
    showMenu(rect.left, rect.bottom + 4, `
      <div class="sf-cascading-header">${title}</div>
      <div class="sf-cascading-item" data-action="pin">${isPinned ? '取消置顶' : '置顶'}</div>
      <div class="sf-cascading-item" data-action="rename">重命名</div>
      <div class="sf-cascading-item menu-has-sub-right" data-action="fork">
        <span>分支</span>
        <span class="sf-cascading-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
        <div class="sf-cascading-submenu">
          <div class="sf-cascading-item" data-action="fork-new-window">新窗口</div>
          <div class="sf-cascading-item" data-action="fork-split">拆分窗口</div>
          <div class="sf-cascading-item" data-action="fork-current">当前窗口打开</div>
        </div>
      </div>
      <div class="sf-cascading-item menu-has-sub-right" data-action="new">
        <span>新建</span>
        <span class="sf-cascading-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
        <div class="sf-cascading-submenu">
          <div class="sf-cascading-item" data-action="new-sidebar">在侧边栏新建对话</div>
          <div class="sf-cascading-item menu-has-sub-right" data-action="new-workdir">
            <span>在工作目录新建</span>
            <span class="sf-cascading-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
            <div class="sf-cascading-submenu">
              ${demoStore.projects.map(p => `<div class="sf-cascading-item" data-action="new-in-project" data-project="${p.name}">${p.name}</div>`).join('')}
              <div class="sf-cascading-item" data-action="new-noproject">不使用项目</div>
            </div>
          </div>
        </div>
      </div>
      <div class="sf-cascading-item" data-action="new-window">新窗口打开</div>
    `);
    bindMenuActions();
  });
}

function bindMenuActions() {
  document.querySelectorAll('#breadcrumb-menu .sf-cascading-item[data-action]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      const project = item.dataset.project;
      const rect = e.target.closest('.sf-cascading-menu')?.getBoundingClientRect();
      closeMenu();

      switch (action) {
        case 'open-vscode': alert('在 VS Code 中打开工作目录'); break;
        case 'open-notepad': alert('在记事本中打开工作目录'); break;
        case 'open-explorer': alert('在资源管理器中打开工作目录'); break;
        case 'open-filebrowser': openFileBrowser(); break;
        case 'pin': togglePinConv(); break;
        case 'rename': openRename(); break;
        case 'fork-new-window': alert('在新的浏览器窗口中打开分支对话'); break;
        case 'fork-split': alert('在拆分视图中打开分支对话'); break;
        case 'fork-current': forkCurrentConv(); break;
        case 'new-sidebar': createNewConv(); break;
        case 'new-in-project': createNewConv(project); break;
        case 'new-noproject': createNewConv(null); break;
        case 'new-window': alert('在新窗口中打开当前对话'); break;
      }
    });
  });
}

function closeMenu() {
  document.getElementById('breadcrumb-menu')?.classList.remove('show');
}

function openFileBrowser() {
  const rs = document.querySelector('.right-sidebar');
  if (rs) {
    rs.classList.remove('collapsed');
    document.querySelectorAll('.right-tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-file-explorer')?.classList.add('active');
  }
}

function togglePinConv() {
  const convId = store.get('currentChatId');
  const el = document.querySelector(`[data-id="${convId}"]`);
  if (!el) return;
  // Toggle pin inline
  const pinnedList = document.getElementById('pinned-list');
  const isPinned = el.closest('#pinned-list') || el.dataset.pinnedId;
  if (isPinned) {
    const pinnedId = el.dataset.pinnedId || el.getAttribute('data-id');
    const clone = pinnedList?.querySelector(`[data-original-id="${pinnedId}"]`);
    if (clone) clone.remove();
    if (el.closest('#pinned-list')) el.remove();
    const orig = document.querySelector(`[data-id="${pinnedId}"]`);
    if (orig) delete orig.dataset.pinnedId;
  } else {
    const id = el.getAttribute('data-id') || 'pin-' + Date.now();
    el.dataset.pinnedId = id;
    const text = el.querySelector('.item-text, .nested-text, .chat-title')?.textContent || 'Item';
    const li = document.createElement('li');
    li.className = 'list-item chat-item pinned-clone';
    li.dataset.originalId = id;
    li.dataset.id = id;
    li.innerHTML = `<div class="item-main"><span class="item-text">${text}</span></div>`;
    pinnedList?.appendChild(li);
  }
  eventBus.emit('sidebar:filter');
}

function openRename() {
  const convId = store.get('currentChatId');
  const el = document.querySelector(`[data-id="${convId}"]`);
  if (!el) return;
  const modal = document.getElementById('rename-modal');
  const input = document.getElementById('rename-input');
  const textSpan = el.querySelector('.item-text, .nested-text, .chat-title');
  if (!modal || !input || !textSpan) return;
  const originalText = textSpan.textContent;
  input.value = originalText;
  modal.classList.add('show');
  setTimeout(() => { input.focus(); input.select(); }, 50);
  const doSave = () => {
    const val = input.value.trim();
    if (val && val !== originalText) {
      textSpan.textContent = val;
      document.getElementById('breadcrumb-conv').textContent = val;
    }
    modal.classList.remove('show');
  };
  document.getElementById('btn-save-rename').addEventListener('click', doSave, { once: true });
  document.getElementById('btn-cancel-rename').addEventListener('click', () => modal.classList.remove('show'), { once: true });
  document.getElementById('close-rename-modal-btn').addEventListener('click', () => modal.classList.remove('show'), { once: true });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } }, { once: true });
}

function forkCurrentConv() {
  const convId = store.get('currentChatId');
  const conv = demoStore.getConversation(convId);
  if (!conv) return;
  const newConv = { ...conv, id: 'conv-' + Date.now(), title: conv.title + ' (副本)', created: Date.now(), lastActive: Date.now() };
  demoStore.addConversation(newConv);
  eventBus.emit('sidebar:filter');
}

function createNewConv(project = null) {
  const name = prompt('输入新对话名称:', '新对话');
  if (!name) return;
  const convId = 'conv-' + Date.now();
  demoStore.addConversation({ id: convId, title: name, project, created: Date.now(), lastActive: Date.now(), archived: false, pinned: false, messages: [], rounds: [] });
  eventBus.emit('sidebar:filter');
}
