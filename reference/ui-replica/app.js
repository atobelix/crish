// Simple regex-based syntax highlighter for prototype code blocks
function highlightCode(root = document) {
  const keywords = /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|try|catch|throw|yield|typeof|instanceof|in|of|break|continue|default|case|switch|true|false|null|undefined)\b/g;
  const functions = /\b([a-zA-Z_$][\w$]*)(?=\()/g;
  const numbers = /\b(\d+(?:\.\d+)?)\b/g;
  const strings = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  const comments = /(\/\/.*$|#.*$)/gm;
  const operators = /(\+|\-|\*|\/|=|!|&|\||<|>|\?|:|\.|,|;)/g;

  root.querySelectorAll('.code-block code').forEach(block => {
    if (block.dataset.highlighted) return;
    let html = block.textContent;
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Protect already-highlighted tokens with placeholders
    const placeholders = [];
    const marker = '___HL';
    const save = (token, className) => {
      placeholders.push(`<span class="${className}">${token}</span>`);
      return `${marker}${placeholders.length - 1}___`;
    };

    html = html.replace(comments, m => save(m, 'token-comment'));
    html = html.replace(strings, m => save(m, 'token-string'));
    html = html.replace(keywords, m => save(m, 'token-keyword'));
    html = html.replace(functions, m => save(m, 'token-function'));
    html = html.replace(numbers, m => save(m, 'token-number'));
    html = html.replace(operators, m => save(m, 'token-operator'));

    html = html.replace(new RegExp(`${marker}(\\d+)___`, 'g'), (_, i) => placeholders[+i]);

    block.innerHTML = html;
    block.dataset.highlighted = 'true';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // --- 1. macOS Window Control Interactions ---
  const macWindow = document.querySelector('.mac-window');
  const closeBtn = document.querySelector('.control.close');
  const minimizeBtn = document.querySelector('.control.minimize');
  const expandBtn = document.querySelector('.control.expand');
  const desktopBackground = document.querySelector('.desktop-background');

  closeBtn.addEventListener('click', () => {
    macWindow.style.display = 'none';
    let restoreBtn = document.querySelector('.restore-window-btn');
    if (!restoreBtn) {
      restoreBtn = document.createElement('button');
      restoreBtn.className = 'restore-window-btn';
      restoreBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 16px; height: 16px; margin-right: 8px;">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <line x1="2" y1="10" x2="22" y2="10"></line>
        </svg>
        Open MyCodex Demo
      `;
      // Styling the restore button dynamically
      restoreBtn.style.position = 'absolute';
      restoreBtn.style.padding = '12px 24px';
      restoreBtn.style.backgroundColor = '#fafafa';
      restoreBtn.style.border = 'none';
      restoreBtn.style.borderRadius = '30px';
      restoreBtn.style.fontSize = '14px';
      restoreBtn.style.fontWeight = '500';
      restoreBtn.style.cursor = 'pointer';
      restoreBtn.style.boxShadow = '0 10px 25px rgba(0,0,0,0.04)';
      restoreBtn.style.fontFamily = 'Inter, sans-serif';
      restoreBtn.style.display = 'flex';
      restoreBtn.style.alignItems = 'center';
      restoreBtn.style.transition = 'all 0.2s';
      
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
      desktopBackground.appendChild(restoreBtn);
    } else {
      restoreBtn.style.display = 'flex';
    }
  });

  minimizeBtn.addEventListener('click', () => {
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

  expandBtn.addEventListener('click', () => {
    if (macWindow.style.maxWidth === '100%') {
      macWindow.style.maxWidth = '1120px';
      macWindow.style.height = '90vh';
      macWindow.style.borderRadius = '12px';
    } else {
      macWindow.style.maxWidth = '100%';
      macWindow.style.height = '100%';
      macWindow.style.borderRadius = '0';
    }
  });


  // --- 2. Sidebar Section Collapse (Clicking entire section-header) ---
  const sidebarSections = document.querySelectorAll('.sidebar-section');
  sidebarSections.forEach(section => {
    const header = section.querySelector('.section-header');
    if (header) {
      header.addEventListener('click', (e) => {
        // Stop collapse if clicking action buttons inside header
        if (e.target.closest('.section-actions')) return;

        section.classList.toggle('collapsed');
        const list = section.querySelector('.section-list');
        if (section.classList.contains('collapsed')) {
          list.style.maxHeight = '0px';
        } else {
          list.style.maxHeight = list.scrollHeight + 100 + 'px';
        }
      });
      
      // Initialize heights
      const list = section.querySelector('.section-list');
      if (list && !section.classList.contains('collapsed')) {
        list.style.maxHeight = list.scrollHeight + 100 + 'px';
      }
    }
  });


  // --- 3. Project/Folder Collapse Binding (chevron click or folder icon click) ---
  const bindProjectFolderCollapse = (projectLi) => {
    const collapseChevron = projectLi.querySelector('.project-collapse-chevron');
    const folderIcon = projectLi.querySelector('.folder-animated-icon');

    const toggleFolder = (e) => {
      e.stopPropagation();
      projectLi.classList.toggle('project-collapsed');
      
      // Refresh section lists heights
      setTimeout(() => {
        sidebarSections.forEach(sec => {
          const list = sec.querySelector('.section-list');
          if (list && !sec.classList.contains('collapsed')) {
            list.style.maxHeight = list.scrollHeight + 100 + 'px';
          }
        });
      }, 200);
    };

    if (collapseChevron) collapseChevron.addEventListener('click', toggleFolder);
    if (folderIcon) folderIcon.addEventListener('click', toggleFolder);
  };

  document.querySelectorAll('.project-item').forEach(bindProjectFolderCollapse);


  // --- 4. Mock Chat Data for dynamic loading ---
  const chatMessagesData = {
    'todo-list-app': [
      { role: 'assistant', content: '我会打开刚做好的 Todo 应用。先尝试内置浏览器；如果这个会话里仍然没有内置浏览器实例，就用系统浏览器打开本地文件。' },
      { role: 'assistant', content: '正在连接内置浏览器并准备打开本地 <code class="inline-code">index.html</code>。' },
      { role: 'tool_group', status: 'summary', expanded: false, calls: [
        { name: 'node_repl', args: 'node_repl.js', result: 'node_repl.js', expanded: false, done: true },
        { name: 'node_repl', args: 'node_repl.js', result: 'node_repl.js', expanded: false, done: true },
        { name: 'node_repl', args: 'node_repl.js', result: 'node_repl.js', expanded: false, done: true }
      ], metrics: { tools: 3, edited: 0, viewed: 0 } },
      { role: 'assistant', content: '连接环境里已有上次的浏览器初始化变量，我会复用它，避免重置会话状态。' },
      { role: 'assistant', content: '内置浏览器仍然不可用。我按插件排错流程确认后，会使用系统浏览器打开同一个本地文件。' },
      { role: 'assistant', content: '内置浏览器确认不可用，接下来直接用 macOS 默认浏览器打开本地页面文件。' },
      { role: 'assistant', content: '已打开 Todo 应用：<code class="inline-code">/tmp/mycodex-demo/index.html</code>。' },
      { role: 'assistant', content: '内置浏览器在这个会话里不可用，所以我用系统默认浏览器打开了本地文件。' }
    ],
    'refactor-auth': [
      { role: 'assistant', content: 'I will help you refactor the login module to support standard secure password flows and OAuth2 configurations.' },
      { role: 'assistant', content: "Let's run a search to locate the auth/login files in this project." },
      { role: 'tool_group', status: 'expanded', expanded: true, calls: [
        { name: 'grep_search', args: 'grep_search --query="login" --SearchPath="."', result: 'auth.js\nloginForm.js\noauth-config.json', expanded: true, done: true }
      ], metrics: { tools: 1, edited: 0, viewed: 3 } },
      { role: 'assistant', content: 'Found authentication code in <code class="inline-code">auth.js</code>. It is currently storing user credentials as plain-text! I will modify it to use bcrypt salt-hashing instead.' }
    ],
    'conex-chat-1': [
      { role: 'assistant', content: 'Hi! I am ready to explore the <strong>conex</strong> codebase. What modules or features would you like to examine first?' }
    ]
  };

  // --- Message / Tool rendering helpers ---
  function escapeHTML(str) {
    return String(str).replace(/[&<>'"]/g, tag => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
  }

  function computeToolMetrics(calls) {
    const viewed = new Set();
    const edited = new Set();
    calls.forEach(call => {
      const name = call.name.toLowerCase();
      if (name.includes('read') || name.includes('view') || name.includes('grep') || name.includes('search')) {
        viewed.add(call.result?.split('\n')[0] || call.args);
      }
      if (name.includes('write') || name.includes('edit') || name.includes('apply') || name.includes('replace')) {
        edited.add(call.result?.split('\n')[0] || call.args);
      }
    });
    return { tools: calls.length, edited: edited.size, viewed: viewed.size };
  }

  function renderDiffView(diff) {
    if (!diff || !diff.hunks) return `<pre><code>${escapeHTML(diff)}</code></pre>`;

    const fileHeader = `
      <div class="diff-file-header">
        <span class="diff-file-name">${escapeHTML(diff.file)}</span>
        <span class="diff-file-stats">
          <span class="diff-stat-added">+${diff.added}</span>
          <span class="diff-stat-removed">-${diff.removed}</span>
        </span>
      </div>
    `;

    const hunksHtml = diff.hunks.map(hunk => {
      const oldLines = hunk.lines.filter(l => l.type !== 'added').length;
      const newLines = hunk.lines.filter(l => l.type !== 'removed').length;
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const linesHtml = hunk.lines.map(line => {
        const marker = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
        const lineClass = `diff-${line.type}`;
        const oldNum = line.type === 'added' ? '' : oldLine++;
        const newNum = line.type === 'removed' ? '' : newLine++;
        return `<div class="diff-line ${lineClass}"><span class="diff-num">${oldNum || ''}</span><span class="diff-num">${newNum || ''}</span><span class="diff-marker">${marker}</span><span class="diff-content">${escapeHTML(line.content)}</span></div>`;
      }).join('');
      return `<div class="diff-hunk-header">@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@</div>${linesHtml}`;
    }).join('');

    const summary = `
      <div class="diff-summary">
        <span>1 changed file</span>
        <span class="diff-stat-added">+${diff.added}</span>
        <span class="diff-stat-removed">-${diff.removed}</span>
      </div>
    `;

    return `<div class="diff-view">${fileHeader}${hunksHtml}${summary}</div>`;
  }

  function renderToolCall(call, index) {
    const expanded = call.expanded !== false;
    const safeArgs = escapeHTML(call.args);
    const isEditTool = call.name === 'edit_file' || call.name === 'edit';
    const outputContent = isEditTool && call.diff
      ? renderDiffView(call.diff)
      : `<pre><code>${escapeHTML(call.result)}</code></pre>`;

    return `
      <div class="tool-invocation" data-call-index="${index}" data-expanded="${expanded}">
        <div class="tool-call-row" title="${safeArgs}">
          <svg class="icon tool-terminal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
          <span class="tool-name">${escapeHTML(call.name)}</span>
          <code class="tool-args">${safeArgs}</code>
          <svg class="icon tool-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="tool-result-window">
          <div class="tool-output">
            ${outputContent}
          </div>
        </div>
      </div>
    `;
  }

  function renderToolGroup(group) {
    const metrics = group.metrics || computeToolMetrics(group.calls);
    const summaryParts = [`${metrics.tools} 个工具`];
    if (metrics.viewed > 0) summaryParts.push(`${metrics.viewed} 个文件查看`);
    if (metrics.edited > 0) summaryParts.push(`${metrics.edited} 个文件编辑`);

    if (group.status === 'summary') {
      const expanded = group.expanded === true;
      return `
        <div class="tool-summary" data-expanded="${expanded}">
          <div class="tool-summary-row">
            <svg class="icon tool-terminal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polyline points="4 17 10 11 4 5"></polyline>
              <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>
            <span class="tool-summary-text">${summaryParts.join(' · ')}</span>
            <svg class="icon tool-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </div>
          <div class="tool-summary-body">
            ${group.calls.map((call, i) => renderToolCall(call, i)).join('')}
          </div>
        </div>
      `;
    }

    // streaming or expanded: render calls directly
    return group.calls.map((call, i) => renderToolCall(call, i)).join('');
  }

  function renderMessage(msg) {
    if (msg.role === 'user') {
      return `<div class="chat-message user-message"><div class="message-bubble">${msg.content}</div></div>`;
    }
    if (msg.role === 'assistant') {
      return `<div class="chat-message assistant-message">${msg.content}</div>`;
    }
    if (msg.role === 'tool_group') {
      return renderToolGroup(msg);
    }
    return '';
  }

  function renderMessages(messages) {
    return messages.map(renderMessage).join('');
  }

  function bindToolToggles(container) {
    container.querySelectorAll('.tool-call-row').forEach(row => {
      row.addEventListener('click', () => {
        const invocation = row.closest('.tool-invocation');
        const expanded = invocation.getAttribute('data-expanded') === 'true';
        invocation.setAttribute('data-expanded', String(!expanded));
      });
    });
    container.querySelectorAll('.tool-summary-row').forEach(row => {
      row.addEventListener('click', () => {
        const summary = row.closest('.tool-summary');
        const expanded = summary.getAttribute('data-expanded') === 'true';
        summary.setAttribute('data-expanded', String(!expanded));
      });
    });
  }

  // Expose renderAgentView for sub-agent reuse
  window.renderAgentView = function(container, messages, opts = {}) {
    const showUserInput = opts.showUserInput !== false;
    const filtered = showUserInput ? messages : messages.filter(m => m.role !== 'user');
    container.innerHTML = renderMessages(filtered);
    bindToolToggles(container);
    highlightCode(container);
  };

  // Sub-agent view helpers
  const subAgentView = document.getElementById('sub-agent-view');
  const subAgentTitle = document.getElementById('sub-agent-title');
  const subAgentMessageList = document.getElementById('sub-agent-message-list');

  window.openSubAgent = function(name, messages) {
    if (!subAgentView || !subAgentMessageList) return;
    subAgentTitle.textContent = name || 'Sub Agent';
    window.renderAgentView(subAgentMessageList, messages || [], { showUserInput: false });

    // Hide chat and feature views, show sub-agent view
    document.querySelectorAll('.feature-panel-view').forEach(el => { el.style.display = 'none'; });
    const chatAreaEl = document.querySelector('.chat-area');
    if (chatAreaEl) chatAreaEl.style.display = 'none';
    const commandBar = document.querySelector('.command-bar');
    if (commandBar) commandBar.style.display = 'none';
    const inputContainer = document.querySelector('.input-panel-container');
    if (inputContainer) inputContainer.style.display = 'none';
    document.getElementById('empty-chat-state').style.display = 'none';

    subAgentView.style.display = 'flex';
    panelTitle.textContent = name || 'Sub Agent';
  };

  window.closeSubAgent = function() {
    if (!subAgentView) return;
    subAgentView.style.display = 'none';
    // Return to last active chat
    const targetId = currentChatId || 'todo-list-app';
    const chatEl = document.querySelector(`[data-id="${targetId}"]`);
    const title = chatEl ? (chatEl.querySelector('.chat-title, .nested-text')?.textContent || 'Chat') : 'Chat';
    activateChatItem(targetId, title, chatEl);
  };

  if (document.getElementById('close-sub-agent-btn')) {
    document.getElementById('close-sub-agent-btn').addEventListener('click', window.closeSubAgent);
  }


  // --- 5. Sidebar Active Selections & Project Activation ---
  const chatArea = document.querySelector('.chat-area');
  const messageList = document.querySelector('.message-list');
  const panelTitle = document.querySelector('.panel-title');
  const footerProjectText = document.querySelector('.project-select-btn span');
  const dropdownProjectMenu = document.querySelector('#dropdown-project .dropdown-menu');
  const featureAccordion = document.getElementById('feature-accordion');
  let activeProjName = 'mycodex-demo';
  let currentChatId = null;

  // Activate Sidebar Item (Clean highlight state)
  const activateProjectItem = (projectLi) => {
    const projName = projectLi.querySelector('.item-text').textContent;
    activeProjName = projName;
    if (footerProjectText) footerProjectText.textContent = projName;
    
    // Sync active in footer dropdown list
    if (dropdownProjectMenu) {
      dropdownProjectMenu.querySelectorAll('.menu-item').forEach(item => {
        if (item.textContent === projName) {
          item.classList.add('selected');
        } else {
          item.classList.remove('selected');
        }
      });
    }

    // Sync active project name and empty greeting if empty state is active
    const emptyState = document.getElementById('empty-chat-state');
    if (emptyState) {
      const greetingEl = emptyState.querySelector('.empty-greeting');
      if (greetingEl) {
        greetingEl.textContent = `我们应该在 ${projName} 中构建什么？`;
      }
      const activeProjNameEl = document.querySelector('.active-project-name');
      if (activeProjNameEl) {
        activeProjNameEl.textContent = projName;
      }
      
      const attachedProjDropdown = document.getElementById('attached-project-dropdown');
      if (attachedProjDropdown) {
        attachedProjDropdown.querySelectorAll('.attached-menu-item').forEach(item => {
          if (item.querySelector('span').textContent.trim() === projName) {
            item.classList.add('selected');
          } else {
            item.classList.remove('selected');
          }
        });
      }
    }
  };
  // Helper: toggle input layout between empty-state (centered, tags visible)
  // and active-chat (bottom docked, tags hidden)
  const setInputMode = (mode) => {
    const inputWrapper = document.querySelector('.input-area-wrapper');
    const textareaEl = inputWrapper?.querySelector('.chat-textarea');
    const contextTags = inputWrapper?.querySelector('.input-context-tags');

    if (mode === 'empty') {
      if (contextTags) contextTags.style.display = 'flex';
      inputWrapper?.classList.remove('active-chat');
      if (textareaEl) textareaEl.placeholder = '随心输入';
    } else {
      if (contextTags) contextTags.style.display = 'none';
      inputWrapper?.classList.add('active-chat');
      if (textareaEl) textareaEl.placeholder = '要求后续变更';
    }
  };

  const activateQuickChat = () => {
    // 1. Deactivate all active sidebar items (chats, folders, features)
    document.querySelectorAll('.chat-item, .nested-item').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.feature-item').forEach(item => item.classList.remove('active'));

    // 2. Hide all feature views
    document.querySelectorAll('.feature-panel-view').forEach(el => { el.style.display = 'none'; });

    // 3. Hide message list and command bar
    const messageListEl = document.querySelector('.message-list');
    if (messageListEl) messageListEl.style.display = 'none';
    const commandBar = document.querySelector('.command-bar');
    if (commandBar) commandBar.style.display = 'none';

    // 4. Hide bottom input panel container
    const inputContainer = document.querySelector('.input-panel-container');
    if (inputContainer) inputContainer.style.display = 'none';

    // 5. Show empty state and move input wrapper inside it
    const emptyState = document.getElementById('empty-chat-state');
    if (emptyState) {
      emptyState.style.display = 'flex';
      
      const inputWrapper = document.querySelector('.input-area-wrapper');
      const emptyContent = emptyState.querySelector('.empty-state-content');
      
      const greetingEl = emptyState.querySelector('.empty-greeting');
      if (greetingEl) {
        greetingEl.textContent = `我们应该在 ${activeProjName} 中构建什么？`;
      }
      const activeProjNameEl = document.querySelector('.active-project-name');
      if (activeProjNameEl) {
        activeProjNameEl.textContent = activeProjName;
      }
      
      if (inputWrapper && emptyContent) {
        emptyContent.appendChild(inputWrapper);
        
        // Switch to empty-state layout: show tags, white card, empty placeholder
        setInputMode('empty');
        
        // Hide dropdowns initially
        document.querySelectorAll('.attached-dropdown-menu').forEach(m => m.classList.remove('show'));
        
        const textareaEl = inputWrapper.querySelector('.chat-textarea');
        if (textareaEl) {
          textareaEl.value = '';
          textareaEl.style.height = 'auto';
          textareaEl.focus();
        }
        
        const sendBtnEl = inputWrapper.querySelector('.send-btn');
        if (sendBtnEl) {
          sendBtnEl.classList.remove('active');
          sendBtnEl.setAttribute('disabled', 'true');
        }
      }
    }

    // 6. Set title in panel header
    panelTitle.textContent = '快速对话';

    // 7. Make sure quick-chat button shows active state
    const quickChatBtn = document.querySelector('.quick-chat-btn');
    if (quickChatBtn) quickChatBtn.classList.add('active');
  };

  const activateChatItem = (chatId, chatTitleText, clickedElement = null) => {
    currentChatId = chatId;
    currentToolGroup = null; // Reset streaming tool group on chat switch

    // Hide empty state and restore input card to bottom container
    const emptyState = document.getElementById('empty-chat-state');
    if (emptyState) emptyState.style.display = 'none';

    // Remove active highlight from quick-chat-btn
    const quickChatBtn = document.querySelector('.quick-chat-btn');
    if (quickChatBtn) quickChatBtn.classList.remove('active');

    // Switch view back to chat
    const commandBar = document.querySelector('.command-bar');
    if (commandBar) commandBar.style.display = 'flex';
    const chatAreaEl = document.querySelector('.chat-area');
    if (chatAreaEl) chatAreaEl.style.display = 'block';
    
    const inputContainer = document.querySelector('.input-panel-container');
    if (inputContainer) {
      inputContainer.style.display = 'block';
      const inputWrapper = document.querySelector('.input-area-wrapper');
      if (inputWrapper) {
        if (!inputContainer.contains(inputWrapper)) {
          inputContainer.appendChild(inputWrapper);
        }
        
        // Switch to active-chat layout: hide tags, bottom docked, chat placeholder
        setInputMode('chat');
        
        // Hide dropdowns
        document.querySelectorAll('.attached-dropdown-menu').forEach(m => m.classList.remove('show'));
      }
    }
    const messageListEl = document.querySelector('.message-list');
    if (messageListEl) messageListEl.style.display = 'flex';

    // Hide feature views
    document.querySelectorAll('.feature-panel-view').forEach(el => { el.style.display = 'none'; });
    // Remove active from feature items
    document.querySelectorAll('.feature-item').forEach(item => item.classList.remove('active'));

    // Remove active highlight from all chat lists (standalone and nested)
    document.querySelectorAll('.chat-item, .nested-item').forEach(c => c.classList.remove('active'));
    
    // Highlight ONLY the selected chat item
    if (clickedElement) {
      clickedElement.classList.add('active');
    } else {
      const match = document.querySelector(`[data-id="${chatId}"]`);
      if (match) match.classList.add('active');
    }

    // Update Header title
    panelTitle.textContent = chatTitleText;

    // Load messages dynamically
    if (chatMessagesData[chatId]) {
      messageList.innerHTML = renderMessages(chatMessagesData[chatId]);
      bindToolToggles(messageList);
      highlightCode(messageList);
    } else {
      messageList.innerHTML = `<div class="chat-message assistant-message"><p>No messages in chat "${escapeHTML(chatTitleText)}". Send a message to start!</p></div>`;
    }
    chatArea.scrollTop = 0;
  };

  // Event delegation for sidebar selections
  document.addEventListener('click', (e) => {
    const target = e.target;

    // Project click
    const projectItem = target.closest('.project-item');
    if (projectItem && !target.closest('.item-actions') && !target.closest('.nested-list') && !target.closest('.project-collapse-chevron')) {
      activateProjectItem(projectItem);
      projectItem.classList.toggle('project-collapsed');
      
      // Refresh section lists heights
      setTimeout(() => {
        sidebarSections.forEach(sec => {
          const list = sec.querySelector('.section-list');
          if (list && !sec.classList.contains('collapsed')) {
            list.style.maxHeight = list.scrollHeight + 100 + 'px';
          }
        });
      }, 200);
    }

    // Nested Chat click
    const nestedItem = target.closest('.nested-item');
    if (nestedItem && !target.closest('.item-actions')) {
      const chatId = nestedItem.getAttribute('data-id');
      const chatTitleText = nestedItem.querySelector('.nested-text').textContent;
      activateChatItem(chatId, chatTitleText, nestedItem);
    }

    // Standalone Chat click
    const standaloneChat = target.closest('.chat-item');
    if (standaloneChat && !standaloneChat.classList.contains('nested-item') && !target.closest('.item-actions')) {
      const chatId = standaloneChat.getAttribute('data-id');
      const chatTitleText = standaloneChat.querySelector('.chat-title').textContent;
      activateChatItem(chatId, chatTitleText, standaloneChat);
    }
  });

  // --- Custom Attached Dropdowns Binding ---
  const attachedProjTrigger = document.getElementById('attached-project-dropdown-trigger');
  const attachedBranchTrigger = document.getElementById('attached-branch-dropdown-trigger');
  const attachedModeTrigger = document.getElementById('attached-mode-dropdown-trigger');
  const attachedProjDropdown = document.getElementById('attached-project-dropdown');
  const attachedBranchDropdown = document.getElementById('attached-branch-dropdown');
  const attachedModeDropdown = document.getElementById('attached-mode-dropdown');

  if (attachedProjTrigger && attachedBranchTrigger && attachedModeTrigger) {
    // Toggle Project Dropdown
    attachedProjTrigger.addEventListener('click', (e) => {
      if (e.target.closest('.attached-dropdown-menu')) return;
      e.stopPropagation();
      attachedProjDropdown.classList.toggle('show');
      attachedBranchDropdown.classList.remove('show');
      attachedModeDropdown.classList.remove('show');
    });

    // Toggle Branch Dropdown
    attachedBranchTrigger.addEventListener('click', (e) => {
      if (e.target.closest('.attached-dropdown-menu')) return;
      e.stopPropagation();
      attachedBranchDropdown.classList.toggle('show');
      attachedProjDropdown.classList.remove('show');
      attachedModeDropdown.classList.remove('show');
    });

    // Toggle Mode Dropdown
    attachedModeTrigger.addEventListener('click', (e) => {
      if (e.target.closest('.attached-dropdown-menu')) return;
      e.stopPropagation();
      attachedModeDropdown.classList.toggle('show');
      attachedProjDropdown.classList.remove('show');
      attachedBranchDropdown.classList.remove('show');
    });

    // Close on outer click
    document.addEventListener('click', () => {
      attachedProjDropdown.classList.remove('show');
      attachedBranchDropdown.classList.remove('show');
      attachedModeDropdown.classList.remove('show');
    });

    // Prevent closing when clicking inside search input or dropdown container
    attachedProjDropdown.addEventListener('click', (e) => e.stopPropagation());
    attachedBranchDropdown.addEventListener('click', (e) => e.stopPropagation());
    attachedModeDropdown.addEventListener('click', (e) => e.stopPropagation());

    // Search/filtering logic
    const searchInputs = document.querySelectorAll('.attached-search-input');
    searchInputs.forEach(input => {
      input.addEventListener('input', () => {
        const query = input.value.toLowerCase().trim();
        const menu = input.closest('.attached-dropdown-menu');
        const items = menu.querySelectorAll('.dropdown-list .attached-menu-item');
        items.forEach(item => {
          const branchNameEl = item.querySelector('.branch-name');
          const text = branchNameEl ? branchNameEl.textContent : item.querySelector('span').textContent;
          if (text.toLowerCase().includes(query)) {
            item.style.display = 'flex';
          } else {
            item.style.display = 'none';
          }
        });
      });
    });

    // Handle Project item selection
    attachedProjDropdown.querySelectorAll('.attached-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        
        attachedProjDropdown.querySelectorAll('.attached-menu-item').forEach(i => {
          i.classList.remove('selected');
          const check = i.querySelector('.check-icon');
          if (check) check.remove();
        });
        item.classList.add('selected');
        
        const projName = item.querySelector('span').textContent.trim();
        
        const nameEl = attachedProjTrigger.querySelector('.active-project-name');
        if (nameEl) nameEl.textContent = projName;
        
        const greetingEl = document.querySelector('.empty-greeting');
        if (greetingEl) greetingEl.textContent = `我们应该在 ${projName} 中构建什么？`;
        
        const checkIcon = document.createElement('svg');
        checkIcon.className = 'check-icon';
        checkIcon.setAttribute('viewBox', '0 0 24 24');
        checkIcon.setAttribute('fill', 'none');
        checkIcon.setAttribute('stroke', 'currentColor');
        checkIcon.setAttribute('stroke-width', '2');
        checkIcon.style.cssText = 'width: 12px; height: 12px; margin-left: auto; color: var(--color-mint);';
        checkIcon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
        item.appendChild(checkIcon);
        
        // Update activeProjName global reference
        activeProjName = projName;
        
        const sidebarProject = Array.from(document.querySelectorAll('.project-item')).find(el => 
          el.querySelector('.item-text').textContent === projName
        );
        if (sidebarProject) {
          activateProjectItem(sidebarProject);
        }
        
        attachedProjDropdown.classList.remove('show');
      });
    });

    // Handle Mode item selection
    attachedModeDropdown.querySelectorAll('.attached-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        
        attachedModeDropdown.querySelectorAll('.attached-menu-item').forEach(i => {
          i.classList.remove('selected');
          const check = i.querySelector('.check-icon');
          if (check) check.remove();
        });
        
        item.classList.add('selected');
        
        const modeName = item.querySelector('span').textContent.trim();
        const activeModeNameEl = attachedModeTrigger.querySelector('.active-mode-name');
        if (activeModeNameEl) activeModeNameEl.textContent = modeName;
        
        const checkIcon = document.createElement('svg');
        checkIcon.className = 'check-icon';
        checkIcon.setAttribute('viewBox', '0 0 24 24');
        checkIcon.setAttribute('fill', 'none');
        checkIcon.setAttribute('stroke', 'currentColor');
        checkIcon.setAttribute('stroke-width', '2');
        checkIcon.style.cssText = 'width: 12px; height: 12px; margin-left: auto; color: var(--color-mint);';
        checkIcon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
        item.appendChild(checkIcon);
        
        attachedModeDropdown.classList.remove('show');
      });
    });

    // Handle Branch item selection
    attachedBranchDropdown.querySelectorAll('.attached-menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        
        attachedBranchDropdown.querySelectorAll('.attached-menu-item').forEach(i => {
          i.classList.remove('selected');
          const check = i.querySelector('.check-icon');
          if (check) check.remove();
        });
        
        item.classList.add('selected');
        
        const branchNameEl = item.querySelector('.branch-name') || item.querySelector('span');
        const branchName = branchNameEl.textContent.trim();
        
        const branchSpan = attachedBranchTrigger.querySelector('.active-branch-name') || attachedBranchTrigger.querySelector('span');
        if (branchSpan) branchSpan.textContent = branchName;
        
        const checkIcon = document.createElement('svg');
        checkIcon.className = 'check-icon';
        checkIcon.setAttribute('viewBox', '0 0 24 24');
        checkIcon.setAttribute('fill', 'none');
        checkIcon.setAttribute('stroke', 'currentColor');
        checkIcon.setAttribute('stroke-width', '2');
        checkIcon.style.cssText = 'width: 12px; height: 12px; margin-left: auto; color: var(--color-mint);';
        checkIcon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
        item.appendChild(checkIcon);
        
        attachedBranchDropdown.classList.remove('show');
      });
    });

    // Action buttons inside attached project dropdown
    const newProjBtn = document.getElementById('attached-new-project-btn');
    if (newProjBtn) {
      newProjBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachedProjDropdown.classList.remove('show');
        const triggerSidebarBtn = document.querySelector('.header-add-folder-btn');
        if (triggerSidebarBtn) triggerSidebarBtn.click();
      });
    }

    const openFolderBtn = document.getElementById('attached-open-folder-btn');
    if (openFolderBtn) {
      openFolderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachedProjDropdown.classList.remove('show');
        alert('使用现有文件夹：(调用本地系统文件夹浏览器选择并加载工作区)');
      });
    }

    const noProjBtn = document.getElementById('attached-no-project-btn');
    if (noProjBtn) {
      noProjBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachedProjDropdown.classList.remove('show');
        alert('设置为不使用任何项目，将进入空白暂存对话状态');
        
        const nameEl = attachedProjTrigger.querySelector('.active-project-name');
        if (nameEl) nameEl.textContent = '未关联项目';
        
        const greetingEl = document.querySelector('.empty-greeting');
        if (greetingEl) greetingEl.textContent = '我们应该构建什么？';
        
        activeProjName = '未关联项目';
      });
    }

    const newBranchBtn = document.getElementById('attached-new-branch-btn');
    if (newBranchBtn) {
      newBranchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachedBranchDropdown.classList.remove('show');
        const newBranchName = prompt('请输入新分支名称:', 'feature-branch');
        if (newBranchName) {
          alert(`新建并切回分支: git checkout -b ${newBranchName}`);
          const branchSpan = attachedBranchTrigger.querySelector('.active-branch-name') || attachedBranchTrigger.querySelector('span');
          if (branchSpan) branchSpan.textContent = newBranchName;
        }
      });
    }

    const graphBtn = document.getElementById('attached-graph-btn');
    if (graphBtn) {
      graphBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachedBranchDropdown.classList.remove('show');
        alert('打开 Git Graph 面板以浏览分支提交关系图 (Simulated Action)');
      });
    }
  }

  // Quick Chat button click handler
  const quickChatBtn = document.querySelector('.quick-chat-btn');
  if (quickChatBtn) {
    quickChatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      activateQuickChat();
    });
  }

  // Initialize input placeholder to match the default active-chat state
  setInputMode('chat');

  // --- 6. Hierarchical Context Menu Setup ---
  const contextMenu = document.getElementById('context-menu');
  const contextMenuList = document.getElementById('context-menu-list');
  let activeMenuTarget = null;

  const showContextMenu = (x, y, targetElement) => {
    activeMenuTarget = targetElement;
    
    // Position menu
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.classList.add('show');

    // Detect level hierarchy
    const isSectionHeader = targetElement.closest('.section-header');
    const isProject = targetElement.closest('.project-item') && !targetElement.closest('.nested-item');
    const isChat = targetElement.closest('.chat-item') || targetElement.closest('.nested-item');

    let menuHTML = '';

    if (isSectionHeader) {
      // 1. Section Level Context Menu (Organize Sidebar, Sort settings - Hierarchical submenus)
      menuHTML = `
        <li class="nested-menu-container">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          <span>整理侧边栏</span>
          <span class="submenu-arrow"><svg class="submenu-arrow-svg" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
          <ul class="nested-menu">
            <li class="menu-subaction" data-action="organize-project"><span>按项目</span><svg class="checkmark-svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg></li>
            <li class="menu-subaction" data-action="organize-recent">近期项目</li>
            <li class="menu-subaction" data-action="organize-chrono">按时间顺序</li>
            <li class="menu-subaction" data-action="organize-move">下移</li>
          </ul>
        </li>
        <li class="nested-menu-container">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          <span>排序条件</span>
          <span class="submenu-arrow"><svg class="submenu-arrow-svg" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"></polyline></svg></span>
          <ul class="nested-menu">
            <li class="menu-subaction" data-action="sort-time">按修改时间</li>
            <li class="menu-subaction" data-action="sort-name">按名称</li>
          </ul>
        </li>
      `;
    } else if (isProject) {
      // 2. Project/Folder Level Context Menu
      const isPinned = targetElement.dataset.pinnedId || targetElement.closest('#pinned-list');
      menuHTML = `
        <li class="menu-item-action" data-action="pin">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
          <span>${isPinned ? '取消置顶项目' : '置顶项目'}</span>
        </li>
        <li class="menu-item-action" data-action="explorer">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          <span>在资源管理器中打开</span>
        </li>
        <li class="menu-item-action" data-action="worktree">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
          <span>创建永久工作树</span>
        </li>
        <li class="menu-item-action" data-action="rename">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          <span>重命名项目</span>
        </li>
        <li class="menu-item-action" data-action="add-chat">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>新建对话</span>
        </li>
        <li class="menu-item-action menu-danger" data-action="remove">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          <span>移除</span>
        </li>
      `;
    } else if (isChat) {
      // 3. Chat/Conversation Level Context Menu
      const isPinned = targetElement.dataset.pinnedId || targetElement.closest('#pinned-list');
      menuHTML = `
        <li class="menu-item-action" data-action="pin">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
          <span>${isPinned ? '取消置顶对话' : '置顶对话'}</span>
        </li>
        <li class="menu-item-action" data-action="open-new-window">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          <span>在新窗口打开</span>
        </li>
        <li class="menu-item-action" data-action="rename">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          <span>重命名对话</span>
        </li>
        <li class="menu-item-action menu-danger" data-action="remove">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          <span>移除</span>
        </li>
      `;
    }

    contextMenuList.innerHTML = menuHTML;
    bindContextMenuActions();
  };

  const closeContextMenu = () => {
    contextMenu.classList.remove('show');
  };

  document.addEventListener('click', closeContextMenu);
  document.addEventListener('contextmenu', closeContextMenu);

  // Hook context triggers to sidebar (delegation)
  const sidebar = document.querySelector('.sidebar');
  sidebar.addEventListener('contextmenu', (e) => {
    const target = e.target.closest('.project-item, .chat-item, .nested-item, .section-header');
    if (target) {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, target);
    }
  });

  sidebar.addEventListener('click', (e) => {
    const moreBtn = e.target.closest('.item-more-btn, .section-more-btn');
    if (moreBtn) {
      e.preventDefault();
      e.stopPropagation();
      const target = moreBtn.closest('.project-item, .chat-item, .nested-item, .section-header');
      const rect = moreBtn.getBoundingClientRect();
      showContextMenu(rect.left, rect.bottom + 4, target);
    }
  });


  // --- 7. Context Menu Action Binding ---
  const pinnedList = document.getElementById('pinned-list');
  const sectionPinned = document.getElementById('section-pinned');

  const updatePinnedVisibility = () => {
    if (pinnedList.children.length > 0) {
      sectionPinned.style.display = 'flex';
      const list = sectionPinned.querySelector('.section-list');
      list.style.maxHeight = list.scrollHeight + 100 + 'px';
    } else {
      sectionPinned.style.display = 'none';
    }
  };

  const bindContextMenuActions = () => {
    // Sub-menus click action support
    contextMenuList.querySelectorAll('.menu-subaction').forEach(subItem => {
      subItem.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu();
        alert(`菜单选项被选中: ${subItem.textContent.trim()}`);
      });
    });

    // Primary items actions
    contextMenuList.querySelectorAll('.menu-item-action').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu();

        const action = item.getAttribute('data-action');
        if (!activeMenuTarget) return;

        switch (action) {
          case 'pin':
            togglePinItem(activeMenuTarget);
            break;
          case 'open-new-window':
            openChatInNewWindow(activeMenuTarget);
            break;
          case 'rename':
            renameItem(activeMenuTarget);
            break;
          case 'remove':
            removeItem(activeMenuTarget);
            break;
          case 'explorer':
            const expText = activeMenuTarget.querySelector('.item-text').textContent;
            alert(`在资源管理器中打开项目: /tmp/${expText}`);
            break;
          case 'worktree':
            const wtText = activeMenuTarget.querySelector('.item-text').textContent;
            alert(`创建工作树: git worktree add ../${wtText}-worktree main`);
            break;
          case 'add-chat':
            addChatInsideProject(activeMenuTarget);
            break;
        }
      });
    });
  };

  // Open Chat in New Window
  const openChatInNewWindow = (element) => {
    const textSpan = element.querySelector('.item-text, .nested-text, .chat-title');
    const title = textSpan ? textSpan.textContent : '新对话';
    alert(`在新窗口打开对话 "${title}"... (在实际应用中，这里将调用 window.open 打开独立的对话面板)`);
  };

  // Toggle Pinned
  const togglePinItem = (element) => {
    const isPinned = element.closest('#pinned-list') || element.dataset.pinnedId;
    
    if (isPinned) {
      let pinnedId = element.dataset.pinnedId || element.getAttribute('data-id');
      const pinnedClone = pinnedList.querySelector(`[data-original-id="${pinnedId}"]`);
      if (pinnedClone) pinnedClone.remove();

      if (element.closest('#pinned-list')) element.remove();

      const originalEl = document.querySelector(`[data-id="${pinnedId}"]`);
      if (originalEl) delete originalEl.dataset.pinnedId;
      
      updatePinnedVisibility();
    } else {
      const itemId = element.getAttribute('data-id') || 'pin-' + Date.now();
      element.dataset.pinnedId = itemId;

      const textSpan = element.querySelector('.item-text, .nested-text, .chat-title');
      const textVal = textSpan ? textSpan.textContent : 'Item';
      const pinLi = document.createElement('li');
      pinLi.className = 'list-item chat-item pinned-clone';
      pinLi.dataset.originalId = itemId;
      pinLi.dataset.id = itemId;
      
      pinLi.innerHTML = `
        <div class="item-main">
          <span class="item-text">${textVal}</span>
          <div class="item-actions">
            <button class="item-more-btn" title="更多">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="1.25"></circle><circle cx="18" cy="12" r="1.25"></circle><circle cx="6" cy="12" r="1.25"></circle>
              </svg>
            </button>
          </div>
        </div>
      `;
      pinnedList.appendChild(pinLi);
      updatePinnedVisibility();
    }
  };

  // Pop-modal Rename
  let renameTargetElement = null;
  const renameModal = document.getElementById('rename-modal');
  const renameInput = document.getElementById('rename-input');

  const renameItem = (element) => {
    const textSpan = element.querySelector('.item-text, .nested-text, .chat-title');
    if (!textSpan) return;

    renameTargetElement = element;
    renameInput.value = textSpan.textContent;
    renameModal.classList.add('show');
    setTimeout(() => {
      renameInput.focus();
      renameInput.select();
    }, 50);
  };

  // Remove
  const removeItem = (element) => {
    const itemId = element.dataset.id;
    const pinnedClone = pinnedList.querySelector(`[data-original-id="${itemId}"]`);
    if (pinnedClone) pinnedClone.remove();

    if (element.closest('#pinned-list')) {
      const originalEl = document.querySelector(`[data-pinned-id="${itemId}"]`);
      if (originalEl) delete originalEl.dataset.pinnedId;
    }

    element.remove();
    updatePinnedVisibility();
  };

  // Add Chat inside Project
  const addChatInsideProject = (projectLi) => {
    const nestedList = projectLi.querySelector('.nested-list');
    const chatId = 'chat-' + Date.now();
    
    const newChatName = prompt('输入新建对话名称:', '新对话');
    if (!newChatName) return;

    const chatLi = document.createElement('li');
    chatLi.className = 'nested-item chat-item';
    chatLi.dataset.id = chatId;
    chatLi.innerHTML = `
      <span class="nested-text">${escapeHTML(newChatName)}</span>
      <span class="chat-time">1m</span>
      <div class="item-actions">
        <button class="item-more-btn" title="更多">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="1.25"></circle><circle cx="18" cy="12" r="1.25"></circle><circle cx="6" cy="12" r="1.25"></circle>
          </svg>
        </button>
      </div>
    `;
    nestedList.appendChild(chatLi);
    activateChatItem(chatId, newChatName, chatLi);
  };

  // Add folder & chat buttons in section headers bindings
  const projectsListEl = document.getElementById('projects-list');
  const chatsListEl = document.getElementById('chats-list');

  document.querySelector('.header-add-folder-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const folderName = prompt('请输入新项目/文件夹名称:', '新项目');
    if (!folderName) return;

    const projectId = 'project-' + Date.now();
    const projectLi = document.createElement('li');
    projectLi.className = 'list-item project-item';
    projectLi.dataset.id = projectId;
    projectLi.innerHTML = `
      <div class="item-main">
        <svg class="icon folder-animated-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path class="folder-back" d="M4 6h4.5l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"></path>
          <path class="folder-front" d="M2 10h20l-1.8 8.2A2 2 0 0 1 18.2 20H5.8a2 2 0 0 1-2-1.8L2 10z"></path>
        </svg>
        <span class="item-text">${escapeHTML(folderName)}</span>
        <span class="project-collapse-chevron" title="折叠项目">
          <svg class="icon chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </span>
        <div class="item-actions">
          <button class="project-add-chat-btn" title="添加对话">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <button class="item-more-btn" title="更多">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="1.25"></circle><circle cx="18" cy="12" r="1.25"></circle><circle cx="6" cy="12" r="1.25"></circle></svg>
          </button>
        </div>
      </div>
      <ul class="nested-list"></ul>
    `;
    projectsListEl.appendChild(projectLi);
    bindProjectFolderCollapse(projectLi);
    activateProjectItem(projectLi);

    const sec = document.getElementById('section-projects');
    const list = sec.querySelector('.section-list');
    list.style.maxHeight = list.scrollHeight + 100 + 'px';
  });

  document.querySelector('.header-add-chat-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const chatName = prompt('请输入新建对话名称:', '新对话');
    if (!chatName) return;

    const chatId = 'chat-' + Date.now();
    const chatLi = document.createElement('li');
    chatLi.className = 'list-item chat-item';
    chatLi.dataset.id = chatId;
    chatLi.innerHTML = `
      <div class="item-main">
        <span class="chat-title">${escapeHTML(chatName)}</span>
        <span class="chat-time">1m</span>
        <div class="item-actions">
          <button class="item-more-btn" title="更多">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="1.25"></circle><circle cx="18" cy="12" r="1.25"></circle><circle cx="6" cy="12" r="1.25"></circle></svg>
          </button>
        </div>
      </div>
    `;
    chatsListEl.appendChild(chatLi);
    activateChatItem(chatId, chatName, chatLi);

    const sec = document.getElementById('section-chats');
    const list = sec.querySelector('.section-list');
    list.style.maxHeight = list.scrollHeight + 100 + 'px';
  });

  // Project hover add chat icon click bind
  sidebar.addEventListener('click', (e) => {
    const addChatBtn = e.target.closest('.project-add-chat-btn');
    if (addChatBtn) {
      e.stopPropagation();
      const projectLi = addChatBtn.closest('.project-item');
      addChatInsideProject(projectLi);
    }
  });


  // --- 8. Generic Custom Dropdown Binder ---
  const bindCustomDropdown = (dropdownEl, callback) => {
    const trigger = dropdownEl.querySelector('.dropdown-trigger');
    const menu = dropdownEl.querySelector('.dropdown-menu');
    const items = dropdownEl.querySelectorAll('.menu-item');
    
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.dropdown-menu').forEach(m => {
        if (m !== menu) m.classList.remove('show');
      });
      menu.classList.toggle('show');
    });
    
    items.forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        items.forEach(sib => sib.classList.remove('selected'));
        item.classList.add('selected');
        
        trigger.querySelector('span').textContent = item.textContent;
        menu.classList.remove('show');
        
        if (callback) {
          const val = item.getAttribute('data-value') || item.textContent;
          callback(val);
        }
      });
    });
  };

  const dropdownFontSize = document.getElementById('settings-dropdown-fontsize');
  bindCustomDropdown(dropdownFontSize, (val) => {
    document.body.classList.remove('font-small', 'font-medium', 'font-large');
    if (val === 'small') {
      document.body.style.fontSize = '12px';
    } else if (val === 'medium') {
      document.body.style.fontSize = '15px';
    } else if (val === 'large') {
      document.body.style.fontSize = '16px';
    } else {
      document.body.style.fontSize = '14px';
    }
  });

  const dropdownProviderType = document.getElementById('dropdown-provider-type');
  const baseUrlInput = document.getElementById('base-url');
  bindCustomDropdown(dropdownProviderType, (val) => {
    if (val === 'OpenAI') {
      baseUrlInput.value = 'https://api.openai.com/v1';
    } else if (val === 'Anthropic') {
      baseUrlInput.value = 'https://api.anthropic.com/v1';
    } else if (val === 'Gemini') {
      baseUrlInput.value = 'https://generativelanguage.googleapis.com/v1';
    } else {
      baseUrlInput.value = '';
    }
  });

  const dropdownProviderModel = document.getElementById('dropdown-provider-model');
  const contextWindowInput = document.getElementById('context-window');
  bindCustomDropdown(dropdownProviderModel, (val) => {
    if (val === 'gpt-4o') {
      contextWindowInput.value = '128000';
    } else if (val === 'gpt-4-turbo') {
      contextWindowInput.value = '128000';
    } else if (val === 'gpt-3.5-turbo') {
      contextWindowInput.value = '16385';
    }
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.custom-settings-dropdown .dropdown-menu').forEach(m => {
      m.classList.remove('show');
    });
  });


  // --- 9. Original Chat Input & Dropdowns ---
  const dropdowns = document.querySelectorAll('.dropdown:not(.custom-settings-dropdown)');
  dropdowns.forEach(dropdown => {
    const trigger = dropdown.querySelector('.dropdown-trigger');
    const menu = dropdown.querySelector('.dropdown-menu');

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdowns.forEach(d => {
        if (d !== dropdown) {
          d.querySelector('.dropdown-menu').classList.remove('show');
        }
      });
      menu.classList.toggle('show');
    });

    const items = dropdown.querySelectorAll('.menu-item');
    items.forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        items.forEach(sib => sib.classList.remove('selected'));
        item.classList.add('selected');
        trigger.querySelector('span').textContent = item.textContent;
        menu.classList.remove('show');

        if (dropdown.id === 'dropdown-project') {
          const sidebarProject = Array.from(document.querySelectorAll('.project-item')).find(el => 
            el.querySelector('.item-text').textContent === item.textContent
          );
          if (sidebarProject) activateProjectItem(sidebarProject);
        }
      });
    });
  });

  document.addEventListener('click', () => {
    dropdowns.forEach(d => {
      d.querySelector('.dropdown-menu').classList.remove('show');
    });
  });


  // --- 10. Chat Message Submissions ---
  const textarea = document.querySelector('.chat-textarea');
  const sendBtn = document.querySelector('.send-btn');

  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = (textarea.scrollHeight - 6) + 'px';

    if (textarea.value.trim() !== '') {
      sendBtn.classList.add('active');
      sendBtn.removeAttribute('disabled');
    } else {
      sendBtn.classList.remove('active');
      sendBtn.setAttribute('disabled', 'true');
    }
  });

  const sendMessage = () => {
    const text = textarea.value.trim();
    if (!text) return;

    const emptyState = document.getElementById('empty-chat-state');
    const isEmptyActive = emptyState && emptyState.style.display !== 'none';

    if (isEmptyActive) {
      // Create a new chat dynamically
      const chatId = 'chat-' + Date.now();
      const chatName = text.length > 25 ? text.substring(0, 25) + '...' : text;
      currentChatId = chatId;
      chatMessagesData[chatId] = [];

      const chatLi = document.createElement('li');
      chatLi.className = 'list-item chat-item';
      chatLi.dataset.id = chatId;
      chatLi.innerHTML = `
        <div class="item-main">
          <span class="chat-title">${escapeHTML(chatName)}</span>
          <span class="chat-time">1m</span>
          <div class="action-status-container">
            <div class="item-actions">
              <button class="item-more-btn" title="更多">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <circle cx="12" cy="12" r="1.25"></circle><circle cx="18" cy="12" r="1.25"></circle><circle cx="6" cy="12" r="1.25"></circle>
                </svg>
              </button>
            </div>
          </div>
        </div>
      `;

      const chatsListEl = document.getElementById('chats-list');
      if (chatsListEl) {
        chatsListEl.appendChild(chatLi);
      }

      // Update sidebar scroll heights
      setTimeout(() => {
        const sec = document.getElementById('section-chats');
        if (sec) {
          const list = sec.querySelector('.section-list');
          if (list && !sec.classList.contains('collapsed')) {
            list.style.maxHeight = list.scrollHeight + 100 + 'px';
          }
        }
      }, 50);

      // Hide empty state and restore input wrapper to bottom container
      emptyState.style.display = 'none';
      const inputWrapper = document.querySelector('.input-area-wrapper');
      const inputContainer = document.querySelector('.input-panel-container');
      if (inputWrapper && inputContainer) {
        inputContainer.appendChild(inputWrapper);
        inputContainer.style.display = 'block';

        // Switch to active-chat layout
        setInputMode('chat');

        // Hide dropdowns
        document.querySelectorAll('.attached-dropdown-menu').forEach(m => m.classList.remove('show'));
      }

      // Show message list and command bar
      const messageListEl = document.querySelector('.message-list');
      if (messageListEl) {
        messageListEl.style.display = 'flex';
        messageListEl.innerHTML = ''; // Clear for new chat
      }
      const commandBar = document.querySelector('.command-bar');
      if (commandBar) commandBar.style.display = 'flex';

      // Highlight the new chat and remove active from quick-chat-btn
      document.querySelectorAll('.chat-item, .nested-item').forEach(c => c.classList.remove('active'));
      chatLi.classList.add('active');
      const quickChatBtn = document.querySelector('.quick-chat-btn');
      if (quickChatBtn) quickChatBtn.classList.remove('active');

      // Set header panel title
      panelTitle.textContent = chatName;
    }

    // Append user message to data and DOM
    const userMsg = { role: 'user', content: escapeHTML(text) };
    if (currentChatId && chatMessagesData[currentChatId]) {
      chatMessagesData[currentChatId].push(userMsg);
    }
    const userEl = document.createElement('div');
    userEl.innerHTML = renderMessage(userMsg);
    messageList.appendChild(userEl.firstElementChild);

    textarea.value = '';
    textarea.style.height = 'auto';
    sendBtn.classList.remove('active');
    sendBtn.setAttribute('disabled', 'true');

    setTimeout(() => { chatArea.scrollTop = chatArea.scrollHeight; }, 50);
    simulateAIResponse(text);
  };

  sendBtn.addEventListener('click', sendMessage);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  const demoToolCallsBtn = document.getElementById('demo-tool-calls-btn');
  if (demoToolCallsBtn) {
    demoToolCallsBtn.addEventListener('click', () => {
      demoContinuousToolCalls({ count: 10, interval: 1000, toolProbability: 0.9 });
    });
  }

  // --- Streaming tool call helpers ---
  let currentToolGroup = null;

  function renderCurrentMessages() {
    if (!messageList || !currentChatId || !chatMessagesData[currentChatId]) return;
    messageList.innerHTML = renderMessages(chatMessagesData[currentChatId]);
    bindToolToggles(messageList);
    highlightCode(messageList);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function appendToolCall(name, args, result, options = {}) {
    if (!currentChatId || !chatMessagesData[currentChatId]) return null;

    const call = {
      name,
      args,
      result,
      expanded: options.expanded !== false,
      done: true,
      ...(options.diff ? { diff: options.diff } : {})
    };

    if (currentToolGroup && currentToolGroup.status === 'streaming') {
      currentToolGroup.calls.push(call);
    } else {
      currentToolGroup = {
        role: 'tool_group',
        status: 'streaming',
        expanded: true,
        calls: [call]
      };
      chatMessagesData[currentChatId].push(currentToolGroup);
    }
    currentToolGroup.metrics = computeToolMetrics(currentToolGroup.calls);
    renderCurrentMessages();
    return currentToolGroup;
  }

  function finalizeToolGroup() {
    if (!currentToolGroup) return;
    currentToolGroup.status = currentToolGroup.calls.length > 1 ? 'summary' : 'expanded';
    currentToolGroup.expanded = currentToolGroup.calls.length <= 1;
    currentToolGroup = null;
    renderCurrentMessages();
  }

  // Reusable tool call templates for demos / simulations
  const toolCallTemplates = [
    {
      name: 'bash',
      args: '$ ls -la src/components',
      result: 'total 24\ndrwxr-xr-x  6 user staff  192 Jun 14 10:00 .\ndrwxr-xr-x  3 user staff   96 Jun 14 09:55 ..\n-rw-r--r--  1 user staff  412 Jun 14 10:00 Button.jsx\n-rw-r--r--  1 user staff  892 Jun 14 10:00 Modal.jsx\n-rw-r--r--  1 user staff  645 Jun 14 10:00 Sidebar.jsx'
    },
    {
      name: 'bash',
      args: '$ cat package.json | grep version',
      result: '"version": "1.2.0",\n"private": true,'
    },
    {
      name: 'bash',
      args: '$ npm run test -- --watch=false',
      result: 'PASS  src/auth/login.test.js\nPASS  src/utils/format.test.js\nPASS  src/api/client.test.js\n\nTest Suites: 3 passed, 3 total\nTests:       18 passed, 18 total'
    },
    {
      name: 'read_file',
      args: '$ cat src/auth/login.js',
      result: 'function login(username, password) {\n  if (username === "admin" && password === "secret") {\n    return { token: "xyz123" };\n  }\n  return null;\n}\n\nmodule.exports = { login };'
    },
    {
      name: 'grep_search',
      args: '$ grep -rn "TODO" src/',
      result: 'src/utils.js:42:// TODO: refactor retry logic\nsrc/api.js:15:// TODO: add request timeout\nsrc/store.js:88:// TODO: normalize state shape'
    },
    {
      name: 'edit_file',
      args: '$ edit_file src/auth/login.js',
      result: 'Applied 2 edits to src/auth/login.js',
      diff: {
        file: 'src/auth/login.js',
        added: 4,
        removed: 2,
        hunks: [
          {
            oldStart: 1, newStart: 1,
            lines: [
              { type: 'context', content: 'function login(username, password) {' },
              { type: 'removed', content: '  if (username === "admin" && password === "secret") {' },
              { type: 'added', content: '  const hash = await bcrypt.hash(password, 10);' },
              { type: 'added', content: '  if (username === "admin" && await bcrypt.compare(password, hash)) {' },
              { type: 'context', content: '    return { token: "xyz123" };' },
              { type: 'context', content: '  }' },
              { type: 'removed', content: '  return null;' },
              { type: 'added', content: '  return { error: "Invalid credentials" };' }
            ]
          }
        ]
      }
    },
    {
      name: 'edit_file',
      args: '$ edit_file src/utils/retry.js',
      result: 'Applied 5 edits to src/utils/retry.js',
      diff: {
        file: 'src/utils/retry.js',
        added: 12,
        removed: 3,
        hunks: [
          {
            oldStart: 10, newStart: 10,
            lines: [
              { type: 'context', content: 'async function retry(fn, options = {}) {' },
              { type: 'removed', content: '  for (let i = 0; i < 3; i++) {' },
              { type: 'added', content: '  const maxAttempts = options.maxAttempts || 3;' },
              { type: 'added', content: '  const delay = options.delay || 1000;' },
              { type: 'added', content: '  for (let i = 0; i < maxAttempts; i++) {' },
              { type: 'context', content: '    try {' },
              { type: 'context', content: '      return await fn();' },
              { type: 'context', content: '    } catch (err) {' },
              { type: 'added', content: '      if (i === maxAttempts - 1) throw err;' },
              { type: 'added', content: '      await sleep(delay);' },
              { type: 'context', content: '    }' },
              { type: 'context', content: '  }' }
            ]
          }
        ]
      }
    },
    {
      name: 'run_test',
      args: '$ npm test -- src/auth',
      result: 'PASS  src/auth/login.test.js\nPASS  src/auth/reset.test.js\n\nTest Suites: 2 passed, 2 total'
    }
  ];

  window.appendToolCall = appendToolCall;
  window.finalizeToolGroup = finalizeToolGroup;

  window.demoContinuousToolCalls = function(options = {}) {
    const count = options.count || 12;
    const interval = options.interval || 1000;
    const toolProbability = options.toolProbability || 0.85;

    // Ensure we are in a chat view
    if (!currentChatId || !chatMessagesData[currentChatId]) {
      activateChatItem('todo-list-app', 'build a todo list app');
    }

    let i = 0;
    const timer = setInterval(() => {
      if (i >= count) {
        clearInterval(timer);
        finalizeToolGroup();
        if (Math.random() > 0.3) {
          chatMessagesData[currentChatId].push({
            role: 'assistant',
            content: '连续工具调用演示结束，已处理所有请求。'
          });
          renderCurrentMessages();
        }
        return;
      }

      if (Math.random() < toolProbability) {
        const tpl = toolCallTemplates[Math.floor(Math.random() * toolCallTemplates.length)];
        appendToolCall(tpl.name, tpl.args, tpl.result, { expanded: false });
      } else {
        finalizeToolGroup();
        chatMessagesData[currentChatId].push({
          role: 'assistant',
          content: `中间说明 #${i + 1}`
        });
        renderCurrentMessages();
      }
      i++;
    }, interval);
  };

  const simulateAIResponse = (userPrompt) => {
    const loadingMsg = document.createElement('div');
    loadingMsg.className = 'chat-message system-thinking';
    loadingMsg.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 13px; margin-top: 8px;">
        <svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; animation: spin 1s linear infinite; color: var(--text-secondary);">
          <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="10"></circle>
        </svg>
        <span>MyCodex is thinking...</span>
      </div>
    `;
    messageList.appendChild(loadingMsg);
    chatArea.scrollTop = chatArea.scrollHeight;

    setTimeout(() => {
      loadingMsg.remove();

      let responseText = "我已经收到了您的请求，正在处理中。由于这是一个原型界面，所有交互均在本地模拟运行。";
      if (userPrompt.toLowerCase().includes('todo') || userPrompt.includes('应用')) {
        responseText = "我尝试重新运行了环境，并通过系统浏览器再次加载了页面。如果有什么需要微调的地方，请随时告诉我。";
      } else if (userPrompt.toLowerCase().includes('hello') || userPrompt.includes('你好')) {
        responseText = "你好！我是 MyCodex AI 助手。我可以帮你配置服务、执行自动化测试或者管理你的工作树。";
      }

      // Build tool group: single tool normally, multiple tools for longer prompts to demo summary
      const baseArgs = `simulate_reply.js --prompt="${userPrompt.substring(0, 30)}..."`;
      appendToolCall('simulate_reply', baseArgs, `Processing prompt: ${userPrompt}\nStatus: ok\nDuration: 120ms`, { expanded: false });
      if (userPrompt.length > 10) {
        appendToolCall('read_file', 'read_file --path="/tmp/mycodex-demo/config.json"', '{ "env": "local", "browser": "system" }', { expanded: false });
      }
      finalizeToolGroup();

      const assistantMsg = { role: 'assistant', content: responseText };
      if (currentChatId && chatMessagesData[currentChatId]) {
        chatMessagesData[currentChatId].push(assistantMsg);
      }

      const aiEl = document.createElement('div');
      aiEl.innerHTML = renderMessage(assistantMsg);
      messageList.appendChild(aiEl.firstElementChild);

      bindToolToggles(messageList);
      highlightCode(messageList);
      chatArea.scrollTop = chatArea.scrollHeight;
    }, 1200);
  };


  // --- 11. Settings Modal Navigation ---
  const settingsBtn = document.querySelector('.settings-btn');
  const modal = document.getElementById('settings-modal');
  const closeModalBtn = document.querySelector('.close-modal-btn');
  const tabButtons = document.querySelectorAll('.settings-tab-btn');
  const panels = document.querySelectorAll('.settings-panel');

  settingsBtn.addEventListener('click', () => {
    modal.classList.add('show');
  });

  const closeModal = () => {
    modal.classList.remove('show');
  };

  closeModalBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetId = btn.getAttribute('data-target');
      panels.forEach(panel => {
        if (panel.id === targetId) {
          panel.classList.add('active');
        } else {
          panel.classList.remove('active');
        }
      });
    });
  });


  // --- 12. Appearance Settings Sync ---
  const themeCards = document.querySelectorAll('.theme-card');
  themeCards.forEach(card => {
    card.addEventListener('click', () => {
      themeCards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      const themeVal = card.getAttribute('data-theme-val');
      if (themeVal === 'dark') {
        document.body.classList.add('dark-theme');
      } else if (themeVal === 'light') {
        document.body.classList.remove('dark-theme');
      } else {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (prefersDark) {
          document.body.classList.add('dark-theme');
        } else {
          document.body.classList.remove('dark-theme');
        }
      }
    });
  });

  const wrapCodeToggle = document.getElementById('toggle-wrap-code');
  wrapCodeToggle.addEventListener('change', () => {
    const isChecked = wrapCodeToggle.checked;
    const blocks = document.querySelectorAll('.code-block code');
    blocks.forEach(block => {
      block.style.whiteSpace = isChecked ? 'pre-wrap' : 'pre';
    });
  });


  // --- 13. Custom LLM Provider Sub-Modal & Form Configuration ---
  const btnAddProvider = document.getElementById('btn-add-provider');
  const addProviderModal = document.getElementById('add-provider-modal');
  const closeSubmodalBtn = document.querySelector('.close-submodal-btn');
  const btnCancelProvider = document.getElementById('btn-cancel-provider');
  const btnTestProvider = document.getElementById('btn-test-provider');
  const providerForm = document.getElementById('provider-form');
  const customProvidersSection = document.getElementById('custom-providers-section');
  const customProvidersList = document.getElementById('custom-providers-list');
  const chatModelDropdown = document.querySelector('#dropdown-model .dropdown-menu');

  btnAddProvider.addEventListener('click', () => {
    addProviderModal.classList.add('show');
  });

  const closeSubmodal = () => {
    addProviderModal.classList.remove('show');
    providerForm.reset();
  };

  closeSubmodalBtn.addEventListener('click', closeSubmodal);
  btnCancelProvider.addEventListener('click', closeSubmodal);
  addProviderModal.addEventListener('click', (e) => {
    if (e.target === addProviderModal) closeSubmodal();
  });

  btnTestProvider.addEventListener('click', () => {
    const key = document.getElementById('api-key').value;
    if (!key) {
      alert('请先填写 API 密钥字段。');
      return;
    }
    btnTestProvider.textContent = '连接测试中...';
    btnTestProvider.setAttribute('disabled', 'true');
    setTimeout(() => {
      btnTestProvider.textContent = '测试连接';
      btnTestProvider.removeAttribute('disabled');
      alert('连接成功！API 密钥与 Base URL 认证有效。');
    }, 1200);
  });

  providerForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const providerType = dropdownProviderType.querySelector('.dropdown-trigger span').textContent;
    const providerName = document.getElementById('provider-name').value;
    const model = dropdownProviderModel.querySelector('.dropdown-trigger span').textContent;

    const customLi = document.createElement('li');
    customLi.className = 'provider-item';
    customLi.innerHTML = `
      <div class="provider-info">
        <span class="provider-name">${escapeHTML(providerName)} (${escapeHTML(providerType)} - ${escapeHTML(model)})</span>
        <span class="provider-status active" style="background-color: #f0fdf4; color: #10b981;">已添加</span>
      </div>
      <label class="switch-container">
        <input type="checkbox" checked>
        <span class="switch-slider"></span>
      </label>
    `;
    customProvidersList.appendChild(customLi);
    
    customProvidersSection.style.display = 'block';

    const modelLi = document.createElement('li');
    modelLi.className = 'menu-item';
    modelLi.textContent = providerName;
    modelLi.addEventListener('click', (e) => {
      e.stopPropagation();
      chatModelDropdown.querySelectorAll('.menu-item').forEach(sib => sib.classList.remove('selected'));
      modelLi.classList.add('selected');
      document.querySelector('#dropdown-model .dropdown-trigger span').textContent = providerName;
      chatModelDropdown.classList.remove('show');
    });
    chatModelDropdown.appendChild(modelLi);

    closeSubmodal();
    alert(`自定义模型 "${providerName}" 已成功添加并加入模型列表！`);
  });

  const openAppBtn = document.querySelector('.open-app-btn');
  openAppBtn.addEventListener('click', () => {
    alert('Mock Action: Opening the application in a simulated workspace tab!');
  });


  // --- 14. Rename Pop-modal Dialog Event Handlers ---
  const cancelRenameBtn = document.getElementById('btn-cancel-rename');
  const closeRenameBtn = document.getElementById('close-rename-modal-btn');
  const renameForm = document.getElementById('rename-form');

  const closeRename = () => {
    renameModal.classList.remove('show');
    renameTargetElement = null;
  };

  if (cancelRenameBtn) cancelRenameBtn.addEventListener('click', closeRename);
  if (closeRenameBtn) closeRenameBtn.addEventListener('click', closeRename);
  if (renameForm) {
    renameForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = renameInput.value.trim();
      if (val && renameTargetElement) {
        const textSpan = renameTargetElement.querySelector('.item-text, .nested-text, .chat-title');
        if (textSpan) {
          const originalText = textSpan.textContent;
          if (val !== originalText) {
            textSpan.textContent = val;
            if (renameTargetElement.classList.contains('active')) {
              panelTitle.textContent = val;
            }

            const itemId = renameTargetElement.dataset.id;
            const pinnedClone = pinnedList.querySelector(`[data-original-id="${itemId}"]`);
            if (pinnedClone) {
              pinnedClone.querySelector('.item-text').textContent = val;
            }
          }
        }
      }
      closeRename();
    });
  }


  // --- 15. Feature Accordion Folding/Unfolding ---
  const featureAccordionTrigger = document.getElementById('feature-accordion-trigger');
  const featureAccordionBody = document.getElementById('feature-accordion-body');

  if (featureAccordionTrigger && featureAccordionBody) {
    featureAccordionTrigger.addEventListener('click', () => {
      featureAccordion.classList.toggle('expanded');
      if (featureAccordion.classList.contains('expanded')) {
        featureAccordionBody.style.maxHeight = featureAccordionBody.scrollHeight + 'px';
      } else {
        featureAccordionBody.style.maxHeight = '0px';
      }
      
      // Update sidebar sections scroll heights
      setTimeout(() => {
        sidebarSections.forEach(sec => {
          const list = sec.querySelector('.section-list');
          if (list && !sec.classList.contains('collapsed')) {
            list.style.maxHeight = list.scrollHeight + 100 + 'px';
          }
        });
      }, 200);
    });

    // Initialize expanded
    featureAccordion.classList.add('expanded');
    featureAccordionBody.style.maxHeight = featureAccordionBody.scrollHeight + 'px';
  }


  // --- 16. Feature View Switcher ---
  const featureItems = document.querySelectorAll('.feature-item');
  const chatViews = [
    document.querySelector('.command-bar'),
    document.querySelector('.chat-area'),
    document.querySelector('.input-panel-container')
  ];
  const featureViews = document.querySelectorAll('.feature-panel-view');

  const showFeatureView = (viewId) => {
    // Hide empty state if visible
    const emptyState = document.getElementById('empty-chat-state');
    if (emptyState) emptyState.style.display = 'none';

    // Remove active highlight from quick-chat-btn
    const quickChatBtn = document.querySelector('.quick-chat-btn');
    if (quickChatBtn) quickChatBtn.classList.remove('active');

    // Restore input card to bottom container
    const inputContainer = document.querySelector('.input-panel-container');
    if (inputContainer) {
      const inputCard = document.querySelector('.input-card');
      if (inputCard && !inputContainer.contains(inputCard)) {
        inputContainer.appendChild(inputCard);
      }
    }

    // Hide chat views
    chatViews.forEach(el => { if (el) el.style.display = 'none'; });
    // Hide all feature views
    featureViews.forEach(el => { el.style.display = 'none'; });
    
    // Show target feature view
    const targetView = document.getElementById(`view-${viewId}`);
    if (targetView) {
      targetView.style.display = 'flex';
    }

    // Set panel title
    const itemName = {
      'prompts': '提示词管理',
      'favorites': '我的收藏',
      'plugins': '插件管理',
      'skills': '技能管理'
    }[viewId];
    panelTitle.textContent = itemName;

    // Remove active state from chats
    document.querySelectorAll('.chat-item, .nested-item').forEach(c => c.classList.remove('active'));
    // Remove active state from feature items, set active on current
    featureItems.forEach(item => {
      if (item.getAttribute('data-panel') === viewId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  };

  featureItems.forEach(item => {
    item.addEventListener('click', () => {
      const viewId = item.getAttribute('data-panel');
      showFeatureView(viewId);
    });
  });


  // --- 17. Favorites document switcher ---
  const favItems = document.querySelectorAll('.secondary-sidebar-item');
  const favDocBody = document.querySelector('.fav-doc-viewer .markdown-body');

  // Initial highlight for any static code blocks
  highlightCode();

  const favDocs = {
    'todo-list-app': `
      <h1 id="sec-title">build a todo list app</h1>
      <div class="doc-metadata">
        <span>收藏时间: 2026-06-13</span>
        <span>关联项目: mycodex-demo</span>
      </div>
      <hr>
      <h2 id="sec-1">1. 需求分析</h2>
      <p>构建一个极简的高级待办事项应用，支持任务添加、完成状态切换、清除已完成 and 本地持久化存储。</p>
      <h2 id="sec-2">2. 代码实现</h2>
      <p>以下是应用的主逻辑文件：</p>
      <pre class="code-block"><code>// todo-app.js
class TodoApp {
  constructor() {
    this.todos = JSON.parse(localStorage.getItem('todos')) || [];
    this.init();
  }
}</code></pre>
      <h2 id="sec-3">3. 问题排查</h2>
      <p>如果遇到本地缓存无法读取的问题，可以检查 <a href="#sec-2">代码实现</a> 中关于 <code>localStorage</code> 的调用方式。</p>
    `,
    'refactor-auth': `
      <h1 id="sec-title">refactor login logic</h1>
      <div class="doc-metadata">
        <span>收藏时间: 2026-06-13</span>
        <span>关联项目: mycodex-demo</span>
      </div>
      <hr>
      <h2 id="sec-1">1. 重构背景</h2>
      <p>为了提升系统的安全性，将纯文本存储的密码重构为 bcrypt 加密哈希存储，并支持 OAuth2 标准授权流程。</p>
      <h2 id="sec-2">2. bcrypt 加密集成</h2>
      <pre class="code-block"><code>// auth.js
import bcrypt from 'bcrypt';
const saltRounds = 10;
export async function hashPassword(password) {
  return await bcrypt.hash(password, saltRounds);
}</code></pre>
    `
  };

  favItems.forEach(item => {
    item.addEventListener('click', () => {
      favItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const docName = item.textContent.trim();
      const docKey = docName.includes('todo') ? 'todo-list-app' : 'refactor-auth';
      if (favDocs[docKey]) {
        favDocBody.innerHTML = favDocs[docKey];
        highlightCode(favDocBody);
      }
    });
  });


  // --- 18. Skills switcher ---
  const skillItems = document.querySelectorAll('#skills-list .secondary-sidebar-item');
  const skillName = document.getElementById('skill-name');
  const skillDesc = document.getElementById('skill-description');
  const skillCode = document.getElementById('skill-code');

  const skillsData = {
    'format_markdown': {
      name: 'format_markdown.js',
      desc: '自动规范化 Markdown 格式，修复空行、列表对齐、标题间距，并优化中文和英文之间的空格间隔。',
      code: `// format_markdown.js\nexport default function formatMarkdown(text) {\n  let formatted = text.replace(/([\\u4e00-\\u9fa5])([A-Za-z0-9])/g, '$1 $2');\n  formatted = formatted.replace(/([A-Za-z0-9])([\\u4e00-\\u9fa5])/g, '$1 $2');\n  formatted = formatted.replace(/\\n{3,}/g, '\\n\\n');\n  return formatted;\n}`
    },
    'extract_todo': {
      name: 'extract_todo.py',
      desc: '从当前工作空间的所有源文件中扫描并提取包含 # TODO 标记的代码行，并以 Markdown 任务列表的形式输出。',
      code: `# extract_todo.py\nimport os\nimport re\n\ndef scan_todos(directory):\n    todo_pattern = re.compile(r'#\\s*TODO:\\s*(.*)', re.IGNORECASE)\n    for root, dirs, files in os.walk(directory):\n        for file in files:\n            if file.endswith(('.py', '.js', '.css', '.html')):\n                path = os.path.join(root, file)\n                with open(path, 'r', encoding='utf-8') as f:\n                    for i, line in enumerate(f, 1):\n                        match = todo_pattern.search(line)\n                        if match:\n                            print(f"- [ ] {file}:{i} - {match.group(1)}")`
    },
    'minify_css': {
      name: 'minify_css.js',
      desc: '移除 CSS 源码中的所有注释、不必要的空格、换行以及重复的属性声明，最大限度地压缩样式文件体积。',
      code: `// minify_css.js\nexport function minifyCSS(cssText) {\n  return cssText\n    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '') // Remove comments\n    .replace(/\\s+([{} >+~;:,])/g, '$1')\n    .replace(/([{} >+~;:,])\\s+/g, '$1')\n    .replace(/\\s+/g, ' ')\n    .trim();\n}`
    }
  };

  skillItems.forEach(item => {
    item.addEventListener('click', () => {
      skillItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const id = item.getAttribute('data-skill');
      const data = skillsData[id];
      if (data) {
        skillName.textContent = data.name;
        skillDesc.textContent = data.desc;
        skillCode.textContent = data.code;
        delete skillCode.dataset.highlighted;
        highlightCode(skillCode.closest('.code-block'));
      }
    });
  });

  // Initialize default active chat
  activateChatItem('todo-list-app', 'build a todo list app');
});
