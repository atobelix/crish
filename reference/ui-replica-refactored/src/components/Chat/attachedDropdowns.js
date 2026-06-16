/**
 * AttachedDropdowns — project/mode/branch context tag dropdowns.
 * Inline dropdown menus that appear below the input area context tags.
 */
import { store } from '../../services/store.js';
import { eventBus } from '../../services/eventBus.js';
import { demoStore } from '../../data/demoStore.js';

export function initAttachedDropdowns() {
  const projects = demoStore.projects.map(p => p.name);
  const modes = ['本地模式', '云端沙盒'];
  const branches = ['master', 'dev'];
  bindDropdown('attached-project-dropdown-trigger', 'attached-project-dropdown', projects, 'active-project-name', (val) => {
    store.set('activeProject', val);
    const greeting = document.querySelector('.empty-greeting');
    if (greeting) greeting.textContent = `我们应该在 ${val} 中构建什么？`;
    eventBus.emit('project:switch', val);
  });
  bindDropdown('attached-mode-dropdown-trigger', 'attached-mode-dropdown', modes, 'active-mode-name');
  bindDropdown('attached-branch-dropdown-trigger', 'attached-branch-dropdown', branches, 'active-branch-name');

  // New project submenu + no project
  document.getElementById('attached-new-project-btn')?.addEventListener('click', () => {
    const name = prompt('输入新项目名:', '新项目');
    if (name) alert(`项目 "${name}" 已创建`);
  });
  document.getElementById('attached-open-folder-btn')?.addEventListener('click', () => {
    alert('打开文件夹 (选择本地目录)');
  });
  document.getElementById('attached-no-project-btn')?.addEventListener('click', () => {
    const trigger = document.getElementById('attached-project-dropdown-trigger');
    const nameEl = trigger?.querySelector('.active-project-name');
    if (nameEl) nameEl.textContent = '未关联项目';
    store.set('activeProject', '未关联项目');
    const greeting = document.querySelector('.empty-greeting');
    if (greeting) greeting.textContent = '我们应该构建什么？';
  });
  document.getElementById('attached-new-branch-btn')?.addEventListener('click', () => {
    const name = prompt('输入新分支名:', 'feature-branch');
    if (name) {
      const trigger = document.getElementById('attached-branch-dropdown-trigger');
      const nameEl = trigger?.querySelector('.active-branch-name');
      if (nameEl) nameEl.textContent = name;
    }
  });
}

function bindDropdown(triggerId, menuId, items, labelClass, onChange) {
  const trigger = document.getElementById(triggerId);
  const menu = document.getElementById(menuId);
  if (!trigger || !menu) return;

  // Build menu items
  const list = menu.querySelector('.dropdown-list');
  if (list) {
    list.innerHTML = items.map(i => {
      const selected = i === items[0] ? ' selected' : '';
      return `<li class="attached-menu-item${selected}" data-value="${i}">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>${i}</span>
      </li>`;
    }).join('');
  }

  trigger.addEventListener('click', (e) => {
    if (e.target.closest('.attached-dropdown-menu')) return;
    e.stopPropagation();
    document.querySelectorAll('.attached-dropdown-menu.show').forEach(m => {
      if (m !== menu) m.classList.remove('show');
    });
    menu.classList.toggle('show');
  });

  list.querySelectorAll('.attached-menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = item.dataset.value;
      const nameEl = trigger.querySelector(`.${labelClass}`);
      if (nameEl) nameEl.textContent = val;
      list.querySelectorAll('.attached-menu-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      menu.classList.remove('show');
      if (onChange) onChange(val);
    });
  });

  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => menu.classList.remove('show'));
}
