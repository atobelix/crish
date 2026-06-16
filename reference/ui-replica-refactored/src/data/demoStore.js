/**
 * demoStore — centralized demo data source.
 *
 * All UI nodes read from this store. Nothing is hardcoded.
 *
 * Structure mirrors the real backend:
 *   .crish/conversations/  → conversations[]
 *   用户指定位置           → projects[]
 *   .crish/config/         → ui preferences
 */

/* ── Timestamps for demo ── */
const now = Date.now();
const min = (m) => now - m * 60000;
const hr = (h) => now - h * 3600000;
const day = (d) => now - d * 86400000;

/* ── Mock file trees ── */
const mycodexFiles = [
  { name: 'index.html', path: 'index.html', status: 'modified' },
  { name: 'style.css',  path: 'style.css', status: null },
  { name: 'app.js',     path: 'app.js',  status: null },
  { name: 'src', type: 'dir', children: [
    { name: 'auth', type: 'dir', children: [
      { name: 'login.js',  path: 'src/auth/login.js',  status: 'modified' },
      { name: 'reset.js',  path: 'src/auth/reset.js',  status: null }
    ]},
    { name: 'utils', type: 'dir', children: [
      { name: 'format.js',       path: 'src/utils/format.js',       status: null },
      { name: 'rate-limiter.js', path: 'src/utils/rate-limiter.js', status: 'modified' },
      { name: 'mcpHelper.js',    path: 'src/utils/mcpHelper.js',   status: null }
    ]},
    { name: 'components', type: 'dir', children: [
      { name: 'ChatPanel.jsx', path: 'src/components/ChatPanel.jsx', status: null },
      { name: 'Sidebar.jsx',   path: 'src/components/Sidebar.jsx',   status: null }
    ]}
  ]}
];

const conexFiles = [
  { name: 'package.json', path: 'package.json', status: null },
  { name: 'Cargo.toml', path: 'Cargo.toml', status: null },
  { name: 'apps', type: 'dir', children: [
    { name: 'agent-workbench', type: 'dir', children: [
      { name: 'src', type: 'dir', children: [
        { name: 'core', type: 'dir', children: [
          { name: 'app-state.ts',   path: 'apps/agent-workbench/src/core/app-state.ts',   status: 'modified' },
          { name: 'tauri-bridge.ts',path: 'apps/agent-workbench/src/core/tauri-bridge.ts',status: 'modified' }
        ]}
      ]}
    ]}
  ]}
];

