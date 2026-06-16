/**
 * BrowserPanel — embedded browser simulation in right sidebar.
 */
import { store } from '../../services/store.js';
import { eventBus } from '../../services/eventBus.js';

export function initBrowserPanel() {
  const panel = document.getElementById('tab-browser');
  if (!panel) return;

  panel.innerHTML = `
    <div class="browser-container">
      <div class="browser-address-bar">
        <button class="browser-btn" id="browser-back-btn" title="返回">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <button class="browser-btn" id="browser-refresh-btn" title="刷新">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
        </button>
        <div class="browser-url-input-wrapper">
          <input type="text" placeholder="输入 URL" class="browser-url-input" value="http://localhost:5173">
          <svg class="browser-loading-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="display:none;">
            <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle>
          </svg>
        </div>
        <button class="browser-btn inspect-toggle-btn" id="browser-inspect-btn" title="审查元素">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <polyline points="9 17 9 7 15 7 15 17"></polyline>
            <line x1="9" y1="12" x2="15" y2="12"></line>
          </svg>
        </button>
      </div>

      <div class="browser-viewport" id="browser-viewport">
        <div class="browser-inspect-overlay" id="browser-inspect-overlay" style="display:none;">
          <div class="inspect-label" id="inspect-label">div.element</div>
        </div>
        <div class="browser-viewport-content" id="browser-viewport-content">
          <div class="browser-server-hub" id="browser-server-hub">
            <div class="hub-header">
              <span class="hub-title">本地</span>
              <button class="hub-filter-btn" title="筛选">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
              </button>
            </div>
            <div class="hub-list">
              <div class="server-card" data-target="mock-app-todo">
                <div class="server-thumbnail">
                  <div class="thumb-window">
                    <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
                    <div class="thumb-line"></div><div class="thumb-line short"></div>
                  </div>
                </div>
                <div class="server-info">
                  <div class="server-name">MyCodex Demo</div>
                  <div class="server-url">localhost:5173</div>
                </div>
                <span class="status-dot green"></span>
              </div>
              <div class="server-card" data-target="mock-app-flowbit">
                <div class="server-thumbnail">
                  <div class="thumb-window">
                    <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
                    <div class="thumb-line"></div><div class="thumb-line short"></div>
                  </div>
                </div>
                <div class="server-info">
                  <div class="server-name">Flowbit Chat</div>
                  <div class="server-url">localhost:5180</div>
                </div>
                <span class="status-dot green"></span>
              </div>
              <div class="server-card" data-target="mock-app-crish">
                <div class="server-thumbnail">
                  <div class="thumb-window">
                    <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
                    <div class="thumb-line"></div><div class="thumb-line short"></div>
                  </div>
                </div>
                <div class="server-info">
                  <div class="server-name">Crish Workbench</div>
                  <div class="server-url">localhost:8088</div>
                </div>
                <span class="status-dot green"></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  bindEvents(panel);
}

function bindEvents(panel) {
  const serverHub = panel.querySelector('#browser-server-hub');
  const viewport = panel.querySelector('#browser-viewport');
  const content = panel.querySelector('#browser-viewport-content');
  const urlInput = panel.querySelector('.browser-url-input');
  const refreshBtn = panel.querySelector('#browser-refresh-btn');
  const spinner = panel.querySelector('.browser-loading-spinner');

  // Server card click → load mock app
  serverHub?.querySelectorAll('.server-card').forEach(card => {
    card.addEventListener('click', () => {
      const targetId = card.dataset.target;
      if (spinner) spinner.style.display = 'block';
      if (urlInput) urlInput.value = card.querySelector('.server-url')?.textContent || '';
      setTimeout(() => {
        if (spinner) spinner.style.display = 'none';
        serverHub.style.display = 'none';
        // Show target mock app
        content.querySelectorAll('.mock-web-app').forEach(a => a.style.display = 'none');
        let app = content.querySelector(`#${targetId}`);
        if (!app) {
          app = createMockApp(targetId);
          content.appendChild(app);
        }
        app.style.display = 'flex';
        panel.querySelector('#browser-back-btn').disabled = false;
      }, 600);
    });
  });

  // Back button
  panel.querySelector('#browser-back-btn')?.addEventListener('click', () => {
    content.querySelectorAll('.mock-web-app').forEach(a => a.style.display = 'none');
    serverHub.style.display = 'block';
    if (urlInput) urlInput.value = 'http://localhost:5173';
  });

  // Refresh
  refreshBtn?.addEventListener('click', () => {
    if (spinner) spinner.style.display = 'block';
    setTimeout(() => { if (spinner) spinner.style.display = 'none'; }, 800);
  });

  // Inspect toggle
  let inspectMode = false;
  panel.querySelector('#browser-inspect-btn')?.addEventListener('click', () => {
    inspectMode = !inspectMode;
    panel.querySelector('#browser-inspect-btn')?.classList.toggle('active', inspectMode);
    if (!inspectMode) panel.querySelector('#browser-inspect-overlay').style.display = 'none';
  });

  if (viewport) {
    viewport.addEventListener('mousemove', (e) => {
      if (!inspectMode) return;
      const overlay = panel.querySelector('#browser-inspect-overlay');
      const label = panel.querySelector('#inspect-label');
      const activeApp = content.querySelector('.mock-web-app:not([style*="display: none"])');
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target && activeApp?.contains(target) && target !== activeApp) {
        const vr = viewport.getBoundingClientRect();
        const tr = target.getBoundingClientRect();
        overlay.style.cssText = `top:${tr.top - vr.top + viewport.scrollTop}px;left:${tr.left - vr.left + viewport.scrollLeft}px;width:${tr.width}px;height:${tr.height}px;display:block;`;
        let desc = target.tagName.toLowerCase();
        if (target.className && typeof target.className === 'string') {
          const first = target.className.split(' ')[0];
          if (first && !first.startsWith('mock-')) desc += '.' + first;
        }
        label.textContent = `${desc} (${Math.round(tr.width)}×${Math.round(tr.height)})`;
      } else {
        overlay.style.display = 'none';
      }
    });
    viewport.addEventListener('mouseleave', () => { panel.querySelector('#browser-inspect-overlay').style.display = 'none'; });
  }
}

