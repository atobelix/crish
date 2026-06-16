/**
 * DiffCenter — round-based diff viewer.
 * Shows current AI editing round by default.
 * Dropdown to switch between rounds.
 * NO stage/commit UI.
 */
import { demoStore } from '../../../data/demoStore.js';
import { eventBus } from '../../../services/eventBus.js';
import { renderDiffView } from '../../../utils/diffHelper.js';

function renderFileList(files) {
  const entries = Object.entries(files);
  if (entries.length === 0) return '<div class="dc-empty">当前轮次暂无改动</div>';
  return entries.map(([filepath, diff]) => {
    const added = diff.added || 0;
    const removed = diff.removed || 0;
    return `
      <div class="dc-file-item" data-file="${filepath}">
        <div class="dc-file-header">
          <svg class="dc-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px;flex-shrink:0;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <span class="dc-file-name">${filepath}</span>
          <span class="dc-file-stats">
            <span class="diff-stat-added">+${added}</span>
            <span class="diff-stat-removed">-${removed}</span>
          </span>
          <svg class="dc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;color:var(--text-muted);transition:transform 0.15s;">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="dc-file-diff" style="display:none;">
          ${renderDiffView(diff)}
        </div>
      </div>`;
  }).join('');
}

export function initDiffCenter() {
  const panel = document.getElementById('tab-diff-center');
  if (!panel) return;
  renderDiffCenter(panel);
  eventBus.on('round:diff', () => renderDiffCenter(panel));
  eventBus.on('chat:select', () => renderDiffCenter(panel));
}

function renderDiffCenter(panel) {
  const convId = demoStore.ui.currentConversationId;
  const conv = demoStore.getConversation(convId);
  const rounds = conv ? conv.rounds : [];
  const currentRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;

  panel.innerHTML = `
    <div class="dc-container">
      <div class="dc-header">
        <span class="dc-title">改动总览</span>
        <div class="dc-round-selector">
          <button class="dc-round-dropdown-trigger">
            <span class="dc-round-label">${currentRound ? currentRound.prompt.slice(0, 24) + (currentRound.prompt.length > 24 ? '...' : '') : '无改动'}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
          <div class="dc-round-menu" style="display:none;">
            ${rounds.length === 0 ? '<div class="dc-round-item disabled">暂无历史轮次</div>' :
              rounds.map((r, i) => {
                const fileCount = Object.keys(r.diffs).length;
                const totalAdded = Object.values(r.diffs).reduce((s, f) => s + (f.added || 0), 0);
                const totalRemoved = Object.values(r.diffs).reduce((s, f) => s + (f.removed || 0), 0);
                const isCurrent = i === rounds.length - 1;
                return `<div class="dc-round-item ${isCurrent ? 'active' : ''}" data-round="${i}">
                  <span class="dc-round-prompt">${r.prompt.slice(0, 30)}${r.prompt.length > 30 ? '...' : ''}</span>
                  <span class="dc-round-meta">${fileCount} 文件 · +${totalAdded} -${totalRemoved}</span>
                </div>`;
              }).join('')}
          </div>
        </div>
      </div>
      <div class="dc-file-list">
        ${currentRound && Object.keys(currentRound.diffs).length > 0
          ? renderFileList(currentRound.diffs)
          : '<div class="dc-empty">暂无改动，等待 AI 工作...</div>'}
      </div>
    </div>
  `;

  bindEvents(panel);
}

function bindEvents(panel) {
  // ── File item toggle ──
  panel.querySelectorAll('.dc-file-header').forEach(header => {
    header.addEventListener('click', () => {
      const item = header.closest('.dc-file-item');
      const diff = item.querySelector('.dc-file-diff');
      const chevron = header.querySelector('.dc-chevron');
      const isOpen = diff.style.display !== 'none';
      diff.style.display = isOpen ? 'none' : 'block';
      chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
    });
  });

  // ── Round selector dropdown ──
  const trigger = panel.querySelector('.dc-round-dropdown-trigger');
  const menu = panel.querySelector('.dc-round-menu');
  if (trigger && menu) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    panel.querySelectorAll('.dc-round-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const roundIdx = parseInt(item.dataset.round);
        const convId = demoStore.ui.currentConversationId;
        const conv = demoStore.getConversation(convId);
        if (conv && conv.rounds[roundIdx]) {
          const round = conv.rounds[roundIdx];
          panel.querySelector('.dc-round-label').textContent = round.prompt.slice(0, 24) + (round.prompt.length > 24 ? '...' : '');
          const fileList = panel.querySelector('.dc-file-list');
          fileList.innerHTML = Object.keys(round.diffs).length > 0
            ? renderFileList(round.diffs)
            : '<div class="dc-empty">该轮次无改动</div>';
          menu.style.display = 'none';
          // Re-bind file toggles
          panel.querySelectorAll('.dc-file-header').forEach(h => {
            h.addEventListener('click', () => {
              const it = h.closest('.dc-file-item');
              const d = it.querySelector('.dc-file-diff');
              const ch = h.querySelector('.dc-chevron');
              const open = d.style.display !== 'none';
              d.style.display = open ? 'none' : 'block';
              ch.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
            });
          });
        }
      });
    });
    document.addEventListener('click', () => { menu.style.display = 'none'; });
  }
}