/* ── Realistic conversation data ── */
const conversations = [
  {
    id: 'conv-1',
    title: 'build a todo list app',
    project: 'mycodex-demo',
    created: day(3),
    lastActive: min(1),
    archived: false,
    pinned: false,
    messages: [
      { role: 'user', content: '帮我创建一个简单的 todo 应用，要有添加、完成、删除功能' },
      { role: 'assistant', content: '我来为你创建这个应用。首先看一下项目结构。' },
      { role: 'tool_group', status: 'summary', expanded: false, calls: [
        { name: 'read_file', args: 'index.html', result: '<!DOCTYPE html>...', expanded: false, done: true },
        { name: 'read_file', args: 'style.css', result: ':root {...}', expanded: false, done: true }
      ], metrics: { tools: 2, edited: 0, viewed: 2 } },
      { role: 'assistant', content: '我看到项目的 HTML 和 CSS 结构。现在创建完整的 Todo 应用代码。' },
      { role: 'tool_group', status: 'summary', expanded: false, calls: [
        { name: 'edit_file', args: 'index.html', result: 'Applied 15 edits', expanded: false, done: true,
          diff: { file: 'index.html', added: 15, removed: 5, hunks: [{ oldStart: 1, newStart: 1, lines: [
            { type: 'removed', content: '<div class="app"><h1>MyCodex</h1></div>' },
            { type: 'added',   content: '<div class="app"><h1>TaskFlow</h1><div class="todo-container"><input id="todo-input" placeholder="Add task..."><button id="add-btn">+</button></div><ul id="todo-list"></ul></div>' }
          ]}] }
        },
        { name: 'edit_file', args: 'style.css', result: 'Applied 8 edits', expanded: false, done: true,
          diff: { file: 'style.css', added: 25, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: [
            { type: 'added', content: '.todo-container { display: flex; gap: 8px; }' },
            { type: 'added', content: '#todo-input { flex: 1; }' },
            { type: 'added', content: '#todo-list { list-style: none; }' },
            { type: 'added', content: '.todo-item { display: flex; align-items: center; padding: 8px; border-bottom: 1px solid #eee; }' }
          ]}] }
        },
        { name: 'edit_file', args: 'app.js', result: 'Applied 20 edits', expanded: false, done: true,
          diff: { file: 'app.js', added: 20, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: [
            { type: 'added', content: 'class TodoApp {' },
            { type: 'added', content: '  constructor() { this.todos = []; this.load(); this.render(); }' },
            { type: 'added', content: '  add(text) { this.todos.push({ id: Date.now(), text, done: false }); this.save(); this.render(); }' },
            { type: 'added', content: '  toggle(id) { const t = this.todos.find(t => t.id === id); if (t) { t.done = !t.done; this.save(); this.render(); } }' }
          ]}] }
        }
      ], metrics: { tools: 3, edited: 3, viewed: 0 } },
      { role: 'assistant', content: '已创建完整的 Todo 应用。包含任务添加、完成状态切换、删除和本地持久化。文件改动汇总：<code class="inline-code">index.html</code> +15/-5, <code class="inline-code">style.css</code> +25, <code class="inline-code">app.js</code> +20。' }
    ],
    rounds: [
      {
        prompt: '帮我创建一个简单的 todo 应用',
        startTime: day(3), endTime: day(3),
        diffs: {
          'index.html': { added: 15, removed: 5, hunks: [{ oldStart: 1, newStart: 1, lines: [
            { type: 'removed', content: '<div class="app"><h1>MyCodex</h1></div>' },
            { type: 'added', content: '<div class="app"><h1>TaskFlow</h1><div class="todo-container">...</div></div>' }
          ]}] },
          'style.css': { added: 25, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: [
            { type: 'added', content: '.todo-container { display: flex; gap: 8px; }' }
          ]}] },
          'app.js': { added: 20, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: [
            { type: 'added', content: 'class TodoApp {' }
          ]}] }
        }
      }
    ]
  },
  {
    id: 'conv-2',
    title: 'refactor login with bcrypt',
    project: 'mycodex-demo',
    created: day(2),
    lastActive: day(1),
    archived: false,
    pinned: false,
    messages: [
      { role: 'user', content: '请把 login.js 的明文密码改成 bcrypt 哈希' },
      { role: 'assistant', content: 'I will refactor the login module to use bcrypt salt-hashing.' },
      { role: 'tool_group', status: 'summary', expanded: false, calls: [
        { name: 'read_file', args: 'src/auth/login.js', result: 'const bcrypt = require("bcrypt");...', expanded: false, done: true }
      ], metrics: { tools: 1, edited: 0, viewed: 1 } },
      { role: 'assistant', content: '已将密码存储改为 bcrypt 哈希，并添加审计日志。' },
      { role: 'tool_group', status: 'summary', expanded: false, calls: [
        { name: 'edit_file', args: 'src/auth/login.js', result: 'Applied 8 edits', expanded: false, done: true,
          diff: { file: 'src/auth/login.js', added: 8, removed: 4, hunks: [{ oldStart: 1, newStart: 1, lines: [
            { type: 'removed', content: '  if (password !== user.password) {' },
            { type: 'added', content: '  const valid = await bcrypt.compare(password, user.passwordHash);' }
          ]}] }
        }
      ], metrics: { tools: 1, edited: 1, viewed: 0 } }
    ],
    rounds: [
      {
        prompt: '请把 login.js 的明文密码改成 bcrypt 哈希',
        startTime: day(2), endTime: day(2),
        diffs: {
          'src/auth/login.js': { added: 8, removed: 4, hunks: [{ oldStart: 1, newStart: 1, lines: [
            { type: 'removed', content: '  if (password !== user.password) {' },
            { type: 'added', content: '  const valid = await bcrypt.compare(password, user.passwordHash);' }
          ]}] }
        }
      }
    ]
  },
  {
    id: 'conv-3',
    title: 'conex setup and requirements',
    project: 'conex',
    created: day(7),
    lastActive: day(3),
    archived: false,
    pinned: false,
    messages: [
      { role: 'assistant', content: 'Hi! I am ready to explore the <strong>conex</strong> codebase. What modules or features would you like to examine first?' },
      { role: 'user', content: '帮我检查 Tauri bridge 的接口' },
      { role: 'tool_group', status: 'expanded', expanded: true, calls: [
        { name: 'grep_search', args: 'grep_search --query="invoke" --path="apps/"', result: 'apps/agent-workbench/src/core/tauri-bridge.ts\napps/agent-workbench/src/core/app-state.ts', expanded: true, done: true },
        { name: 'read_file', args: 'apps/agent-workbench/src/core/tauri-bridge.ts', result: 'import { invoke } from "@tauri-apps/api/core";...', expanded: false, done: true }
      ], metrics: { tools: 2, edited: 0, viewed: 2 } },
      { role: 'assistant', content: 'Found Tauri bridge in <code class="inline-code">tauri-bridge.ts</code>. 当前有 4 个 invoke 接口：read_projects, read_conversation, save_message, read_file。结构合理。' }
    ],
    rounds: [
      {
        prompt: '帮我检查 Tauri bridge 的接口',
        startTime: day(3), endTime: day(3),
        diffs: {}
      }
    ]
  },
  {
    id: 'conv-4',
    title: '关于 CSS 架构的快速讨论',
    project: null,
    created: day(1),
    lastActive: min(30),
    archived: false,
    pinned: false,
    messages: [
      { role: 'user', content: 'CSS 设计系统怎么组织更合理？用 tokens 还是 utility classes？' },
      { role: 'assistant', content: '建议两者结合：用 CSS custom properties 定义 tokens，用 utility classes 作为快捷方式，组件样式仍然独立。这样既有系统性又有灵活性。' }
    ],
    rounds: []
  },
  {
    id: 'conv-5',
    title: '设计数据库迁移方案',
    project: 'conex',
    created: day(14),
    lastActive: day(10),
    archived: false,
    pinned: false,
    messages: [
      { role: 'user', content: '帮我想一个数据库迁移方案' },
      { role: 'assistant', content: '建议使用增量迁移 + 版本控制的策略。每个迁移文件对应一个 schema 版本，支持上滚和回滚。' }
    ],
    rounds: []
  },
  {
    id: 'conv-6',
    title: 'review上周提交的代码',
    project: null,
    created: day(8),
    lastActive: day(5),
    archived: true,
    pinned: false,
    messages: [
      { role: 'assistant', content: '这是上周提交的代码 review 总结...' }
    ],
    rounds: []
  }
];

