/**
 * Chat messages data store.
 * Each conversation is keyed by its chat ID.
 */
export const chatMessagesData = {
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
    { role: 'assistant', content: '已打开 Todo 应用：<code class="inline-code">/tmp/mycodex-demo/index.html</code>。' }
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
