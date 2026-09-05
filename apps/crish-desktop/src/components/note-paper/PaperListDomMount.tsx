/**
 * PaperListDomMount — 桌面 React 层挂载 `PaperList`（W3-G 窗口 DOM · 产品挂载）
 *
 * ## 角色
 * - 把 `@crish/block-paper` 的 `PaperList` 接到 note-paper React 树
 * - 输入：hydrate / 投影块（id + flavour/text/level 呈现），**非**权威树
 * - 仅窗口∪pin 进 DOM；窗外真 remove + spacer（**禁止** CSS hidden 假虚拟化）
 *
 * ## 槽契约（SD-04 · chrome ∥ content 钉死）
 * | 槽 | 锚 | 宿主 | 计入内容互斥？ |
 * |----|----|------|----------------|
 * | **chrome** | `[data-bp-chrome-mount="1"]` | `BlockChromeDomHost` | 否（chrome 皮） |
 * | **content · paper-list** | `[data-bp-paper-list-mount="1"]` | 本组件 → `PaperList` | **是** |
 * | **content · react-rows** | `[data-content-row="1"]` | Strict/Skeleton React 行 | **是** |
 *
 * - chrome 与 content **同屏兄弟**，生命周期独立；destroy 一方 **不** 删另一方
 * - 不共享 DOM 子树；不共用 `hostRef`
 * - **产品默认**：`presentationMode='paper-list'` 时 **不** 再挂全量 content-row
 *   （互斥由 `resolvePresentationMode` / StrictPanel 保证；本组件只负责列表槽）
 * - `debug-dual` 才允许 content-row + 本槽同屏（非产品默认）
 *
 * ## 诚实边界（钉死）
 * - **≠ EL-01** e2e 满关；**≠** A-PERF 数值门（仅结构 DOM 上界）
 * - **≠ W3-P WindowManager 全闭环** / 真 ProjectionDiff / awareness
 * - 假数据 / hydrate 投影列表 **≠** 权威树；写仍走 Intent
 * - 窗口/scroll 参数可测；挂载后 DOM 块数 ≤ `MAX_MOUNTED_DOM_BLOCKS`
 *
 * 测：`PaperListDomMount.test.tsx` · `presentationMode.test.ts`
 */

import React, { useEffect, useRef } from 'react';
import {
  PaperList,
  type PaperBlockProjection,
  type PaperListScrollState,
  type PaperListWindowState,
} from '@crish/block-paper';
/** W3-G PaperList 产品挂载皮（visual-align 08/09 列表间距）；≠ EL-01 */
import '@crish/block-paper/paper-list.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** 驱动 PaperList 的投影块（hydrate / silent 均可；≠ 权威） */
export type PaperListMountBlock = {
  id: string;
  flavour?: string;
  text?: string;
  /** 标题级 1–6；写入 list 行 `data-heading-level`（LR-V4） */
  level?: number;
};

function toPaperBlockProjection(
  block: PaperListMountBlock
): PaperBlockProjection {
  const proj: PaperBlockProjection = { id: block.id };
  if (block.flavour !== undefined) proj.flavour = block.flavour;
  if (block.text !== undefined) proj.text = block.text;
  if (block.level !== undefined) proj.level = block.level;
  return proj;
}

function findBlockElement(
  target: EventTarget | null,
  container: HTMLElement | null
): HTMLElement | null {
  if (!target || !(target instanceof HTMLElement) || !container) return null;
  const blockEl = target.closest<HTMLElement>(
    '.bp-paper-block, [data-bp-paper-block="1"], [data-block-id], [data-bp-paper-block-id]'
  );
  if (blockEl && container.contains(blockEl)) {
    return blockEl;
  }
  return null;
}

function getBlockId(el: HTMLElement | null): string | null {
  if (!el) return null;
  return (
    el.getAttribute('data-block-id') ??
    el.getAttribute('data-bp-paper-block-id') ??
    null
  );
}