/* ── UI state ── */
const ui = {
  model: 'Gemini 3.5 Flash',
  latency: 42,
  branch: 'master',
  gitDirty: 501,
  activeProject: 'mycodex-demo',
  currentConversationId: 'conv-1',
  sidebarFilter: {
    sortBy: 'recent',
    groupBy: 'project',
    archiveFilter: 'active',
    timeFilter: 0,
    projectFilter: []
  }
};

/* ── Public API ── */
export const demoStore = {
  get projects() { return [{
    name: 'mycodex-demo', path: 'C:\\Users\\orange\\mycodex-demo', files: mycodexFiles,
    git: { branch: 'master', dirty: 501 }
  }, {
    name: 'conex', path: 'C:\\Software\\conex', files: conexFiles,
    git: { branch: 'master', dirty: 3 }
  }]; },

  get conversations() { return [...conversations]; },

  get ui() { return { ...ui }; },

  /** Return conversations sorted+grouped+filtered for sidebar rendering */
  getConversations: (filter = {}) => {
    const f = { ...ui.sidebarFilter, ...filter };
    let list = [...conversations];

    // archive filter
    if (f.archiveFilter === 'active') list = list.filter(c => !c.archived);
    else if (f.archiveFilter === 'archived') list = list.filter(c => c.archived);

    // time filter
    if (f.timeFilter > 0) {
      const cutoff = now - f.timeFilter * 86400000;
      list = list.filter(c => c.lastActive >= cutoff);
    }

    // project filter
    if (f.projectFilter.length > 0) {
      list = list.filter(c => c.project && f.projectFilter.includes(c.project));
    }

    // sort
    if (f.sortBy === 'created') list.sort((a, b) => b.created - a.created);
    else list.sort((a, b) => b.lastActive - a.lastActive);

    return list;
  },

  getConversation: (id) => conversations.find(c => c.id === id),

  getProject: (name) => ({ name, path: `C:\\Users\\orange\\${name}`, files: [], git: { branch: 'master', dirty: 0 } }),

  updateUI: (partial) => { Object.assign(ui, partial); },

  addConversation: (conv) => { conversations.unshift(conv); },

  updateConversation: (id, partial) => {
    const idx = conversations.findIndex(c => c.id === id);
    if (idx > -1) Object.assign(conversations[idx], partial);
  },

  removeConversation: (id) => {
    const idx = conversations.findIndex(c => c.id === id);
    if (idx > -1) conversations.splice(idx, 1);
  },

  addRound: (convId, round) => {
    const conv = conversations.find(c => c.id === convId);
    if (conv) { conv.rounds.push(round); conv.lastActive = Date.now(); }
  },

  addDiff: (convId, roundIdx, filepath, diff) => {
    const conv = conversations.find(c => c.id === convId);
    if (conv && conv.rounds[roundIdx]) {
      conv.rounds[roundIdx].diffs[filepath] = diff;
      conv.lastActive = Date.now();
    }
  }
};
