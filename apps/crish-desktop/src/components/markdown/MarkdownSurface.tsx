/**
 * Markdown 渲染表面：可信 HTML + Island 注水 + i18n 锚点增强。
 *
 * 只负责“把一段 Rust 产出的 HTML 安全地放进 DOM”，不负责块切分、调度、
 * 点击事件；这些由 MarkdownBlock / MarkdownBlockItem / 交互边界负责。
 *
 * html 更新走增量补丁（patchSurfaceContent）：未变子树整棵保留，文本增长
 * 走 TextNode 追加，结构变化才整节点替换；enhance 只扫 patch 触及的范围，
 * 不再每次整块 innerHTML 替换 + 全量扫描。
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

/** Island 占位标记：占位节点由 React Portal 独占，patch 时整棵跳过。 */
function islandMarkerOf(element: Element): string | null {
  const island = element.getAttribute('data-md-island');
  const slot = element.getAttribute('data-island-slot');
  if (island === null && slot === null) return null;
  return `${island ?? ''}|${slot ?? ''}|${element.getAttribute('data-tex') ?? ''}`;
}

function syncAttributes(oldEl: Element, newEl: Element): boolean {
  let changed = false;
  for (const attr of Array.from(oldEl.attributes)) {
    if (!newEl.hasAttribute(attr.name)) {
      oldEl.removeAttribute(attr.name);
      changed = true;
    }
  }
  for (const attr of Array.from(newEl.attributes)) {
    if (oldEl.getAttribute(attr.name) !== attr.value) {
      oldEl.setAttribute(attr.name, attr.value);
      changed = true;
    }
  }
  return changed;
}

function pushScope(scopes: HTMLElement[], element: HTMLElement): void {
  if (!scopes.includes(element)) scopes.push(element);
}

function patchNode(
  oldNode: Node,
  newNode: Node,
  scopes: HTMLElement[]
): boolean {
  if (oldNode.isEqualNode(newNode)) return false;

  if (
    oldNode.nodeType === Node.TEXT_NODE &&
    newNode.nodeType === Node.TEXT_NODE
  ) {
    const textNode = oldNode as Text;
    const nextData = newNode.textContent ?? '';
    if (nextData === textNode.data) return false;
    // 纯增长走 appendData（与 streamingCodeHighlighter 的 TextNode 追加同
    // 思路）：已渲染前缀的文本节点身份不变，只把增量挂到尾部。
    if (textNode.data.length > 0 && nextData.startsWith(textNode.data)) {
      textNode.appendData(nextData.slice(textNode.data.length));
    } else {
      textNode.data = nextData;
    }
    if (textNode.parentElement) pushScope(scopes, textNode.parentElement);
    return true;
  }

  if (
    oldNode.nodeType === Node.ELEMENT_NODE &&
    newNode.nodeType === Node.ELEMENT_NODE
  ) {
    const oldEl = oldNode as Element;
    const newEl = newNode as Element;
    if (oldEl.tagName === newEl.tagName) {
      const oldMarker = islandMarkerOf(oldEl);
      const newMarker = islandMarkerOf(newEl);
      if (oldMarker !== null || newMarker !== null) {
        // Island 占位：标记一致整棵跳过（Portal 独占，外部清理会触发
        // removeChild 崩溃）；标记变化走下方整节点替换。
        if (oldMarker !== null && oldMarker === newMarker) return false;
      } else {
        let changed = syncAttributes(oldEl, newEl);
        if (changed && oldEl instanceof HTMLElement) {
          pushScope(scopes, oldEl);
        }
        if (patchChildren(oldEl, newEl, scopes)) changed = true;
        return changed;
      }
    }
  }

  const parent = oldNode.parentNode;
  if (!parent) return false;
  const replacement = newNode.cloneNode(true);
  parent.replaceChild(replacement, oldNode);
  if (replacement instanceof HTMLElement) pushScope(scopes, replacement);
  else if (parent instanceof HTMLElement) pushScope(scopes, parent);
  return true;
}

