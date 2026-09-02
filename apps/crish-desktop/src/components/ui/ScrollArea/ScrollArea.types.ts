import React from 'react';

/**
 * 四级宽度 Token 契约类型
 * 遵循统一滚动条 Token 规范 (四级宽度系统)
 */
export type ScrollAreaSize = 'xs' | 'sm' | 'md' | 'lg';

/** 滚动方向契约 */
export type ScrollAreaOrientation = 'vertical' | 'horizontal' | 'both';

/** 滚动条防抖与占位策略 */
export type ScrollAreaGutter = 'auto' | 'stable';

/** 滚动条显隐机制 */
export type ScrollAreaType = 'auto' | 'always' | 'hover' | 'scroll';

/** 视口实时几何指标快照 */
export interface ScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  isAtTop: boolean;
  isAtBottom: boolean;
  isAtLeft: boolean;
  isAtRight: boolean;
  progressY: number; // 0.0 ~ 1.0
  progressX: number; // 0.0 ~ 1.0
}

/** 命令式控制器 Handle 契约 */
export interface ScrollAreaHandle {
  /** 滚动至最顶部 */
  scrollToTop: (behavior?: ScrollBehavior) => void;
  /** 滚动至最底部 */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** 通用坐标滚动 */
  scrollTo: (options: ScrollToOptions) => void;
  /** 相对偏移滚动 */
  scrollBy: (options: ScrollToOptions) => void;
  /** 触发与步进按钮完全同构的单步微调 */
  scrollStep: (direction: 'up' | 'down' | 'left' | 'right', behavior?: ScrollBehavior) => void;
  /** 获取内部承载滚动的原生 Viewport 元素引用 */
  getViewport: () => HTMLDivElement | null;
  /** 获取当前瞬时几何指标快照 */
  getMetrics: () => ScrollMetrics;
}

/**
 * ScrollArea UI 原子组件 Props 契约
 * 纯第一层原子层契约，零 store/hooks 依赖
 */
export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * 尺寸分级（严格从 Token 体系选取，严禁裸写 px）
   * - 'xs': 超细纤薄型（默认无按钮，允许显式开启）
   * - 'sm': 紧凑型
   * - 'md': 标准默认基准型 (SSOT)
   * - 'lg': 宽屏大视口型
   * @default 'md'
   */
  size?: ScrollAreaSize;

  /**
   * 是否在轨道两端渲染端点安全护栏（带微圆角等腰三角箭头）
   * 规则：showButtons ?? (size !== 'xs') (M04 闭环)
   * - 未显式指定时：xs 默认关闭按钮，sm/md/lg 默认开启按钮；
   * - 显式指定 boolean 时：严格遵循传入值，允许 size='xs' 显式开启按钮。
   * @default size !== 'xs'
   */
  showButtons?: boolean;

  /**
   * 容器外层圆角半径 (px)，用于驱动 calculateSafeAreaInset 动态避让 (M02 闭环)
   * 彻底消除 8px/12px/14px 弹窗圆角截断顶部与底部安全箭头
   * @default 0
   */
  radius?: number;

  /**
   * 滚动条侧柱距离容器外边缘间距 (px)
   * 严格保留 2px 物理透明防误触间隙
   * @default 2
   */
  trackMargin?: number;

  /**
   * 滚动方向契约
   * @default 'vertical'
   */
  orientation?: ScrollAreaOrientation;

  /**
   * 滚动条占位避免布局位移策略
   * @default 'auto'
   */
  scrollbarGutter?: ScrollAreaGutter;

  /**
   * 滚动条显隐机制
   * - 'hover': 悬浮时显现，静止时隐匿（默认推荐）
   * - 'always': 始终常驻显示
   * - 'scroll': 滚动中显现，静止 150ms 后渐隐
   * - 'auto': 依据内容是否溢出自动决定
   * @default 'hover'
   */
  type?: ScrollAreaType;

  /**
   * 单步步进距离 (px)
   * - number: 固定像素
   * - 'auto': 黄金视口比例自适应算法（默认 40px，在极小视口自适应）
   * @default 'auto'
   */
  stepSize?: number | 'auto';

  /**
   * 多态根容器 HTML 标签
   * @default 'div'
   */
  as?: React.ElementType;

  /** 视口容器类名与样式覆盖 */
  viewportClassName?: string;
  viewportStyle?: React.CSSProperties;

  /** 内容包裹层类名与样式覆盖 */
  contentClassName?: string;
  contentStyle?: React.CSSProperties;

  /** 原生 Viewport DOM Ref 转发引用 */
  viewportRef?: React.Ref<HTMLDivElement>;

  /** 滚动监听回调 */
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;

  /** 滚动停止（静止）防抖 150ms 触发回调 */
  onScrollIdle?: () => void;

  /** 可访问性无障碍区域标签描述 */
  ariaLabel?: string;

  /** 子节点 */
  children?: React.ReactNode;
}
