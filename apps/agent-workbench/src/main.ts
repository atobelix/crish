import { invoke } from '@tauri-apps/api/core';
import { appWindow } from '@tauri-apps/api/window';

// 创建 UI 结构
function createUI() {
  const app = document.getElementById('app')!;

  app.innerHTML = `
    <div class="repl-window-root">
      <!-- 自定义标题栏 -->
      <header class="repl-titlebar" data-tauri-drag-region>
        <div class="repl-titlebar-left">
          <span class="repl-titlebar-brand">Conex</span>
        </div>
        <div class="repl-titlebar-title">Agent Workbench</div>
        <div class="repl-titlebar-right">
          <button class="repl-win-btn" id="win-min" title="最小化">
            <i data-lucide="minus"></i>
          </button>
          <button class="repl-win-btn" id="win-max" title="最大化">
            <i data-lucide="square"></i>
          </button>
          <button class="repl-win-btn close" id="win-close" title="关闭">
            <i data-lucide="x"></i>
          </button>
        </div>
      </header>

      <!-- 主容器 -->
      <main class="repl-workspace-container">
        <!-- 左侧边栏 -->
        <aside class="repl-sidebar">
          <div class="repl-sidebar-top-section">
            <div class="repl-sidebar-nav-item active" id="nav-new">
              <span class="repl-sidebar-nav-icon"><i data-lucide="message-circle"></i></span>
              <span>新对话</span>
            </div>
            <div class="repl-sidebar-nav-item" id="nav-history">
              <span class="repl-sidebar-nav-icon"><i data-lucide="history"></i></span>
              <span>历史会话</span>
            </div>
            <div class="repl-sidebar-scroll-area" id="sessions-list">
              <!-- 会话列表将动态加载 -->
            </div>
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

        <!-- 聊天主区域 -->
        <section class="repl-main-panel-container">
          <div class="repl-main-card">
            <!-- 聊天消息区 -->
            <div class="repl-chat-messages-scroll-area" id="chat-messages">
              <div class="repl-chat-welcome">
                <h2>欢迎使用 Conex Agent Workbench</h2>
                <p>开始新对话</p>
              </div>
            </div>

            <!-- 工具审批闸口 -->
            <div class="repl-tool-approval-deck hidden" id="tool-approval-deck">
              <div class="repl-tool-deck-header">
                <div class="repl-tool-deck-status">
                  <span class="repl-deck-status-dot warn-amber"></span>
                  <span class="repl-deck-status-text">工具调用请求</span>
                </div>
                <div class="repl-tool-deck-meta" id="tool-deck-meta"></div>
              </div>
              <div class="repl-tool-deck-body">
                <pre id="tool-deck-content"></pre>
              </div>
              <div class="repl-tool-deck-actions">
                <button class="repl-deck-btn btn-deny" id="deck-btn-deny">拒绝</button>
                <button class="repl-deck-btn btn-approve" id="deck-btn-approve">允许</button>
              </div>
            </div>

            <!-- 输入框 -->
            <div class="repl-chat-input-sticky-footer">
              <div class="repl-input-box-container">
                <textarea class="repl-input-textarea" id="chat-input" placeholder="输入消息..." rows="1"></textarea>
                <div class="repl-input-actions-bar">
                  <div class="repl-input-actions-right">
                    <button class="repl-send-btn" id="btn-send">
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
  if (window.lucide) {
    window.lucide.createIcons();
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
  const messagesContainer = document.getElementById('chat-messages');

  async function sendMessage() {
    const message = input.value.trim();
    if (!message) return;

    // 添加用户消息到 UI
    addMessage('user', message);
    input.value = '';

    try {
      // 调用 Tauri 后端
      const response = await invoke<string>('send_message', { message });
      addMessage('assistant', response);
    } catch (error) {
      console.error('发送消息失败:', error);
      addMessage('system', '发送失败: ' + error);
    }
  }

  function addMessage(role: 'user' | 'assistant' | 'system', content: string) {
    if (!messagesContainer) return;

    // 移除欢迎消息
    const welcome = messagesContainer.querySelector('.repl-chat-welcome');
    if (welcome) welcome.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = `repl-chat-msg-row ${role}`;
    msgDiv.innerHTML = `
      <div class="repl-chat-msg-bubble">${escapeHtml(content)}</div>
    `;
    messagesContainer.appendChild(msgDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  sendBtn?.addEventListener('click', sendMessage);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  createUI();
  setupWindowControls();
  setupChat();
});
