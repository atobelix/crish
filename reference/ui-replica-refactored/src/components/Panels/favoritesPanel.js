/**
 * FavoritesPanel — doc viewer switching.
 */
import { highlightCode } from '../../utils/highlight.js';

const docs = {
  'build a todo list app': `<h1>build a todo list app</h1>
    <div class="doc-metadata"><span>收藏时间: 2026-06-13</span><span>关联项目: mycodex-demo</span></div><hr>
    <h2>需求分析</h2><p>构建一个极简的高级待办事项应用，支持任务添加、完成状态切换、清除已完成及本地持久化存储。</p>
    <pre class="code-block"><code>// todo-app.js\nclass TodoApp {\n  constructor() {\n    this.todos = JSON.parse(localStorage.getItem('todos')) || [];\n  }\n}</code></pre>
    <h2>代码实现</h2><p>以下是应用的主逻辑文件。</p>`,
  'refactor login logic': `<h1>refactor login logic</h1>
    <div class="doc-metadata"><span>收藏时间: 2026-06-13</span><span>关联项目: mycodex-demo</span></div><hr>
    <h2>重构背景</h2><p>为了提升系统的安全性，将纯文本存储的密码重构为 bcrypt 加密哈希存储。</p>
    <pre class="code-block"><code>// auth.js\nimport bcrypt from 'bcrypt';\nconst saltRounds = 10;\nexport async function hashPassword(password) {\n  return await bcrypt.hash(password, saltRounds);\n}</code></pre>`
};

export function initFavoritesPanel() {
  const items = document.querySelectorAll('#view-favorites .secondary-sidebar-item');
  const body = document.querySelector('#view-favorites .markdown-body');
  if (!items.length || !body) return;
  items.forEach(item => {
    item.addEventListener('click', () => {
      items.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const key = item.textContent.trim();
      const content = docs[key];
      if (content) body.innerHTML = content;
      if (window.Prism) setTimeout(() => body.querySelectorAll('pre code').forEach(b => { b.removeAttribute('data-highlighted'); window.Prism.highlightElement(b); }), 50);
    });
  });
}
