/**
 * TabManager — right sidebar tab management.
 * Drag-to-reorder, middle-click close, "+" add tab menu.
 */
import { store } from '../../services/store.js';

const tabDefs = {
  'tab-dual-chat': { label: '对话', multi: true, children: ['inherit', 'new'], icon: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path><path d="M17 9a6.48 6.48 0 0 0-5.5-5.5 8.48 8.48 0 0 0-4.3.6"></path>' },
  'tab-browser': { label: '浏览器', multi: true, icon: '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>' },
  'tab-token-metrics': { label: '使用统计', icon: '<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>' },
  'tab-file-explorer': { label: '文件浏览', icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>' },
  'tab-diff-center': { label: '差异总览', icon: '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1"></path><rect x="8" y="2" width="14" height="14" rx="2" ry="2"></rect>' }
};

let activeTabs = [
  { id: 'tab-dual-chat-1', base: 'tab-dual-chat', label: '对话', panel: 'tab-dual-chat' },
  { id: 'tab-browser-1', base: 'tab-browser', label: '浏览器', panel: 'tab-browser' },
  { id: 'tab-token-metrics', base: 'tab-token-metrics', label: '使用统计', panel: 'tab-token-metrics' },
  { id: 'tab-file-explorer', base: 'tab-file-explorer', label: '文件浏览', panel: 'tab-file-explorer' },
  { id: 'tab-diff-center', base: 'tab-diff-center', label: '差异总览', panel: 'tab-diff-center' }
];

let activeTabId = 'tab-dual-chat-1';
let counters = { 'tab-dual-chat': 1, 'tab-browser': 1 };

export function initTabManager() {
  const list = document.getElementById('right-tab-list');
  const addBtn = document.getElementById('right-tab-add-btn');
  if (!list) return;

  renderTabs();
  bindAddButton(addBtn);
}

function renderTabs() {
  const list = document.getElementById('right-tab-list');
  if (!list) return;
  list.innerHTML = activeTabs.map(t => {
    const def = tabDefs[t.base];
    return `<button class="right-tab-btn ${t.id === activeTabId ? 'active' : ''}" data-tab-id="${t.id}" data-base="${t.base}" title="${t.label}">
      <span class="tab-icon-wrap">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${def?.icon || ''}</svg>
        ${activeTabs.length > 1 ? '<svg class="tab-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' : ''}
      </span>
      <span class="tab-label">${t.label}</span>
    </button>`;
  }).join('');
  bindTabEvents();
}

function bindTabEvents() {
  const list = document.getElementById('right-tab-list');
  if (!list) return;

  // Click to activate
  list.querySelectorAll('.right-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      const id = btn.dataset.tabId;
      if (document.querySelector('.right-sidebar')?.classList.contains('collapsed')) {
        document.querySelector('.right-sidebar')?.classList.remove('collapsed');
      }
      activateTab(id);
    });

    // Middle-click close
    btn.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(btn.dataset.tabId); }
    });

    // Drag init
    initDrag(btn);
  });

  // Wheel scroll
  list.addEventListener('wheel', (e) => {
    if (e.deltaY) { e.preventDefault(); list.scrollLeft += e.deltaY; }
  }, { passive: false });
}

/* ── Tab activation ── */
function activateTab(id) {
  const tab = activeTabs.find(t => t.id === id);
  if (!tab) return;
  activeTabId = id;
  document.querySelectorAll('.right-tab-panel').forEach(p => p.classList.remove('active'));
  if (tab.panel) {
    const panel = document.getElementById(tab.panel);
    if (panel) panel.classList.add('active');
  }
  renderTabs();
}

/* ── Tab close ── */
function closeTab(id) {
  if (activeTabs.length <= 1) return;
  const idx = activeTabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  activeTabs.splice(idx, 1);
  if (id === activeTabId) activeTabId = activeTabs[0].id;
  activateTab(activeTabId);
}

/* ── Drag reorder ── */
let dragSrc = -1;
let dragClone = null;
let isDragging = false;
let dragTimeout = null;

function initDrag(btn) {
  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest('.tab-close')) return;
    const start = { x: e.clientX, y: e.clientY };
    dragTimeout = setTimeout(() => {
      isDragging = true;
      dragSrc = Array.from(btn.parentElement.children).indexOf(btn);
      btn.classList.add('dragging');
      dragClone = btn.cloneNode(true);
      dragClone.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;opacity:0.7;';
      document.body.appendChild(dragClone);
      posClone(e);
    }, 300);
    const onMove = (e) => {
      if (dragTimeout) {
        if (Math.abs(e.clientX - start.x) > 5 || Math.abs(e.clientY - start.y) > 5) clearTimeout(dragTimeout);
      }
      if (isDragging) {
        posClone(e);
        document.querySelectorAll('.right-tab-btn').forEach(b => b.classList.remove('drag-over'));
        const over = document.elementsFromPoint(e.clientX, e.clientY).find(el => el.classList?.contains('right-tab-btn'));
        if (over && over !== btn) over.classList.add('drag-over');
      }
    };
    const onUp = () => {
      clearTimeout(dragTimeout);
      if (dragClone) { dragClone.remove(); dragClone = null; }
      if (isDragging) {
        btn.classList.remove('dragging');
        document.querySelectorAll('.right-tab-btn').forEach(b => b.classList.remove('drag-over'));
        const list = document.getElementById('right-tab-list');
        if (list) {
          const over = list.querySelector('.drag-over');
          if (over) {
            const overIdx = Array.from(list.children).indexOf(over);
            if (overIdx !== dragSrc && dragSrc >= 0) {
              const tab = activeTabs.splice(dragSrc, 1)[0];
              activeTabs.splice(overIdx, 0, tab);
              renderTabs();
            }
          }
        }
        isDragging = false;
      }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  btn.addEventListener('mousedown', onDown);
}

function posClone(e) {
  if (dragClone) { dragClone.style.left = (e.clientX - 20) + 'px'; dragClone.style.top = (e.clientY - 13) + 'px'; }
}

/* ── Add tab button ── */
function bindAddButton(btn) {
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('add-tab-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.id = 'add-tab-menu';
    menu.className = 'attached-dropdown-menu show';
    const rect = btn.getBoundingClientRect();
    menu.style.cssText = `position:fixed;z-index:1000;width:140px;top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;left:auto;`;
    menu.innerHTML = Object.entries(tabDefs).map(([key, def]) =>
      `<div class="attached-menu-item" data-base="${key}">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${def.icon}</svg>
        <span>${def.label}</span>
      </div>`
    ).join('');
    document.body.appendChild(menu);
    menu.querySelectorAll('.attached-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const base = item.dataset.base;
        const existing2 = activeTabs.find(t => t.base === base);
        if (existing2) { activateTab(existing2.id); menu.remove(); return; }
        const def = tabDefs[base];
        let id, label;
        if (def.multi) {
          counters[base] = (counters[base] || 0) + 1;
          id = base + '-' + counters[base];
          label = def.label + ' ' + counters[base];
        } else {
          id = base; label = def.label;
        }
        const panel = document.getElementById(base);
        activeTabs.push({ id, base, label, panel: base });
        activateTab(id);
        menu.remove();
      });
    });
    document.addEventListener('click', () => menu.remove(), { once: true });
  });
}
