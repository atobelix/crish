/**
 * SkillsPanel — code preview switching.
 */
const skills = {
  'format_markdown.js': {
    desc: '自动规范化 Markdown 格式，修复空行、列表对齐、标题间距，并优化中英文之间的空格间隔。',
    code: "// format_markdown.js\nexport default function formatMarkdown(text) {\n  let formatted = text.replace(/([\\u4e00-\\u9fa5])([A-Za-z0-9])/g, '$1 $2');\n  formatted = formatted.replace(/([A-Za-z0-9])([\\u4e00-\\u9fa5])/g, '$1 $2');\n  formatted = formatted.replace(/\\n{3,}/g, '\\n\\n');\n  return formatted;\n}"
  },
  'extract_todo.py': {
    desc: '从所有源文件中扫描并提取包含 # TODO 标记的代码行。',
    code: "# extract_todo.py\nimport os, re\n\ndef scan_todos(directory):\n    todo_pattern = re.compile(r'#\\s*TODO:\\s*(.*)', re.IGNORECASE)\n    for root, dirs, files in os.walk(directory):\n        for file in files:\n            if file.endswith(('.py', '.js', '.css')):\n                path = os.path.join(root, file)\n                with open(path, 'r') as f:\n                    for i, line in enumerate(f, 1):\n                        match = todo_pattern.search(line)\n                        if match:\n                            print(f\"- [ ] {file}:{i} - {match.group(1)}\")"
  },
  'minify_css.js': {
    desc: '移除 CSS 源码中的注释、空格、换行，压缩样式文件体积。',
    code: "// minify_css.js\nexport function minifyCSS(cssText) {\n  return cssText\n    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')\n    .replace(/\\s+([{} >+~;:,])/g, '$1')\n    .replace(/([{} >+~;:,])\\s+/g, '$1')\n    .replace(/\\s+/g, ' ')\n    .trim();\n}"
  }
};

export function initSkillsPanel() {
  const items = document.querySelectorAll('#view-skills .secondary-sidebar-item');
  if (!items.length) return;
  items.forEach(item => {
    item.addEventListener('click', () => {
      items.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const key = item.textContent.trim();
      const data = skills[key];
      if (!data) return;
      const viewer = document.querySelector('#view-skills .fav-doc-viewer');
      if (!viewer) return;
      viewer.innerHTML = `<h3>${key}</h3>
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">${data.desc}</p>
        <pre class="code-block scrollable"><code>${data.code}</code></pre>`;
      if (window.Prism) setTimeout(() => viewer.querySelector('pre code')?.removeAttribute('data-highlighted'), 50);
    });
  });
}
