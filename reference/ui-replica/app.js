// Performance-optimized syntax highlighter using Prism.js with fallbacks
function highlightCode(root = document) {
  if (window.Prism) {
    root.querySelectorAll('.code-block code, pre code, .markdown-body pre code').forEach(block => {
      if (block.dataset.highlighted) return;

      // Extract file extension or content features to detect language
      let text = block.textContent;
      let lang = 'javascript'; // default

      // Simple heuristic language detection
      if (text.includes('def ') || text.includes('import sys') || text.includes('__main__')) {
        lang = 'python';
      } else if (text.includes('html') || text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
        lang = 'markup';
      } else if (text.includes('{') && (text.includes('margin:') || text.includes('padding:') || text.includes('color: var('))) {
        lang = 'css';
      } else if (text.startsWith('$ ') || text.startsWith('npm ') || text.startsWith('node ')) {
        lang = 'bash';
      }

      block.classList.add(`language-${lang}`);
      window.Prism.highlightElement(block);
      block.dataset.highlighted = 'true';
    });
  } else {
    // Basic fallback highlights when offline/CDN load fails
    root.querySelectorAll('.code-block code, pre code, .markdown-body pre code').forEach(block => {
      if (block.dataset.highlighted) return;
      block.innerHTML = block.textContent
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      block.dataset.highlighted = 'true';
    });
  }
}

