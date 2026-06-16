/**
 * FileExplorer — right sidebar tab.
 * Toolbar: horizontal row, scope dropdown, tree toggle, refresh.
 * Split: file tree (left) + code viewer (right).
 * Code viewer: clean (no diff borders), annotation-ready.
 */
import { FloatingActionBar } from '../../Shared/Annotation/floatingActionBar.js';
import { AnnotationStore } from '../../Shared/Annotation/annotationStore.js';
import { escapeHTML } from '../../../utils/escape.js';
import { demoStore } from '../../../data/demoStore.js';

/* ── Mock file database ── */
const mockFiles = {
  'index.html': '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="UTF-8">\n  <title>MyCodex Workbench</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div class="app-layout">\n    <aside class="sidebar">...</aside>\n    <main class="main-panel">...</main>\n  </div>\n</body>\n</html>',
  'style.css': '/* Global design system */\n:root {\n  --bg-sidebar: #fafafa;\n  --bg-main: #ffffff;\n  --bg-hover: #f0f0f0;\n}\n\n.app-layout {\n  display: flex;\n  height: 100vh;\n}',
  'app.js': "// Main client-side controller\ndocument.addEventListener('DOMContentLoaded', () => {\n  console.log('Initializing...');\n  setupSidebar();\n  setupDiffs();\n});",
  'src/utils/mcpHelper.js': `// MCP Server Bridge\nexport function registerMCPServer(name, config) {\n  if (config.enabled) {\n    return startServer(name, config.args);\n  }\n  return null;\n}\n\nfunction startServer(name, args) {\n  return { status: 'connected', pid: Math.floor(Math.random() * 10000) };\n}`,
  'src/auth/login.js': `const bcrypt = require('bcrypt');\nconst { RateLimiter } = require('../utils/rate-limiter');\n\nasync function login(username, password) {\n  if (!username || !password) return { error: 'Missing fields' };\n  const user = await db.users.findByUsername(username);\n  if (!user) return { error: 'Invalid credentials' };\n  return { token: 'mock-token', user: { id: user.id, username } };\n}`,
  'src/components/ChatPanel.jsx': `import React, { useState } from 'react';\n\nfunction ChatPanel({ messages, onSend }) {\n  const [input, setInput] = useState('');\n  const handleSubmit = (e) => {\n    e.preventDefault();\n    if (!input.trim()) return;\n    onSend(input);\n    setInput('');\n  };\n  return (\n    <div className="chat-panel">\n      {messages.map((m, i) => <div key={i}>{m.text}</div>)}\n      <form onSubmit={handleSubmit}>\n        <input value={input} onChange={e => setInput(e.target.value)} />\n        <button type="submit">Send</button>\n      </form>\n    </div>\n  );\n}`
};

/* ── File tree structure (from demoStore) ── */
function getFileTreeData() {
  const activeProject = demoStore.projects.find(p => p.name === demoStore.ui.activeProject);
  return activeProject ? activeProject.files : (demoStore.projects[0]?.files || []);
}

