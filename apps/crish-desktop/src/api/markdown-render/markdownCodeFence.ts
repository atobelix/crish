/**
 * 代码围栏解析与高亮渲染。
 *
 * 从 markdownPlugins.ts 拆出（T4-11 SR-06-R3）：fence info string 解析、
 * 代码块 HTML 构建、闭合/未闭合 fence 抽出。
 */

import { highlightCode } from '../codeHighlight';
import { escapeHtml } from '../markdownRenderLite';

/** fence info string → 语言 id（首 token；c++ 等别名归一） */
export function langFromFenceInfo(info: string): string {
  const raw = (String(info || '').trim().split(/\s+/)[0] ?? '')
    .replace(/^language-/, '')
    .replace(/^\./, '');
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const aliases: Record<string, string> = {
    'c++': 'cpp',
    'c#': 'csharp',
    cs: 'csharp',
    js: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    md: 'markdown',
    ps1: 'bash',
    powershell: 'bash',
  };
  return aliases[lower] || lower;
}

/** 从 fence info string 提取 file="…" 属性值 */
export function extractFilePathFromFenceInfo(info: string): string {
  const m = String(info || '').match(/\bfile=(?:"([^"]*)"|(\S+))/);
  return m ? (m[1] ?? m[2] ?? '') : '';
}

function buildCodeFenceHtml(
  bodyRaw: string,
  langClean: string,
  filePath?: string
): string {
  const body = bodyRaw.replace(/\n$/, '');
  let inner: string;
  try {
    inner = highlightCode(body, langClean);
  } catch {
    inner = escapeHtml(body);
  }
  const langBadge = langClean
    ? `<span class="md-code-lang" data-lang="${escapeHtml(langClean)}" aria-label="${escapeHtml(langClean)}">${escapeHtml(langClean)}</span>`
    : '';
  const blockAttr = langClean ? ` data-lang="${escapeHtml(langClean)}"` : '';
  let breadcrumb = '';
  if (filePath) {
    const segments = filePath.split('/');
    const parts = segments.map((s, i) => {
      const isLast = i === segments.length - 1;
      const cls = isLast
        ? 'md-code-breadcrumb-file'
        : 'md-code-breadcrumb-segment';
      return `<span class="${cls}">${escapeHtml(s)}</span>`;
    });
    breadcrumb = `<span class="md-code-breadcrumb">${parts.join('<span class="md-code-breadcrumb-separator">/</span>')}</span>`;
  }
  const leftContent = breadcrumb || langBadge;
  const rightLang = breadcrumb ? langBadge : '';
  const actions = `<div class="md-code-actions">${rightLang}<button type="button" class="md-code-copy" aria-label="复制代码" title="复制代码">复制</button></div>`;
  const header = `<div class="md-code-header"><div class="md-code-header-left">${leftContent}</div>${actions}</div>`;
  return `<div class="md-code-block"${blockAttr}>${header}<pre class="md-code-pre hljs"><code class="language-${escapeHtml(langClean)}">${inner}</code></pre></div>`;
}

/**
 * 抽出 fenced code：闭合 ```…```，以及文末未闭合 fence（流式输出中间态）。
 */
export function extractCodeFences(text: string): {
  text: string;
  fences: string[];
} {
  const fences: string[] = [];
  let out = text.replace(
    /```([^\n`]{0,500})\r?\n([\s\S]{0,50000}?)```/g,
    (_, info, code) => {
      const i = fences.length;
      const langClean = langFromFenceInfo(info);
      const filePath = extractFilePathFromFenceInfo(info);
      fences.push(buildCodeFenceHtml(code, langClean, filePath));
      return `\n%%FENCE${i}%%\n`;
    }
  );
  out = out.replace(/```([^\n`]*)\r?\n([\s\S]*)$/, (full, info, code) => {
    if (/(^|\n)```/.test(code)) return full;
    const i = fences.length;
    const langClean = langFromFenceInfo(info);
    const filePath = extractFilePathFromFenceInfo(info);
    fences.push(buildCodeFenceHtml(code, langClean, filePath));
    return `\n%%FENCE${i}%%\n`;
  });
  return { text: out, fences };
}
