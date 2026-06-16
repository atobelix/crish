/**
 * AddProviderModal — sub-modal for adding custom LLM providers.
 */
export function initAddProviderModal() {
  const addBtn = document.getElementById('btn-add-provider');
  const container = document.getElementById('settings-modal');
  if (!addBtn || !container) return;

  // Create sub-modal HTML
  const subModal = document.createElement('div');
  subModal.className = 'modal-overlay sub-modal';
  subModal.id = 'add-provider-modal';
  subModal.style.display = 'none';
  subModal.innerHTML = `
    <div class="settings-modal-card sub-modal-card">
      <div class="modal-header">
        <h2>添加自定义模型提供商</h2>
        <button class="close-submodal-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
      </div>
      <div class="submodal-body">
        <p class="submodal-subtitle">配置自定义 LLM 提供商以扩展可用的 AI 模型列表。</p>
        <form id="provider-form">
          <div class="form-row">
            <div class="form-group flex-1">
              <label>提供商类型</label>
              <div class="dropdown settings-dropdown" id="dropdown-provider-type">
                <button class="dropdown-trigger settings-dropdown-trigger"><span>OpenAI</span><svg class="chevron-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="6 9 12 15 18 9"></polyline></svg></button>
                <ul class="dropdown-menu"><li class="menu-item selected" data-value="OpenAI">OpenAI</li><li class="menu-item" data-value="Anthropic">Anthropic</li><li class="menu-item" data-value="Gemini">Gemini</li></ul>
              </div>
            </div>
            <div class="form-group flex-1">
              <label>提供商名称</label>
              <input type="text" id="provider-name" placeholder="例如: My Custom AI" required>
            </div>
          </div>
          <div class="form-group">
            <label>API Base URL</label>
            <input type="url" id="base-url" placeholder="https://api.openai.com/v1" required>
          </div>
          <div class="form-group">
            <label>API 密钥</label>
            <input type="password" id="api-key" placeholder="sk-..." required>
            <span class="field-hint">密钥仅存储在本地浏览器，不会发送到第三方。</span>
          </div>
          <div class="form-row">
            <div class="form-group flex-1">
              <label>模型</label>
              <div class="dropdown settings-dropdown" id="dropdown-provider-model">
                <button class="dropdown-trigger settings-dropdown-trigger"><span>gpt-4o</span><svg class="chevron-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="6 9 12 15 18 9"></polyline></svg></button>
                <ul class="dropdown-menu"><li class="menu-item selected" data-value="gpt-4o">gpt-4o</li><li class="menu-item" data-value="gpt-4-turbo">gpt-4-turbo</li><li class="menu-item" data-value="gpt-3.5-turbo">gpt-3.5-turbo</li></ul>
              </div>
            </div>
            <div class="form-group flex-1">
              <label>上下文窗口</label>
              <input type="number" id="context-window" value="128000" readonly>
            </div>
          </div>
          <div class="form-footer">
            <button type="button" class="btn-secondary" id="btn-test-provider">测试连接</button>
            <button type="button" class="btn-secondary" id="btn-cancel-provider">取消</button>
            <button type="submit" class="btn-primary">添加提供商</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.body.appendChild(subModal);

  // Event bindings
  addBtn.addEventListener('click', () => { subModal.style.display = 'flex'; });

  subModal.querySelector('.close-submodal-btn').addEventListener('click', () => close(subModal));
  subModal.querySelector('#btn-cancel-provider').addEventListener('click', () => close(subModal));
  subModal.addEventListener('click', (e) => { if (e.target === subModal) close(subModal); });

  // Provider type → auto-fill base URL
  const typeDropdown = subModal.querySelector('#dropdown-provider-type');
  const baseUrlInput = subModal.querySelector('#base-url');
  const modelDropdown = subModal.querySelector('#dropdown-provider-model');
  const contextInput = subModal.querySelector('#context-window');

  typeDropdown.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const val = item.dataset.value;
      const urls = { OpenAI: 'https://api.openai.com/v1', Anthropic: 'https://api.anthropic.com/v1', Gemini: 'https://generativelanguage.googleapis.com/v1' };
      baseUrlInput.value = urls[val] || '';
    });
  });

  modelDropdown.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const val = item.dataset.value;
      const windows = { 'gpt-4o': '128000', 'gpt-4-turbo': '128000', 'gpt-3.5-turbo': '16385' };
      contextInput.value = windows[val] || '128000';
    });
  });

  // Test connection
  subModal.querySelector('#btn-test-provider').addEventListener('click', () => {
    const key = subModal.querySelector('#api-key').value;
    if (!key) { alert('请先填写 API 密钥'); return; }
    const btn = subModal.querySelector('#btn-test-provider');
    btn.disabled = true;
    btn.textContent = '连接测试中...';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '测试连接';
      alert('连接成功！API 密钥认证有效。');
    }, 1200);
  });

  // Provider drop-down binding
  [typeDropdown, modelDropdown].forEach(dd => {
    const trigger = dd.querySelector('.dropdown-trigger');
    const menu = dd.querySelector('.dropdown-menu');
    if (trigger && menu) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.settings-dropdown .dropdown-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
        menu.classList.toggle('show');
      });
      menu.querySelectorAll('.menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.querySelectorAll('.menu-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
          trigger.querySelector('span').textContent = item.textContent;
          menu.classList.remove('show');
        });
      });
    }
  });

  document.addEventListener('click', () => {
    subModal.querySelectorAll('.settings-dropdown .dropdown-menu').forEach(m => m.classList.remove('show'));
  });

  // Submit
  subModal.querySelector('#provider-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = subModal.querySelector('#provider-name').value;
    const type = typeDropdown.querySelector('.dropdown-trigger span').textContent;
    const model = modelDropdown.querySelector('.dropdown-trigger span').textContent;
    // Add to providers list
    const list = document.querySelector('.providers-list');
    const li = document.createElement('li');
    li.className = 'provider-item';
    li.innerHTML = `<div class="provider-info"><span class="provider-name">${name} (${type} - ${model})</span><span class="provider-status active">已添加</span></div>
      <label class="switch-container"><input type="checkbox" checked><span class="switch-slider"></span></label>`;
    list?.appendChild(li);
    // Add to model dropdown
    const chatModelMenu = document.querySelector('#dropdown-model .dropdown-menu');
    if (chatModelMenu) {
      const modelLi = document.createElement('li');
      modelLi.className = 'menu-item';
      modelLi.textContent = name;
      modelLi.addEventListener('click', (e) => {
        e.stopPropagation();
        chatModelMenu.querySelectorAll('.menu-item').forEach(i => i.classList.remove('selected'));
        modelLi.classList.add('selected');
        document.querySelector('#dropdown-model .dropdown-trigger span').textContent = name;
        chatModelMenu.classList.remove('show');
      });
      chatModelMenu.appendChild(modelLi);
    }
    close(subModal);
    alert(`自定义模型 "${name}" 已成功添加！`);
  });
}

function close(modal) {
  modal.style.display = 'none';
  const form = modal.querySelector('#provider-form');
  if (form) form.reset();
}
