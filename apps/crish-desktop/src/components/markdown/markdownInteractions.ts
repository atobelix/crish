/**
 * Markdown 交互唯一入口：代码复制/折行/折叠、路径跳转、外链、页内锚点。
 *
 * 文档视图与聊天消息都通过同一个 handler 处理，避免两套复制/路径逻辑漂移。
 * 安全边界：所有 Markdown 发起的本地路径打开都先过可执行后缀拦截。
 */
import type React from 'react';
import { copyTextToClipboard } from '@crish/shared-utils';
import { isBlockedExecutablePath } from '../../api/blockedExecutableExtensions';
import {
  isExternalNavigableHref,
  isSafeHref,
  sanitizeUrlCandidate,
} from '../../api/urlSafety';
import type { TranslationKey } from '../../i18n/types';
import { invokeResult } from '../../api/tauriInvoke';
import { logInternalError } from '../../api/userFacingErrors';

interface MarkdownPathLocation {
  line?: number;
  col?: number;
}

export interface MarkdownInteractionContext {
  t: (key: TranslationKey) => string;
  onOpenPath?: (path: string, location?: MarkdownPathLocation) => void;
  onCopyFeedback?: (kind: 'success' | 'error', text?: string) => void;
  onBlockedPath?: (path: string) => void;
  openExternal?: (url: string) => void;
}

export function handleMarkdownEvent(
  event: React.MouseEvent<Element>,
  ctx: MarkdownInteractionContext
): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const root =
    event.currentTarget instanceof HTMLElement ? event.currentTarget : null;

  const copyButton = target.closest<HTMLElement>('.md-code-copy');
  if (copyButton) {
    event.preventDefault();
    event.stopPropagation();
    void copyCodeBlock(copyButton, ctx);
    return;
  }

  const wrapButton = target.closest<HTMLElement>('.md-code-wrap');
  if (wrapButton) {
    event.preventDefault();
    event.stopPropagation();
    toggleCodeWrap(wrapButton);
    return;
  }

  const foldButton = target.closest<HTMLElement>('.md-code-fold');
  if (foldButton) {
    event.preventDefault();
    event.stopPropagation();
    toggleCodeFold(foldButton);
    return;
  }

  const pathButton = target.closest<HTMLElement>('.md-path-link');
  if (pathButton) {
    event.preventDefault();
    event.stopPropagation();
    const rawPath =
      pathButton.getAttribute('data-path') || pathButton.textContent || '';
    const { cleanPath, line, col } = parsePathAndLocation(rawPath);
    if (!cleanPath) return;
    if (isBlockedExecutablePath(cleanPath)) {
      ctx.onBlockedPath?.(cleanPath);
      return;
    }
    ctx.onOpenPath?.(cleanPath, { line, col });
    return;
  }

  const anchor = target.closest<HTMLAnchorElement>('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (href == null) return;

  const sanitized = sanitizeUrlCandidate(href);
  if (!sanitized) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (isExternalNavigableHref(sanitized)) {
    event.preventDefault();
    event.stopPropagation();
    if (isSafeHref(sanitized)) {
      (ctx.openExternal ?? defaultOpenExternal)(sanitized);
    }
    return;
  }

  if (sanitized.startsWith('#')) {
    event.preventDefault();
    event.stopPropagation();
    scrollToAnchor(root, sanitized.slice(1));
    return;
  }

  // 未知/危险绝对 scheme：禁止 WebView 原生导航。
  if (/^[a-z][a-z0-9+.-]*:/i.test(sanitized)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  // 相对/本地路径：Markdown 内不得触发 SPA 硬导航。
  event.preventDefault();
  event.stopPropagation();
  const { cleanPath, line, col } = parsePathAndLocation(sanitized);
  if (!cleanPath) return;
  if (isBlockedExecutablePath(cleanPath)) {
    ctx.onBlockedPath?.(cleanPath);
    return;
  }
  ctx.onOpenPath?.(cleanPath, { line, col });
}

export function parsePathAndLocation(raw: string): {
  cleanPath: string;
  line?: number;
  col?: number;
} {
  let s = raw.trim();
  let line: number | undefined;
  let col: number | undefined;

  const hashMatch = s.match(/^(.*?)#L(\d+)(?:-L?\d+)?$/i);
  if (hashMatch) {
    s = hashMatch[1] ?? s;
    line = Number.parseInt(hashMatch[2] ?? '', 10);
  } else {
    const colonMatch = s.match(/^(.*?):(\d+)(?::(\d+))?$/);
    if (colonMatch) {
      s = colonMatch[1] ?? s;
      line = Number.parseInt(colonMatch[2] ?? '', 10);
      if (colonMatch[3]) col = Number.parseInt(colonMatch[3], 10);
    }
  }

  return {
    cleanPath: s.trim(),
    ...(Number.isFinite(line) ? { line } : {}),
    ...(Number.isFinite(col) ? { col } : {}),
  };
}

async function copyCodeBlock(
  button: HTMLElement,
  ctx: MarkdownInteractionContext
): Promise<void> {
  const block = button.closest<HTMLElement>('.md-code-block');
  if (!block) return;

  const lineElements = Array.from(
    block.querySelectorAll<HTMLElement>('.md-code-line')
  );
  const text = lineElements.length
    ? lineElements.map((line) => line.textContent ?? '').join('\n')
    : (block.querySelector('pre')?.textContent ?? '');
  if (!text) return;

  const ok = await copyTextToClipboard(text);
  if (!ok) {
    ctx.onCopyFeedback?.('error', text);
    return;
  }

  button.dataset.copied = 'true';
  const copiedLabel = ctx.t('common.markdownCopied');
  button.setAttribute('data-tooltip', copiedLabel);
  button.setAttribute('aria-label', copiedLabel);
  ctx.onCopyFeedback?.('success', text);

  window.setTimeout(() => {
    if (!button.isConnected) return;
    delete button.dataset.copied;
    const copyLabel = ctx.t('common.markdownCopy');
    button.setAttribute('data-tooltip', copyLabel);
    button.setAttribute('aria-label', copyLabel);
  }, 1500);
}

function toggleCodeWrap(button: HTMLElement): void {
  const block = button.closest<HTMLElement>('.md-code-block');
  if (!block) return;
  const wrapped = block.classList.toggle('md-code-wrapped');
  button.setAttribute('aria-pressed', String(wrapped));
}

function toggleCodeFold(button: HTMLElement): void {
  const block = button.closest<HTMLElement>('.md-code-block');
  if (!block) return;
  const collapsed = block.classList.toggle('md-code-collapsed');
  button.setAttribute('aria-expanded', String(!collapsed));
}

function scrollToAnchor(root: HTMLElement | null, rawId: string): void {
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    /* 保留原 id */
  }
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(id)
      : id.replace(/"/g, '\\"');
  const scope: ParentNode = root ?? document;
  const element =
    scope.querySelector<HTMLElement>(`#${escaped}`) ??
    document.getElementById(id);
  element?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function defaultOpenExternal(url: string): void {
  void invokeResult('workbench_open_external_url', { url })
    .then((result) => {
      if (result.status !== 'ok') {
        logInternalError(
          'markdownExternalLink',
          result.status === 'missing'
            ? 'workbench_open_external_url missing'
            : result.message
        );
      }
    })
    .catch((error) => {
      logInternalError('markdownExternalLink', error);
    });
}
