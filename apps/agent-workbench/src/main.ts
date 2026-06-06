import { appWindow } from '@tauri-apps/api/window';
import { appState } from './core/app-state';
import { tauriBridge } from './core/tauri-bridge';
import { eventBus, Events } from './core/event-bus';

/**
 * 主入口文件
 * 初始化应用、创建 UI、绑定事件
 */

// 创建完整的 UI 结构
function createUI() {
  const app = document.getElementById('app')!;

  app.innerHTML = `
    <div class="repl-window-root">
      <!-- 自定义标题栏 -->
      <header class="repl-titlebar" data-tauri-drag-region>
        <div class="repl-titlebar-left">
          <nav class="repl-titlebar-menus">
            <span class="repl-titlebar-menu" data-menu="file"><i data-lucide="files"></i>文件</span>
            <span class="repl-titlebar-menu" data-menu="edit"><i data-lucide="square-pen"></i>编辑</span>
            <span class="repl-titlebar-menu" data-menu="view"><i data-lucide="eye"></i>查看</span>
            <span class="repl-titlebar-menu" data-menu="window" id="menu-window"><i data-lucide="monitor"></i>窗口</span>
            <span class="repl-titlebar-menu" data-menu="help"><i data-lucide="help-circle"></i>帮助</span>
          </nav>
        </div>
        <div class="repl-titlebar-title">Conex Agent Workbench</div>
        <div class="repl-titlebar-right">
          <button class="repl-win-btn" id="win-min" title="最小化">
            <svg width="10" height="1" viewBox="0 0 10 1">
              <line y1="0.5" x2="10" y2="0.5" stroke="currentColor" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="repl-win-btn" id="win-max" title="最大化">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" rx="1.5"/>
            </svg>
          </button>
          <button class="repl-win-btn close" id="win-close" title="关闭">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </header>

      <!-- 工作区容器 -->
      <main class="repl-workspace-container">
        <!-- 左侧边栏 -->
        <aside class="repl-sidebar">
          <div class="repl-sidebar-top-section">
            <div class="repl-sidebar-nav-item active" id="nav-new">
              <span class="repl-sidebar-nav-icon"><i data-lucide="message-circle"></i></span>
              <span>新对话</span>
            </div>
            <div class="repl-sidebar-nav-item" id="nav-search">
              <span class="repl-sidebar-nav-icon"><i data-lucide="search"></i></span>
              <span>搜索</span>
            </div>
            <div class="repl-sidebar-nav-item" id="nav-skills">
              <span class="repl-sidebar-nav-icon"><i data-lucide="brain"></i></span>
              <span>技能</span>
            </div>

            <div class="repl-sidebar-scroll-area">
              <div class="repl-tree-group" id="sessions-tree">
                <!-- 会话列表动态生成 -->
              </div>
            </div>
          </div>

          <div class="repl-sidebar-bottom-section">
            <div class="repl-sidebar-section-title">最近对话</div>
            <div id="recent-sessions"></div>
          </div>

          <div class="repl-sidebar-bottom">
            <div class="repl-sidebar-profile-trigger" id="nav-settings">
              <div class="repl-sidebar-profile-avatar">U</div>
              <div class="repl-sidebar-profile-info">
                <span class="repl-sidebar-profile-name">用户</span>
                <span class="repl-sidebar-profile-status">就绪</span>
              </div>
              <span class="repl-sidebar-profile-settings-icon"><i data-lucide="settings"></i></span>
            </div>
          </div>
        </aside>

        <!-- 可调整分隔条 -->
        <div class="repl-resizer repl-resizer-left" id="resizer-left"></div>

        <!-- 主聊天区域 -->
        <section class="repl-main-panel-container">
          <div class="repl-main-card">
            <!-- 卡片子标题 -->
            <div class="repl-card-subheader">
              <div class="repl-sub-center">
                <span class="repl-sub-title" id="session-title">新对话</span>
                <button class="repl-sub-btn-more" id="sub-more-options">
                  <i data-lucide="more-horizontal"></i>
                </button>
              </div>
              <div class="repl-sub-right">
                <button class="repl-sub-btn" id="sub-info" title="会话详情">
                  <i data-lucide="info"></i>
                </button>
              </div>
            </div>

            <!-- 聊天消息区域 -->
            <div class="repl-chat-messages-scroll-area" id="chat-messages">
              <div class="repl-chat-welcome">
                <h2>欢迎使用 Conex Agent Workbench</h2>
                <p>开始新对话，或从侧边栏选择历史会话</p>
              </div>
            </div>

            <!-- 输入区域 -->
            <div class="repl-chat-input-sticky-footer">
              <!-- 工具审批闸口 -->
              <div class="repl-tool-approval-deck hidden" id="tool-approval-deck">
                <div class="repl-tool-deck-header">
                  <div class="repl-tool-deck-status">
                    <span class="repl-deck-status-dot warn-amber"></span>
                    <span class="repl-deck-status-text">系统工具运行请求</span>
                  </div>
                  <div class="repl-tool-deck-meta" id="tool-deck-meta">Tool: pending</div>
                </div>
                <div class="repl-tool-deck-body">
                  <div class="repl-tool-deck-code-pane" id="tool-deck-code-view">
                    <pre><code id="tool-deck-command"></code></pre>
                  </div>
                </div>
                <div class="repl-tool-deck-actions">
                  <button class="repl-deck-btn btn-deny" id="deck-btn-deny">
                    <span>拒绝</span>
                  </button>
                  <button class="repl-deck-btn btn-approve" id="deck-btn-approve">
                    <span>允许执行</span>
                  </button>
                </div>
              </div>

              <!-- 输入框 -->
              <div class="repl-input-box-container">
                <textarea
                  class="repl-input-textarea"
                  id="chat-input"
                  placeholder="输入消息..."
                  rows="1"
                ></textarea>

                <div class="repl-input-actions-bar">
                  <div class="repl-input-actions-left">
                    <div class="repl-circle-btn" id="btn-attach" title="添加上下文">
                      <i data-lucide="plus"></i>
                    </div>
                    <div class="repl-orange-badge" id="btn-access">
                      <i data-lucide="alert-circle" style="width: 14px; height: 14px;"></i>
                      <span>安全确认模式</span>
                    </div>
                  </div>
                  <div class="repl-input-actions-right">
                    <button class="repl-send-btn" id="btn-send" title="发送消息">
                      <i data-lucide="arrow-up"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;

  // 初始化 Lucide 图标
  if ((window as any).lucide) {
    (window as any).lucide.createIcons();
  }
}

// 窗口控制
function setupWindowControls() {
  document.getElementById('win-min')?.addEventListener('click', () => appWindow.minimize());
  document.getElementById('win-max')?.addEventListener('click', () => appWindow.toggleMaximize());
  document.getElementById('win-close')?.addEventListener('click', () => appWindow.close());
}

// 聊天功能
function setupChat() {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('btn-send');
  const messagesContainer = document.getElementById('chat-messages')!;

  async function sendMessage() {
    const message = input.value.trim();
    if (!message) return;

    // 添加用户消息
    const userMsg = appState.addMessage({
      role: 'user',
      content: message,
    });

    // 渲染到 UI
    renderMessage(userMsg);
    input.value = '';

    // 发送到后端
    try {
      const runId = `run-${Date.now()}`;
      appState.setState('activeRunId', runId);
      appState.setState('isStreaming', true);

      await tauriBridge.runTask({
        prompt: message,
        runId,
      });
    } catch (error) {
      console.error('发送消息失败:', error);
      appState.addMessage({
        role: 'system',
        content: `错误: ${error}`,
      });
    }
  }

  function renderMessage(message: any) {
    // 移除欢迎消息
    const welcome = messagesContainer.querySelector('.repl-chat-welcome');
    if (welcome) welcome.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = `repl-chat-msg-row ${message.role}`;
    msgDiv.dataset.messageId = message.id;
    msgDiv.innerHTML = `
      <div class="repl-chat-msg-bubble">${escapeHtml(message.content)}</div>
    `;
    messagesContainer.appendChild(msgDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // 发送按钮
  sendBtn?.addEventListener('click', sendMessage);

  // Enter 发送，Shift+Enter 换行
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 订阅状态变化
  appState.subscribe('currentSession', (session) => {
    if (session) {
      // 重新渲染所有消息
      messagesContainer.innerHTML = '';
      session.messages.forEach(renderMessage);

      // 更新标题
      const titleEl = document.getElementById('session-title');
      if (titleEl) titleEl.textContent = session.title;
    }
  });
}

// 侧边栏功能
function setupSidebar() {
  const newBtn = document.getElementById('nav-new');

  newBtn?.addEventListener('click', () => {
    appState.createSession();
    eventBus.emit(Events.SESSION_CREATED);
  });

  // 订阅会话列表变化
  appState.subscribe('sessions', (sessions) => {
    renderSessionsList(sessions);
  });
}

function renderSessionsList(sessions: any[]) {
  const container = document.getElementById('recent-sessions');
  if (!container) return;

  container.innerHTML = sessions
    .slice(0, 10)
    .map(
      (session) => `
      <div class="repl-sidebar-direct-item" data-session-id="${session.id}">
        <span class="repl-sidebar-direct-title">${escapeHtml(session.title)}</span>
        <span class="repl-sidebar-direct-right">${formatTime(session.updatedAt)}</span>
      </div>
    `
    )
    .join('');

  // 绑定点击事件
  container.querySelectorAll('.repl-sidebar-direct-item').forEach((el) => {
    el.addEventListener('click', () => {
      const sessionId = (el as HTMLElement).dataset.sessionId;
      if (sessionId) {
        appState.switchSession(sessionId);
      }
    });
  });
}

// 设置后端事件监听
function setupBackendListeners() {
  // 监听运行事件
  tauriBridge.onRunEvent((event) => {
    console.log('Run event:', event);

    // 处理助手消息
    if (event.type === 'text') {
      // TODO: 实现流式文本渲染
    }

    // 处理工具调用
    if (event.type === 'tool_use') {
      // TODO: 显示工具审批闸口
    }
  });

  // 监听快照事件
  tauriBridge.onSnapshot((event) => {
    console.log('Snapshot:', event);
  });
}

// 工具函数
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  return `${days} 天前`;
}

// 初始化应用
function init() {
  createUI();
  setupWindowControls();
  setupChat();
  setupSidebar();
  setupBackendListeners();

  // 创建默认会话
  appState.createSession('新对话');

  console.log('✅ Conex Agent Workbench 已启动');
}

// DOM 加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
