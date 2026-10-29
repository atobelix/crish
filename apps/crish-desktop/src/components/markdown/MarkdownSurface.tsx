/**
 * Markdown 渲染表面：可信 HTML + Island 注水 + i18n 锚点增强。
 *
 * 只负责“把一段 Rust 产出的 HTML 安全地放进 DOM”，不负责块切分、调度、
 * 点击事件；这些由 MarkdownBlock / MarkdownBlockItem / 交互边界负责。
 */
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { TranslationKey } from '../../i18n/types';
import { hash16 } from '../../api/markdown/markdownChunker';
import type { MarkdownVariant } from '../../api/rustCore';
import { IslandPortal } from './islands/IslandPortal';

const TOOLTIP_KEY_MAP: Record<string, TranslationKey> = {
  'markdown.code.copy': 'common.markdownCopy',
  'markdown.code.copied': 'common.markdownCopied',
  'markdown.code.wrap': 'common.markdownWrap',
  'markdown.code.fold': 'common.markdownFold',
};

const CALLOUT_KEY_MAP: Record<string, TranslationKey> = {
  note: 'common.calloutNote',
  tip: 'common.calloutTip',
  important: 'common.calloutImportant',
  warning: 'common.calloutWarning',
  caution: 'common.calloutCaution',
};

interface IslandDescriptor {
  key: string;
  name: string;
  source: string;
  target: HTMLElement;
  host?: HTMLElement;
  displayMode?: boolean;
}

function sameIslands(a: IslandDescriptor[], b: IslandDescriptor[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      item.key === other.key &&
      item.name === other.name &&
      item.source === other.source &&
      item.target === other.target &&
      item.host === other.host &&
      item.displayMode === other.displayMode
    );
  });
}

export interface MarkdownSurfaceProps {
  html: string;
  variant?: MarkdownVariant;
  className?: string;
  as?: 'div' | 'span';
  isActive?: boolean;
  style?: React.CSSProperties;
  onClick?: React.MouseEventHandler<HTMLElement>;
  dataAttributes?: Record<string, string | undefined>;
}

export function MarkdownSurface({
  html,
  variant = 'chat',
  className,
  as = 'div',
  isActive = false,
  style,
  onClick,
  dataAttributes,
}: MarkdownSurfaceProps): React.ReactElement {
  const rootRef = useRef<HTMLElement | null>(null);
  const [islands, setIslands] = useState<IslandDescriptor[]>([]);
  const { t } = useI18n();

  const enhance = useCallback(
    (root: HTMLElement) => {
      root
        .querySelectorAll<HTMLElement>('[data-tooltip-key]')
        .forEach((element) => {
          const rustKey = element.getAttribute('data-tooltip-key');
          const localeKey = rustKey ? TOOLTIP_KEY_MAP[rustKey] : undefined;
          if (!localeKey) return;
          const text = t(localeKey);
          element.setAttribute('data-tooltip', text);
          element.setAttribute('aria-label', text);
        });

      root
        .querySelectorAll<HTMLElement>('[data-callout-title]')
        .forEach((element) => {
          const kind = element.getAttribute('data-callout-title');
          const localeKey = kind ? CALLOUT_KEY_MAP[kind] : undefined;
          if (localeKey) element.textContent = t(localeKey);
        });

      root
        .querySelectorAll<HTMLAnchorElement>('[data-footnote-backref]')
        .forEach((element) => {
          element.setAttribute('aria-label', t('common.footnoteBack'));
        });
    },
    [t]
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // innerHTML 必须由命令式写入：React 若管理 dangerouslySetInnerHTML，
    // 每次 Islands 状态更新都会重写子树，冲掉 enhance() 注入的 i18n 属性。
    root.innerHTML = html;
    enhance(root);

    const next: IslandDescriptor[] = [];
    if (!isActive) {
      root
        .querySelectorAll<HTMLElement>('[data-md-island="math"]')
        .forEach((element, index) => {
          const source = element.getAttribute('data-tex') ?? '';
          if (!source) return;
          // 清掉 Rust 占位 fallback 后再把节点交给 React Portal；Portal 挂载后
          // 由 React 独占该节点，任何外部 textContent 清理都会触发 removeChild 崩溃。
          element.textContent = '';
          next.push({
            key: `math-${index}-${hash16(source)}`,
            name: 'math',
            source,
            target: element,
            displayMode: element.classList.contains('md-math-block'),
          });
        });

      root
        .querySelectorAll<HTMLElement>('[data-island-slot="mermaid"]')
        .forEach((slot, index) => {
          const host = slot.closest<HTMLElement>('.md-code-block');
          const source = host
            ? Array.from(host.querySelectorAll<HTMLElement>('.md-code-line'))
                .map((line) => line.textContent ?? '')
                .join('\n')
            : '';
          if (!source) return;
          slot.textContent = '';
          next.push({
            key: `mermaid-${index}-${hash16(source)}`,
            name: 'mermaid',
            source,
            target: slot,
            host: host ?? undefined,
          });
        });
    }

    setIslands((prev) => (sameIslands(prev, next) ? prev : next));
  }, [html, isActive, enhance, as]);

  const attrs: Record<string, string | undefined> = {
    ...dataAttributes,
    'data-md-variant': variant,
  };
  for (const key of Object.keys(attrs)) {
    if (attrs[key] === undefined) delete attrs[key];
  }

  const container = React.createElement(as, {
    ref: rootRef,
    className: ['md-rendered', 'conex-markdown', className]
      .filter(Boolean)
      .join(' '),
    style,
    onClick,
    ...attrs,
  });

  return (
    <>
      {container}
      {islands.map((island) => (
        <IslandPortal
          key={island.key}
          name={island.name}
          source={island.source}
          target={island.target}
          host={island.host}
          displayMode={island.displayMode}
        />
      ))}
    </>
  );
}