function patchChildren(
  oldParent: Node,
  newParent: Node,
  scopes: HTMLElement[]
): boolean {
  let changed = false;
  const oldKids = Array.from(oldParent.childNodes);
  const newKids = Array.from(newParent.childNodes);
  const shared = Math.min(oldKids.length, newKids.length);
  for (let i = 0; i < shared; i += 1) {
    const oldKid = oldKids[i];
    const newKid = newKids[i];
    if (!oldKid || !newKid) continue;
    if (patchNode(oldKid, newKid, scopes)) changed = true;
  }
  for (let i = shared; i < newKids.length; i += 1) {
    const newKid = newKids[i];
    if (!newKid) continue;
    const clone = newKid.cloneNode(true);
    oldParent.appendChild(clone);
    if (clone instanceof HTMLElement) pushScope(scopes, clone);
    else if (oldParent instanceof HTMLElement) pushScope(scopes, oldParent);
    changed = true;
  }
  for (let i = oldKids.length - 1; i >= shared; i -= 1) {
    oldKids[i]?.remove();
    changed = true;
  }
  return changed;
}

/**
 * 把新 HTML 以增量补丁写入已渲染的 root：未变化子树按 isEqualNode 整棵
 * 跳过（节点身份保留），文本增长走 appendData，只有结构变化才整节点替换。
 * 返回需要补跑 enhance 的范围（新增/替换/被改元素的子树根，已去重并
 * 剔除被其他范围包含的子范围）。
 */
