/**
 * Conex 输入框与过渡逻辑控制器
 */

class ConexComposerApp {
  constructor() {
    this.container = document.getElementById('chatContainer');
    this.textarea = document.getElementById('composerTextarea');
    this.sendBtn = document.getElementById('sendBtn');
    this.chatFlow = document.getElementById('chatFlow');

    this.projectLabel = document.getElementById('projectLabel');
    this.cloudLabel = document.getElementById('cloudLabel');

    this.viewState = 'empty'; // 'empty' | 'chat'

    this.init();
  }

  init() {
    // 监听输入
    this.textarea.addEventListener('input', () => {
      const val = this.textarea.value.trim();
      this.sendBtn.classList.toggle('visible', val.length > 0);

      // 自适应多行高度
      this.textarea.style.height = 'auto';
      this.textarea.style.height = `${Math.min(Math.max(this.textarea.scrollHeight, 24), 140)}px`;
    });

    // 回车发送 (Shift+Enter 换行)
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });

    this.sendBtn.addEventListener('click', () => this.submit());

    // 点击空白处关闭浮层
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.trayItem') && !e.target.closest('.trayMenu')) {
        this.closeMenus();
      }
    });
  }

  submit() {
    const text = this.textarea.value.trim();
    if (!text) return;

    // 清空重置输入框
    this.textarea.value = '';
    this.textarea.style.height = 'auto';
    this.sendBtn.classList.remove('visible');

    // 首次发送时平滑过渡到底部
    if (this.viewState === 'empty') {
      this.viewState = 'chat';
      this.container.setAttribute('data-view', 'chat');
    }

    // 挂载用户消息
    this.appendMessage('user', text);

    // 模拟简短响应
    setTimeout(() => {
      this.appendMessage('agent', `已在项目 [${this.projectLabel.innerText}]（${this.cloudLabel.innerText}）接收任务并执行。`);
    }, 360);
  }

  appendMessage(role, text) {
    const row = document.createElement('div');
    row.className = `msgRow ${role}`;
    if (role === 'user') {
      row.innerHTML = `<div class="userBubble">${this.escape(text)}</div>`;
    } else {
      row.innerHTML = `<div class="agentText">${this.escape(text)}</div>`;
    }
    this.chatFlow.appendChild(row);
    this.chatFlow.scrollTop = this.chatFlow.scrollHeight;
  }

  escape(s) {
    return s.replace(/[&<>'"]/g, t => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[t] || t));
  }

  toggleMenu(id) {
    const el = document.getElementById(id);
    const isOpen = el.classList.contains('open');
    this.closeMenus();
    if (!isOpen) el.classList.add('open');
  }

  closeMenus() {
    document.querySelectorAll('.trayMenu').forEach(m => m.classList.remove('open'));
  }

  setProject(name) {
    this.projectLabel.innerText = name;
    this.closeMenus();
  }

  setCloud(name) {
    this.cloudLabel.innerText = name;
    this.closeMenus();
  }

  reset() {
    this.viewState = 'empty';
    this.container.setAttribute('data-view', 'empty');
    this.chatFlow.innerHTML = '';
    this.textarea.focus();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.conexApp = new ConexComposerApp();
});