function convertStaticDiffs() {
  document.querySelectorAll('.diff-item-content').forEach(container => {
    const pre = container.querySelector('pre.diff-code-block');
    if (!pre) return;
    const code = pre.querySelector('code');
    if (!code) return;

    const diffView = document.createElement('div');
    diffView.className = 'diff-view';

    // Get all spans inside code
    const spans = code.querySelectorAll('span');
    if (spans.length > 0) {
      let oldLine = 1;
      let newLine = 1;

      spans.forEach(span => {
        const text = span.textContent;
        let type = 'context';
        let marker = ' ';
        let content = text;
        let oldNum = '';
        let newNum = '';

        if (span.classList.contains('diff-chunk')) {
          const match = text.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
          if (match) {
            oldLine = parseInt(match[1], 10);
            newLine = parseInt(match[2], 10);
          }
          return; // Skip chunk headers
        } else if (span.classList.contains('diff-deletion')) {
          type = 'removed';
          marker = '-';
          if (text.startsWith('-')) {
            content = text.substring(1);
          }
          oldNum = oldLine++;
        } else if (span.classList.contains('diff-addition')) {
          type = 'added';
          marker = '+';
          if (text.startsWith('+')) {
            content = text.substring(1);
          }
          newNum = newLine++;
        } else if (span.classList.contains('diff-context')) {
          type = 'context';
          marker = ' ';
          oldNum = oldLine++;
          newNum = newLine++;
        }

        const lineDiv = document.createElement('div');
        lineDiv.className = `diff-line diff-${type}`;

        const numSpan1 = document.createElement('span');
        numSpan1.className = 'diff-num';
        numSpan1.textContent = oldNum || '';
        const numSpan2 = document.createElement('span');
        numSpan2.className = 'diff-num';
        numSpan2.textContent = newNum || '';

        const markerSpan = document.createElement('span');
        markerSpan.className = 'diff-marker';
        markerSpan.textContent = marker;

        const contentSpan = document.createElement('span');
        contentSpan.className = 'diff-content';
        contentSpan.textContent = content;

        lineDiv.appendChild(numSpan1);
        lineDiv.appendChild(numSpan2);
        lineDiv.appendChild(markerSpan);
        lineDiv.appendChild(contentSpan);

        diffView.appendChild(lineDiv);
      });
    }

    // Replace pre with diffView
    pre.replaceWith(diffView);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // Convert static diff blocks to reuse the clean flex line-by-line structure
  convertStaticDiffs();

  // --- 1. Windows Window Control Interactions ---
  const macWindow = document.querySelector('.mac-window'); // keep variable name for compatibility
  const winCloseBtn = document.getElementById('win-close-btn');
  const winMinBtn = document.getElementById('win-min-btn');
  const winMaxBtn = document.getElementById('win-max-btn');
  const desktopBackground = document.querySelector('.desktop-background');

  if (winCloseBtn) {
    winCloseBtn.addEventListener('click', () => {
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
        restoreBtn.style.zIndex = '1000';
        
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

  // --- 1.1 Windows Titlebar Dropdown & Command Palette Interactions ---
  const commandPaletteModal = document.getElementById('command-palette-modal');
  const winSearchBox = document.querySelector('.win-search-box');
  const paletteSearchInput = document.querySelector('.palette-search-input');

  const showCommandPalette = () => {
    if (commandPaletteModal) {
      commandPaletteModal.style.display = 'flex';
      setTimeout(() => {
        if (paletteSearchInput) paletteSearchInput.focus();
      }, 50);
    }
  };

  const hideCommandPalette = () => {
    if (commandPaletteModal) {
      commandPaletteModal.style.display = 'none';
    }
  };

  const winToggleSidebarBtn = document.getElementById('win-toggle-sidebar-btn');
  const sidebar = document.querySelector('.sidebar');
  if (winToggleSidebarBtn && sidebar) {
    winToggleSidebarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sidebar.classList.toggle('collapsed');
      if (!sidebar.classList.contains('collapsed')) {
        try { const s = localStorage.getItem('sidebar-left-width'); if (s) sidebar.style.width = s; } catch (_) {}
      }
    });
  }

  const winToggleRightSidebarBtn = document.getElementById('win-toggle-right-sidebar-btn');
  if (winToggleRightSidebarBtn) {
    winToggleRightSidebarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (rightSidebar) {
        rightSidebar.classList.toggle('collapsed');
        if (!rightSidebar.classList.contains('collapsed')) {
          try { const s = localStorage.getItem('sidebar-right-width'); if (s) rightSidebar.style.width = s; } catch (_) {}
          // Ensure first tab is active
          const firstTab = rightTabList ? rightTabList.querySelector('.right-tab-btn') : null;
          if (firstTab) activateTab(firstTab.dataset.tabId);
        }
      }
    });
  }

  // --- Sidebar drag-to-resize with auto-collapse ---
  function initSidebarResize(sidebar, edge, storageKey, defaultWidth, minWidth) {
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
      const initWidth = parseFloat(sidebar.dataset.initWidth) || rect.width;
      let newWidth;
      if (edge === 'right') {
        newWidth = e.clientX - rect.left;
      } else {
        newWidth = rect.right - e.clientX;
      }
      // Damping: collapse only when dragged past half the initial width
      if (newWidth < initWidth * 0.5) {
        sidebar.classList.add('collapsed');
        try { localStorage.setItem(storageKey, ''); } catch (_) {}
        isResizing = false;
        sidebar.classList.remove('resizing');
        sidebar.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        return;
      }
      newWidth = Math.max(minWidth, Math.min(newWidth, rect.width * 0.5));
      sidebar.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      sidebar.classList.remove('resizing');
      sidebar.style.transition = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        const w = sidebar.style.width;
        if (w && parseFloat(w) >= minWidth) localStorage.setItem(storageKey, w);
      } catch (_) {}
    };

    // Attach to the edge pseudo-element via capturing on the sidebar itself
    sidebar.addEventListener('mousedown', (e) => {
      if (edge === 'right') {
        const rect = sidebar.getBoundingClientRect();
        if (e.clientX >= rect.right - 6 && e.clientX <= rect.right) {
          onMouseDown(e);
        }
      } else {
        const rect = sidebar.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.left + 6) {
          onMouseDown(e);
        }
      }
    });

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Restore saved width
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) sidebar.style.width = saved;
    } catch (_) {}
  }

  const leftSidebar = document.querySelector('.sidebar');
  const rightSidebar = document.querySelector('.right-sidebar');
  if (leftSidebar) initSidebarResize(leftSidebar, 'right', 'sidebar-left-width', '260px', 190);
  if (rightSidebar) initSidebarResize(rightSidebar, 'left', 'sidebar-right-width', '360px', 300);

  // --- Responsive collapse: right first, then left ---
  function handleResponsiveCollapse() {
    const winBody = document.querySelector('.window-body');
    if (!winBody) return;
    const available = winBody.clientWidth;
    const leftW = leftSidebar && !leftSidebar.classList.contains('collapsed') ? leftSidebar.offsetWidth : 0;
    const rightW = rightSidebar && !rightSidebar.classList.contains('collapsed') ? rightSidebar.offsetWidth : 0;
    const minMain = 520;
    if (available - leftW - rightW < minMain) {
      if (rightSidebar && !rightSidebar.classList.contains('collapsed')) {
        rightSidebar.classList.add('collapsed');
      } else if (leftSidebar && !leftSidebar.classList.contains('collapsed')) {
        leftSidebar.classList.add('collapsed');
      }
    }
    if (available - leftW - rightW < minMain) {
      if (rightSidebar && !rightSidebar.classList.contains('collapsed')) {
        rightSidebar.classList.add('collapsed');
      } else if (leftSidebar && !leftSidebar.classList.contains('collapsed')) {
        leftSidebar.classList.add('collapsed');
      }
    }
  }

  window.addEventListener('resize', handleResponsiveCollapse);

  if (winSearchBox) {
    winSearchBox.addEventListener('click', (e) => {
      e.stopPropagation();
      showCommandPalette();
    });
  }

  if (commandPaletteModal) {
    commandPaletteModal.addEventListener('click', (e) => {
      if (e.target === commandPaletteModal) {
        hideCommandPalette();
      }
    });
  }

  // Bind command palette item actions
  const paletteItems = document.querySelectorAll('.palette-item');
  paletteItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.getAttribute('data-action');
      hideCommandPalette();
      executePaletteAction(action);
    });
  });

  function executePaletteAction(action) {
    switch (action) {
      case 'new-chat':
        const headerAddChatBtn = document.querySelector('.header-add-chat-btn');
        if (headerAddChatBtn) headerAddChatBtn.click();
        break;
      case 'toggle-sidebar':
        const sidebarEl = document.querySelector('.sidebar');
        if (sidebarEl) {
          sidebarEl.classList.toggle('collapsed');
          if (!sidebarEl.classList.contains('collapsed')) {
            try { const s = localStorage.getItem('sidebar-left-width'); if (s) sidebarEl.style.width = s; } catch (_) {}
          }
        }
        break;
      case 'toggle-right-sidebar':
        const rSidebar = document.querySelector('.right-sidebar');
        if (rSidebar) {
          rSidebar.classList.toggle('collapsed');
          if (!rSidebar.classList.contains('collapsed')) {
            try { const s = localStorage.getItem('sidebar-right-width'); if (s) rSidebar.style.width = s; } catch (_) {}
            // Ensure first tab is active
            const firstTab = rightTabList ? rightTabList.querySelector('.right-tab-btn') : null;
            if (firstTab) activateTab(firstTab.dataset.tabId);
          }
        }
        break;
      case 'open-settings':
        const settingsBtn = document.querySelector('.settings-btn');
        if (settingsBtn) settingsBtn.click();
        break;
      case 'run-demo':
        const demoBtn = document.getElementById('demo-tool-calls-btn');
        if (demoBtn) demoBtn.click();
        break;
      case 'toggle-theme':
        // Find current active theme card and toggle
        const activeThemeCard = document.querySelector('.theme-grid .theme-card.active');
        const themeCards = document.querySelectorAll('.theme-grid .theme-card');
        if (activeThemeCard && themeCards.length > 0) {
          let nextIndex = 0;
          themeCards.forEach((c, idx) => {
            if (c === activeThemeCard) {
              nextIndex = (idx + 1) % themeCards.length;
            }
          });
          themeCards[nextIndex].click();
        }
        break;
      default:
        console.log('Unknown action:', action);
    }
  }

  // Keyboard shortcut listeners
  document.addEventListener('keydown', (e) => {
    // Ctrl+P opens command palette
    if (e.ctrlKey && e.key === 'p') {
      e.preventDefault();
      showCommandPalette();
    }
    // Escape closes command palette
    if (e.key === 'Escape') {
      hideCommandPalette();
    }
    // Ctrl+B toggles sidebar
    if (e.ctrlKey && e.key === 'b') {
      e.preventDefault();
      executePaletteAction('toggle-sidebar');
    }
  });

  // Top menubar dropdown handling: Clicking on item in menu dropdown performs mock action
  const winMenuDropdowns = document.querySelectorAll('.win-menu-dropdown');
  winMenuDropdowns.forEach(dropdown => {
    dropdown.addEventListener('click', (e) => {
      const target = e.target.closest('.dropdown-item');
      if (!target) return;
      
      e.stopPropagation();
      const id = target.id;
      
      switch(id) {
        case 'menu-new-file':
        case 'menu-new-terminal':
          alert(`模拟运行指令：${target.textContent.trim()}`);
          break;
        case 'menu-open-folder':
          const openFolderBtn = document.getElementById('attached-open-folder-btn');
          if (openFolderBtn) openFolderBtn.click();
          else alert('打开文件夹文件选择器');
          break;
        case 'menu-save':
          alert('模拟：工作区所有变更已成功保存！');
          break;
        case 'menu-exit':
          if (winCloseBtn) winCloseBtn.click();
          break;
        case 'menu-undo':
          alert('模拟撤销上一命令执行结果');
          break;
        case 'menu-redo':
          alert('模拟重做上一命令');
          break;
        case 'menu-copy':
          alert('模拟文本复制');
          break;
        case 'menu-paste':
          alert('模拟文本粘贴');
          break;
        case 'menu-toggle-sidebar':
          executePaletteAction('toggle-sidebar');
          break;
        case 'menu-toggle-right-sidebar':
          executePaletteAction('toggle-right-sidebar');
          break;
        case 'menu-toggle-terminal':
          alert('切换终端面板');
          break;
        case 'menu-run-task':
          executePaletteAction('run-demo');
          break;
        case 'menu-about':
          alert('MyCodex Developer Studio v1.0.0\n基于 Antigravity 强劲的智能 IDE 主题系统。');
          break;
        case 'menu-docs':
          alert('打开在线文档页: https://gemini.google.com/antigravity');
          break;
      }
    });
  });

  // Click toggle for win-menu: keeps dropdown open after click
  document.querySelectorAll('.win-menu-item').forEach(function(item) {
    item.addEventListener('click', function(e) {
      if (e.target.closest('.win-menu-dropdown')) return;
      e.stopPropagation();
      document.querySelectorAll('.win-menu-item.active').forEach(function(el) {
        if (el !== item) el.classList.remove('active');
      });
      item.classList.toggle('active');
    });
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.win-menu-item')) {
      document.querySelectorAll('.win-menu-item.active').forEach(function(el) {
        el.classList.remove('active');
      });
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

    return `<div class="diff-view">${hunksHtml}</div>`;
  }

  const toolNameLabels = {
    'bash': '调用', 'read_file': '读取', 'edit_file': '编辑',
    'edit': '编辑', 'grep_search': '搜索', 'run_test': '测试',
    'simulate_reply': '调用', 'node_repl': '执行'
  };

  function renderToolCall(call, index) {
    const expanded = call.expanded !== false;
    const safeArgs = escapeHTML(call.args);
    const friendlyLabel = call.label || safeArgs;
    const displayName = toolNameLabels[call.name] || call.name;
    const status = call.status || 'success';
    const isEditTool = call.name === 'edit_file' || call.name === 'edit';
    const hasFailed = status === 'failure';
    const uid = call.uid || `call-${index}-${Date.now()}`;

    // Status icon: terminal for success, dash-circle for failure (NOT red, use muted)
    const statusIcon = hasFailed
      ? `<svg class="icon tool-status-icon tool-status-icon-fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`
      : `<svg class="icon tool-status-icon tool-status-icon-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

    // Edit stats: show +N -M in row + file-explorer button
    let editStatsHtml = '';
    if (isEditTool && call.diff) {
      editStatsHtml = `<span class="tool-edit-stats"><span class="diff-stat-added">+${call.diff.added}</span><span class="diff-stat-removed">-${call.diff.removed}</span><svg class="tool-open-files-btn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" title="在资源管理器中打开"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></span>`;
    }

    // Output: for failed calls, show empty / minimal content
    const outputContent = hasFailed
      ? `<pre style="color: var(--text-muted); font-style: italic;">调用超时，内容不可用。</pre>`
      : (isEditTool && call.diff ? renderDiffView(call.diff) : `<pre><code>${escapeHTML(call.result)}</code></pre>`);

    return `
      <div class="tool-invocation" data-call-uid="${uid}" data-call-index="${index}" data-expanded="${expanded}" data-status="${status}">
        <div class="tool-call-row" title="${safeArgs}">
          ${statusIcon}
          <span class="tool-name">${escapeHTML(displayName)}</span>
          <code class="tool-args">${escapeHTML(friendlyLabel)}</code>
          ${editStatsHtml}
          <svg class="icon tool-chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="output-window tool-result-window">
          <div class="output-box tool-output">
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
    const groupUid = group.uid || '';

    if (group.status === 'summary') {
      const expanded = group.expanded === true;
      return `
        <div class="tool-summary" data-group-uid="${groupUid}" data-expanded="${expanded}">
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
    if (msg.role === 'change_summary') {
      const diffs = conversationDiffs[currentChatId] || {};
      return `<div class="chat-message change-summary-message">${renderChangeSummary(diffs)}</div>`;
    }
    if (msg.role === 'plan_group') {
      return `<div class="chat-message">${renderPlanGroup(msg)}</div>`;
    }
    return '';
  }

  function renderMessages(messages) {
    return messages.map(renderMessage).join('');
  }

  // --- Change summary (file diffs overview) ---
  function renderChangeSummary(diffs) {
    const files = Object.keys(diffs);
    if (files.length === 0) return '';
    const totalAdded = files.reduce((s, f) => s + diffs[f].added, 0);
    const totalRemoved = files.reduce((s, f) => s + diffs[f].removed, 0);

    const fileItems = files.map(file => {
      const d = diffs[file];
      return `
        <div class="change-file-item" data-file="${escapeHTML(file)}">
          <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <span class="file-name">${escapeHTML(file)}</span>
          <span class="file-stats">
            <span class="diff-stat-added">+${d.added}</span>
            <span class="diff-stat-removed">-${d.removed}</span>
          </span>
        </div>`;
    }).join('');

    return `
      <div class="change-summary" data-expanded="false">
        <div class="change-summary-header">
          <span class="change-summary-text">文件变动总览 · ${files.length} 个文件被修改 (+${totalAdded} -${totalRemoved})</span>
          <svg class="icon chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="change-summary-body">
          <div class="change-file-list">${fileItems}</div>
          <div class="change-file-diff-container"></div>
        </div>
      </div>`;
  }

  function appendChangeSummary() {
    if (!currentChatId || !conversationDiffs[currentChatId]) return;
    const diffs = conversationDiffs[currentChatId];
    if (Object.keys(diffs).length === 0) return;
    // Prevent duplicate change summaries
    const msgs = chatMessagesData[currentChatId];
    if (msgs.some(m => m.role === 'change_summary')) return;
    msgs.push({ role: 'change_summary' });
    renderCurrentMessages();
  }

  function bindChangeSummary(container) {
    const header = container.querySelector('.change-summary-header');
    if (header) {
      header.addEventListener('click', () => {
        const summary = header.closest('.change-summary');
        const expanded = summary.getAttribute('data-expanded') === 'true';
        summary.setAttribute('data-expanded', String(!expanded));
      });
    }

    container.querySelectorAll('.change-file-item').forEach(item => {
      item.addEventListener('click', () => {
        const fileName = item.dataset.file;
        const body = item.closest('.change-summary-body');
        const diffContainer = body.querySelector('.change-file-diff-container');
        const diffs = conversationDiffs[currentChatId] || {};
        const diff = diffs[fileName];
        if (!diff) return;

        body.querySelectorAll('.change-file-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');

        diffContainer.innerHTML = `
          <div class="change-file-diff visible">
            ${renderDiffView(diff)}
          </div>`;
        highlightCode(diffContainer);
      });
    });
  }

  function bindToolToggles(container) {
    container.querySelectorAll('.tool-call-row').forEach(row => {
      row.addEventListener('click', () => {
        const invocation = row.closest('.tool-invocation');
        const expanded = invocation.getAttribute('data-expanded') === 'true';
        invocation.setAttribute('data-expanded', String(!expanded));
        // Sync back to data model
        const uid = invocation.dataset.callUid;
        if (uid && chatMessagesData[currentChatId]) {
          for (const msg of chatMessagesData[currentChatId]) {
            if (msg.role === 'tool_group' && msg.calls) {
              const call = msg.calls.find(c => c.uid === uid);
              if (call) { call.expanded = !expanded; break; }
            }
          }
        }
      });
    });
    container.querySelectorAll('.tool-summary-row').forEach(row => {
      row.addEventListener('click', () => {
        const summary = row.closest('.tool-summary');
        const expanded = summary.getAttribute('data-expanded') === 'true';
        summary.setAttribute('data-expanded', String(!expanded));
        // Sync back to data model
        const uid = summary.dataset.groupUid;
        if (uid && chatMessagesData[currentChatId]) {
          for (const msg of chatMessagesData[currentChatId]) {
            if (msg.role === 'tool_group' && msg.uid === uid) {
              msg.expanded = !expanded; break;
            }
          }
        }
      });
    });
    bindChangeSummary(container);
    bindPlanToggles(container);
  }

  // --- Plan group (inline message flow) ---
  function renderPlanGroup(group) {
    const expanded = group.expanded !== false;
    const total = group.plans.length;
    const done = group.plans.filter(p => p.status === 'completed').length;
    const activePlan = group.plans.find(p => p.status === 'active');
    const activeTask = activePlan ? activePlan.content : '';
    const headerText = done === total
      ? `计划 · 全部完成 (${total}/${total})`
      : (activeTask ? `计划 · ${activeTask} (${done}/${total})` : `计划 · ${done}/${total} 已完成`);
    const fileItems = group.plans.map(p => {
      const cls = p.status === 'completed' ? 'completed' : (p.status === 'active' ? 'active' : '');
      const icon = p.status === 'completed'
        ? '<svg class="plan-icon completed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>'
        : (p.status === 'active'
          ? '<svg class="plan-icon active" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle></svg>'
          : '<svg class="plan-icon pending" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle></svg>');
      return `<div class="plan-item ${cls}">${icon}<span class="plan-content">${escapeHTML(p.content)}</span></div>`;
    }).join('');
    return `
      <div class="plan-group" data-expanded="${expanded}">
        <div class="plan-group-header">
          <svg class="icon plan-terminal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="9" y1="15" x2="15" y2="15"></line>
            <line x1="12" y1="12" x2="12" y2="18"></line>
          </svg>
          <span class="plan-group-text">${escapeHTML(headerText)}</span>
          <svg class="icon chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="plan-group-body">${fileItems}</div>
      </div>`;
  }

  function bindPlanToggles(container) {
    container.querySelectorAll('.plan-group-header').forEach(header => {
      header.addEventListener('click', () => {
        const group = header.closest('.plan-group');
        const expanded = group.getAttribute('data-expanded') === 'true';
        // Collapse all other plan groups
        container.querySelectorAll('.plan-group').forEach(el => {
          if (el !== group) el.dataset.expanded = 'false';
        });
        group.setAttribute('data-expanded', String(!expanded));
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
    panelTitle.textContent = 'mycodex-demo / ' + (name || 'Sub Agent');
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
    panelTitle.textContent = '对话 / 快速对话';

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
    panelTitle.textContent = activeProjName + ' / ' + chatTitleText;

    // Load messages dynamically
    if (chatMessagesData[chatId]) {
      messageList.innerHTML = renderMessages(chatMessagesData[chatId]);
      bindToolToggles(messageList);
      highlightCode(messageList);
    } else {
      messageList.innerHTML = `<div class="chat-message assistant-message"><p>No messages in chat "${escapeHTML(chatTitleText)}". Send a message to start!</p></div>`;
    }

    // Clear finished status from this chat item on activation
    if (clickedElement) {
      const statusEl = clickedElement.querySelector('.chat-status.status-completed');
      if (statusEl) statusEl.remove();
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
  if (sidebar) {
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
  }

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

  // --- Slash commands ---
  const slashCommands = {
    '/plan': { label: '运行计划演示', handler: () => { textarea.value = ''; window.demoPlanFlow(); } },
    '/approve': { label: '显示审批面板', handler: () => { textarea.value = ''; window.demoApproval(); } },
    '/tool': { label: '连续工具调用', handler: () => { textarea.value = ''; window.demoContinuousToolCalls(); } },
    '/help': { label: '显示可用命令', handler: () => { textarea.value = ''; showSlashHelp(); } }
  };

  let slashPopup = null;

  function createSlashPopup() {
    if (slashPopup) return;
    slashPopup = document.createElement('div');
    slashPopup.className = 'slash-popup';
    const inputCard = document.querySelector('.input-card');
    if (inputCard) {
      inputCard.style.position = 'relative';
      inputCard.appendChild(slashPopup);
    }
  }

  function showSlashPopup(filter) {
    createSlashPopup();
    const items = Object.keys(slashCommands)
      .filter(cmd => !filter || cmd.startsWith(filter))
      .map(cmd => `<div class="slash-item" data-cmd="${cmd}"><span class="slash-cmd">${cmd}</span><span class="slash-label">${escapeHTML(slashCommands[cmd].label)}</span></div>`)
      .join('');
    if (!items) { slashPopup.classList.remove('show'); return; }
    slashPopup.innerHTML = items;
    slashPopup.classList.add('show');
    slashPopup.querySelectorAll('.slash-item').forEach(el => {
      el.addEventListener('click', () => {
        const cmd = el.dataset.cmd;
        slashPopup.classList.remove('show');
        if (slashCommands[cmd]) slashCommands[cmd].handler();
      });
    });
  }

  function showSlashHelp() {
    const msg = Object.keys(slashCommands).map(cmd => `${cmd} — ${slashCommands[cmd].label}`).join('\n');
    alert('可用斜杠命令:\n\n' + msg);
  }

  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = (textarea.scrollHeight - 6) + 'px';
    // Slash command detection
    if (textarea.value.startsWith('/')) {
      showSlashPopup(textarea.value);
    } else if (slashPopup) {
      slashPopup.classList.remove('show');
    }

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
      panelTitle.textContent = activeProjName + ' / ' + chatName;
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

    setTimeout(() => {
      const threshold = 30;
      if (chatArea.scrollTop + chatArea.clientHeight >= chatArea.scrollHeight - threshold) {
        chatArea.scrollTop = chatArea.scrollHeight;
      }
    }, 50);
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
  const conversationDiffs = {}; // { chatId: { filepath: diff } }

  function renderCurrentMessages() {
    if (!messageList || !currentChatId || !chatMessagesData[currentChatId]) return;

    // Save expanded states before re-render (by uid)
    const expandedStates = new Map();
    messageList.querySelectorAll('.tool-invocation[data-call-uid]').forEach(el => {
      expandedStates.set(el.dataset.callUid, el.dataset.expanded === 'true');
    });
    messageList.querySelectorAll('.tool-summary[data-group-uid]').forEach(el => {
      expandedStates.set(`group:${el.dataset.groupUid}`, el.dataset.expanded === 'true');
    });

    messageList.innerHTML = renderMessages(chatMessagesData[currentChatId]);

    // Restore expanded states after re-render
    messageList.querySelectorAll('.tool-invocation[data-call-uid]').forEach(el => {
      const saved = expandedStates.get(el.dataset.callUid);
      if (saved !== undefined) {
        el.dataset.expanded = String(saved);
      }
    });
    messageList.querySelectorAll('.tool-summary[data-group-uid]').forEach(el => {
      const saved = expandedStates.get(`group:${el.dataset.groupUid}`);
      if (saved !== undefined) {
        el.dataset.expanded = String(saved);
      }
    });

    bindToolToggles(messageList);
    highlightCode(messageList);

    // Auto-collapse: only the last plan_group is expanded
    const planGroups = messageList.querySelectorAll('.plan-group');
    if (planGroups.length > 0) {
      const last = planGroups[planGroups.length - 1];
      planGroups.forEach(el => { el.dataset.expanded = 'false'; });
      last.dataset.expanded = 'true';
    }

    // Smart scroll: only scroll to bottom if user was already near the bottom
    const threshold = 30;
    if (chatArea.scrollTop + chatArea.clientHeight >= chatArea.scrollHeight - threshold) {
      chatArea.scrollTop = chatArea.scrollHeight;
    }
  }

  let toolUidCounter = 0;

  function appendToolCall(name, args, result, options = {}) {
    if (!currentChatId || !chatMessagesData[currentChatId]) return null;

    const call = {
      name,
      args,
      result,
      uid: `call-${++toolUidCounter}`,
      expanded: options.expanded !== false,
      done: true,
      status: options.status || 'success',
      ...(options.label ? { label: options.label } : {}),
      ...(options.diff ? { diff: options.diff } : {})
    };

    if (currentToolGroup && currentToolGroup.status === 'streaming') {
      currentToolGroup.calls.push(call);
    } else {
      currentToolGroup = {
        role: 'tool_group',
        status: 'streaming',
        uid: `group-${++toolUidCounter}`,
        expanded: true,
        calls: [call]
      };
      chatMessagesData[currentChatId].push(currentToolGroup);
    }
    currentToolGroup.metrics = computeToolMetrics(currentToolGroup.calls);

    // Register edit diffs in conversation registry
    if (options.diff && options.diff.file) {
      if (!conversationDiffs[currentChatId]) conversationDiffs[currentChatId] = {};
      conversationDiffs[currentChatId][options.diff.file] = options.diff;
    }

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
      name: 'bash', label: 'src/',
      args: '$ ls -laR src/',
      result: 'src/:\ndrwxr-xr-x   8 user staff   256 Jun 14 10:00 .\ndrwxr-xr-x  12 user staff   384 Jun 14 09:55 ..\ndrwxr-xr-x  10 user staff   320 Jun 14 09:58 auth\ndrwxr-xr-x  15 user staff   480 Jun 14 10:00 api\ndrwxr-xr-x   6 user staff   192 Jun 14 10:00 utils\n-rw-r--r--   1 user staff  1203 Jun 14 10:01 index.js\n-rw-r--r--   1 user staff  3456 Jun 14 09:59 config.json\n\nsrc/auth:\ndrwxr-xr-x  4 user staff   128 Jun 14 10:00 .\ndrwxr-xr-x  3 user staff    96 Jun 14 10:00 ..\n-rw-r--r--  1 user staff   823 Jun 14 10:00 login.js\n-rw-r--r--  1 user staff  1289 Jun 14 10:00 reset.js\n\nsrc/api:\ndrwxr-xr-x  5 user staff   160 Jun 14 10:00 .\ndrwxr-xr-x  3 user staff    96 Jun 14 10:00 ..\n-rw-r--r--  1 user staff   412 Jun 14 10:00 client.js\n-rw-r--r--  1 user staff   892 Jun 14 10:00 routes.js\n-rw-r--r--  1 user staff   645 Jun 14 10:00 middleware.js\n\nsrc/utils:\ndrwxr-xr-x  3 user staff    96 Jun 14 10:00 .\ndrwxr-xr-x  3 user staff    96 Jun 14 10:00 ..\n-rw-r--r--  1 user staff  2154 Jun 14 10:00 format.js'
    },
    {
      name: 'bash', label: 'dist/',
      args: '$ du -sh dist/',
      result: 'dist/\ntotal 24M\ndrwxr-xr-x  6 user staff   192 Jun 14 10:00 assets\ndrwxr-xr-x  4 user staff   128 Jun 14 10:00 static\n-rw-r--r--  1 user staff 1.2M Jun 14 10:00 bundle.js\n-rw-r--r--  1 user staff  42k Jun 14 10:00 index.html'
    },
    {
      name: 'bash', label: 'npm run test --coverage',
      args: '$ npm run test -- --coverage',
      result: 'PASS  src/auth/login.test.js  (5.2s)\n  ✓ returns token on valid credentials (12ms)\n  ✓ rejects invalid password (8ms)\n  ✓ handles missing fields (6ms)\n  ✓ rate-limits after 5 attempts (45ms)\n\nPASS  src/utils/format.test.js  (3.8s)\n  ✓ formats date correctly (4ms)\n  ✓ handles null input (2ms)\n  ✓ truncates long strings (3ms)\n  ✓ escapes HTML entities (5ms)\n\nPASS  src/api/client.test.js  (6.1s)\n  ✓ GET /users returns list (15ms)\n  ✓ POST /users creates user (22ms)\n  ✓ DELETE /users/:id returns 404 for unknown (11ms)\n  ✓ handles network timeout (34ms)\n\n------------------------|---------|----------|---------|---------|\nFile                    | % Stmts | % Branch | % Funcs | % Lines |\n------------------------|---------|----------|---------|---------|\nAll files               |   88.5  |    82.3  |   91.2  |   88.5  |\n src/auth/login.js      |   95.2  |    88.9  |  100.0  |   95.2  |\n src/api/client.js      |   82.6  |    75.0  |   83.3  |   82.6  |\n src/utils/format.js    |   90.0  |    83.3  |   90.0  |   90.0  |\n------------------------|---------|----------|---------|---------|\n\nTest Suites: 3 passed, 3 total\nTests:       12 passed, 12 total'
    },
    {
      name: 'read_file', label: 'src/auth/login.js',
      args: '$ cat src/auth/login.js',
      result: 'const bcrypt = require("bcrypt");\nconst { RateLimiter } = require("../utils/rate-limiter");\n\nconst limiter = new RateLimiter({ windowMs: 60000, maxAttempts: 5 });\n\nasync function login(username, password) {\n  if (!username || !password) {\n    return { error: "Missing required fields" };\n  }\n\n  const remaining = limiter.check(username);\n  if (remaining <= 0) {\n    return { error: "Too many attempts. Please wait before trying again." };\n  }\n\n  const user = await db.users.findByUsername(username);\n  if (!user) {\n    return { error: "Invalid credentials" };\n  }\n\n  const valid = await bcrypt.compare(password, user.passwordHash);\n  if (!valid) {\n    return { error: "Invalid credentials" };\n  }\n\n  const token = jwt.sign(\n    { userId: user.id, role: user.role },\n    process.env.JWT_SECRET,\n    { expiresIn: "24h" }\n  );\n\n  return { token, user: { id: user.id, username: user.username, role: user.role } };\n}\n\nmodule.exports = { login };'
    },
    {
      name: 'read_file', label: 'src/utils/format.js',
      args: '$ cat src/utils/format.js',
      result: '/**\n * Format a date to a human-readable string.\n * Supports ISO strings, timestamps, and Date objects.\n */\nexport function formatDate(input, options = {}) {\n  if (input == null) return "";\n  const date = typeof input === "string" || typeof input === "number"\n    ? new Date(input)\n    : input;\n  if (isNaN(date.getTime())) return "Invalid date";\n  const locale = options.locale || "zh-CN";\n  return new Intl.DateTimeFormat(locale, {\n    year: "numeric",\n    month: "long",\n    day: "numeric",\n    hour: "2-digit",\n    minute: "2-digit",\n    ...options\n  }).format(date);\n}\n\n/**\n * Truncate a string to a given length, appending "..." if truncated.\n */\nexport function truncate(str, maxLength = 100) {\n  if (!str) return "";\n  if (str.length <= maxLength) return str;\n  return str.slice(0, maxLength - 3) + "...";\n}'
    },
    {
      name: 'grep_search', label: '"TODO|FIXME|HACK" 在 src/ 中',
      args: '$ grep -rn "TODO\\|FIXME\\|HACK" src/',
      result: 'src/utils/format.js:42:  // TODO: add support for relative dates\nsrc/utils/rate-limiter.js:15:  // FIXME: race condition when multiple requests arrive simultaneously\nsrc/utils/rate-limiter.js:88:  // TODO: persist rate limit state to redis\nsrc/api/routes.js:23:  // TODO: implement pagination for large result sets\nsrc/api/routes.js:67:  // HACK: temporary workaround for IE11 compatibility, remove when dropping support\nsrc/store.js:45:  // TODO: normalize state shape, currently nested objects are 3 levels deep\nsrc/auth/reset.js:12:  // TODO: add email notification when password reset is requested\nsrc/auth/reset.js:34:  // TODO: invalidate all existing sessions after password reset\nsrc/index.js:8:  // FIXME: process.env not set during testing, use fallback defaults\nsrc/index.js:15:  // TODO: add graceful shutdown handler for SIGTERM/SIGINT'
    },
    {
      name: 'edit_file', label: 'src/auth/login.js',
      args: '$ edit_file src/auth/login.js',
      result: 'Applied 5 edits to src/auth/login.js',
      diff: {
        file: 'src/auth/login.js',
        added: 8, removed: 4,
        hunks: [
          {
            oldStart: 1, newStart: 1,
            lines: [
              { type: 'context', content: 'const bcrypt = require("bcrypt");' },
              { type: 'removed', content: 'const { RateLimiter } = require("../utils/rate-limiter");' },
              { type: 'added', content: 'const { RateLimiter } = require("../utils/rate-limiter");' },
              { type: 'added', content: 'const { AuditLogger } = require("../utils/audit");' },
              { type: 'context', content: '' },
              { type: 'removed', content: 'const limiter = new RateLimiter({ windowMs: 60000, maxAttempts: 5 });' },
              { type: 'added', content: 'const limiter = new RateLimiter({ windowMs: 60000, maxAttempts: 5 });' },
              { type: 'added', content: 'const logger = new AuditLogger({ service: "auth" });' },
              { type: 'context', content: '' },
              { type: 'context', content: 'async function login(username, password) {' },
              { type: 'context', content: '  if (!username || !password) {' },
              { type: 'removed', content: '    return { error: "Missing required fields" };' },
              { type: 'added', content: '    logger.warn("login_attempt_missing_fields", { username });' },
              { type: 'added', content: '    return { error: "Missing required fields" };' }
            ]
          },
          {
            oldStart: 15, newStart: 18,
            lines: [
              { type: 'context', content: '  const valid = await bcrypt.compare(password, user.passwordHash);' },
              { type: 'context', content: '  if (!valid) {' },
              { type: 'added', content: '    logger.warn("login_failed_invalid_password", { username });' },
              { type: 'context', content: '    return { error: "Invalid credentials" };' },
              { type: 'context', content: '  }' },
              { type: 'context', content: '' },
              { type: 'context', content: '  const token = jwt.sign(' },
              { type: 'removed', content: '    { userId: user.id, role: user.role },' },
              { type: 'added', content: '    { userId: user.id, role: user.role, sessionId: crypto.randomUUID() },' },
              { type: 'context', content: '    process.env.JWT_SECRET,' },
              { type: 'context', content: '    { expiresIn: "24h" }' },
              { type: 'context', content: '  );' },
              { type: 'context', content: '' },
              { type: 'added', content: '  logger.info("login_success", { username, userId: user.id });' },
              { type: 'context', content: '  return { token, user: { id: user.id, username: user.username, role: user.role } };' }
            ]
          }
        ]
      }
    },
    {
      name: 'edit_file', label: 'src/utils/rate-limiter.js',
      args: '$ edit_file src/utils/rate-limiter.js',
      result: 'Applied 8 edits to src/utils/rate-limiter.js',
      diff: {
        file: 'src/utils/rate-limiter.js',
        added: 18, removed: 5,
        hunks: [
          {
            oldStart: 12, newStart: 12,
            lines: [
              { type: 'context', content: 'class RateLimiter {' },
              { type: 'context', content: '  constructor(options = {}) {' },
              { type: 'context', content: '    this.windowMs = options.windowMs || 60000;' },
              { type: 'context', content: '    this.maxAttempts = options.maxAttempts || 10;' },
              { type: 'removed', content: '    this.store = new Map();' },
              { type: 'added', content: '    this.store = new Map();' },
              { type: 'added', content: '    this._cleanupInterval = setInterval(() => this._cleanup(), 30000);' },
              { type: 'context', content: '  }' },
              { type: 'context', content: '' },
              { type: 'context', content: '  check(key) {' },
              { type: 'context', content: '    const now = Date.now();' },
              { type: 'removed', content: '    // FIXME: race condition when multiple requests arrive simultaneously' },
              { type: 'context', content: '    const windowStart = now - this.windowMs;' },
              { type: 'context', content: '    let entries = this.store.get(key) || [];' },
              { type: 'context', content: '    entries = entries.filter(t => t > windowStart);' },
              { type: 'added', content: '    // Use a lock to prevent race conditions on concurrent requests' },
              { type: 'added', content: '    if (this._locked) {' },
              { type: 'added', content: '      return 0;' },
              { type: 'added', content: '    }' },
              { type: 'context', content: '    const remaining = this.maxAttempts - entries.length;' },
              { type: 'context', content: '    if (remaining > 0) {' },
              { type: 'context', content: '      entries.push(now);' },
              { type: 'context', content: '      this.store.set(key, entries);' },
              { type: 'context', content: '    }' },
              { type: 'added', content: '    this._locked = false;' },
              { type: 'context', content: '    return remaining;' },
              { type: 'context', content: '  }' },
              { type: 'context', content: '' },
              { type: 'added', content: '  _cleanup() {' },
              { type: 'added', content: '    const now = Date.now();' },
              { type: 'added', content: '    const windowStart = now - this.windowMs;' },
              { type: 'added', content: '    for (const [key, entries] of this.store) {' },
              { type: 'added', content: '      const filtered = entries.filter(t => t > windowStart);' },
              { type: 'added', content: '      if (filtered.length === 0) {' },
              { type: 'added', content: '        this.store.delete(key);' },
              { type: 'added', content: '      } else {' },
              { type: 'added', content: '        this.store.set(key, filtered);' },
              { type: 'added', content: '      }' },
              { type: 'added', content: '    }' },
              { type: 'added', content: '  }' }
            ]
          }
        ]
      }
    },
    {
      name: 'run_test', label: 'auth 测试套件',
      args: '$ npm test -- --filter="auth"',
      result: 'PASS  src/auth/login.test.js  (4.8s)\n  ✓ returns token on valid credentials (10ms)\n  ✓ rejects invalid password (7ms)\n  ✓ handles missing fields (5ms)\n  ✓ rate-limits after 5 attempts (42ms)\n  ✓ logs audit events on failure (28ms)\n\nPASS  src/auth/reset.test.js  (3.2s)\n  ✓ sends reset email (15ms)\n  ✓ requires valid token (8ms)\n  ✓ expires after 1 hour (11ms)\n\nTest Suites: 2 passed, 2 total\nTests:       8 passed, 8 total'
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
          appendChangeSummary();
        }
        return;
      }

      if (Math.random() < toolProbability) {
        const tpl = toolCallTemplates[Math.floor(Math.random() * toolCallTemplates.length)];
        const opts = { expanded: false };
        if (tpl.label) opts.label = tpl.label;
        if (tpl.diff) opts.diff = tpl.diff;
        opts.status = Math.random() < 0.15 ? 'failure' : 'success';
        appendToolCall(tpl.name, tpl.args, tpl.result, opts);
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
    if (chatArea.scrollTop + chatArea.clientHeight >= chatArea.scrollHeight - 30) {
      chatArea.scrollTop = chatArea.scrollHeight;
    }

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
      // Add mock edit diffs so change summary has content
      appendToolCall('edit_file', '$ edit_file src/auth/login.js', 'Applied 5 edits to src/auth/login.js', { expanded: false, diff: { file: 'src/auth/login.js', added: 8, removed: 4, hunks: [{ oldStart: 1, newStart: 1, lines: [{ type: 'context', content: 'const bcrypt = require("bcrypt");' }, { type: 'context', content: 'const { RateLimiter } = require("../utils/rate-limiter");' }, { type: 'context', content: '' }, { type: 'removed', content: 'const limiter = new RateLimiter({ windowMs: 60000, maxAttempts: 5 });' }, { type: 'added', content: 'const limiter = new RateLimiter({ windowMs: 30000, maxAttempts: 10 });' }, { type: 'context', content: '' }, { type: 'removed', content: 'async function login(username, password) {' }, { type: 'added', content: 'async function login(username, password, otpCode) {' }, { type: 'context', content: '  if (!username || !password) {' }, { type: 'added', content: '    return { error: "Missing required fields" };' }, { type: 'context', content: '  }' }, { type: 'context', content: '' }, { type: 'context', content: '  const remaining = limiter.check(username);' }, { type: 'context', content: '  if (remaining <= 0) {' }, { type: 'context', content: '    return { error: "Too many attempts. Please wait before trying again." };' }] }] } });
      if (userPrompt.includes('测试') || userPrompt.includes('test')) {
        appendToolCall('edit_file', '$ edit_file src/utils/format.js', 'Applied edits to format.js', { expanded: false, diff: { file: 'src/utils/format.js', added: 3, removed: 1, hunks: [{ oldStart: 5, newStart: 5, lines: [{ type: 'context', content: 'export function formatDate(input, options = {}) {' }, { type: 'context', content: '  if (input == null) return "";' }, { type: 'removed', content: '  const date = typeof input === "string" || typeof input === "number"' }, { type: 'added', content: '  // Normalize input to Date object' }, { type: 'added', content: '  const date = typeof input === "string" || typeof input === "number"' }, { type: 'context', content: '    ? new Date(input)' }, { type: 'context', content: '    : input;' }] }] } });
      }
      finalizeToolGroup();

      const assistantMsg = { role: 'assistant', content: responseText };
      if (currentChatId && chatMessagesData[currentChatId]) {
        chatMessagesData[currentChatId].push(assistantMsg);
      }
      renderCurrentMessages();
      appendChangeSummary();
    }, 1200);
  };

  // --- Plan group: demo flow (generates plan_group messages in chat data) ---
  const demoPlanSteps = [
    '分析项目目录结构及现有代码',
    '识别关键模块与数据流',
    '确定实现方案架构',
    '编写核心业务逻辑代码',
    '添加单元测试覆盖',
    '执行集成测试并修复问题'
  ];

  window.demoPlanFlow = function() {
    if (!currentChatId || !chatMessagesData[currentChatId]) return;

    // Push initial plan (step 0 active)
    function pushPlan(completedUpTo) {
      const plans = demoPlanSteps.map((content, i) => ({
        id: `step-${i}`,
        content,
        status: i < completedUpTo ? 'completed' : (i === completedUpTo ? 'active' : 'pending')
      }));
      const allDone = completedUpTo >= demoPlanSteps.length;
      chatMessagesData[currentChatId].push({
        role: 'plan_group',
        expanded: true,
        status: allDone ? 'completed' : 'in_progress',
        plans
      });
      renderCurrentMessages();
    }

    pushPlan(0);
    let stepIdx = 1;
    const timer = setInterval(() => {
      pushPlan(stepIdx);
      stepIdx++;
      if (stepIdx > demoPlanSteps.length) {
        clearInterval(timer);
      }
    }, 1500);
    return timer;
  };

  // Link demo: after tool calls, add plan group to chat
  const origDemo = window.demoContinuousToolCalls;
  if (origDemo) {
    const origDemoFn = origDemo;
    window.demoContinuousToolCalls = function(options) {
      origDemoFn(options);
      setTimeout(() => window.demoPlanFlow(), 1500);
    };
  }

  // --- Command Approval Panel ---
  const approvalPanel = document.getElementById('approval-panel');
  const approvalList = document.getElementById('approval-list');
  const approvalCount = document.getElementById('approval-count');

  window.showApproval = function(items) {
    if (!approvalPanel || !approvalList) return;
    if (!items || items.length === 0) { approvalPanel.style.display = 'none'; return; }
    approvalList.innerHTML = items.map((item, idx) => `
      <div class="approval-item" data-idx="${idx}">
        <div class="approval-left">
          <svg class="approval-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            ${item.icon || '<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>'}
          </svg>
          <div class="approval-info">
            <span class="approval-action">${escapeHTML(item.action)}</span>
            <code class="approval-args">${escapeHTML(item.args)}</code>
          </div>
        </div>
        <div class="approval-right">
          <button class="approval-btn approve" data-idx="${idx}">允许</button>
          <button class="approval-btn reject" data-idx="${idx}">拒绝</button>
        </div>
      </div>
    `).join('');

    // Bind approve/reject
    approvalList.querySelectorAll('.approval-btn.approve').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const item = items[idx];
        if (item.onApprove) item.onApprove();
        items.splice(idx, 1);
        window.showApproval(items);
      });
    });
    approvalList.querySelectorAll('.approval-btn.reject').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const item = items[idx];
        if (item.onReject) item.onReject();
        items.splice(idx, 1);
        window.showApproval(items);
      });
    });

    approvalCount.textContent = items.length;
    approvalPanel.style.display = 'block';
  };

  window.clearApproval = function() {
    if (approvalPanel) approvalPanel.style.display = 'none';
  };

  // Demo: show approval panel when tools are pending
  window.demoApproval = function() {
    window.showApproval([
      {
        action: '读取文件',
        args: 'src/auth/login.js',
        onApprove: () => appendToolCall('read_file', 'src/auth/login.js', 'file content...', { expanded: false }),
        onReject: () => {}
      },
      {
        action: '执行命令',
        args: 'npm run test -- --coverage',
        onApprove: () => appendToolCall('bash', 'npm run test -- --coverage', 'test output...', { expanded: false }),
        onReject: () => {}
      }
    ]);
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
              panelTitle.textContent = activeProjName + ' / ' + val;
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
    panelTitle.textContent = '功能 / ' + itemName;

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

  // --- 16. MCP Server Cards Interactive Bindings ---
  const mcpServerCards = document.querySelectorAll('.mcp-server-card');
  mcpServerCards.forEach(card => {
    const toggleSwitch = card.querySelector('.mcp-toggle-switch');
    const configBtn = card.querySelector('.mcp-btn-config');
    const configPanel = card.querySelector('.mcp-config-panel');
    const saveBtn = card.querySelector('.mcp-btn-save');
    const statusDot = card.querySelector('.mcp-status-dot');
    const statusText = card.querySelector('.mcp-status-text');
    const detailsDiv = card.querySelector('.mcp-details');

    // Switch toggle logic
    if (toggleSwitch) {
      toggleSwitch.addEventListener('change', () => {
        if (toggleSwitch.checked) {
          card.classList.remove('disabled');
          if (statusDot) statusDot.classList.add('active');
          if (statusText) {
            statusText.textContent = '已连接';
            statusText.style.color = '';
          }
        } else {
          card.classList.add('disabled');
          if (statusDot) statusDot.classList.remove('active');
          if (statusText) {
            statusText.textContent = '已关闭';
            statusText.style.color = 'var(--text-muted)';
          }
          // Close panel if open
          if (configPanel) configPanel.classList.remove('expanded');
        }
      });
    }

    // Expand/collapse config panel
    if (configBtn && configPanel) {
      configBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (card.classList.contains('disabled')) return;
        configPanel.classList.toggle('expanded');
      });
    }

    // Save parameters logic (with mock loading indicator)
    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const originalHtml = saveBtn.innerHTML;
        saveBtn.disabled = true;
        saveBtn.innerHTML = `
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:11px; height:11px; animation: spin-rotate 1s linear infinite; margin-right:4px; display:inline-block; vertical-align: middle;">
            <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle>
          </svg>
          保存中...
        `;

        setTimeout(() => {
          saveBtn.disabled = false;
          saveBtn.innerHTML = originalHtml;
          if (configPanel) configPanel.classList.remove('expanded');

          // Check if it's filesystem server and update details path
          const serverName = card.getAttribute('data-server');
          if (serverName === 'filesystem') {
            const argsInput = card.querySelector('.mcp-input-args');
            if (argsInput && detailsDiv) {
              const val = argsInput.value;
              // Extract path from arguments
              const parts = val.split(' ');
              const pathPart = parts.find(p => p.includes('\\') || p.includes('/'));
              if (pathPart) {
                detailsDiv.textContent = `路径: ${pathPart}`;
              }
            }
          }
          alert('MCP 服务参数配置保存成功并已重连！');
        }, 1200);
      });
    }
  });

  // --- Plugin card switch toggles ---
  document.querySelectorAll('.plugin-card .switch-container input[type="checkbox"]').forEach(toggle => {
    toggle.addEventListener('change', () => {
      const card = toggle.closest('.plugin-card');
      const badge = card.querySelector('.plugin-badge');
      if (!badge) return;
      if (toggle.checked) {
        badge.className = 'plugin-badge active';
        badge.textContent = '已启用';
      } else {
        badge.className = 'plugin-badge disabled';
        badge.textContent = '已禁用';
      }
    });
  });

  // --- 17. Right Sidebar Tab Management ---
  let tabInstanceCounters = {};
  const tabDefinitions = {
    'tab-dual-chat': {
      label: '对话',
      multi: true,
      hasSubmenu: true,
      submenuItems: [
        { action: 'inherit', label: '继承主面板对话', icon: '<path d="M7 20l4-16 4 16"></path><path d="M3 12h4"></path><path d="M17 12h4"></path>' },
        { action: 'new', label: '新对话', icon: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>' }
      ],
      icon: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path><path d="M17 9a6.48 6.48 0 0 0-5.5-5.5 8.48 8.48 0 0 0-4.3.6"></path>',
      createInstance: function(n) { return { label: '对话 ' + n, panelId: 'tab-dual-chat' }; }
    },
    'tab-browser': {
      label: '浏览器',
      multi: true,
      icon: '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',
      createInstance: function(n) { return { label: '浏览器 ' + n, panelId: 'tab-browser' }; }
    },
    'tab-terminal': {
      label: '终端',
      multi: true,
      icon: '<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>',
      createInstance: function(n) { return { label: '终端 ' + n, panelId: null }; }
    },
    'tab-token-metrics': {
      label: 'Token 统计',
      icon: '<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>'
    },
    'tab-file-explorer': {
      label: '文件浏览',
      icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>'
    },
    'tab-diff-center': {
      label: '差异总览',
      icon: '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1"></path><rect x="8" y="2" width="14" height="14" rx="2" ry="2"></rect>'
    }
  };

  function createTabInstance(baseType) {
    var def = tabDefinitions[baseType];
    if (!def || !def.multi) return null;
    tabInstanceCounters[baseType] = (tabInstanceCounters[baseType] || 0) + 1;
    var n = tabInstanceCounters[baseType];
    var info = def.createInstance ? def.createInstance(n) : { label: def.label, panelId: null };
    return { id: baseType + '-' + n, baseType: baseType, label: info.label, panelId: info.panelId };
  }

  var activeTabs = [{ id: 'tab-dual-chat-1', baseType: 'tab-dual-chat', label: '对话', panelId: 'tab-dual-chat' }];
  var rightTabList = document.getElementById('right-tab-list');
  var rightTabAddBtn = document.getElementById('right-tab-add-btn');
  var rightActions = document.getElementById('right-tab-actions');
  var allTabPanels = document.querySelectorAll('.right-tab-panel');

  function renderTabBar() {
    if (!rightTabList) return;
    rightTabList.innerHTML = activeTabs.map(function(tab, idx) {
      var def = tabDefinitions[tab.baseType];
      if (!def) return '';
      var isActive = idx === 0;
      var closable = activeTabs.length > 1;
      return '<button class="right-tab-btn ' + (isActive ? 'active' : '') + '" data-tab-id="' + tab.id + '" title="' + tab.label + '" draggable="true">' +
        '<span class="tab-icon-wrap">' +
          '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' + def.icon + '</svg>' +
          (closable ? '<svg class="tab-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' : '') +
        '</span>' +
        '<span class="tab-label">' + tab.label + '</span>' +
      '</button>';
    }).join('');
    bindTabEvents();
  }

  let dragSrcIdx = -1;
  let dragTimer = null;
  let dragStartPos = null;
  let isDragReady = false;
  let dragClone = null;

  function initTabDrag(btn) {
    // Long-press: hold 300ms + move threshold to activate drag
    const onMouseDown = (e) => {
      if (e.button !== 0 || e.target.closest('.tab-close')) return;
      dragStartPos = { x: e.clientX, y: e.clientY };
      isDragReady = false;
      dragTimer = setTimeout(() => {
        isDragReady = true;
        dragSrcIdx = Array.from(rightTabList.children).indexOf(btn);
        btn.classList.add('dragging');
        // Create a visual drag clone
        dragClone = btn.cloneNode(true);
        dragClone.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;opacity:0.7;';
        document.body.appendChild(dragClone);
        positionClone(e);
      }, 300);
    };

    const onMouseMove = (e) => {
      if (dragTimer && dragStartPos) {
        const dx = e.clientX - dragStartPos.x;
        const dy = e.clientY - dragStartPos.y;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          clearTimeout(dragTimer);
          dragTimer = null;
        }
      }
      if (isDragReady && dragClone) {
        positionClone(e);
        // Highlight target
        const overBtn = getOverBtn(e);
        rightTabList.querySelectorAll('.right-tab-btn').forEach(b => b.classList.remove('drag-over'));
        if (overBtn && overBtn !== btn) overBtn.classList.add('drag-over');
      }
    };

    const onMouseUp = (e) => {
      clearTimeout(dragTimer);
      dragTimer = null;
      if (isDragReady) {
        btn.classList.remove('dragging');
        rightTabList.querySelectorAll('.right-tab-btn').forEach(b => b.classList.remove('drag-over'));
        if (dragClone) { dragClone.remove(); dragClone = null; }
        const overBtn = getOverBtn(e);
        if (overBtn && overBtn !== btn) {
          const overIdx = Array.from(rightTabList.children).indexOf(overBtn);
          if (overIdx !== dragSrcIdx && dragSrcIdx >= 0) {
            const item = activeTabs.splice(dragSrcIdx, 1)[0];
            activeTabs.splice(overIdx, 0, item);
            renderTabBar();
          }
        }
        isDragReady = false;
        dragSrcIdx = -1;
      }
    };

    btn.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function positionClone(e) {
    if (dragClone) {
      dragClone.style.left = (e.clientX - 20) + 'px';
      dragClone.style.top = (e.clientY - 13) + 'px';
    }
  }

  function getOverBtn(e) {
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    return els.find(el => el.classList && el.classList.contains('right-tab-btn'));
  }

  function bindTabEvents() {
    rightTabList.querySelectorAll('.right-tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        if (e.target.closest('.tab-close')) return;
        var tabId = btn.dataset.tabId;
        if (rightSidebar.classList.contains('collapsed')) {
          rightSidebar.classList.remove('collapsed');
        }
        activateTab(tabId);
        renderTabBar();
      });
      btn.addEventListener('mousedown', function(e) {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(btn.dataset.tabId);
        }
      });
      initTabDrag(btn);
    });
    if (rightTabAddBtn) {
      rightTabAddBtn.onclick = showAddTabMenu;
    }
  }

  function activateTab(tabId) {
    var tab = activeTabs.find(function(t) { return t.id === tabId; });
    if (!tab) return;
    allTabPanels.forEach(function(p) { p.classList.remove('active'); });
    if (tab.panelId) {
      var panel = document.getElementById(tab.panelId);
      if (panel) panel.classList.add('active');
    }
    rightTabList.querySelectorAll('.right-tab-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.tabId === tabId);
    });
  }

  function closeTab(tabId) {
    if (activeTabs.length <= 1) return;
    var idx = activeTabs.findIndex(function(t) { return t.id === tabId; });
    if (idx === -1) return;
    var tab = activeTabs[idx];
    activeTabs.splice(idx, 1);
    if (tab.panelId) {
      var panel = document.getElementById(tab.panelId);
      if (panel) panel.classList.remove('active');
    }
    if (activeTabs.length > 0) {
      activateTab(activeTabs[0].id);
    }
    renderTabBar();
  }

  function showAddTabMenu() {
    if (!rightTabAddBtn) return;
    var existing = document.getElementById('add-tab-dropdown');
    if (existing) existing.remove();
    var available = Object.keys(tabDefinitions);
    var dropdown = document.createElement('div');
    dropdown.id = 'add-tab-dropdown';
    dropdown.className = 'attached-dropdown-menu show';
    dropdown.style.cssText = 'position:fixed;z-index:1000;width:140px;margin-top:0;';
    var rect = rightTabAddBtn.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.right = (window.innerWidth - rect.right) + 'px';
    dropdown.style.left = 'auto';
    var listHtml = '';
    available.forEach(function(baseType) {
      var def = tabDefinitions[baseType];
      listHtml += '<div class="attached-menu-item';
      if (def.hasSubmenu) listHtml += ' submenu-parent';
      listHtml += '" data-base="' + baseType + '">';
      listHtml += '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' + def.icon + '</svg>';
      listHtml += '<span>' + def.label + '</span>';
      if (def.hasSubmenu) {
        listHtml += '<svg class="submenu-arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:10px;height:10px;margin-left:auto;color:var(--text-muted);"><polyline points="9 18 15 12 9 6"></polyline></svg>';
      }
      listHtml += '</div>';
    });
    dropdown.innerHTML = listHtml;
    document.body.appendChild(dropdown);
    dropdown.querySelectorAll('.submenu-parent').forEach(function(parent) {
      var baseType = parent.dataset.base;
      var def = tabDefinitions[baseType];

      // Build submenu as a child of parent (CSS hover propagation, no JS events)
      var submenu = document.createElement('div');
      submenu.className = 'attached-submenu cascading';
      submenu.style.cssText = 'position:absolute;left:-164px;top:-4px;bottom:auto;width:160px;flex-direction:column;row-gap:4px;padding:4px;background:#fff;border:1px solid rgba(0,0,0,0.08);border-radius:12px;z-index:1010;';
      var subHtml = '';
      def.submenuItems.forEach(function(item) {
        subHtml += '<div class="attached-action-btn" data-base="' + baseType + '" data-action="' + item.action + '">';
        subHtml += '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:12px;height:12px">' + item.icon + '</svg>';
        subHtml += '<span>' + item.label + '</span></div>';
      });
      submenu.innerHTML = subHtml;
      parent.style.position = 'relative';
      parent.appendChild(submenu);

      // Click handlers for submenu items
      submenu.querySelectorAll('.attached-action-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var base = btn.dataset.base;
          var tab = createTabInstance(base);
          if (!tab) { dropdown.remove(); submenu.remove(); return; }
          activeTabs.unshift(tab);
          if (tab.panelId) {
            var panel = document.getElementById(tab.panelId);
            if (panel) { document.querySelectorAll('.right-tab-panel').forEach(function(p) { p.classList.remove('active'); }); panel.classList.add('active'); }
          }
          activateTab(tab.id);
          renderTabBar();
          submenu.style.display = 'none';
          dropdown.remove();
          submenu.remove();
        });
      });
    });
    dropdown.querySelectorAll('.attached-menu-item:not(.submenu-parent)').forEach(function(item) {
      item.addEventListener('click', function() {
        var baseType = item.dataset.base;
        var existing2 = activeTabs.find(function(t) { return t.baseType === baseType; });
        if (existing2) { activateTab(existing2.id); renderTabBar(); dropdown.remove(); return; }
        var def2 = tabDefinitions[baseType];
        var newTab = { id: baseType, baseType: baseType, label: def2.label, panelId: baseType };
        activeTabs.unshift(newTab);
        if (newTab.panelId) {
          var panel2 = document.getElementById(newTab.panelId);
          if (panel2) { document.querySelectorAll('.right-tab-panel').forEach(function(p) { p.classList.remove('active'); }); panel2.classList.add('active'); }
        }
        activateTab(newTab.id);
        renderTabBar();
        dropdown.remove();
      });
    });
    var closeHandler = function(e) {
      if (!dropdown.contains(e.target) && e.target !== rightTabAddBtn) {
        dropdown.remove();
        document.querySelectorAll('.attached-submenu').forEach(function(s) { s.remove(); });
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    setTimeout(function() { document.addEventListener('mousedown', closeHandler); }, 0);
  }

  // Initial render
  renderTabBar();
  if (activeTabs.length > 0) activateTab(activeTabs[0].id);

  // --- 18. Tab 1: Dual Chat panel logic ---
  const dualChatMessages = document.getElementById('dual-chat-messages');
  const dualChatTextarea = document.getElementById('dual-chat-textarea');
  const dualChatSendBtn = document.getElementById('dual-chat-send-btn');
  const clearDualChatBtn = document.getElementById('clear-dual-chat-btn');

  if (dualChatTextarea && dualChatSendBtn) {
    dualChatTextarea.addEventListener('input', () => {
      dualChatSendBtn.disabled = dualChatTextarea.value.trim() === '';
    });

    const sendDualMessage = () => {
      const text = dualChatTextarea.value.trim();
      if (!text) return;

      // Append User message (Reusing main chat message bubble class)
      const userMsgHtml = `
        <div class="chat-message user-message">
          <div class="message-bubble">${escapeHTML(text)}</div>
        </div>
      `;
      dualChatMessages.insertAdjacentHTML('beforeend', userMsgHtml);
      dualChatTextarea.value = '';
      dualChatSendBtn.disabled = true;
      dualChatMessages.scrollTop = dualChatMessages.scrollHeight;

      // Mock AI response (Reusing main assistant message bubble class)
      setTimeout(() => {
        const assistantResponses = [
          "这确实是一个很好的角度！我已经同步了当前的上下文，你可以继续在主会话中开发，这里将作为提示词优化的专属便签。",
          "收到！关于你的提示词，我建议修改为以下预设：\n\n```markdown\n- 始终关注原子化修改\n- 每次生成均以 diff block 形式展示\n```\n你可以复制使用！",
          "好的，已经将此次分析记录在辅助双轨通道中。根据上下文，刚才对 todo list 的修改非常合理，我们下一步可以运行测试。"
        ];
        const randomReply = assistantResponses[Math.floor(Math.random() * assistantResponses.length)];
        const aiMsgHtml = `
          <div class="chat-message assistant-message">${randomReply.replace(/\n/g, '<br>')}</div>
        `;
        dualChatMessages.insertAdjacentHTML('beforeend', aiMsgHtml);
        dualChatMessages.scrollTop = dualChatMessages.scrollHeight;

        // Dynamic Token increments!
        if (window.addMockTokenLog) {
          window.addMockTokenLog('dual_chat_reply', 1800, 350);
        }
      }, 1000);
    };

    dualChatSendBtn.addEventListener('click', sendDualMessage);
    dualChatTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendDualMessage();
      }
    });
  }

  if (clearDualChatBtn && dualChatMessages) {
    clearDualChatBtn.addEventListener('click', () => {
      dualChatMessages.innerHTML = `
        <div class="chat-message assistant-message">已成功清空副面板对话，你可以开始新的任务了。</div>
      `;
    });
  }

  // --- 19. Tab 2: Token Metrics dynamic updates ---
  let currentTokensUsed = 4253109;
  const totalTokensLimit = 10000000;
  
  window.addMockTokenLog = function(actionName, inputTokens, outputTokens) {
    const logList = document.getElementById('token-log-list');
    if (!logList) return;

    // Create item
    const timeStr = new Date().toTimeString().split(' ')[0];
    const logHtml = `
      <li class="token-log-item">
        <div class="log-meta">
          <span class="log-action">${escapeHTML(actionName)}</span>
          <span class="log-time">${timeStr}</span>
        </div>
        <div class="log-tokens">
          <span class="input-tokens">+${inputTokens.toLocaleString()} in</span>
          <span class="output-tokens">${outputTokens > 0 ? '+' + outputTokens.toLocaleString() + ' out' : '--'}</span>
        </div>
      </li>
    `;
    logList.insertAdjacentHTML('afterbegin', logHtml);

    // Keep log list to 8 items max for UI neatness
    if (logList.children.length > 8) {
      logList.removeChild(logList.lastChild);
    }

    // Update tokens count
    const totalAdded = inputTokens + outputTokens;
    currentTokensUsed += totalAdded;
    if (currentTokensUsed > totalTokensLimit) currentTokensUsed = totalTokensLimit;

    // Update UI numbers
    const totalUsedTokensSpan = document.querySelector('.total-used-tokens');
    if (totalUsedTokensSpan) {
      const percentage = ((currentTokensUsed / totalTokensLimit) * 100).toFixed(1);
      totalUsedTokensSpan.textContent = `已使用: ${currentTokensUsed.toLocaleString()} (${percentage}%)`;
    }

    // Update progress bar splits (mocked adjustment)
    const cachedInputBar = document.querySelector('.bar-fill.fill-cached-input');
    const inputBar = document.querySelector('.bar-fill.fill-input');
    const cachedOutputBar = document.querySelector('.bar-fill.fill-cached-output');
    const outputBar = document.querySelector('.bar-fill.fill-output');

    if (inputBar && outputBar) {
      // Simulate slight width variations
      const currentPct = (currentTokensUsed / totalTokensLimit) * 100;
      const cachedInputPct = 25; // fixed base for mock
      const cachedOutputPct = 3.5;
      const inputPct = Math.max(5, currentPct - cachedInputPct - cachedOutputPct - 2);
      const outputPct = currentPct - cachedInputPct - cachedOutputPct - inputPct;

      if (cachedInputBar) cachedInputBar.style.width = cachedInputPct + '%';
      inputBar.style.width = Math.max(0, inputPct) + '%';
      if (cachedOutputBar) cachedOutputBar.style.width = cachedOutputPct + '%';
      outputBar.style.width = Math.max(0, outputPct) + '%';
    }
  };

  // Intercept main chat send button (whenever user sends message in main screen, increase tokens!)
  const mainSendBtn = document.querySelector('.send-btn');
  const mainTextarea = document.querySelector('.chat-textarea');
  if (mainTextarea && mainSendBtn) {
    mainSendBtn.addEventListener('click', () => {
      const text = mainTextarea.value.trim();
      if (text) {
        setTimeout(() => {
          window.addMockTokenLog('user_message', text.length * 3 + 120, 0);
        }, 100);
      }
    });

    mainTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const text = mainTextarea.value.trim();
        if (text) {
          setTimeout(() => {
            window.addMockTokenLog('user_message', text.length * 3 + 120, 0);
          }, 100);
        }
      }
    });
  }

  // --- 20. Tab 3: Embedded Browser logic & Element Inspector ---
  const browserBackBtn = document.getElementById('browser-back-btn');
  const browserForwardBtn = document.getElementById('browser-forward-btn');
  const browserRefreshBtn = document.getElementById('browser-refresh-btn');
  const browserLoadingSpinner = document.getElementById('browser-loading-spinner');
  const browserInspectBtn = document.getElementById('browser-inspect-btn');
  const browserViewport = document.getElementById('browser-viewport');
  const browserInspectOverlay = document.getElementById('browser-inspect-overlay');
  const inspectLabel = document.getElementById('inspect-label');
  const browserUrlInput = document.getElementById('browser-url-input');
  const browserServerHub = document.getElementById('browser-server-hub');
  
  let isInspectModeActive = false;

  // Server Card Click to Load App
  if (browserServerHub) {
    const serverCards = browserServerHub.querySelectorAll('.server-card');
    serverCards.forEach(card => {
      card.addEventListener('click', () => {
        const url = card.getAttribute('data-url');
        const targetId = card.getAttribute('data-target');
        
        if (browserRefreshBtn) browserRefreshBtn.style.pointerEvents = 'none';
        if (browserLoadingSpinner) browserLoadingSpinner.style.display = 'block';
        if (browserUrlInput) browserUrlInput.value = url;

        setTimeout(() => {
          if (browserRefreshBtn) browserRefreshBtn.style.pointerEvents = 'auto';
          if (browserLoadingSpinner) browserLoadingSpinner.style.display = 'none';
          
          // Hide Hub and show Target App
          browserServerHub.style.display = 'none';
          
          // Hide all mock apps first
          document.querySelectorAll('.mock-web-app').forEach(app => {
            app.style.display = 'none';
          });
          
          // Show target app
          const targetApp = document.getElementById(targetId);
          if (targetApp) targetApp.style.display = 'flex';

          if (browserBackBtn) browserBackBtn.disabled = false;
          
          if (window.addMockTokenLog) {
            window.addMockTokenLog(`browser_navigate (${card.querySelector('.server-name').textContent})`, 240, 0);
          }
        }, 800);
      });
    });
  }

  // Browser Back Button logic
  if (browserBackBtn) {
    browserBackBtn.addEventListener('click', () => {
      // Check if we are showing a sub-app
      const activeApp = document.querySelector('.mock-web-app:not([style*="display: none"])');
      if (activeApp) {
        if (browserLoadingSpinner) browserLoadingSpinner.style.display = 'block';
        
        setTimeout(() => {
          if (browserLoadingSpinner) browserLoadingSpinner.style.display = 'none';
          
          // Hide active app and show hub
          activeApp.style.display = 'none';
          if (browserServerHub) browserServerHub.style.display = 'block';
          if (browserUrlInput) browserUrlInput.value = 'http://localhost:5173';
          
          if (window.addMockTokenLog) {
            window.addMockTokenLog('browser_back', 120, 0);
          }
        }, 500);
      }
    });
  }

  // Refresh spinner simulation
  if (browserRefreshBtn && browserLoadingSpinner) {
    browserRefreshBtn.addEventListener('click', () => {
      browserRefreshBtn.style.pointerEvents = 'none';
      browserLoadingSpinner.style.display = 'block';

      setTimeout(() => {
        browserRefreshBtn.style.pointerEvents = 'auto';
        browserLoadingSpinner.style.display = 'none';
        if (window.addMockTokenLog) {
          window.addMockTokenLog('browser_reload', 120, 0);
        }
      }, 1000);
    });
  }

  // Toggle Inspect Mode
  if (browserInspectBtn) {
    browserInspectBtn.addEventListener('click', () => {
      isInspectModeActive = !isInspectModeActive;
      browserInspectBtn.classList.toggle('active', isInspectModeActive);
      
      if (!isInspectModeActive) {
        if (browserInspectOverlay) browserInspectOverlay.style.display = 'none';
      }
    });
  }

  // Listen to mousemove inside the viewport content for inspection
  if (browserViewport && browserInspectOverlay && inspectLabel) {
    browserViewport.addEventListener('mousemove', (e) => {
      if (!isInspectModeActive) return;

      const x = e.clientX;
      const y = e.clientY;
      
      browserInspectOverlay.style.display = 'none';
      const target = document.elementFromPoint(x, y);
      
      // Dynamically locate the currently visible mock-web-app
      const activeApp = document.querySelector('.mock-web-app:not([style*="display: none"])');
      
      if (target && activeApp && activeApp.contains(target) && target !== activeApp) {
        const viewportRect = browserViewport.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();

        const top = targetRect.top - viewportRect.top + browserViewport.scrollTop;
        const left = targetRect.left - viewportRect.left + browserViewport.scrollLeft;
        
        browserInspectOverlay.style.top = top + 'px';
        browserInspectOverlay.style.left = left + 'px';
        browserInspectOverlay.style.width = targetRect.width + 'px';
        browserInspectOverlay.style.height = targetRect.height + 'px';
        browserInspectOverlay.style.display = 'block';

        let labelText = target.tagName.toLowerCase();
        if (target.className && typeof target.className === 'string') {
          const firstClass = target.className.split(' ')[0];
          if (firstClass && !firstClass.startsWith('token-') && !firstClass.startsWith('mock-')) {
            labelText += '.' + firstClass;
          }
        }
        labelText += ` (${Math.round(targetRect.width)} × ${Math.round(targetRect.height)})`;
        inspectLabel.textContent = labelText;
      } else {
        browserInspectOverlay.style.display = 'none';
      }
    });

    browserViewport.addEventListener('mouseleave', () => {
      if (browserInspectOverlay) browserInspectOverlay.style.display = 'none';
    });

    // Intercept clicks in inspect mode
    browserViewport.addEventListener('click', (e) => {
      if (isInspectModeActive) {
        e.preventDefault();
        e.stopPropagation();
        const target = e.target.closest('*');
        const activeApp = document.querySelector('.mock-web-app:not([style*="display: none"])');
        
        if (target && activeApp && activeApp.contains(target) && target !== activeApp) {
          let desc = target.tagName.toLowerCase();
          if (target.className && typeof target.className === 'string') {
            desc += '.' + target.className.split(' ')[0];
          }
          alert(`元素审查指示：\n元素: <${desc}>\n大小: ${target.offsetWidth}px x ${target.offsetHeight}px\n你可以直接让 AI 优化此处的 CSS 样式或功能。`);
        }
      }
    }, true);
  }

  // --- 21. Tab 4: File Explorer & Inline Line Annotations logic ---
  const fileTree = document.getElementById('file-tree');
  const activeNotesContext = document.getElementById('active-notes-context');
  const contextTagsContainer = document.getElementById('context-tags-container');
  const explorerTreeView = document.getElementById('explorer-tree-view');
  const explorerFileContentView = document.getElementById('explorer-file-content-view');
  const fileViewerPath = document.getElementById('file-viewer-path');
  const codeViewerContainer = document.getElementById('code-viewer-container');
  const fileViewerBackBtn = document.getElementById('file-viewer-back-btn');

  // Multi-dimensional notes database: fileNotes[filePath][lineNum] = noteText
  const fileNotes = {};
  let activeViewingPath = null;

  // Mock High-Fidelity File Database
  const mockFilesDatabase = {
    "index.html": `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>MyCodex Workbench</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="app-layout">
    <!-- Left sidebar and main workspace layout -->
    <aside class="sidebar">...</aside>
    <main class="main-panel">...</main>
  </div>
</body>
</html>`,
    "style.css": `/* Global design system tokens */
:root {
  --bg-sidebar: #fafafa; /* Level 2 */
  --bg-main: #ffffff;    /* Level 1 */
  --bg-hover: #f0f0f0;   /* Level 3 */
  --border-color: #ededed;
}

.app-layout {
  display: flex;
  height: 100vh;
  overflow: hidden;
}`,
    "app.js": `// Main client-side compiler controller
document.addEventListener('DOMContentLoaded', () => {
  console.log("Initializing workspace UI replica...");
  setupSidebar();
  setupGitDiffs();
});

function setupSidebar() {
  const sidebar = document.querySelector('.sidebar');
  // Collapsing transition handler
}`,
    "src/utils/mcpHelper.js": `// MCP Server Bridge Protocol Wrapper
export function registerMCPServer(serverName, config) {
  console.log(\`Registering MCP Server: \${serverName}\`);
  if (config.enabled) {
    return startServerInstance(serverName, config.args);
  }
  return null;
}

function startServerInstance(name, args) {
  return {
    status: 'connected',
    pid: Math.floor(Math.random() * 10000),
    uptime: 0
  };
}`,
    "src/auth/login.js": `// High-performance User authentication handler
const bcrypt = require("bcrypt");
const { RateLimiter } = require("../utils/rate-limiter");
const { AuditLogger } = require("../utils/audit");

const limiter = new RateLimiter({ windowMs: 60000, maxAttempts: 5 });
const logger = new AuditLogger({ service: "auth" });

async function login(username, password) {
  if (!username || !password) {
    logger.warn("login_attempt_missing_fields", { username });
    return { error: "Missing fields" };
  }
  // Authenticate user credentials safely
  return { success: true };
}`
  };

  // Helper: format title with project prefix
  function setFormattedPanelTitle(path, isFile = false) {
    const titleEl = document.querySelector('.panel-title');
    if (titleEl) {
      titleEl.textContent = `mycodex-demo / ${path}`;
    }
  }

  // Simple RegEx syntax highlighters for light theme white background
  function simpleCodeHighlight(lineText) {
    let esc = escapeHTML(lineText);
    // keywords
    esc = esc.replace(/\b(const|let|var|function|class|return|import|export|from|async|await|new|if|else|for|while)\b/g, '<span class="token-keyword">$1</span>');
    // strings
    esc = esc.replace(/(["'`])(.*?)\1/g, '<span class="token-string">$1$2$1</span>');
    // comments
    esc = esc.replace(/(\/\/.*)$/g, '<span class="token-comment">$1</span>');
    return esc;
  }

  // Render file viewer content by lines
  function openFileInViewer(filePath) {
    activeViewingPath = filePath;
    if (fileViewerPath) fileViewerPath.textContent = filePath;
    setFormattedPanelTitle(filePath, true);

    const codeText = mockFilesDatabase[filePath] || 
      `// Mock code block for ${filePath}\n// Double-click line number to insert note context.\n\nfunction init() {\n  console.log("Inspecting file...");\n  return true;\n}`;
    
    const lines = codeText.split('\n');
    if (codeViewerContainer) {
      codeViewerContainer.innerHTML = '';
      
      lines.forEach((lineText, idx) => {
        const lineNum = idx + 1;
        const highlighted = simpleCodeHighlight(lineText);
        
        // Code line row structure
        const row = document.createElement('div');
        row.className = 'code-line-row-wrapper';
        row.setAttribute('data-line', lineNum);
        
        let rowHtml = `
          <div class="code-line-row">
            <div class="code-line-num" title="点击添加批注">${lineNum}</div>
            <div class="code-line-content">${highlighted}</div>
          </div>
        `;
        
        row.innerHTML = rowHtml;

        // Render saved notes if exists
        const fileNotesMap = fileNotes[filePath];
        if (fileNotesMap && fileNotesMap[lineNum]) {
          const noteBox = renderAnnotationBox(lineNum, fileNotesMap[lineNum]);
          row.appendChild(noteBox);
        }

        // Add line number click event
        const numBtn = row.querySelector('.code-line-num');
        numBtn.addEventListener('click', () => {
          triggerAnnotationInput(row, lineNum);
        });

        codeViewerContainer.appendChild(row);
      });
    }

    if (explorerTreeView) explorerTreeView.style.display = 'none';
    if (explorerFileContentView) explorerFileContentView.style.display = 'flex';
  }

  // Render official annotation box below code line
  function renderAnnotationBox(lineNum, noteText) {
    const box = document.createElement('div');
    box.className = 'line-annotation-box';
    box.setAttribute('data-line', lineNum);
    box.innerHTML = `
      <div class="annotation-meta">
        <span>行 ${lineNum} · AI 批注上下文</span>
      </div>
      <div class="annotation-text">${escapeHTML(noteText)}</div>
      <div class="annotation-actions">
        <button class="annotation-action-link delete-link">删除</button>
      </div>
    `;

    box.querySelector('.delete-link').addEventListener('click', (e) => {
      e.stopPropagation();
      removeLineAnnotation(activeViewingPath, lineNum, box);
    });

    return box;
  }

  // Trigger inline annotation input form
  function triggerAnnotationInput(rowWrapper, lineNum) {
    // Check if input is already there
    if (rowWrapper.querySelector('.line-annotation-input-card')) return;

    const inputCard = document.createElement('div');
    inputCard.className = 'line-annotation-input-card';
    inputCard.innerHTML = `
      <textarea class="annotation-textarea" placeholder="输入要在此行备注的批注，例如：'重构为响应式布局'..." rows="2"></textarea>
      <div class="annotation-input-actions">
        <button class="annotation-btn-small btn-cancel">取消</button>
        <button class="annotation-btn-small btn-save">保存</button>
      </div>
    `;

    // Cancel action
    inputCard.querySelector('.btn-cancel').addEventListener('click', () => {
      inputCard.remove();
    });

    // Save action
    inputCard.querySelector('.btn-save').addEventListener('click', () => {
      const textarea = inputCard.querySelector('.annotation-textarea');
      const val = textarea.value.trim();
      if (val) {
        saveLineAnnotation(activeViewingPath, lineNum, val, rowWrapper);
      }
      inputCard.remove();
    });

    rowWrapper.appendChild(inputCard);
    inputCard.querySelector('.annotation-textarea').focus();
  }

  // Save line annotation
  function saveLineAnnotation(filePath, lineNum, noteText, rowWrapper) {
    if (!fileNotes[filePath]) fileNotes[filePath] = {};
    
    // Remove old box if exists
    const oldBox = rowWrapper.querySelector('.line-annotation-box');
    if (oldBox) oldBox.remove();

    // Save
    fileNotes[filePath][lineNum] = noteText;

    // Append new box
    const newBox = renderAnnotationBox(lineNum, noteText);
    rowWrapper.appendChild(newBox);

    // Update file tree node counts
    updateFileTreeNodeBadge(filePath);
    updateActiveNotesContextView();

    // Add log
    if (window.addMockTokenLog) {
      const filename = filePath.split('/').pop();
      window.addMockTokenLog(`annotate_file (${filename}:L${lineNum})`, 95, 0);
    }
  }

  // Remove line annotation
  function removeLineAnnotation(filePath, lineNum, boxElement) {
    if (fileNotes[filePath]) {
      delete fileNotes[filePath][lineNum];
      if (Object.keys(fileNotes[filePath]).length === 0) {
        delete fileNotes[filePath];
      }
    }
    boxElement.remove();
    updateFileTreeNodeBadge(filePath);
    updateActiveNotesContextView();
  }

  // Calculate and update the green note indicator badge on the tree node
  function updateFileTreeNodeBadge(filePath) {
    const fileNode = fileTree.querySelector(`.tree-node.file[data-path="${CSS.escape(filePath)}"]`);
    if (fileNode) {
      const badge = fileNode.querySelector('.note-indicator-badge');
      if (badge) {
        const fileNotesMap = fileNotes[filePath];
        const count = fileNotesMap ? Object.keys(fileNotesMap).length : 0;
        if (count > 0) {
          badge.textContent = count;
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      }
    }
  }

  // Folder expand/collapse logic
  if (fileTree) {
    const folderNodes = fileTree.querySelectorAll('.tree-node.folder');
    folderNodes.forEach(folder => {
      const row = folder.querySelector('.node-row');
      const toggle = folder.querySelector('.toggle-icon');
      const children = folder.querySelector('.node-children');

      if (row) {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          const isExpanded = folder.classList.toggle('expanded');
          if (toggle) toggle.classList.toggle('expanded', isExpanded);
          if (children) {
            children.style.display = isExpanded ? 'block' : 'none';
          }
        });
      }
    });

    // File double click triggers opening file content
    const fileNodes = fileTree.querySelectorAll('.tree-node.file');
    fileNodes.forEach(file => {
      const row = file.querySelector('.node-row');
      if (row) {
        row.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          fileTree.querySelectorAll('.tree-node.file').forEach(f => f.classList.remove('selected'));
          file.classList.add('selected');
          const filePath = file.getAttribute('data-path');
          openFileInViewer(filePath);
        });
      }
    });
  }

  // Back to tree list
  if (fileViewerBackBtn) {
    fileViewerBackBtn.addEventListener('click', () => {
      if (explorerFileContentView) explorerFileContentView.style.display = 'none';
      if (explorerTreeView) explorerTreeView.style.display = 'block';
      activeViewingPath = null;
      setFormattedPanelTitle('build a todo list app');
    });
  }

  // Helper: Update Active Notes list as context tag badges above the file tree
  function updateActiveNotesContextView() {
    if (!contextTagsContainer || !activeNotesContext) return;

    contextTagsContainer.innerHTML = '';
    let totalTagsCount = 0;

    Object.keys(fileNotes).forEach(filePath => {
      const lineMap = fileNotes[filePath];
      Object.keys(lineMap).forEach(lineNum => {
        totalTagsCount++;
        const note = lineMap[lineNum];
        const filename = filePath.split('/').pop();
        const truncatedNote = note.length > 15 ? note.substring(0, 15) + '...' : note;

        const tag = document.createElement('div');
        tag.className = 'context-tag';
        tag.innerHTML = `
          <span>📄 ${filename}:L${lineNum} "${truncatedNote}"</span>
          <span class="tag-remove" title="移除此批注">&times;</span>
        `;

        // Click tag to open file content
        tag.addEventListener('click', () => {
          // Switch to tab-file-explorer first
          switchRightTab('tab-file-explorer');
          openFileInViewer(filePath);
        });

        // Click close to remove annotation
        const removeBtn = tag.querySelector('.tag-remove');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          delete fileNotes[filePath][lineNum];
          if (Object.keys(fileNotes[filePath]).length === 0) {
            delete fileNotes[filePath];
          }
          updateFileTreeNodeBadge(filePath);
          // If viewing this file, refresh viewer
          if (activeViewingPath === filePath) {
            openFileInViewer(filePath);
          }
          updateActiveNotesContextView();
        });

        contextTagsContainer.appendChild(tag);
      });
    });

    if (totalTagsCount === 0) {
      activeNotesContext.style.display = 'none';
    } else {
      activeNotesContext.style.display = 'flex';
    }
  }


  // --- 22. Tab 5: VS Code style Git source control Diff Center logic ---
  const diffAccordionList = document.getElementById('diff-accordion-list');
  const stagedDiffList = document.getElementById('staged-diff-list');
  const collapseAllDiffsBtn = document.getElementById('collapse-all-diffs-btn');
  const gitCommitInput = document.getElementById('git-commit-input');
  const gitCommitSubmitBtn = document.getElementById('git-commit-submit-btn');
  const stagedCountBadge = document.getElementById('staged-count-badge');
  const changesCountBadge = document.getElementById('changes-count-badge');

  // Interactive Git Lists
  let unstagedFiles = ['index.html', 'style.css', 'app.js', 'src/utils/mcpHelper.js'];
  let stagedFiles = [];

  // Chevron click expand differential views
  function setupAccordionEvents(item) {
    const header = item.querySelector('.diff-item-header');
    if (header) {
      header.addEventListener('click', (e) => {
        // Prevent expanding when clicking interactive buttons
        if (e.target.closest('.diff-git-action-btn')) return;
        const isExpanded = item.classList.toggle('expanded');
        if (isExpanded && window.addMockTokenLog) {
          window.addMockTokenLog(`view_diff (${item.getAttribute('data-file')})`, 45, 0);
        }
      });
    }

    // Stage file button
    const stageBtn = item.querySelector('.staged-btn');
    if (stageBtn) {
      stageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const filename = item.getAttribute('data-file');
        stageFile(filename, item);
      });
    }

    // Revert changes button
    const revertBtn = item.querySelector('.revert-btn');
    if (revertBtn) {
      revertBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const filename = item.getAttribute('data-file');
        revertFile(filename, item);
      });
    }
  }

  // Initialize unstaged accordion items
  if (diffAccordionList) {
    diffAccordionList.querySelectorAll('.diff-accordion-item').forEach(item => {
      setupAccordionEvents(item);
    });
  }

  // Stage action
  function stageFile(filename, itemElement) {
    unstagedFiles = unstagedFiles.filter(f => f !== filename);
    stagedFiles.push(filename);
    
    // Modify stage button to unstage button
    const stageBtn = itemElement.querySelector('.staged-btn');
    if (stageBtn) {
      stageBtn.textContent = '-';
      stageBtn.title = '取消暂存更改';
      stageBtn.className = 'diff-git-action-btn unstaged-action-btn';
      
      // Re-register event to unstage action
      stageBtn.replaceWith(stageBtn.cloneNode(true));
      const newStageBtn = itemElement.querySelector('.unstaged-action-btn');
      newStageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        unstageFile(filename, itemElement);
      });
    }

    // Remove revert button when staged
    const revertBtn = itemElement.querySelector('.revert-btn');
    if (revertBtn) revertBtn.style.display = 'none';

    // Move to staged changes container
    if (stagedDiffList) stagedDiffList.appendChild(itemElement);

    updateGitCountBadges();
  }

  // Unstage action
  function unstageFile(filename, itemElement) {
    stagedFiles = stagedFiles.filter(f => f !== filename);
    unstagedFiles.push(filename);

    // Modify unstage button to stage button
    const unstageBtn = itemElement.querySelector('.unstaged-action-btn');
    if (unstageBtn) {
      unstageBtn.textContent = '+';
      unstageBtn.title = '暂存更改';
      unstageBtn.className = 'diff-git-action-btn staged-btn';

      unstageBtn.replaceWith(unstageBtn.cloneNode(true));
      const newStageBtn = itemElement.querySelector('.staged-btn');
      newStageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        stageFile(filename, itemElement);
      });
    }

    // Restore revert button
    const revertBtn = itemElement.querySelector('.revert-btn');
    if (revertBtn) revertBtn.style.display = 'inline-flex';

    // Move to unstaged changes container
    if (diffAccordionList) diffAccordionList.appendChild(itemElement);

    updateGitCountBadges();
  }

  // Revert simulation
  function revertFile(filename, itemElement) {
    if (confirm(`确定要放弃对 ${filename} 的所有未暂存改动吗？此操作无法撤销。`)) {
      unstagedFiles = unstagedFiles.filter(f => f !== filename);
      itemElement.remove();
      updateGitCountBadges();
      
      // Update file tree node Git status badge
      const treeNode = fileTree.querySelector(`.tree-node.file[data-path="${CSS.escape(filename)}"]`);
      if (treeNode) {
        treeNode.className = 'tree-node file';
        const badge = treeNode.querySelector('.git-status-badge');
        if (badge) badge.style.display = 'none';
      }
    }
  }

  // Update numbers badges
  function updateGitCountBadges() {
    if (stagedCountBadge) stagedCountBadge.textContent = stagedFiles.length;
    if (changesCountBadge) changesCountBadge.textContent = unstagedFiles.length;
  }

  // Collapse all diffs
  if (collapseAllDiffsBtn) {
    collapseAllDiffsBtn.addEventListener('click', () => {
      document.querySelectorAll('.diff-accordion-item').forEach(item => {
        item.classList.remove('expanded');
      });
    });
  }

  // Submit git commit simulation
  const performGitCommit = () => {
    const message = gitCommitInput ? gitCommitInput.value.trim() : '';
    if (stagedFiles.length === 0) {
      alert("请先暂存至少一个文件的改动以供提交！");
      return;
    }
    const commitMsg = message || 'update code components';
    
    // Create elegant toast banner
    const toast = document.createElement('div');
    toast.className = 'git-commit-toast';
    toast.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width: 14px; height: 14px; color: #10b981; margin-right: 6px;">
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 8 12 12 16 14"></polyline>
      </svg>
      <span>Git 提交成功: "${commitMsg}" 已推送至 master 分支</span>
    `;

    // Dynamic toast styles
    Object.assign(toast.style, {
      position: 'absolute',
      bottom: '16px',
      right: '16px',
      backgroundColor: '#ffffff',
      border: '1px solid #ededed',
      borderRadius: '8px',
      padding: '8px 16px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
      fontSize: '11.5px',
      color: '#3a3a38',
      display: 'flex',
      alignItems: 'center',
      zIndex: '2000',
      transition: 'opacity 0.3s, transform 0.3s',
      opacity: '0',
      transform: 'translateY(10px)'
    });

    document.querySelector('.mac-window').appendChild(toast);
    
    // Animate slide up
    setTimeout(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    }, 50);

    // Remove toast after 3 seconds
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);

    // Empty staged list
    if (stagedDiffList) stagedDiffList.innerHTML = '';
    
    // Remove Git status from file tree nodes
    stagedFiles.forEach(file => {
      const treeNode = fileTree.querySelector(`.tree-node.file[data-path="${CSS.escape(file)}"]`);
      if (treeNode) {
        treeNode.className = 'tree-node file';
        const badge = treeNode.querySelector('.git-status-badge');
        if (badge) badge.style.display = 'none';
      }
    });

    stagedFiles = [];
    if (gitCommitInput) gitCommitInput.value = '';
    updateGitCountBadges();
  };

  if (gitCommitSubmitBtn) {
    gitCommitSubmitBtn.addEventListener('click', performGitCommit);
  }
  if (gitCommitInput) {
    gitCommitInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        performGitCommit();
      }
    });
  }

  // Initialize default active chat
  activateChatItem('todo-list-app', 'build a todo list app');
});
