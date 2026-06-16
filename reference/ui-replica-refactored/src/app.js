/**
 * Main application entry point.
 * Initializes all modules and binds interactions.
 */
import { store } from './services/store.js';
import { eventBus } from './services/eventBus.js';
import { ThemeService } from './services/themeService.js';
import { KeyboardShortcuts } from './services/keyboardShortcuts.js';
import { roundManager } from './services/roundManager.js';
import { initSidebar } from './components/Sidebar/sidebar.js';
import { initChat, renderCurrentMessages, activateChat } from './components/Chat/chat.js';
import { initModals } from './components/Modals/modalManager.js';
import { initFileExplorer } from './components/RightSidebar/FileExplorer/file-explorer.js';
import { initDiffCenter } from './components/RightSidebar/DiffCenter/diff-center.js';
import { initDualChat } from './components/RightSidebar/DualChat/dual-chat.js';
import { initTokenMetrics } from './components/RightSidebar/token-metrics.js';
import { initBrowserPanel } from './components/RightSidebar/browser-panel.js';
import { initAttachedDropdowns } from './components/Chat/attachedDropdowns.js';
import { initSlashCommands, initDemoButton, setInputMode, activateEmptyState, activateChatMode } from './services/demos.js';
import { initContextMenu } from './components/Sidebar/contextMenu.js';
import { initAddProviderModal } from './components/Modals/addProviderModal.js';
import { initFavoritesPanel } from './components/Panels/favoritesPanel.js';
import { initSkillsPanel } from './components/Panels/skillsPanel.js';
import { initBreadcrumbMenus } from './components/Panels/breadcrumbMenus.js';
import { demoStore } from './data/demoStore.js';
import { renderSidebar } from './services/sidebarEngine.js';
import { highlightCode } from './utils/highlight.js';
import { escapeHTML } from './utils/escape.js';
import { AnnotationStore } from './components/Shared/Annotation/annotationStore.js';

