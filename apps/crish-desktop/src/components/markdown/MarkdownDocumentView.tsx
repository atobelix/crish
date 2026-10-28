import React, { useCallback, useRef } from 'react';
import { Priority } from '../../workers';
import { useAsyncMarkdownHtml } from '../../api/markdownRenderAsync';
import {
  isSafeHref,
  sanitizeUrlCandidate,
} from '../../api/markdown-render/markdownSanitizer';
import { VirtualPlainCodeViewer } from '../diff/VirtualPlainCodeViewer';
import { ScrollArea } from '@/components/ui';
import { copyTextToClipboard } from '@crish/shared-utils';
import { useLeafScope } from '../../contexts/LeafScopeContext';
import { useI18n } from '../../i18n';

/** 超过此阈值（默认 256KB）将强制熔断切入虚拟化极速代码呈现 */
export const DEFAULT_LARGE_FILE_THRESHOLD_BYTES = 256 * 1024;

export interface MarkdownDocumentViewProps {
  content?: string;
  filePath?: string;
  variant?: 'document' | 'chat';
  className?: string;
  priority?: Priority;
  largeFileThreshold?: number; // 默认 256 * 1024
  wordWrap?: boolean;
  onOpenPath?: (path: string) => void;
  emptyPlaceholder?: string;
  onCopyFeedback?: (status: 'success' | 'error', text?: string) => void;
  scrollable?: boolean;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  footerSlot?: React.ReactNode;
}

export interface ParsedPathTarget {
  cleanPath: string;
  line?: number;
  col?: number;
}

/**
 * 智能拆解文件路径中的锚点与行列号：
 * 1. #L10 或 #L10-L20
 * 2. :line:col 或 :line
 */