function createMockApp(id) {
  const apps = {
    'mock-app-todo': `<div class="mock-web-app" id="mock-app-todo">
      <header class="mock-app-header"><h1>TaskFlow</h1><span class="mock-app-badge">Dev</span></header>
      <div class="mock-app-body">
        <div class="mock-input-row"><input type="text" placeholder="添加新任务..." class="mock-app-input"><button class="mock-app-add-btn">添加</button></div>
        <ul class="mock-app-list">
          <li class="mock-app-item done"><span class="checkbox checked"></span><span class="todo-text">引入 Prism.js</span></li>
          <li class="mock-app-item"><span class="checkbox"></span><span class="todo-text">侧边栏折叠支持</span></li>
        </ul>
      </div>
      <footer class="mock-app-footer"><span>剩余 2 项</span><button class="mock-app-clear-btn">清除已完成</button></footer>
    </div>`,
    'mock-app-flowbit': `<div class="mock-web-app" id="mock-app-flowbit">
      <header class="mock-app-header"><h1>Flowbit Chat</h1><span class="mock-app-badge">Online</span></header>
      <div class="mock-app-body" style="padding:10px;gap:8px;max-height:180px;overflow-y:auto;">
        <div style="font-size:11px;color:#555;background:#f2f2f2;padding:6px 10px;border-radius:8px 8px 8px 2px;align-self:flex-start;max-width:85%;">你好！有什么我可以帮您的吗？</div>
        <div style="font-size:11px;color:#fff;background:var(--color-blue);padding:6px 10px;border-radius:8px 8px 2px 8px;align-self:flex-end;max-width:85%;">请写一个 React 组件。</div>
      </div>
      <footer class="mock-app-footer"><input type="text" placeholder="说点什么..." style="border:none;outline:none;background:none;font-size:10px;width:100%;color:var(--text-main);"></footer>
    </div>`,
    'mock-app-crish': `<div class="mock-web-app" id="mock-app-crish">
      <header class="mock-app-header"><h1>Crish Workbench</h1><span class="mock-app-badge" style="background:var(--color-amber-bg);color:var(--color-amber);">Active</span></header>
      <div class="mock-app-body" style="background:#fff;border:1px solid var(--border-default);color:var(--text-main);font-size:9px;padding:10px;height:120px;overflow-y:auto;gap:4px;">
        <div>[18:30:10] Agent started.</div>
        <div>[18:30:15] Running search query...</div>
        <div>[18:30:20] Found 12 matching files.</div>
      </div>
      <footer class="mock-app-footer" style="font-size:8.5px;"><span>PID: 8088</span><span>Uptime: 1m 45s</span></footer>
    </div>`
  };
  const div = document.createElement('div');
  div.innerHTML = apps[id] || '<div class="mock-web-app" style="padding:20px;text-align:center;">App unavailable</div>';
  return div.firstElementChild;
}
