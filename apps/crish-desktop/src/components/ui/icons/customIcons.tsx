/**
 * 品牌 / 回退观感图标（AppIcon custom 轨）。
 * 统一 currentColor + round cap/join；默认描边由 AppIcon iconTokens 注入。
 */

import * as React from 'react';

export type CustomIconProps = {
  size?: number | string;
  className?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
  'aria-hidden'?: boolean | 'true' | 'false';
};

function baseProps(
  size: number | string,
  className?: string,
  style?: React.CSSProperties,
  viewBox = '0 0 24 24',
) {
  return {
    width: size,
    height: size,
    viewBox,
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    style: {
      display: 'inline-block',
      verticalAlign: 'middle',
      flexShrink: 0,
      ...style,
    },
    'aria-hidden': true as const,
  };
}

/* ─── 侧栏开关：24 网格「圆角大矩形 + 竖分栏」，与 Hugeicons 同描边视觉 ─── */

export function IconSidebarLeft({
  size = 16,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style, '0 0 24 24')}>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="4"
        strokeWidth={strokeWidth}
      />
      <path d="M9.5 4.5v15" strokeWidth={strokeWidth} />
    </svg>
  );
}

export function IconSidebarRight({
  size = 16,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style, '0 0 24 24')}>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="4"
        strokeWidth={strokeWidth}
      />
      <path d="M14.5 4.5v15" strokeWidth={strokeWidth} />
    </svg>
  );
}

/** 展开折叠：居中细折线（比通用 chevron 更干净） */
export function IconChevronDown({
  size = 16,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M7 10l5 5 5-5" strokeWidth={strokeWidth} />
    </svg>
  );
}

export function IconChevronUp({
  size = 16,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M7 14l5-5 5 5" strokeWidth={strokeWidth} />
    </svg>
  );
}

export function IconChevronRight({
  size = 16,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M10 7l5 5-5 5" strokeWidth={strokeWidth} />
    </svg>
  );
}

export function IconChevronLeft({
  size = 16,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M14 7l-5 5 5 5" strokeWidth={strokeWidth} />
    </svg>
  );
}

/* ─── 历史 Lucide 观感（24 网格），经 custom 保持单轨 ─── */

/** 浏览器 / 万维网 */
export function IconGlobe({
  size = 24,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="12" cy="12" r="10" strokeWidth={strokeWidth} />
      <path
        d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"
        strokeWidth={strokeWidth}
      />
      <path d="M2 12h20" strokeWidth={strokeWidth} />
    </svg>
  );
}

/** 面板最大化（对角向外，历史 Maximize2） */
export function IconMaximize2({
  size = 24,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M15 3h6v6" strokeWidth={strokeWidth} />
      <path d="M9 21H3v-6" strokeWidth={strokeWidth} />
      <path d="M21 3l-7 7" strokeWidth={strokeWidth} />
      <path d="M3 21l7-7" strokeWidth={strokeWidth} />
    </svg>
  );
}

/** 面板最小化（对角向内，历史 Minimize2） */
export function IconMinimize2({
  size = 24,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M4 14h6v6" strokeWidth={strokeWidth} />
      <path d="M20 10h-6V4" strokeWidth={strokeWidth} />
      <path d="M14 10l7-7" strokeWidth={strokeWidth} />
      <path d="M3 21l7-7" strokeWidth={strokeWidth} />
    </svg>
  );
}

export function IconGitBranch({
  size = 24,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path d="M6 3v12" strokeWidth={strokeWidth} />
      <circle cx="18" cy="6" r="3" strokeWidth={strokeWidth} />
      <circle cx="6" cy="18" r="3" strokeWidth={strokeWidth} />
      <path d="M18 9a9 9 0 0 1-9 9" strokeWidth={strokeWidth} />
    </svg>
  );
}

export function IconGitCommit({
  size = 24,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="12" cy="12" r="3" strokeWidth={strokeWidth} />
      <path d="M3 12h6" strokeWidth={strokeWidth} />
      <path d="M15 12h6" strokeWidth={strokeWidth} />
    </svg>
  );
}

export function IconGitFork({
  size = 24,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <circle cx="12" cy="18" r="3" strokeWidth={strokeWidth} />
      <circle cx="6" cy="6" r="3" strokeWidth={strokeWidth} />
      <circle cx="18" cy="6" r="3" strokeWidth={strokeWidth} />
      <path
        d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"
        strokeWidth={strokeWidth}
      />
      <path d="M12 12v3" strokeWidth={strokeWidth} />
    </svg>
  );
}

export function IconFolder({
  size = 24,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path
        d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
        strokeWidth={strokeWidth}
      />
    </svg>
  );
}

export function IconFolderOpen({
  size = 24,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style)}>
      <path
        d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"
        strokeWidth={strokeWidth}
      />
    </svg>
  );
}

/** 新建对话：历史软圆角开口方 + 钢笔（右上留缺口） */
export function IconNewChatPen({
  size = 16,
  className,
  strokeWidth = 1.75,
  style,
}: CustomIconProps) {
  return (
    <svg {...baseProps(size, className, style, '0 0 24 24')}>
      <path
        d="M11 3H7.5A4.5 4.5 0 0 0 3 7.5v9A4.5 4.5 0 0 0 7.5 21h9a4.5 4.5 0 0 0 4.5-4.5v-6"
        strokeWidth={strokeWidth}
      />
      <path
        d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
        strokeWidth={strokeWidth}
      />
    </svg>
  );
}