export function parsePathAndLocation(rawPath: string): ParsedPathTarget {
  let s = String(rawPath ?? '').trim();
  let line: number | undefined;
  let col: number | undefined;

  // 1. 匹配 #L12 或 #L12-L24 锚点语法
  const hashMatch = s.match(/#L(\d+)(?:-L\d+)?$/i);
  if (hashMatch && hashMatch.index !== undefined && hashMatch[1]) {
    line = parseInt(hashMatch[1], 10);
    s = s.slice(0, hashMatch.index);
  } else {
    // 2. 匹配 :line:col 或 :line 语法（排除 Windows 盘符 C:）
    const colonMatch = s.match(/:(\d+)(?::(\d+))?$/);
    if (colonMatch && colonMatch.index !== undefined && colonMatch[1]) {
      line = parseInt(colonMatch[1], 10);
      if (colonMatch[2]) {
        col = parseInt(colonMatch[2], 10);
      }
      s = s.slice(0, colonMatch.index);
    }
  }

  return { cleanPath: s, line, col };
}

/** 与 isSafeHref 一致的外链 scheme 判定（大小写不敏感） */
function isExternalNavigableHref(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^mailto:/i.test(url);
}

/**
 * 安全调用外部系统浏览器打开链接，杜绝 WebView2 内部跳转。
 * 唯一入口：sanitizeUrlCandidate → isSafeHref → http(s)/mailto。
 */
function openExternalUrl(url: string): void {
  const sanitized = sanitizeUrlCandidate(url);
  if (!sanitized) return;
  if (!isSafeHref(sanitized) || !isExternalNavigableHref(sanitized)) return;

  if (typeof window !== 'undefined') {
    window.open(sanitized, '_blank', 'noopener,noreferrer');
  }
}

/**
 * MarkdownDocumentView — 单一真理源 Markdown 静态文档呈现组件
 *
 * 核心架构：
 * 1. 前置大文件熔断：当 content.length > largeFileThreshold（256KB）时，
 *    严格阻断向 useAsyncMarkdownHtml 传参（向 Rust 传空串），原地挂载 VirtualPlainCodeViewer 并附带优雅提示条；
 * 2. 原生 CSS tab-size 替代：在容器声明 tab-size: var(--md-code-tab-size, 2)，彻底废黜主线程 DOM 字符串重写；
 * 3. 挂载结构对齐：<div ref={containerRef} className={`md-rendered conex-markdown ${className || ''}`} data-md-variant={variant}>
 *    支持 failed 降级为 <pre className="md-text-fallback">，达成 Zero-CLS = 0.000；
 * 4. 容器级事件委托（解决伪连通）：
 *    - 拦截 .md-code-copy：写入剪贴板并挂载 .is-copied 类名与“已复制”对勾文案，1500ms 平滑复位；
 *    - 拦截 .md-path-link：拆解 data-path 中的 :line:col 或 #L10，触发 onOpenPath 回调并广播定位事件；
 *    - 拦截 <a class="md-a"> 或普通外部链接：安全移交系统默认浏览器打开。
 */
export const MarkdownDocumentView: React.FC<MarkdownDocumentViewProps> =
  React.memo(function MarkdownDocumentView({
    content,
    filePath = 'document.md',
    variant = 'document',
    className = '',
    priority = Priority.High,
    largeFileThreshold = DEFAULT_LARGE_FILE_THRESHOLD_BYTES,
    wordWrap = true,
    onOpenPath,
    emptyPlaceholder,
    onCopyFeedback,
    scrollable = variant === 'document',
    onScroll,
    footerSlot,
  }: MarkdownDocumentViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const onOpenPathRef = useRef(onOpenPath);
    onOpenPathRef.current = onOpenPath;

    const onCopyFeedbackRef = useRef(onCopyFeedback);
    onCopyFeedbackRef.current = onCopyFeedback;

    const scope = useLeafScope();
    const scopeRef = useRef(scope);
    scopeRef.current = scope;

    const { t } = useI18n();

    const contentLength = content?.length || 0;

    // 1. 大文件前置硬熔断判定（>256KB 严格阻断进入 useAsyncMarkdownHtml）
    const isLargeFile = Boolean(
      largeFileThreshold &&
      largeFileThreshold > 0 &&
      contentLength > largeFileThreshold
    );

    // 2. 只有非大文件且非空时才交由异步渲染引擎处理；熔断时严格向 Rust / worker 传空串
    const targetMarkdown = isLargeFile ? '' : content || '';
    const { html, loading, failed } = useAsyncMarkdownHtml(
      targetMarkdown,
      priority
    );

    // 3. 容器级事件委托中枢（代码复制、路径跳转、外链拦截）
    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;

        // 3.1 拦截代码块复制按钮 (.md-code-copy)
        const copyBtn = target.closest('.md-code-copy');
        if (copyBtn instanceof HTMLElement) {
          e.preventDefault();
          e.stopPropagation();

          const codeBlock = copyBtn.closest('.md-code-block');
          const codeEl =
            codeBlock?.querySelector('pre code') ||
            codeBlock?.querySelector('pre') ||
            codeBlock?.querySelector('code');
          const textToCopy = codeEl?.textContent ?? '';

          if (!textToCopy) return;

          const applyCopiedState = () => {
            copyBtn.classList.add('is-copied');
            const originalText = copyBtn.textContent;
            copyBtn.textContent = t('common.copied');
            copyBtn.setAttribute('aria-label', t('common.copied'));

            setTimeout(() => {
              copyBtn.classList.remove('is-copied');
              copyBtn.textContent = originalText || t('common.copy');
              copyBtn.setAttribute(
                'aria-label',
                originalText || t('common.copy')
              );
            }, 1500);

            onCopyFeedbackRef.current?.('success', textToCopy);
          };

          copyTextToClipboard(textToCopy).then((ok) => {
            if (ok) {
              applyCopiedState();
            } else {
              onCopyFeedbackRef.current?.('error', t('common.copyFailed'));
            }
          });
          return;
        }

        // 3.2 拦截本地路径超链接微胶囊 (.md-path-link)
        const pathBtn = target.closest('.md-path-link');
        if (pathBtn instanceof HTMLElement) {
          e.preventDefault();
          e.stopPropagation();

          const rawPath =
            pathBtn.getAttribute('data-path') || pathBtn.textContent || '';
          const { cleanPath, line, col } = parsePathAndLocation(rawPath);
          if (cleanPath && !isExternalNavigableHref(cleanPath)) {
            onOpenPathRef.current?.(cleanPath);
            if (typeof window !== 'undefined') {
              const currentScope = scopeRef.current;
              const domLeaf = target
                .closest<HTMLElement>('[data-leaf-id]')
                ?.getAttribute('data-leaf-id');
              const domSession = target
                .closest<HTMLElement>('[data-session-id]')
                ?.getAttribute('data-session-id');
              const leafId = currentScope.leafId || domLeaf || undefined;
              const sessionId =
                currentScope.sessionId || domSession || undefined;

              window.dispatchEvent(
                new CustomEvent('crish-open-file', {
                  detail: {
                    path: cleanPath,
                    line,
                    col,
                    ...(leafId ? { leafId } : {}),
                    ...(sessionId ? { sessionId } : {}),
                  },
                })
              );
            }
          }
          return;
        }

        // 3.3 外链导航单轨：sanitizeUrlCandidate + isSafeHref（禁止大小写敏感 startsWith 启发式）
        const anchor = target.closest('a');
        if (anchor instanceof HTMLAnchorElement) {
          const href = anchor.getAttribute('href');
          if (href == null) return;

          const sanitized = sanitizeUrlCandidate(href);
          if (!sanitized) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if (isExternalNavigableHref(sanitized)) {
            e.preventDefault();
            e.stopPropagation();
            if (isSafeHref(sanitized)) {
              openExternalUrl(sanitized);
            }
            return;
          }

          // 未知/危险绝对 scheme：禁止落入 WebView 默认导航
          if (
            /^[a-z][a-z0-9+.-]*:/i.test(sanitized) &&
            !isSafeHref(sanitized)
          ) {
            e.preventDefault();
            e.stopPropagation();
          }
          // 相对路径 / #锚点：保持既有默认行为（不外开）
        }
      },
      [t]
    );

    // 4. 空内容分支优雅呈现
    if (!content || !content.trim()) {
      const emptyNode = (
        <div
          ref={containerRef}
          className={`md-rendered conex-markdown ${className || ''}`.trim()}
          data-md-variant={variant}
          style={
            {
              tabSize: 'var(--md-code-tab-size, 2)',
              MozTabSize: 'var(--md-code-tab-size, 2)',
            } as React.CSSProperties
          }
        >
          {emptyPlaceholder ? (
            <div
              className="md-empty-placeholder"
              style={{
                color: 'var(--text-tertiary)',
                padding: 'var(--space-2, 8px) 0',
              }}
            >
              {emptyPlaceholder}
            </div>
          ) : null}
        </div>
      );

      if (scrollable) {
        return (
          <ScrollArea
            size="sm"
            type="auto"
            orientation="both"
            onScroll={onScroll}
            className="md-document-scroll-root"
            style={{ width: '100%', height: '100%', flex: 1, minHeight: 0 }}
          >
            {emptyNode}
          </ScrollArea>
        );
      }
      return emptyNode;
    }

    // 5. 大文件防崩熔断分支：挂载 VirtualPlainCodeViewer
    if (isLargeFile) {
      return (
        <div
          ref={containerRef}
          className={`md-rendered conex-markdown md-large-file ${className || ''}`.trim()}
          data-md-variant={variant}
          data-large-file="true"
          style={
            {
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              minHeight: 0,
              tabSize: 'var(--md-code-tab-size, 2)',
              MozTabSize: 'var(--md-code-tab-size, 2)',
            } as React.CSSProperties
          }
        >
          <div style={{ flex: 1, minHeight: 0, height: '100%', width: '100%' }}>
            <VirtualPlainCodeViewer
              content={content}
              filePath={filePath}
              wordWrap={wordWrap}
            />
          </div>
        </div>
      );
    }

    // 6. 编译失败容灾兜底分支：保持纯文本排版与换行，达成 Zero-CLS = 0.000
    if (failed && !html) {
      const fallbackNode = (
        <div
          ref={containerRef}
          className={`md-rendered conex-markdown ${className || ''}`.trim()}
          data-md-variant={variant}
          data-failed="true"
          style={
            {
              tabSize: 'var(--md-code-tab-size, 2)',
              MozTabSize: 'var(--md-code-tab-size, 2)',
            } as React.CSSProperties
          }
          onClick={handleClick}
        >
          <pre
            className="md-text-fallback"
            tabIndex={0}
            aria-label="Markdown 纯文本回退视图"
            style={{
              margin: 0,
              padding: 'var(--space-3, 12px)',
              fontFamily: 'var(--md-font-mono, monospace)',
              fontSize: 'var(--font-size-sm, 13px)',
              lineHeight: 1.6,
              color: 'var(--text-primary)',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowX: 'auto',
            }}
          >
            {content}
          </pre>
        </div>
      );

      if (scrollable) {
        return (
          <ScrollArea
            size="sm"
            type="auto"
            orientation="both"
            onScroll={onScroll}
            className="md-document-scroll-root"
            style={{ width: '100%', height: '100%', flex: 1, minHeight: 0 }}
            contentStyle={{
              minHeight: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {fallbackNode}
            {footerSlot ? (
              <div
                className="md-document-footer"
                style={{
                  padding: '0 var(--space-3, 12px) var(--space-3, 12px)',
                }}
              >
                {footerSlot}
              </div>
            ) : null}
          </ScrollArea>
        );
      }

      return (
        <>
          {fallbackNode}
          {footerSlot}
        </>
      );
    }

    // 7. 标准 Markdown HTML 呈现分支
    const contentNode = (
      <div
        ref={containerRef}
        className={`md-rendered conex-markdown ${className || ''}`.trim()}
        data-md-variant={variant}
        data-loading={loading ? 'true' : 'false'}
        data-failed={failed ? 'true' : 'false'}
        style={
          {
            tabSize: 'var(--md-code-tab-size, 2)',
            MozTabSize: 'var(--md-code-tab-size, 2)',
          } as React.CSSProperties
        }
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );

    if (scrollable) {
      return (
        <ScrollArea
          size="sm"
          type="auto"
          orientation="both"
          onScroll={onScroll}
          className="md-document-scroll-root"
          style={{ width: '100%', height: '100%', flex: 1, minHeight: 0 }}
          contentStyle={{
            minHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {contentNode}
          {footerSlot ? (
            <div
              className="md-document-footer"
              style={{ padding: '0 var(--space-3, 12px) var(--space-3, 12px)' }}
            >
              {footerSlot}
            </div>
          ) : null}
        </ScrollArea>
      );
    }

    return (
      <>
        {contentNode}
        {footerSlot}
      </>
    );
  });

MarkdownDocumentView.displayName = 'MarkdownDocumentView';
