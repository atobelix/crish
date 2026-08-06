/**
 * HTML 导出 — docToHtml
 *
 * 遍历 ProseMirror 文档树生成语义化 HTML。
 * 支持所有已注册的块级和行内节点类型。
 */

import type { Node as PMNode, Mark } from '@tiptap/pm/model';

/* ── Mark → HTML 标签映射 ── */

function openMark(mark: Mark): string {
  switch (mark.type.name) {
    case 'bold': return '<strong>';
    case 'italic': return '<em>';
    case 'strike': return '<del>';
    case 'underline': return '<u>';
    case 'code': return '<code>';
    case 'highlight': return '<mark>';
    case 'link': {
      const href = mark.attrs.href ?? '';
      return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener">`;
    }
    case 'textStyle': {
      const color = mark.attrs.color;
      return color ? `<span style="color:${escapeAttr(color)}">` : '<span>';
    }
    default: return '<span>';
  }
}

function closeMark(mark: Mark): string {
  switch (mark.type.name) {
    case 'bold': return '</strong>';
    case 'italic': return '</em>';
    case 'strike': return '</del>';
    case 'underline': return '</u>';
    case 'code': return '</code>';
    case 'highlight': return '</mark>';
    case 'link': return '</a>';
    case 'textStyle': return '</span>';
    default: return '</span>';
  }
}

