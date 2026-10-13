/**
 * NativeContentVisibility — 全系统确定性物理原语 2：原生 content-visibility 视口跳过配置生成器
 *
 * 物理不变量：
 * 1. 依托 Blink C++ 标准 content-visibility: auto/hidden 与 contain-intrinsic-size，视口外子树 Layout/Paint 开销归零；
 * 2. 元素保留在 DOM 树中，表单状态、焦点选区与浏览器原生查找 100% 无损保留；
 * 3. 提供 React CSSProperties 配置生成器与原生 DOM 样式直写辅助器。
 */
import type { CSSProperties } from 'react';

export type ContentVisibilityMode = 'auto' | 'hidden' | 'visible';

export interface ContentVisibilityOptions {
  /** 渲染跳过模式，默认 'auto' */
  mode?: ContentVisibilityMode;
  /** 预估固有高度（数字默认转 px，如 36 -> 'auto 36px'），默认 36 */
  intrinsicHeight?: number | string;
  /** 预估固有宽度（数字默认转 px），默认 'auto' */
  intrinsicWidth?: number | string;
  /** CSS contain 隔离策略，默认 'layout style paint' */
  contain?: string;
  /** 是否开启独立层叠上下文 isolation: isolate，默认 false */
  isolation?: boolean;
}

export const CONTENT_VISIBILITY_CLASSES = {
  autoSlot: 'cv-auto-slot',
  hiddenSlot: 'cv-hidden-slot',
  floatingIsolation: 'cv-floating-isolation',
} as const;

function formatDimension(
  dim: number | string | undefined,
  fallback: string
): string {
  if (dim === undefined || dim === null || dim === '') return fallback;
  if (typeof dim === 'number') return `${dim}px`;
  return dim;
}

export function formatContainIntrinsicSize(
  intrinsicHeight?: number | string,
  intrinsicWidth?: number | string
): string {
  const heightToken = formatDimension(intrinsicHeight, '36px');
  if (intrinsicWidth === undefined || intrinsicWidth === 'auto') {
    return heightToken.startsWith('auto ')
      ? heightToken
      : `auto ${heightToken}`;
  }
  const widthToken = formatDimension(intrinsicWidth, 'auto');
  return `auto ${widthToken} auto ${heightToken}`;
}

/**
 * 生成通用原生 content-visibility 样式配置对象
 */
export function createContentVisibilityStyle(
  options: ContentVisibilityOptions = {}
): CSSProperties {
  const mode = options.mode ?? 'auto';
  const contain = options.contain ?? 'layout style paint';

  if (mode === 'visible') {
    return options.isolation
      ? { contentVisibility: 'visible', isolation: 'isolate' }
      : { contentVisibility: 'visible' };
  }

  const defaultHeight = mode === 'hidden' ? '100%' : 36;
  const containIntrinsicSize = formatContainIntrinsicSize(
    options.intrinsicHeight ?? defaultHeight,
    options.intrinsicWidth
  );

  const style: CSSProperties = {
    contentVisibility: mode,
    containIntrinsicSize,
    contain,
  };

  if (options.isolation) {
    style.isolation = 'isolate';
  }

  return style;
}

/**
 * 生成动态自动跳过排版配置（用于长下拉列表、会话消息分桶、复杂浮层容器）
 */
export function createAutoSlotStyle(
  intrinsicHeight: number | string = 36,
  intrinsicWidth?: number | string
): CSSProperties {
  return createContentVisibilityStyle({
    mode: 'auto',
    intrinsicHeight,
    intrinsicWidth,
    contain: 'layout style paint',
  });
}

/**
 * 生成强制隐藏跳过排版配置（用于分屏非激活窗格、折叠面板与后台标签页）
 */
export function createHiddenSlotStyle(
  intrinsicHeight: number | string = '100%'
): CSSProperties {
  return createContentVisibilityStyle({
    mode: 'hidden',
    intrinsicHeight,
    contain: 'layout style paint',
  });
}

/**
 * 生成浮层与隔离宿主边界样式（阻断浮层内部动画与样式向全局扩散）
 */
export function createFloatingIsolationStyle(): CSSProperties {
  return {
    contain: 'layout style paint',
    isolation: 'isolate',
  };
}

/**
 * 直接向原生 DOM 元素写入 content-visibility 跳过策略
 */
export function applyContentVisibility(
  el: HTMLElement | null | undefined,
  options: ContentVisibilityOptions = {}
): void {
  if (!el) return;
  const styleObj = createContentVisibilityStyle(options);
  if (styleObj.contentVisibility) {
    el.style.setProperty(
      'content-visibility',
      String(styleObj.contentVisibility)
    );
  }
  if (styleObj.containIntrinsicSize) {
    el.style.setProperty(
      'contain-intrinsic-size',
      String(styleObj.containIntrinsicSize)
    );
  } else {
    el.style.removeProperty('contain-intrinsic-size');
  }
  if (styleObj.contain) {
    el.style.setProperty('contain', String(styleObj.contain));
  } else {
    el.style.removeProperty('contain');
  }
  if (styleObj.isolation) {
    el.style.setProperty('isolation', String(styleObj.isolation));
  }
}

export const NativeContentVisibility = {
  classes: CONTENT_VISIBILITY_CLASSES,
  formatContainIntrinsicSize,
  createStyle: createContentVisibilityStyle,
  createAutoSlotStyle,
  createHiddenSlotStyle,
  createFloatingIsolationStyle,
  applyToElement: applyContentVisibility,
} as const;