/* ── Simple syntax highlight ── */
function highlightLine(text) {
  let esc = escapeHTML(text);
  esc = esc.replace(/\b(const|let|var|function|return|import|export|if|else|async|await)\b/g, '<span class="token-keyword">$1</span>');
  esc = esc.replace(/(["'`])(.*?)\1/g, '<span class="token-string">$1$2$1</span>');
  esc = esc.replace(/(\/\/.*)$/g, '<span class="token-comment">$1</span>');
  return esc;
}

function renderFileTree(nodes, depth = 0) {
  return nodes.map(node => {
    if (node.isDir) {
      const indent = depth * 14;
      return `
        <div class="ft-node ft-folder" data-path="${node.name}">
          <div class="ft-row" style="padding-left:${12 + indent}px">
            <span class="ft-toggle">▶</span>
            <svg class="ft-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span class="ft-name">${node.name}</span>
          </div>
          <div class="ft-children" style="display:none">
            ${renderFileTree(node.children || [], depth + 1)}
          </div>
        </div>`;
    } else {
      const indent = depth * 14 + 16;
      const hasAnnotations = AnnotationStore.getByTarget(node.path).length > 0;
      return `
        <div class="ft-node ft-file" data-path="${node.path}">
          <div class="ft-row" style="padding-left:${12 + indent}px">
            <svg class="ft-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
            <span class="ft-name">${node.name}</span>
            ${hasAnnotations ? '<span class="ft-ann-badge" title="包含批注">●</span>' : ''}
          </div>
        </div>`;
    }
  }).join('');
}

export function initFileExplorer() {
  const panel = document.getElementById('tab-file-explorer');
  if (!panel) return;

  panel.innerHTML = `
    <div class="fe-container">
      <!-- Toolbar: horizontal row -->
      <div class="fe-toolbar">
        <button class="fe-tool-btn" id="fe-tree-toggle" title="切换文件树">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
        </button>
        <button class="fe-tool-btn" id="fe-refresh" title="刷新">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38"></path></svg>
        </button>
        <div class="fe-spacer"></div>

        <!-- Scope dropdown -->
        <div class="fe-scope-dropdown">
          <button class="fe-scope-trigger">
            <span class="fe-scope-label">AI 改动</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
          <div class="fe-scope-menu" style="display:none">
            <div class="fe-scope-item selected" data-scope="ai">AI 改动 (MyCodex)</div>
            <div class="fe-scope-item" data-scope="all">所有改动 (All)</div>
          </div>
        </div>

        <!-- Git branch indicator -->
        <div class="fe-git-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M13 6h3a2 2 0 0 1 2 2v7"></path><line x1="6" y1="9" x2="6" y2="21"></line></svg>
          <span>master</span>
        </div>
      </div>

      <!-- Split: tree + content -->
      <div class="fe-split">
        <div class="fe-tree-panel" id="fe-tree-panel">
          <div class="fe-tree-container">${renderFileTree(getFileTreeData())}</div>
        </div>
        <div class="fe-content-panel" id="fe-content-panel">
          <div class="fe-viewer-header" id="fe-viewer-header">
            <span class="fe-viewer-path" id="fe-viewer-path">选择文件以查看内容</span>
            <button class="fe-viewer-back" id="fe-viewer-back" style="display:none">← 返回</button>
          </div>
          <div class="fe-viewer-body" id="fe-viewer-body">
            <div class="fe-viewer-placeholder">点击左侧文件查看代码</div>
          </div>
        </div>
      </div>
    </div>
  `;

  bindEvents(panel);
}

function bindEvents(panel) {
  const treeContainer = panel.querySelector('.fe-tree-container');

  // ── Folder toggle ──
  panel.querySelectorAll('.ft-folder > .ft-row').forEach(row => {
    row.addEventListener('click', () => {
      const folder = row.closest('.ft-folder');
      const children = folder.querySelector('.ft-children');
      const toggle = row.querySelector('.ft-toggle');
      const isOpen = children.style.display !== 'none';
      children.style.display = isOpen ? 'none' : 'block';
      toggle.textContent = isOpen ? '▶' : '▼';
    });
  });

  // ── File click → show content ──
  panel.querySelectorAll('.ft-file').forEach(file => {
    file.addEventListener('click', () => {
      const path = file.dataset.path;
      const code = mockFiles[path] || '// No preview available';
      showFileContent(path, code);
      panel.querySelectorAll('.ft-file').forEach(f => f.classList.remove('selected'));
      file.classList.add('selected');
    });
  });

  // ── Scope dropdown ──
  const scopeTrigger = panel.querySelector('.fe-scope-trigger');
  const scopeMenu = panel.querySelector('.fe-scope-menu');
  if (scopeTrigger && scopeMenu) {
    scopeTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      scopeMenu.style.display = scopeMenu.style.display === 'none' ? 'block' : 'none';
    });
    panel.querySelectorAll('.fe-scope-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.querySelectorAll('.fe-scope-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        scopeMenu.querySelector('.fe-scope-label').textContent = item.textContent.split('(')[0].trim();
        scopeMenu.style.display = 'none';
      });
    });
    document.addEventListener('click', () => { scopeMenu.style.display = 'none'; });
  }

  // ── Tree toggle ──
  const treeToggle = panel.querySelector('#fe-tree-toggle');
  const treePanel = panel.querySelector('.fe-tree-panel');
  if (treeToggle && treePanel) {
    treeToggle.addEventListener('click', () => {
      treePanel.classList.toggle('collapsed');
    });
  }

  // ── Refresh ──
  panel.querySelector('#fe-refresh')?.addEventListener('click', () => {
    const path = panel.querySelector('.fe-viewer-path')?.textContent;
    if (path && path !== '选择文件以查看内容') {
      const code = mockFiles[path] || '';
      showFileContent(path, code);
    }
  });

  // ── Back button ──
  panel.querySelector('#fe-viewer-back')?.addEventListener('click', () => {
    panel.querySelector('.fe-viewer-body').innerHTML = '<div class="fe-viewer-placeholder">点击左侧文件查看代码</div>';
    panel.querySelector('.fe-viewer-path').textContent = '选择文件以查看内容';
    panel.querySelector('#fe-viewer-back').style.display = 'none';
  });
}