/* ── 转义 ── */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(val: string): string {
  return val.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── 行内内容序列化 ── */

function serializeInline(node: PMNode): string {
  const parts: string[] = [];

  node.forEach((child) => {
    if (child.isText) {
      let html = escapeHtml(child.text ?? '');
      // 按 mark 顺序包裹
      const marks = child.marks;
      for (const mark of marks) {
        html = openMark(mark) + html + closeMark(mark);
      }
      parts.push(html);
    } else if (child.type.name === 'hardBreak') {
      parts.push('<br>');
    } else if (child.type.name === 'mathInline') {
      parts.push(`<span class="math-inline">\\(${escapeHtml(child.textContent)}\\)</span>`);
    } else {
      // 其他行内节点：递归
      parts.push(serializeInline(child));
    }
  });

  return parts.join('');
}

/* ── 块级节点序列化 ── */

function serializeNode(node: PMNode): string {
  const name = node.type.name;
  const inline = () => serializeInline(node);

  switch (name) {
    case 'paragraph':
      return `<p>${inline()}</p>`;

    case 'heading': {
      const level = node.attrs.level ?? 1;
      const tag = `h${Math.min(level, 6)}`;
      return `<${tag}>${inline()}</${tag}>`;
    }

    case 'bulletList':
      return `<ul>${serializeChildren(node)}</ul>`;

    case 'orderedList': {
      const start = node.attrs.start;
      return start && start !== 1
        ? `<ol start="${start}">${serializeChildren(node)}</ol>`
        : `<ol>${serializeChildren(node)}</ol>`;
    }

    case 'listItem':
      return `<li>${serializeChildren(node)}</li>`;

    case 'taskList':
      return `<ul class="task-list">${serializeChildren(node)}</ul>`;

    case 'taskItem': {
      const checked = node.attrs.checked ? ' checked' : '';
      return `<li class="task-item"><input type="checkbox" disabled${checked}> ${serializeChildren(node)}</li>`;
    }

    case 'blockquote':
      return `<blockquote>${serializeChildren(node)}</blockquote>`;

    case 'horizontalRule':
      return '<hr>';

    case 'codeBlock': {
      const lang = node.attrs.language ?? '';
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
      return `<pre><code${cls}>${escapeHtml(node.textContent)}</code></pre>`;
    }

    case 'table':
      return `<table>${serializeChildren(node)}</table>`;

    case 'tableRow':
      return `<tr>${serializeChildren(node)}</tr>`;

    case 'tableHeader':
      return `<th>${inline()}</th>`;

    case 'tableCell':
      return `<td>${inline()}</td>`;

    case 'callout': {
      const kind = node.attrs.kind ?? 'note';
      return `<div class="callout callout--${escapeAttr(kind)}">${serializeChildren(node)}</div>`;
    }

    case 'mathBlock':
      return `<div class="math-block">\\[${escapeHtml(node.textContent)}\\]</div>`;

    case 'mermaidBlock':
      return `<div class="mermaid">${escapeHtml(node.textContent)}</div>`;

    case 'imageBlock': {
      const src = node.attrs.src ?? '';
      const alt = node.attrs.alt ?? '';
      return `<figure><img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy"></figure>`;
    }

    case 'videoBlock': {
      const src = node.attrs.src ?? '';
      return `<figure><video src="${escapeAttr(src)}" controls></video></figure>`;
    }

    case 'audioBlock': {
      const src = node.attrs.src ?? '';
      return `<figure><audio src="${escapeAttr(src)}" controls></audio></figure>`;
    }

    case 'bookmarkBlock': {
      const url = node.attrs.url ?? '';
      const title = node.attrs.title ?? url;
      return `<div class="bookmark"><a href="${escapeAttr(url)}">${escapeHtml(title)}</a></div>`;
    }

    case 'embedBlock': {
      const src = node.attrs.src ?? '';
      return `<div class="embed"><iframe src="${escapeAttr(src)}" loading="lazy" allowfullscreen></iframe></div>`;
    }

    case 'columnLayout':
      return `<div class="columns" style="display:flex;gap:1em;">${serializeChildren(node)}</div>`;

    case 'column':
      return `<div class="column" style="flex:1;">${serializeChildren(node)}</div>`;

    case 'toggleHeading': {
      const level = node.attrs.level ?? 2;
      const summary = node.firstChild ? serializeInline(node.firstChild) : '';
      // 第一个子节点是标题文本，后续是折叠内容
      const content: string[] = [];
      node.forEach((child, _, idx) => { if (idx > 0) content.push(serializeNode(child)); });
      return `<details><summary><h${level}>${summary}</h${level}></summary>${content.join('')}</details>`;
    }

    case 'diffBlock': {
      const lang = node.attrs.language ?? '';
      return `<pre class="diff"><code class="language-diff">${escapeHtml(node.textContent)}</code></pre>`;
    }

    default:
      // 未知块类型：递归子节点或直接输出文本
      if (node.isLeaf) return `<p>${escapeHtml(node.textContent)}</p>`;
      return serializeChildren(node);
  }
}

function serializeChildren(node: PMNode): string {
  const parts: string[] = [];
  node.forEach((child) => parts.push(serializeNode(child)));
  return parts.join('\n');
}

/* ── 公共 API ── */

/**
 * 将 ProseMirror 文档转为完整 HTML 文档字符串。
 *
 * @param doc ProseMirror 文档节点
 * @param title 文档标题（可选）
 * @returns 完整 HTML 字符串
 */
export function docToHtml(doc: PMNode, title = 'Document'): string {
  const body = serializeChildren(doc);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { max-width: 720px; margin: 2em auto; padding: 0 1em; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.7; color: #24241E; }
    h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
    pre { background: #f5f5f0; padding: 1em; border-radius: 8px; overflow-x: auto; }
    code { font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 0.9em; }
    blockquote { border-left: 3px solid #cdcdc2; margin-left: 0; padding-left: 1em; color: #78786e; }
    img { max-width: 100%; border-radius: 8px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #cdcdc2; padding: 0.5em 0.75em; text-align: left; }
    th { background: #f5f5f0; font-weight: 600; }
    hr { border: none; border-top: 1px solid #cdcdc2; margin: 2em 0; }
    .task-list { list-style: none; padding-left: 0; }
    .task-item { display: flex; align-items: baseline; gap: 0.5em; }
    .callout { border-left: 3px solid #529cca; padding: 0.75em 1em; margin: 1em 0; border-radius: 4px; background: rgba(82, 156, 202, 0.06); }
    .math-block { text-align: center; margin: 1em 0; }
    .columns { display: flex; gap: 1em; }
    .column { flex: 1; }
    mark { background: rgba(255, 212, 0, 0.4); padding: 0.1em 0.2em; border-radius: 2px; }
    a { color: #2383e2; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * 仅导出 body 内容（不含 HTML 外壳），用于嵌入。
 */
export function docToHtmlFragment(doc: PMNode): string {
  return serializeChildren(doc);
}
