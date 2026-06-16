/**
 * Modal manager — handles all modal open/close logic.
 */
import { eventBus } from '../../services/eventBus.js';
import { ThemeService } from '../../services/themeService.js';

const modals = {
  'command-palette-modal': { trigger: null, close: 'Escape' },
  'settings-modal': { trigger: '.settings-btn', close: true },
  'rename-modal': { trigger: null, close: true }
};

export function initModals() {
  // Global escape closes all modals, ordered by priority
  eventBus.on('escape', () => {
    document.querySelectorAll('.modal-overlay.show').forEach(m => {
      m.classList.remove('show');
    });
    document.querySelectorAll('.attached-dropdown-menu.show').forEach(m => {
      m.classList.remove('show');
    });
  });

  // Settings modal
  const settingsBtn = document.querySelector('.settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  if (settingsBtn && settingsModal) {
    settingsBtn.addEventListener('click', () => settingsModal.classList.add('show'));
    settingsModal.querySelector('.close-modal-btn')?.addEventListener('click', () => settingsModal.classList.remove('show'));
    settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('show'); });
  }

  // Command palette
  eventBus.on('command-palette:open', () => {
    const palette = document.getElementById('command-palette-modal');
    if (palette) {
      palette.style.display = 'flex';
      setTimeout(() => palette.querySelector('.palette-search-input')?.focus(), 50);
    }
  });

  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('show');
    });
  });

  // Settings tab navigation
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      const target = document.getElementById(btn.getAttribute('data-target'));
      if (target) target.classList.add('active');
    });
  });

  // Theme cards (user explicit action)
  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const val = card.getAttribute('data-theme-val');
      ThemeService.setUserTheme(val);
    });
  });

  // MCP Server cards (delegated)
  document.addEventListener('change', (e) => {
    const toggle = e.target.closest('.mcp-toggle-switch');
    if (!toggle) return;
    const card = toggle.closest('.mcp-server-card');
    if (!card) return;
    const dot = card.querySelector('.mcp-status-dot');
    const txt = card.querySelector('.mcp-status-text');
    if (toggle.checked) {
      card.classList.remove('disabled');
      if (dot) dot.classList.add('active');
      if (txt) { txt.textContent = '已连接'; txt.style.color = ''; }
    } else {
      card.classList.add('disabled');
      if (dot) dot.classList.remove('active');
      if (txt) { txt.textContent = '已关闭'; txt.style.color = ''; }
      const cp = card.querySelector('.mcp-config-panel');
      if (cp) cp.classList.remove('expanded');
    }
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.mcp-btn-config');
    if (!btn || btn.closest('.mcp-server-card')?.classList.contains('disabled')) return;
    const cp = btn.closest('.mcp-server-card')?.querySelector('.mcp-config-panel');
    if (cp) cp.classList.toggle('expanded');
  });
  document.addEventListener('click', (e) => {
    const saveBtn = e.target.closest('.mcp-btn-save');
    if (!saveBtn) return;
    e.stopPropagation();
    const card = saveBtn.closest('.mcp-server-card');
    if (!card) return;
    const panel = card.querySelector('.mcp-config-panel');
    const orig = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:11px;height:11px;animation:spin-rotate 1s linear infinite;margin-right:4px;display:inline-block;"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle></svg>保存中...';
    setTimeout(() => {
      saveBtn.disabled = false;
      saveBtn.innerHTML = orig;
      if (panel) panel.classList.remove('expanded');
      const argsInput = card.querySelector('.mcp-input-args');
      const details = card.querySelector('.mcp-details');
      if (argsInput && details) {
        const parts = argsInput.value.split(' ');
        const pathPart = parts.find(p => p.includes('\\') || p.includes('/'));
        if (pathPart) details.textContent = '路径: ' + pathPart;
      }
      alert('MCP 服务参数配置保存成功并已重连！');
    }, 1200);
  });
}
