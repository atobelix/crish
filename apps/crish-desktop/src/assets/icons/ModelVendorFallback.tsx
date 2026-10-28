import React from 'react';
import { Tooltip } from '@/components/ui';

export interface ModelVendorFallbackProps {
  /** 显示尺寸（像素），默认 24 */
  size?: number;
  /** 圆角大小（像素），默认保持与方形比例一致 */
  radius?: number;
  /** 悬停提示文字，默认为 '本地 / 自定义模型' */
  title?: string;
  /** 附加 className */
  className?: string;
  /** 自定义内联样式 */
  style?: React.CSSProperties;
}

/**
 * ModelVendorFallback — 统一全局唯一的模型兜底空图标
 *
 * 核心设计原则（用户明确裁决）：
 * 1. 桌面软件官方 App 图标作为唯一兜底：针对所有未知、私有或未收录厂商，直接呈现桌面自身的原彩 App 图标；
 * 2. 视觉一体感：深黑圆角渐变底板 + 翡翠绿核心点 + 白星芒，无论在 16px 还是 32px 下都极致精细锐利；
 * 3. 纯静态零网络：直接内联原生 SVG 矢量，零额外网络请求，零加载时闪烁。
 */
export const ModelVendorFallback: React.FC<ModelVendorFallbackProps> = ({
  size = 24,
  radius,
  title = '本地 / 自定义模型',
  className = '',
  style = {},
}) => {
  // 若未显式传入 radius，则按 app-icon 原生 50/200 = 25% 比例自适应计算
  const computedRadius =
    radius !== undefined ? radius : Math.round(size * 0.25);

  const element = (
    <div
      className={`model-vendor-fallback ${className}`.trim()}
      style={{
        width: size,
        height: size,
        borderRadius: computedRadius,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        overflow: 'hidden',
        userSelect: 'none',
        boxSizing: 'border-box',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
        ...style,
      }}
      role="img"
      aria-label={title}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 200 200"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ display: 'block', width: '100%', height: '100%' }}
      >
        <defs>
          <linearGradient
            id="crish-fallback-grad"
            x1="0%"
            y1="0%"
            x2="0%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#131316" />
            <stop offset="100%" stopColor="#08080a" />
          </linearGradient>
        </defs>
        {/* 圆角背景底板 */}
        <rect
          width="200"
          height="200"
          rx="50"
          fill="url(#crish-fallback-grad)"
        />
        {/* 翡翠绿微点 */}
        <ellipse cx="100" cy="35" rx="16" ry="16" fill="#10B981" />
        {/* 白线条星芒核心（strokeWidth 26 为 200×200 画布的几何构造参数，非图标描边，不走 ICON_STROKE） */}
        <g
          fill="none"
          stroke="#F4F4F5"
          strokeWidth="26"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M 100 118 L 28 118" />
          <path d="M 100 118 L 172 118" />
          <path d="M 100 118 L 58 42" />
          <path d="M 100 118 L 142 42" />
          <path d="M 100 118 L 80 170" />
          <path d="M 100 118 L 120 170" />
        </g>
      </svg>
    </div>
  );

  if (!title) {
    return element;
  }

  return <Tooltip content={title}>{element}</Tooltip>;
};
