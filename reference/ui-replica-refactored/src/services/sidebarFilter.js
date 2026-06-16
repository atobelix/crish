/**
 * SidebarFilter — cascading filter/sort menu.
 * Renders a multi-level cascading menu bound to #sf-trigger.
 */
import { eventBus } from './eventBus.js';
import { demoStore } from '../data/demoStore.js';

export const FilterState = {
  sortBy: 'recent',
  groupBy: 'project',
  archiveFilter: 'active',
  timeFilter: 0,
  projectFilter: []
};

/* ── Helper: synced item HTML ── */
function opt(label, value, current, isMulti = false) {
  const active = isMulti
    ? current.includes(value)
    : current === value;
  return `<div class="sf-cascading-item${active ? ' active' : ''}" data-value="${value}">
    <span>${label}</span>
    ${active ? '<span class="sf-cascading-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
  </div>`;
}

/* ── Build the full cascading menu HTML ── */
export function renderFilterPanel() {
  const s = FilterState;
  const projects = demoStore.projects.map(p => p.name);

  return `<div class="sf-cascading-menu" id="sf-cascading-menu">
    <div class="sf-cascading-header">排序与过滤</div>

    <div class="sf-cascading-item">
      <span>排序方式</span>
      <span class="sf-cascading-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
      <div class="sf-cascading-submenu">
        ${opt('最近活跃', 'recent', s.sortBy)}
        ${opt('创建时间', 'created', s.sortBy)}
      </div>
    </div>

    <div class="sf-cascading-item">
      <span>分组方式</span>
      <span class="sf-cascading-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
      <div class="sf-cascading-submenu">
        ${opt('按时间', 'time', s.groupBy)}
        ${opt('按项目', 'project', s.groupBy)}
      </div>
    </div>

    <div class="sf-cascading-item">
      <span>存档状态</span>
      <span class="sf-cascading-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
      <div class="sf-cascading-submenu">
        ${opt('正在使用', 'active', s.archiveFilter)}
        ${opt('已归档', 'archived', s.archiveFilter)}
        ${opt('全部', 'all', s.archiveFilter)}
      </div>
    </div>

    <div class="sf-cascading-item">
      <span>最近活跃</span>
      <span class="sf-cascading-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
      <div class="sf-cascading-submenu">
        ${opt('全部', 0, s.timeFilter)}
        ${opt('最近1天', 1, s.timeFilter)}
        ${opt('最近3天', 3, s.timeFilter)}
        ${opt('最近7天', 7, s.timeFilter)}
        ${opt('最近30天', 30, s.timeFilter)}
      </div>
    </div>

    ${projects.length > 0 ? `<div class="sf-cascading-item">
      <span>按项目过滤</span>
      <span class="sf-cascading-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
      <div class="sf-cascading-submenu">
        ${projects.map(p => opt(p, p, s.projectFilter, true)).join('')}
      </div>
    </div>` : ''}
  </div>`;
}

/* ── Bind filter triggers (delegated — sf-trigger is dynamic) ── */
export function bindFilterCascading() {
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.sf-trigger');
    if (!trigger) return;
    e.stopPropagation();

    const existing = document.getElementById('sf-cascading-menu');
    if (existing) { existing.classList.remove('show'); existing.remove(); return; }
    
    const div = document.createElement('div');
    div.innerHTML = renderFilterPanel();
    const menu = div.firstElementChild;
    document.body.appendChild(menu);
    // Position
    const rect = trigger.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
    setTimeout(() => menu.classList.add('show'), 10);

    // Bind submenu clicks
    menu.querySelectorAll('.sf-cascading-item > .sf-cascading-submenu .sf-cascading-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = item.dataset.value;
        const parentText = item.closest('.sf-cascading-item').querySelector('span:first-child').textContent;
        const map = {
          '最近活跃': 'sortBy', '创建时间': 'sortBy',
          '按时间': 'groupBy', '按项目': 'groupBy',
          '正在使用': 'archiveFilter', '已归档': 'archiveFilter', '全部': 'archiveFilter',
          '全部(时间)': 'timeFilter', '最近1天': 'timeFilter', '最近3天': 'timeFilter', '最近7天': 'timeFilter', '最近30天': 'timeFilter'
        };
        // Determine the key based on parent context
        let key = map[parentText];
        if (!key) {
          if (parentText === '按项目过滤') key = 'projectFilter';
          else if (parentText.includes('天') || parentText === '全部') key = 'timeFilter';
        }
        if (key === 'timeFilter') FilterState[key] = parseInt(val);
        else if (key === 'projectFilter') {
          const idx = FilterState.projectFilter.indexOf(val);
          if (idx > -1) FilterState.projectFilter.splice(idx, 1);
          else FilterState.projectFilter.push(val);
        } else {
          FilterState[key] = val;
        }
        demoStore.updateUI({ sidebarFilter: { ...FilterState } });
        menu.remove();
        eventBus.emit('sidebar:filter', { ...FilterState });
      });
    });

    // Close on outside click
    document.addEventListener('click', () => { menu.remove(); }, { once: true });
  });
}