export type PaperListDomMountProps = {
  /**
   * 投影块序列（order = 数组序）。
   * 0 块时不创建 list（仅空槽锚点，与 chrome 槽对称）。
   */
  blocks: readonly PaperListMountBlock[];
  /**
   * 索引窗口 [start, end)（未含 overscan）。
   * 与 `scroll` 二选一；都缺省时走 PaperList 默认可见块数。
   */
  window?: PaperListWindowState;
  /**
   * 滚动态（优先于 window；内部自动 HeightMap 预估）。
   * jsdom 可测：改 scrollTop → 窗外真 remove。
   */
  scroll?: PaperListScrollState;
  /** 前后 overscan 块数 */
  overscan?: number;
  focusId?: string | null;
  composingIds?: readonly string[];
  extraPinned?: readonly string[];
  /**
   * 未给 window/scroll 时的默认可见块数（结构门测友好）。
   * 默认交由 PaperList（20）。
   */
  defaultVisibleCount?: number;
  defaultEstimatePx?: number;
  /**
   * 宿主就绪 / 销毁回调（测试可拿 getMountedCount / setScroll / setWindow）。
   * 每次重建先 `null` 再新 list。
   */
  onListReady?: (list: PaperList | null) => void;
  /** 额外 className */
  className?: string;
  /** 挂载根 data-testid；默认 note-paper-paper-list */
  testId?: string;
  /** 文本变更或防抖停顿持久化回调 */
  onBlockChange?: (blockId: string, newText: string) => void;
  /** 文本提交回调（失焦或回车时派发） */
  onTextCommit?: (blockId: string, newText: string) => void;
  /** 单块实时输入事件 */
  onBlockInput?: (blockId: string, newText: string) => void;
  /** 回车插入新段落 */
  onBlockInsert?: (afterBlockId: string, initialText?: string) => void;
  onEnter?: (blockId: string, currentText: string) => void;
  /** 退格键空段落删除 */
  onBlockDelete?: (blockId: string) => void;
  onBackspace?: (blockId: string, currentText: string) => void;
  /** 防抖时长（毫秒，默认 300） */
  debounceMs?: number;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * 命令式挂载 PaperList：挂在 ref 容器内，生命周期与 React 对齐。
 *
 * 块 id 序列 / 窗口 / scroll 变化会 rebuild 或 set* 同步；
 * 呈现投影（flavour/text/level）变化走 setProjections。
 */
export const PaperListDomMount: React.FC<PaperListDomMountProps> = ({
  blocks,
  window: windowState,
  scroll,
  overscan,
  focusId,
  composingIds,
  extraPinned,
  defaultVisibleCount,
  defaultEstimatePx,
  onListReady,
  className,
  testId = 'note-paper-paper-list',
  onBlockChange,
  onTextCommit,
  onBlockInput,
  onBlockInsert,
  onEnter,
  onBlockDelete,
  onBackspace,
  debounceMs = 300,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<PaperList | null>(null);
  const onListReadyRef = useRef(onListReady);
  onListReadyRef.current = onListReady;

  // 活跃打字状态记录，避免外层 projection refresh 冲掉光标与最新文本
  const activeEditingBlockIdRef = useRef<string | null>(null);
  const activeDraftsRef = useRef<Map<string, string>>(new Map());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isComposingRef = useRef(false);

  // 回调引用保持最新，避免 effect 重复注销绑定
  const onBlockChangeRef = useRef(onBlockChange);
  onBlockChangeRef.current = onBlockChange;
  const onTextCommitRef = useRef(onTextCommit);
  onTextCommitRef.current = onTextCommit;
  const onBlockInputRef = useRef(onBlockInput);
  onBlockInputRef.current = onBlockInput;
  const onBlockInsertRef = useRef(onBlockInsert);
  onBlockInsertRef.current = onBlockInsert;
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;
  const onBlockDeleteRef = useRef(onBlockDelete);
  onBlockDeleteRef.current = onBlockDelete;
  const onBackspaceRef = useRef(onBackspace);
  onBackspaceRef.current = onBackspace;

  // 块 id 序签名：仅 id 序列变化才重建（避免每 render 新数组引用）
  const orderKey = blocks.map((b) => b.id).join('|');
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // 窗口 / 滚动态序列化（供 effect 依赖）
  const windowKey = windowState
    ? `${windowState.startIndex}:${windowState.endIndex}`
    : '';
  const scrollKey = scroll
    ? `${scroll.scrollTop}:${scroll.viewportHeight}`
    : '';
  const pinKey = [
    focusId ?? '',
    composingIds?.join(',') ?? '',
    extraPinned?.join(',') ?? '',
  ].join('|');

  // 呈现投影签名（不重建 list，只 setProjections）
  const projKey = blocks
    .map((b) => `${b.id}:${b.flavour ?? ''}:${b.text ?? ''}:${b.level ?? ''}`)
    .join('|');

  // 1) 创建 / 销毁 PaperList（order 变化 → 重建，确保 HeightMap 对齐）
  useEffect(() => {
    const parent = mountRef.current;
    if (!parent) return;

    const specs = blocksRef.current;
    if (specs.length === 0) {
      if (listRef.current) {
        listRef.current.destroy();
        listRef.current = null;
        onListReadyRef.current?.(null);
      }
      return;
    }

    const activeId = activeEditingBlockIdRef.current;
    const projections: PaperBlockProjection[] = specs.map((b) => {
      const proj = toPaperBlockProjection(b);
      if (b.id === activeId) {
        const draft = activeDraftsRef.current.get(b.id);
        if (draft !== undefined) {
          proj.text = draft;
        }
      }
      return proj;
    });

    const opts: ConstructorParameters<typeof PaperList>[1] = {
      order: specs.map((b) => b.id),
      projections,
    };
    if (windowState) opts.window = { ...windowState };
    if (scroll) opts.scroll = { ...scroll };
    if (overscan !== undefined) opts.overscan = overscan;
    if (focusId !== undefined) opts.focusId = focusId;
    if (composingIds) opts.composingIds = composingIds;
    if (extraPinned) opts.extraPinned = extraPinned;
    if (defaultVisibleCount !== undefined) {
      opts.defaultVisibleCount = defaultVisibleCount;
    }
    if (defaultEstimatePx !== undefined) {
      opts.defaultEstimatePx = defaultEstimatePx;
    }

    const list = new PaperList(parent, opts);
    listRef.current = list;
    onListReadyRef.current?.(list);

    return () => {
      list.destroy();
      if (listRef.current === list) {
        listRef.current = null;
      }
      onListReadyRef.current?.(null);
    };
    // orderKey 驱动重建；window/scroll/pin 初值随创建写入
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 后续由 sync effect 更新
  }, [orderKey]);

  // 2) 窗口 / scroll / pin / overscan 变更 → set* 而非全量重建
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (scroll) {
      list.setScroll({ ...scroll });
    } else if (windowState) {
      list.setWindow({ ...windowState });
    }

    if (overscan !== undefined) {
      list.setOverscan(overscan);
    }

    list.setPin({
      focusId: focusId ?? null,
      composingIds: composingIds ?? [],
      extraPinned: extraPinned ?? [],
    });
  }, [
    windowKey,
    scrollKey,
    pinKey,
    overscan,
    windowState,
    scroll,
    focusId,
    composingIds,
    extraPinned,
  ]);

  // 3) 呈现投影文本/flavour/level 变化
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    void projKey;
    const activeId = activeEditingBlockIdRef.current;
    const projections: PaperBlockProjection[] = blocksRef.current.map((b) => {
      const proj = toPaperBlockProjection(b);
      // 活跃输入状态保护：在当前元素打字期间，避免外层 projection refresh 覆写其 textContent 或破坏光标位置
      if (b.id === activeId) {
        const draft = activeDraftsRef.current.get(b.id);
        if (draft !== undefined) {
          proj.text = draft;
        }
      }
      return proj;
    });
    list.setProjections(projections);

    // 针对正在打字的活跃块，确保 DOM 中的 textContent 不被意外冲刷
    if (activeId && mountRef.current) {
      const draft = activeDraftsRef.current.get(activeId);
      if (draft !== undefined) {
        const el = mountRef.current.querySelector<HTMLElement>(
          `[data-block-id="${activeId}"], [data-bp-paper-block-id="${activeId}"]`
        );
        if (el && el.textContent !== draft) {
          el.textContent = draft;
        }
      }
    }
  }, [projKey]);

  // 4) 挂载直接打字与编辑交互的 DOM 事件监听
  useEffect(() => {
    const parent = mountRef.current;
    if (!parent) return;

    let lastBlurBlockId: string | null = null;
    let lastBlurTime = 0;

    const handleBeforeInput = (e: Event) => {
      const blockEl = findBlockElement(e.target, parent);
      const blockId = getBlockId(blockEl);
      if (!blockId || !blockEl) return;
      activeEditingBlockIdRef.current = blockId;
    };

    const handleInput = (e: Event) => {
      const blockEl = findBlockElement(e.target, parent);
      const blockId = getBlockId(blockEl);
      if (!blockId || !blockEl) return;

      activeEditingBlockIdRef.current = blockId;
      const newText = blockEl.textContent ?? '';
      activeDraftsRef.current.set(blockId, newText);

      if (isComposingRef.current) {
        return;
      }

      onBlockInputRef.current?.(blockId, newText);

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        onBlockChangeRef.current?.(blockId, newText);
      }, debounceMs);
    };

    const handleCompositionStart = (e: CompositionEvent) => {
      isComposingRef.current = true;
      const blockEl = findBlockElement(e.target, parent);
      const blockId = getBlockId(blockEl);
      if (blockId) {
        activeEditingBlockIdRef.current = blockId;
      }
    };

    const handleCompositionEnd = (e: CompositionEvent) => {
      isComposingRef.current = false;
      const blockEl = findBlockElement(e.target, parent);
      const blockId = getBlockId(blockEl);
      if (!blockId || !blockEl) return;

      const newText = blockEl.textContent ?? '';
      activeDraftsRef.current.set(blockId, newText);
      onBlockInputRef.current?.(blockId, newText);

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        onBlockChangeRef.current?.(blockId, newText);
      }, debounceMs);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const blockEl = findBlockElement(e.target, parent);
      const blockId = getBlockId(blockEl);
      if (!blockId || !blockEl) return;

      if (e.key === 'Enter') {
        if (isComposingRef.current) return;
        e.preventDefault();
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        const currentText = blockEl.textContent ?? '';
        onTextCommitRef.current?.(blockId, currentText);
        onBlockChangeRef.current?.(blockId, currentText);
        onEnterRef.current?.(blockId, currentText);
        onBlockInsertRef.current?.(blockId, '');
        return;
      }

      if (e.key === 'Backspace') {
        if (isComposingRef.current) return;
        const currentText = blockEl.textContent ?? '';
        if (currentText === '') {
          e.preventDefault();
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
          }
          // 段落为空时：自动前移焦点至前一可编辑块
          const prevEl = blockEl.previousElementSibling as HTMLElement | null;
          if (prevEl && prevEl.getAttribute('contenteditable')) {
            prevEl.focus();
            try {
              const sel = window.getSelection?.();
              if (sel) {
                const range = document.createRange();
                range.selectNodeContents(prevEl);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
              }
            } catch {
              // ignore
            }
          }
          onBackspaceRef.current?.(blockId, currentText);
          onBlockDeleteRef.current?.(blockId);
          return;
        }
      }
    };

    const handleBlur = (e: FocusEvent) => {
      const blockEl = findBlockElement(e.target, parent);
      const blockId = getBlockId(blockEl);
      if (!blockId || !blockEl) return;

      const now = Date.now();
      if (lastBlurBlockId === blockId && now - lastBlurTime < 50) {
        return;
      }
      lastBlurBlockId = blockId;
      lastBlurTime = now;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      const currentText = blockEl.textContent ?? '';
      onBlockChangeRef.current?.(blockId, currentText);
      onTextCommitRef.current?.(blockId, currentText);

      if (activeEditingBlockIdRef.current === blockId) {
        activeEditingBlockIdRef.current = null;
        activeDraftsRef.current.delete(blockId);
      }
    };

    const handleFocus = (e: FocusEvent) => {
      const blockEl = findBlockElement(e.target, parent);
      const blockId = getBlockId(blockEl);
      if (blockId) {
        activeEditingBlockIdRef.current = blockId;
      }
    };

    parent.addEventListener('beforeinput', handleBeforeInput);
    parent.addEventListener('input', handleInput);
    parent.addEventListener('compositionstart', handleCompositionStart);
    parent.addEventListener('compositionend', handleCompositionEnd);
    parent.addEventListener('keydown', handleKeyDown);
    parent.addEventListener('blur', handleBlur, true);
    parent.addEventListener('focusout', handleBlur);
    parent.addEventListener('focus', handleFocus, true);
    parent.addEventListener('focusin', handleFocus);

    return () => {
      parent.removeEventListener('beforeinput', handleBeforeInput);
      parent.removeEventListener('input', handleInput);
      parent.removeEventListener('compositionstart', handleCompositionStart);
      parent.removeEventListener('compositionend', handleCompositionEnd);
      parent.removeEventListener('keydown', handleKeyDown);
      parent.removeEventListener('blur', handleBlur, true);
      parent.removeEventListener('focusout', handleBlur);
      parent.removeEventListener('focus', handleFocus, true);
      parent.removeEventListener('focusin', handleFocus);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [debounceMs]);

  const rootClass = ['np-paper-list-mount', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={mountRef}
      className={rootClass}
      data-testid={testId}
      data-bp-paper-list-mount="1"
      data-paper-list-block-count={String(blocks.length)}
      data-paper-list-window={windowKey || undefined}
      data-paper-list-scroll={scrollKey || undefined}
      // 诚实：≠ EL-01；≠ W3-P WindowManager 全闭环
      data-paper-list-track="w3-g"
      data-paper-list-el="open"
      aria-hidden={blocks.length === 0 ? true : undefined}
    />
  );
};

export default PaperListDomMount;