function showFileContent(path, code) {
  const viewerBody = document.getElementById('fe-viewer-body');
  const viewerPath = document.getElementById('fe-viewer-path');
  const viewerBack = document.getElementById('fe-viewer-back');
  if (!viewerBody) return;

  viewerPath.textContent = path;
  if (viewerBack) viewerBack.style.display = 'inline-flex';

  const lines = code.split('\n');
  const annotations = AnnotationStore.getByTarget(path);
  const annMap = {};
  annotations.forEach(a => {
    // Try to extract line number from text if stored as 'filepath:lineNum'
    const lineMatch = a.target.match(/:(\d+)$/);
    if (lineMatch) annMap[lineMatch[1]] = a;
  });

  viewerBody.innerHTML = `
    <div class="fe-code-viewer" data-file-path="${path}">
      ${lines.map((line, i) => {
        const lineNum = i + 1;
        const highlighted = highlightLine(line);
        const hasAnn = annMap[lineNum];
        return `<div class="fe-line-row" data-line="${lineNum}">
          <div class="fe-line-num" data-line="${lineNum}">${lineNum}</div>
          <div class="fe-line-content">${highlighted || '&nbsp;'}</div>
          ${hasAnn ? `<span class="fe-line-ann-marker" title="${escapeHTML(hasAnn.comment)}">●</span>` : ''}
        </div>`;
      }).join('')}
    </div>
  `;

  // Attach floating action bar
  const codeViewer = viewerBody.querySelector('.fe-code-viewer');
  FloatingActionBar.attach(codeViewer, (e) => {
    const lineRow = e.target.closest('.fe-line-row');
    const lineNum = lineRow ? lineRow.dataset.line : '0';
    return path + ':' + lineNum;
  });

  // Line number click → annotate
  viewerBody.querySelectorAll('.fe-line-num').forEach(el => {
    el.addEventListener('click', () => {
      const lineNum = el.dataset.line;
      const content = el.closest('.fe-line-row')?.querySelector('.fe-line-content')?.textContent || '';
      window.parent?.postMessage?.({ type: 'annotate', target: `${path}:${lineNum}`, text: content }, '*');
      // Trigger the annotation input directly
      const event = new CustomEvent('annotation:trigger', {
        detail: { target: `${path}:${lineNum}`, text: content.trim().slice(0, 60) }
      });
      document.dispatchEvent(event);
    });
  });
}