document.addEventListener('DOMContentLoaded', () => {
  try {
  // ── 1. Init core services ──
  ThemeService.init();
  // Sync theme card with actual theme
  const savedTheme = localStorage.getItem('mycodex_theme') || 'light';
  document.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('active', c.dataset.themeVal === savedTheme));
  KeyboardShortcuts.init();
  initSidebar();
  initChat();
  initModals();
  initFileExplorer();
  initDiffCenter();
  initDualChat();
  initTokenMetrics();
  initBrowserPanel();
  initAttachedDropdowns();
  initSlashCommands();
  // Demo capsule
  const capsule = document.getElementById('demo-capsule');
  if (capsule) {
    capsule.addEventListener('click', (e) => {
      if (e.target.closest('.demo-capsule-menu')) return;
      const menu = capsule.querySelector('.demo-capsule-menu');
      menu.classList.toggle('show');
    });
    capsule.querySelectorAll('.demo-capsule-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        if (action === 'tool' && window.demoContinuousToolCalls) window.demoContinuousToolCalls({ count: 8, interval: 900 });
        if (action === 'plan' && window.demoPlanFlow) window.demoPlanFlow();
        if (action === 'approve' && window.demoApproval) window.demoApproval();
        capsule.querySelector('.demo-capsule-menu').classList.remove('show');
      });
    });
    document.addEventListener('click', () => capsule.querySelector('.demo-capsule-menu').classList.remove('show'));
  }

  // Project status button
  document.getElementById('project-status-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('project-status-panel');
    const existing = document.querySelector('.project-status-panel.show');
    if (existing && existing !== panel) existing.classList.remove('show');
    panel.classList.toggle('show');
    if (panel.classList.contains('show')) {
      const rect = e.target.closest('button').getBoundingClientRect();
      panel.style.left = (rect.right - panel.offsetWidth) + 'px';
      panel.style.top = (rect.bottom + 4) + 'px';
    }
  });
  document.addEventListener('click', () => {
    document.getElementById('project-status-panel')?.classList.remove('show');
  });
  document.getElementById('project-status-panel')?.addEventListener('click', (e) => e.stopPropagation());
  initContextMenu();
  initAddProviderModal();
  initFavoritesPanel();
  initSkillsPanel();
  initBreadcrumbMenus();

  // Render sidebar from demoStore
  const dynamicSections = document.getElementById('dynamic-sections');
  if (dynamicSections) {
    const doRender = () => {
      try { renderSidebar(dynamicSections); } catch(e) { dynamicSections.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;">渲染错误: ' + e.message + '</div>'; }
      // Re-bind accordion toggles for newly rendered sections
      document.querySelectorAll('.accordion-section > .accordion-header, .accordion-folder > .accordion-header').forEach(header => {
        header.addEventListener('click', (e) => {
          if (e.target.closest('.item-actions, .section-actions')) return;
          const accordion = header.closest('.accordion');
          const expanded = accordion.getAttribute('data-expanded') !== 'false';
          accordion.setAttribute('data-expanded', String(!expanded));
        });
      });
    };
    doRender();
    eventBus.on('sidebar:filter', doRender);
  }

  // Update titlebar status from demoStore
  const ui = demoStore.ui;
  const statusItem = document.querySelector('.win-status-item span:last-child');
  if (statusItem) statusItem.textContent = `${ui.model} · ${ui.latency}ms`;
  const branchEl = document.querySelector('.win-status-item.status-git span:last-child');
  if (branchEl) branchEl.textContent = ui.branch;

  // Default to empty state
  setInputMode('empty');

  // Set first conversation as default
  const firstConv = demoStore.getConversations()[0];
  if (firstConv) {
    store.set('currentChatId', firstConv.id);
    demoStore.updateUI({ currentConversationId: firstConv.id });
  }
  } catch(e) { console.error('Init error:', e); }
  // All event bindings continue below regardless of init errors...

  // ── 3. Titlebar interactions ──
  const winCloseBtn = document.getElementById('win-close-btn');
  const winMinBtn = document.getElementById('win-min-btn');
  const winMaxBtn = document.getElementById('win-max-btn');
  const macWindow = document.querySelector('.mac-window');

  if (winCloseBtn) {
    winCloseBtn.addEventListener('click', () => {
      macWindow.style.display = 'none';
      let restoreBtn = document.querySelector('.restore-window-btn');
      if (!restoreBtn) {
        restoreBtn = document.createElement('button');
        restoreBtn.className = 'restore-window-btn';
        restoreBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:16px;height:16px;margin-right:8px;"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg> Open MyCodex Demo`;
        Object.assign(restoreBtn.style, {
          position: 'absolute', padding: '12px 24px', backgroundColor: '#fafafa',
          border: 'none', borderRadius: '30px', fontSize: '14px', fontWeight: '500',
          cursor: 'pointer', boxShadow: '0 10px 25px rgba(0,0,0,0.04)',
          fontFamily: 'Inter, sans-serif', display: 'flex', alignItems: 'center',
          transition: 'all 0.2s', zIndex: '1000'
        });
        restoreBtn.addEventListener('mouseenter', () => {
          restoreBtn.style.transform = 'translateY(-2px)';
          restoreBtn.style.boxShadow = '0 15px 30px rgba(0,0,0,0.06)';
          restoreBtn.style.backgroundColor = '#f2f2f2';
        });
        restoreBtn.addEventListener('mouseleave', () => {
          restoreBtn.style.transform = 'translateY(0)';
          restoreBtn.style.boxShadow = '0 10px 25px rgba(0,0,0,0.04)';
          restoreBtn.style.backgroundColor = '#fafafa';
        });
        restoreBtn.addEventListener('click', () => {
          macWindow.style.display = 'flex';
          restoreBtn.style.display = 'none';
        });
        document.querySelector('.desktop-background')?.appendChild(restoreBtn);
      }
    });
  }

  if (winMinBtn) {
    winMinBtn.addEventListener('click', () => {
      macWindow.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s';
      if (macWindow.style.transform === 'scale(0.3) translateY(100%)') {
        macWindow.style.transform = 'scale(1) translateY(0)';
        macWindow.style.opacity = '1';
      } else {
        macWindow.style.transform = 'scale(0.3) translateY(100%)';
        macWindow.style.opacity = '0';
        setTimeout(() => {
          macWindow.style.transform = 'scale(1) translateY(0)';
          macWindow.style.opacity = '1';
        }, 2000);
      }
    });
  }

  if (winMaxBtn) {
    winMaxBtn.addEventListener('click', () => {
      const isMaximized = macWindow.style.maxWidth === '100%';
      const iconMaximize = winMaxBtn.querySelector('.icon-maximize');
      const iconRestore = winMaxBtn.querySelector('.icon-restore');
      if (isMaximized) {
        macWindow.style.maxWidth = '1120px';
        macWindow.style.height = '90vh';
        macWindow.style.borderRadius = '12px';
        if (iconMaximize) iconMaximize.style.display = 'block';
        if (iconRestore) iconRestore.style.display = 'none';
      } else {
        macWindow.style.maxWidth = '100%';
        macWindow.style.height = '100%';
        macWindow.style.borderRadius = '0';
        if (iconMaximize) iconMaximize.style.display = 'none';
        if (iconRestore) iconRestore.style.display = 'block';
      }
    });
  }

  // ── 4. Input dropdown triggers ──
  document.querySelectorAll('.dropdown-trigger').forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = trigger.closest('.dropdown').querySelector('.dropdown-menu');
      if (!menu) return;
      document.querySelectorAll('.dropdown-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
      menu.classList.toggle('show');
    });
  });
  document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = item.closest('.dropdown-menu');
      if (!menu) return;
      menu.querySelectorAll('.menu-item').forEach(sib => sib.classList.remove('selected'));
      item.classList.add('selected');
      const trigger = menu.closest('.dropdown').querySelector('.dropdown-trigger span');
      if (trigger) trigger.textContent = item.textContent;
      menu.classList.remove('show');
    });
  });

  // ── 5. Menu interactions ──
  document.querySelectorAll('.win-menu-item').forEach(item => {
    item.addEventListener('click', function(e) {
      if (e.target.closest('.win-menu-dropdown')) return;
      e.stopPropagation();
      document.querySelectorAll('.win-menu-item.active').forEach(el => {
        if (el !== this) el.classList.remove('active');
      });
      this.classList.toggle('active');
    });
  });

  // Right sidebar tab switching (delegated)
  document.getElementById('right-tab-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.right-tab-btn');
    if (!btn) return;
    document.querySelectorAll('.right-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tabId = btn.dataset.tab;
    document.querySelectorAll('.right-tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(tabId);
    if (panel) panel.classList.add('active');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.win-menu-item')) {
      document.querySelectorAll('.win-menu-item.active').forEach(el => el.classList.remove('active'));
    }
  });

  // Menu item actions
  document.getElementById('menu-toggle-right-sidebar')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelector('.right-sidebar')?.classList.toggle('collapsed');
  });
  document.getElementById('menu-toggle-sidebar')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelector('.sidebar')?.classList.toggle('collapsed');
  });

  // ── 5. Title copy dropdown ──
  document.getElementById('title-copy-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.querySelector('#title-copy-dropdown .title-dropdown-menu');
    document.querySelectorAll('.title-dropdown-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    menu?.classList.toggle('show');
  });
  document.querySelectorAll('#title-copy-dropdown .title-dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      if (action === 'copy-session') navigator.clipboard.writeText(document.querySelector('.message-list')?.textContent || '');
      if (action === 'copy-path') navigator.clipboard.writeText(demoStore.ui.activeProject || '');
      document.querySelector('#title-copy-dropdown .title-dropdown-menu')?.classList.remove('show');
    });
  });

  // ── 5. Title more dropdown ──
  document.getElementById('title-more-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.querySelector('#title-more-dropdown .title-dropdown-menu');
    document.querySelectorAll('.title-dropdown-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    menu?.classList.toggle('show');
  });
  document.querySelectorAll('#title-more-menu > .title-dropdown-item:not(.menu-has-sub)').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      if (action === 'rename') document.getElementById('rename-modal')?.classList.add('show');
      if (action === 'pin') {
        const el = document.querySelector(`[data-id="${store.get('currentChatId')}"]`);
        if (el) { el.dataset.pinnedId = store.get('currentChatId');
          const text = el.querySelector('.item-text, .nested-text, .chat-title')?.textContent || '';
          document.getElementById('pinned-list').innerHTML += '<li class="list-item chat-item pinned-clone" data-original-id="' + store.get('currentChatId') + '" data-id="' + store.get('currentChatId') + '"><div class="item-main"><span class="item-text">' + text + '</span></div></li>';
        }
        eventBus.emit('sidebar:filter');
      }
      if (action === 'archive') {
        demoStore.updateConversation(store.get('currentChatId'), { archived: true });
        eventBus.emit('sidebar:filter');
      }
      if (action === 'new-window') alert('在新窗口中打开对话');
      document.querySelector('#title-more-dropdown .title-dropdown-menu')?.classList.remove('show');
    });
  });
  document.querySelectorAll('.title-dropdown-submenu .title-dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const apps = { 'open-vscode': 'VS Code', 'open-notepad': '记事本', 'open-explorer': '资源管理器' };
      alert(`在 ${apps[item.dataset.action] || ''} 中打开当前工作目录`);
      document.querySelector('#title-more-dropdown .title-dropdown-menu')?.classList.remove('show');
    });
  });
  // Close title dropdowns on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.title-dropdown-menu.show, .dropdown-menu.show').forEach(m => m.classList.remove('show'));
  });

  // ── 6. Sidebar sections accordion ──
  document.querySelectorAll('.accordion-section > .accordion-header, .accordion-folder > .accordion-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.item-actions, .section-actions')) return;
      const accordion = header.closest('.accordion');
      const expanded = accordion.getAttribute('data-expanded') !== 'false';
      accordion.setAttribute('data-expanded', String(!expanded));
    });
  });

  // ── 7. Feature accordion ──
  const featureAccordion = document.getElementById('feature-accordion');
  const featureTrigger = document.getElementById('feature-accordion-trigger');
  if (featureTrigger && featureAccordion) {
    featureTrigger.addEventListener('click', () => {
      const expanded = featureAccordion.getAttribute('data-expanded') !== 'false';
      featureAccordion.setAttribute('data-expanded', String(!expanded));
    });
  }

  // ── 8. Feature panel switcher ──
  document.querySelectorAll('.feature-item').forEach(item => {
    item.addEventListener('click', () => {
      const viewId = item.getAttribute('data-panel');
      document.querySelectorAll('.feature-item').forEach(f => f.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.feature-panel-view').forEach(v => v.style.display = 'none');
      document.querySelectorAll('.command-bar, .chat-area, .input-panel-container').forEach(el => {
        if (el) el.style.display = 'none';
      });
      const target = document.getElementById(`view-${viewId}`);
      if (target) target.style.display = 'flex';
      document.querySelector('.panel-title').textContent = `功能 / ${item.textContent.trim()}`;
    });
  });

  // ── 9. Search box -> command palette ──
  const winSearchBox = document.querySelector('.win-search-box');
  if (winSearchBox) {
    winSearchBox.addEventListener('click', (e) => {
      e.stopPropagation();
      eventBus.emit('command-palette:open');
    });
  }

  // ── 10. Palette item click -> actions ──
  document.querySelectorAll('.palette-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.getAttribute('data-action');
      document.getElementById('command-palette-modal')?.style.setProperty('display', 'none');
      switch (action) {
        case 'toggle-sidebar': eventBus.emit('sidebar:toggle'); break;
        case 'new-chat': eventBus.emit('chat:new'); break;
        case 'open-settings': document.getElementById('settings-modal')?.classList.add('show'); break;
      }
    });
  });

  // ── 11. Input handling ──
  const textarea = document.querySelector('.chat-textarea');
  const sendBtn = document.querySelector('.send-btn');
  if (textarea && sendBtn) {
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = (textarea.scrollHeight - 6) + 'px';
      const hasText = textarea.value.trim() !== '';
      sendBtn.classList.toggle('active', hasText);
      sendBtn.disabled = !hasText;
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = textarea.value.trim();
        if (!text) return;
        const userMsg = { role: 'user', content: escapeHTML(text) };
        const chatId = store.get('currentChatId');
        const conv = demoStore.getConversation(chatId);
        if (conv) conv.messages.push(userMsg);
        const msgEl = document.createElement('div');
        msgEl.innerHTML = `<div class="chat-message user-message"><div class="message-bubble">${escapeHTML(text)}</div></div>`;
        document.querySelector('.message-list')?.appendChild(msgEl.firstElementChild);
        textarea.value = '';
        textarea.style.height = 'auto';
        sendBtn.classList.remove('active');
        sendBtn.disabled = true;
      }
    });
  }

  // ── 12. Right sidebar visibility ──
  const setRightSidebarVisible = (visible) => {
    const s = document.querySelector('.right-sidebar');
    if (s) {
      if (visible) {
        s.classList.remove('collapsed');
      } else {
        s.classList.add('collapsed');
      }
    }
  };

  // ── 13. Window controls: sidebar toggles ──
  document.getElementById('win-toggle-sidebar-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const sidebar = document.querySelector('.sidebar');
    sidebar?.classList.toggle('collapsed');
  });
  // Panel sidebar toggle: opens dropdown menu to select a panel
  const toggleWrap = document.querySelector('.panel-sidebar-toggle-wrap');
  const toggleBtn = document.getElementById('panel-sidebar-toggle');
  const toggleMenu = document.getElementById('panel-sidebar-menu');
  if (toggleBtn && toggleMenu) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu.classList.toggle('show');
      toggleWrap?.classList.toggle('open');
    });
    // Select a panel → open right sidebar with that panel
    toggleMenu.querySelectorAll('.panel-sidebar-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const panelId = item.dataset.panel;
        const rs = document.querySelector('.right-sidebar');
        if (rs) {
          rs.classList.remove('collapsed');
          document.querySelectorAll('.right-tab-panel').forEach(p => p.classList.remove('active'));
          const panel = document.getElementById(panelId);
          if (panel) panel.classList.add('active');
        }
        toggleMenu.classList.remove('show');
        toggleWrap?.classList.remove('open');
      });
    });
    // Close on outside click
    document.addEventListener('click', () => {
      if (toggleMenu.classList.contains('show')) {
        toggleMenu.classList.remove('show');
        toggleWrap?.classList.remove('open');
      }
    });
  }

  // ── 13. Quick chat → empty state ──
  const activateQuickChat = () => {
    document.querySelectorAll('.chat-item, .nested-item').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.feature-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.feature-panel-view').forEach(v => v.style.display = 'none');
    const ml = document.querySelector('.message-list');
    if (ml) ml.style.display = 'none';
    const cb = document.querySelector('.command-bar');
    if (cb) cb.style.display = 'none';
    const ic = document.querySelector('.input-panel-container');
    if (ic) ic.style.display = 'none';
    const es = document.getElementById('empty-chat-state');
    if (es) {
      es.style.display = 'flex';
      const g = es.querySelector('.empty-greeting');
      if (g) g.textContent = '我们应该在' + (store.get('activeProject') || 'mycodex-demo') + ' 中构建什么？';
      const iw = document.querySelector('.input-area-wrapper');
      const ec = es.querySelector('.empty-state-content');
      if (iw && ec) {
        ec.appendChild(iw);
        setInputMode('empty');
        document.querySelectorAll('.attached-dropdown-menu').forEach(m => m.classList.remove('show'));
        const ta = iw.querySelector('.chat-textarea');
        if (ta) { ta.value = ''; ta.style.height = 'auto'; }
        const sb = iw.querySelector('.send-btn');
        if (sb) { sb.classList.remove('active'); sb.disabled = true; }
      }
    }
    const pt = document.querySelector('.panel-title');
    if (pt) pt.textContent = '对话 / 快速对话';
    setRightSidebarVisible(false);
    document.querySelector('.quick-chat-btn')?.classList.add('active');
  };

  document.querySelector('.quick-chat-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    activateQuickChat();
  });

  // ── 14. Close sub-agent ──
  document.getElementById('close-sub-agent-btn')?.addEventListener('click', () => {
    document.getElementById('sub-agent-view').style.display = 'none';
  });

  // ── 15. Project add-chat buttons (delegated) ──
  document.querySelector('.sidebar')?.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.project-add-chat-btn');
    if (addBtn) {
      e.stopPropagation();
      const projectItem = addBtn.closest('.project-item');
      const nestedList = projectItem?.querySelector('.nested-list');
      if (nestedList) {
        const name = prompt('输入新对话名:', '新对话');
        if (name) {
          const id = 'chat-' + Date.now();
          const li = document.createElement('li');
          li.className = 'nested-item chat-item';
          li.dataset.id = id;
          li.innerHTML = `<span class="nested-text">${escapeHTML(name)}</span><span class="chat-time">1m</span>`;
          nestedList.appendChild(li);
          eventBus.emit('chat:select', id, name, li);
        }
      }
    }
  });

  // ── 16. Sidebar action buttons: handled by sidebar.js (delegated)
  // (old static handlers removed) 

  // ── 14. Rename modal ──
  const renameModal = document.getElementById('rename-modal');
  document.getElementById('btn-cancel-rename')?.addEventListener('click', () => renameModal.classList.remove('show'));
  document.getElementById('close-rename-modal-btn')?.addEventListener('click', () => renameModal.classList.remove('show'));

  // ── 15. Annotation trigger from file line numbers ──
  document.addEventListener('annotation:trigger', (e) => {
    const { target, text } = e.detail;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.15);';
    overlay.innerHTML = `<div style="background:#fff;border-radius:12px;padding:16px;width:380px;max-width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.15);display:flex;flex-direction:column;gap:10px;"><div style="font-size:11px;color:#999;word-break:break-word;">${escapeHTML(text)}</div><textarea class="ann-input" placeholder="输入批注内容..." style="width:100%;min-height:60px;border:1px solid #e5e5e5;border-radius:8px;padding:8px;font-size:13px;font-family:Inter,sans-serif;outline:none;resize:vertical;"></textarea><div style="display:flex;justify-content:flex-end;gap:8px;"><button class="ann-cancel" style="padding:6px 12px;border:1px solid #e5e5e5;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;color:#666;">取消</button><button class="ann-save" style="padding:6px 14px;border:none;border-radius:8px;background:#10b981;color:#fff;cursor:pointer;font-size:12px;font-weight:500;">保存批注</button></div></div>`;
    overlay.querySelector('.ann-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.ann-save').addEventListener('click', () => {
      const comment = overlay.querySelector('.ann-input').value.trim();
      if (comment) AnnotationStore.add({ type: 'file_line', target, text, comment, source: 'user' });
      overlay.remove();
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    overlay.querySelector('.ann-input').focus();
  });

  // ── 16. Sidebar resize ──
  initSidebarResize(document.querySelector('.sidebar'), 'right', 'sidebar-left-width', 190);
  initSidebarResize(document.querySelector('.right-sidebar'), 'left', 'sidebar-right-width', 300);

  function initSidebarResize(sidebar, edge, storageKey, minWidth) {
    if (!sidebar) return;
    let isResizing = false;
    const onMouseDown = (e) => {
      isResizing = true;
      sidebar.dataset.initWidth = sidebar.offsetWidth;
      sidebar.classList.add('resizing');
      sidebar.style.transition = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    };
    const onMouseMove = (e) => {
      if (!isResizing) return;
      const rect = sidebar.parentElement.getBoundingClientRect();
      const initW = parseFloat(sidebar.dataset.initWidth) || rect.width;
      let newW = edge === 'right' ? e.clientX - rect.left : rect.right - e.clientX;
      if (newW < initW * 0.5) {
        sidebar.classList.add('collapsed');
        isResizing = false;
        sidebar.classList.remove('resizing');
        sidebar.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        return;
      }
      newW = Math.max(minWidth, Math.min(newW, rect.width * 0.5));
      sidebar.style.width = newW + 'px';
    };
    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      sidebar.classList.remove('resizing');
      sidebar.style.transition = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    sidebar.addEventListener('mousedown', (e) => {
      const r = sidebar.getBoundingClientRect();
      if (edge === 'right' && e.clientX >= r.right - 6 && e.clientX <= r.right) onMouseDown(e);
      if (edge === 'left' && e.clientX >= r.left && e.clientX <= r.left + 6) onMouseDown(e);
    });
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }
});
