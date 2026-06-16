/**
 * SidebarEngine — dynamic sidebar DOM rendering.
 *
 * Renders into `#dynamic-sections`:
 *   1. Master control bar (title + filter + add button)
 *   2. Pinned section (if pinned items exist, unfiltered)
 *   3. Section groups (project or time mode, filtered by state)
 */
import { demoStore } from '../data/demoStore.js';
import { escapeHTML } from '../utils/escape.js';

/* ── Time helpers ── */
function isToday(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }
function isYesterday(ts) { const d = new Date(); d.setDate(d.getDate() - 1); return new Date(ts).toDateString() === d.toDateString(); }
function timeLabel(ts) {
  if (isToday(ts)) return '今天';
  if (isYesterday(ts)) return '昨天';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 3) return '最近3天';
  if (d <= 7) return '最近7天';
  return '更早';
}

/* ── Chat item HTML ── */
function chatItemHTML(conv, nested = false) {
  const cls = `chat-item ${nested ? 'nested-item' : 'list-item'}`;
  const active = conv.id === demoStore.ui.currentConversationId ? ' active' : '';
  const statusHTML = conv.messages.length > 1
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="var(--color-mint)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="var(--color-blue)" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle></svg>';
  const timeStr = isToday(conv.lastActive) ? new Date(conv.lastActive).toTimeString().slice(0, 5) : timeLabel(conv.lastActive);
  const moreBtn = '<button class="item-action-btn item-more-btn" title="更多"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="1.25"></circle><circle cx="18" cy="12" r="1.25"></circle><circle cx="6" cy="12" r="1.25"></circle></svg></button>';
  if (nested) {
    return `<li class="nested-item ${cls}${active}" data-id="${conv.id}">
      <span class="nested-text">${escapeHTML(conv.title)}</span>
      <span class="chat-time">${timeStr}</span>
      <div class="action-status-container">
        <span class="chat-status">${statusHTML}</span>
        <div class="item-actions">${moreBtn}</div>
      </div>
    </li>`;
  }
  return `<li class="${cls}${active}" data-id="${conv.id}">
    <div class="item-main">
      <span class="chat-title">${escapeHTML(conv.title)}</span>
      <span class="chat-time">${timeStr}</span>
      <div class="action-status-container">
        <span class="chat-status">${statusHTML}</span>
        <div class="item-actions">${moreBtn}</div>
      </div>
    </div>
  </li>`;
}

/* ── Folder HTML (only in project mode) ── */
function folderHTML(projectName, conversations) {
  const nestedChats = conversations.map(c => chatItemHTML(c, true)).join('');
  return `<li class="list-item project-item accordion accordion-folder" data-id="${projectName}" data-expanded="true">
    <div class="accordion-header item-main">
      <svg class="icon folder-animated-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path class="folder-back" d="M4 6h4.5l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"></path>
        <path class="folder-front" d="M2 10h20l-1.8 8.2A2 2 0 0 1 18.2 20H5.8a2 2 0 0 1-2-1.8L2 10z"></path>
      </svg>
      <span class="item-text">${escapeHTML(projectName)}</span>
      <span class="accordion-chevron"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="6 9 12 15 18 9"></polyline></svg></span>
      <div class="item-actions">
        <button class="item-action-btn project-add-chat-btn" title="添加对话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
        <button class="item-action-btn item-more-btn" title="更多"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="1.25"></circle><circle cx="18" cy="12" r="1.25"></circle><circle cx="6" cy="12" r="1.25"></circle></svg></button>
      </div>
    </div>
    <div class="accordion-body"><ul class="nested-list">${nestedChats}</ul></div>
  </li>`;
}

/* ── Section (with actions: filter + add) ── */
function buildSection(id, title, addBtnType, listHTML) {
  const addBtn = addBtnType === 'folder'
    ? '<button class="section-action-btn header-add-folder-btn" title="新建项目"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg></button>'
    : '<button class="section-action-btn header-add-chat-btn" title="新建对话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>';
  return `<div class="accordion accordion-section sidebar-section" id="section-${id}" data-expanded="true">
    <div class="accordion-header section-header">
      <span class="section-title">${title}</span>
      <svg class="icon accordion-chevron accordion-chevron-hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
      <div class="section-actions">
        <button class="section-action-btn sf-trigger" title="排序与过滤">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px;">
            <line x1="4" y1="6" x2="20" y2="6"></line><line x1="7" y1="12" x2="17" y2="12"></line>
            <line x1="10" y1="18" x2="14" y2="18"></line>
          </svg>
        </button>
        ${addBtn}
      </div>
    </div>
    <div class="accordion-body"><ul class="section-list" id="${id}-list">${listHTML}</ul></div>
  </div>`;
}

/* ── Pinned section (if items exist, NOT filtered) ── */
function pinnedSectionHTML() {
  const pinned = document.getElementById('pinned-list');
  if (!pinned || pinned.children.length === 0) return '';
  return `<div class="accordion accordion-section sidebar-section" id="section-pinned" data-expanded="true">
    <div class="accordion-header section-header">
      <span class="section-title">置顶</span>
      <svg class="icon accordion-chevron accordion-chevron-hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </div>
    <div class="accordion-body"><ul class="section-list" id="pinned-list">${pinned.innerHTML}</ul></div>
  </div>`;
}

/* ═══════════════ MAIN ENTRY ═══════════════ */
export function renderSidebar(container, filterState = null) {
  try {
    const filter = filterState || demoStore.ui.sidebarFilter;
    const conversations = demoStore.getConversations(filter);

    // 1. Pinned section (clone live DOM content)
    let html = pinnedSectionHTML();

    // 2. Sections
    if (conversations.length === 0) {
      html += '<div class="sidebar-empty-hint">没有匹配的对话</div>';
    } else if (filter.groupBy === 'project') {
      const projectGroups = new Map();
      const standaloneChats = [];
      demoStore.projects.forEach(p => projectGroups.set(p.name, []));
      conversations.forEach(c => {
        if (c.project && projectGroups.has(c.project)) projectGroups.get(c.project).push(c);
        else standaloneChats.push(c);
      });
      const folders = [];
      projectGroups.forEach((chats, name) => { if (chats.length > 0) folders.push(folderHTML(name, chats)); });
      if (folders.length > 0) html += buildSection('projects', '项目', 'folder', folders.join('\n'));
      if (standaloneChats.length > 0) html += buildSection('chats', '对话', 'chat', standaloneChats.map(c => chatItemHTML(c)).join('\n'));
    } else {
      const timeGroups = new Map();
      conversations.forEach(c => {
        const label = timeLabel(c.lastActive);
        if (!timeGroups.has(label)) timeGroups.set(label, []);
        timeGroups.get(label).push(c);
      });
      const order = ['今天', '昨天', '最近3天', '最近7天', '更早'];
      order.forEach(label => {
        const items = timeGroups.get(label);
        if (items && items.length > 0) html += buildSection('time-' + label, label, 'chat', items.map(c => chatItemHTML(c)).join('\n'));
      });
    }

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div style="padding:12px;color:var(--danger);font-size:13px;">渲染错误: ' + e.message + '</div>';
  }
}