function patchSurfaceContent(root: HTMLElement, html: string): HTMLElement[] {
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = html;
  const scopes: HTMLElement[] = [];
  patchChildren(root, template.content, scopes);
  return scopes.filter(
    (scope, index) =>
      scope.isConnected &&
      !scopes.some(
        (other, otherIndex) =>
          otherIndex !== index && other !== scope && other.contains(scope)
      )
  );
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
  const islandsRef = useRef<IslandDescriptor[]>([]);
  islandsRef.current = islands;
  const appliedRef = useRef<{
    root: HTMLElement;
    html: string;
    enhance: (root: HTMLElement) => void;
    isActive: boolean;
  } | null>(null);
  const { t } = useI18n();

  const enhanceElement = useCallback(
    (element: HTMLElement) => {
      const rustKey = element.getAttribute('data-tooltip-key');
      if (rustKey) {
        const localeKey = TOOLTIP_KEY_MAP[rustKey];
        if (localeKey) {
          const text = t(localeKey);
          element.setAttribute('data-tooltip', text);
          element.setAttribute('aria-label', text);
        }
      }
      const kind = element.getAttribute('data-callout-title');
      if (kind) {
        const localeKey = CALLOUT_KEY_MAP[kind];
        if (localeKey) element.textContent = t(localeKey);
      }
      if (element.hasAttribute('data-footnote-backref')) {
        element.setAttribute('aria-label', t('common.footnoteBack'));
      }
    },
    [t]
  );

  const enhance = useCallback(
    (root: HTMLElement) => {
      root
        .querySelectorAll<HTMLElement>(
          '[data-tooltip-key], [data-callout-title], [data-footnote-backref]'
        )
        .forEach((element) => enhanceElement(element));
    },
    [enhanceElement]
  );

  /** 只对 patch 触及的范围补跑 enhance，不再全 root 扫描。 */
  const enhanceScopes = useCallback(
    (scopes: HTMLElement[]) => {
      for (const scope of scopes) {
        enhanceElement(scope);
        scope
          .querySelectorAll<HTMLElement>(
            '[data-tooltip-key], [data-callout-title], [data-footnote-backref]'
          )
          .forEach((element) => enhanceElement(element));
      }
    },
    [enhanceElement]
  );

  /**
   * 重建 Island 描述符：patch 后仍存活的占位保留原描述符（Portal 不重挂），
   * 只在 patch 触及的范围内收集新出现占位；html 未变时以 [root] 全量重扫。
   */
  const rebuildIslands = useCallback(
    (root: HTMLElement, scopes: HTMLElement[], forceFullScan: boolean) => {
      if (isActive) {
        setIslands((prev) => (prev.length === 0 ? prev : []));
        return;
      }

      const next: IslandDescriptor[] = [];
      const seen = new Set<HTMLElement>();
      if (!forceFullScan) {
        for (const descriptor of islandsRef.current) {
          if (!descriptor.target.isConnected) continue;
          if (descriptor.name === 'math') {
            const source = descriptor.target.getAttribute('data-tex') ?? '';
            if (!source) continue;
            seen.add(descriptor.target);
            if (source === descriptor.source) {
              next.push(descriptor);
            } else {
              const all = root.querySelectorAll('[data-md-island="math"]');
              const index = Array.prototype.indexOf.call(
                all,
                descriptor.target
              );
              next.push({
                ...descriptor,
                key: `math-${index}-${hash16(source)}`,
                source,
              });
            }
          } else {
            const host = descriptor.host;
            if (!host || !host.isConnected) continue;
            const source = Array.from(
              host.querySelectorAll<HTMLElement>('.md-code-line')
            )
              .map((line) => line.textContent ?? '')
              .join('\n');
            if (!source) continue;
            seen.add(descriptor.target);
            if (source === descriptor.source) {
              next.push(descriptor);
            } else {
              const all = root.querySelectorAll('[data-island-slot="mermaid"]');
              const index = Array.prototype.indexOf.call(
                all,
                descriptor.target
              );
              next.push({
                ...descriptor,
                key: `mermaid-${index}-${hash16(source)}`,
                source,
              });
            }
          }
        }
      }

      const collect = (scope: HTMLElement, includeSelf: boolean) => {
        const mathEls: HTMLElement[] = [];
        if (includeSelf && scope.matches('[data-md-island="math"]')) {
          mathEls.push(scope);
        }
        scope
          .querySelectorAll<HTMLElement>('[data-md-island="math"]')
          .forEach((element) => mathEls.push(element));
        for (const element of mathEls) {
          if (seen.has(element)) continue;
          seen.add(element);
          const source = element.getAttribute('data-tex') ?? '';
          if (!source) continue;
          // 清掉 Rust 占位 fallback 后再把节点交给 React Portal；Portal 挂载后
          // 由 React 独占该节点，任何外部 textContent 清理都会触发 removeChild 崩溃。
          element.textContent = '';
          const all = root.querySelectorAll('[data-md-island="math"]');
          const index = Array.prototype.indexOf.call(all, element);
          next.push({
            key: `math-${index}-${hash16(source)}`,
            name: 'math',
            source,
            target: element,
            displayMode: element.classList.contains('md-math-block'),
          });
        }

        const slots: HTMLElement[] = [];
        if (includeSelf && scope.matches('[data-island-slot="mermaid"]')) {
          slots.push(scope);
        }
        scope
          .querySelectorAll<HTMLElement>('[data-island-slot="mermaid"]')
          .forEach((slot) => slots.push(slot));
        for (const slot of slots) {
          if (seen.has(slot)) continue;
          seen.add(slot);
          const host = slot.closest<HTMLElement>('.md-code-block');
          const source = host
            ? Array.from(host.querySelectorAll<HTMLElement>('.md-code-line'))
                .map((line) => line.textContent ?? '')
                .join('\n')
            : '';
          if (!source) continue;
          slot.textContent = '';
          const all = root.querySelectorAll('[data-island-slot="mermaid"]');
          const index = Array.prototype.indexOf.call(all, slot);
          next.push({
            key: `mermaid-${index}-${hash16(source)}`,
            name: 'mermaid',
            source,
            target: slot,
            host: host ?? undefined,
          });
        }
      };

      for (const scope of scopes) collect(scope, scope !== root);
      if (forceFullScan) collect(root, false);

      setIslands((prev) => (sameIslands(prev, next) ? prev : next));
    },
    [isActive]
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const applied = appliedRef.current;
    const freshRoot = !applied || applied.root !== root;

    if (freshRoot || applied.html !== html) {
      let scopes: HTMLElement[];
      if (freshRoot || root.childNodes.length === 0) {
        // innerHTML 必须由命令式写入：React 若管理 dangerouslySetInnerHTML，
        // 每次 Islands 状态更新都会重写子树，冲掉 enhance() 注入的 i18n 属性。
        root.innerHTML = html;
        scopes = [root];
      } else {
        // 增量补丁：只替换变化区域，未变子树节点身份保留。
        scopes = patchSurfaceContent(root, html);
      }
      if (scopes.length > 0) enhanceScopes(scopes);
      appliedRef.current = { root, html, enhance, isActive };
      rebuildIslands(root, scopes, freshRoot);
      return;
    }

    // html 未变：语言切换只就地重跑 enhance（不重写 DOM）；
    // isActive 翻转（流式收口）只重建 Island 描述符。
    if (applied.enhance !== enhance) {
      enhance(root);
      applied.enhance = enhance;
    }
    if (applied.isActive !== isActive) {
      applied.isActive = isActive;
      rebuildIslands(root, [root], true);
    }
  }, [html, isActive, enhance, enhanceScopes, rebuildIslands, as]);

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
