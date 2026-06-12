/**
 * Markdown 流式渲染组件
 * 集成 markdown-it + highlight.js，支持增量渲染和代码块复制按钮
 */

import { useMemo, useRef, useEffect, useCallback } from 'preact/hooks';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { tauriBridge } from '../core/tauri-bridge';
import { appState } from '../core/app-state';
import { showToast } from './ToastContainer';

// 初始化 markdown-it 实例（带代码高亮）
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight(str: string, lang: string): string {
    let highlighted: string;
    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch (_) {
        highlighted = md.utils.escapeHtml(str);
      }
    } else {
      try {
        highlighted = hljs.highlightAuto(str).value;
      } catch (_) {
        highlighted = md.utils.escapeHtml(str);
      }
    }
    const langLabel = lang ? `<span class="repl-code-lang">${md.utils.escapeHtml(lang)}</span>` : '';
    return `<pre class="hljs">${langLabel}<button class="repl-code-copy-btn" title="复制代码"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><code>${highlighted}</code></pre>`;
  },
});

// 渲染缓存，避免相同内容重复解析
const renderCache = new Map<string, string>();
const MAX_CACHE_SIZE = 100;

function renderMarkdown(content: string): string {
  // 流式内容经常变化，只缓存最终结果
  if (renderCache.has(content)) {
    return renderCache.get(content)!;
  }

  const html = md.render(content);

  // 管理 cache 大小
  if (renderCache.size >= MAX_CACHE_SIZE) {
    const firstKey = renderCache.keys().next().value;
    if (firstKey) renderCache.delete(firstKey);
  }
  renderCache.set(content, html);

  return html;
}

interface MarkdownRendererProps {
  content: string;
  streaming?: boolean;
}

/**
 * Markdown 渲染器
 * 支持流式增量渲染：streaming 时只更新变化的部分
 */
export function MarkdownRenderer({ content, streaming }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevContentRef = useRef('');

  const html = useMemo(() => renderMarkdown(content), [content]);

  // 流式渲染时保持滚动位置
  useEffect(() => {
    if (!streaming || !containerRef.current) return;

    const container = containerRef.current;
    // 检查用户是否在底部附近
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;

    // 如果内容变长且用户在底部，自动滚动
    if (isNearBottom && content.length > prevContentRef.current.length) {
      container.scrollTop = container.scrollHeight;
    }

    prevContentRef.current = content;
  }, [content, streaming]);

  return (
    <div
      ref={containerRef}
      class="repl-markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * 代码块复制按钮
 * 处理点击事件并显示复制反馈
 */
export function CodeBlockCopyButton() {
  useEffect(() => {
    const handler = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('.repl-code-copy-btn') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      const pre = btn.closest('pre');
      const code = pre?.querySelector('code');
      if (code) {
        try {
          await navigator.clipboard.writeText(code.textContent || '');
          btn.classList.add('copied');
          showToast('已复制到剪贴板', 'success', 1500);
          setTimeout(() => btn.classList.remove('copied'), 1500);
        } catch {}
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return null;
}

/**
 * Action 链接处理器
 * 处理 markdown 中的 action:// 链接点击
 */
export function ActionLinkHandler() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!href.startsWith('action://')) return;
      e.preventDefault();
      e.stopPropagation();

      const action = href.slice('action://'.length);
      if (action === 'open-folder') {
        tauriBridge.selectFolder().then(folder => {
          if (folder) {
            appState.addOpenedFolder(folder);
            appState.setState('workingDirectory', folder);
            // workMode 由 currentSession.projectId 决定，创建项目会话切换到 agent 模式
            const projectSessions = appState.getProjectSessions(folder);
            if (projectSessions.length > 0) appState.switchSession(projectSessions[0].id);
            else appState.createSession('新对话', folder);
          }
        });
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return null;
}
