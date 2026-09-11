/**
 * assets/icons/uiIcons.tsx — 基础界面精致细线矢量图标与文件格式资产
 * 汇集 Zero-Blue 极简设计、纤细折叠指示符及 160+ 高频彩色文件图标渲染器。
 */

import React from 'react';
import { getFileIconSvg } from './fileIcons';
import { ICON_STROKE } from '../../components/ui/icons/iconTokens';

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  className?: string;
}

/**
 * 精致细线折叠展开指示符 (16x16 微型画布，stroke-width 1.25，优雅轻盈)
 */
export const ChevronDownIcon: React.FC<IconProps> = ({
  size = 14,
  className,
  style,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={ICON_STROKE.fine}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
    aria-hidden="true"
    {...props}
  >
    <path d="M4.5 6.5L8 10L11.5 6.5" />
  </svg>
);

/**
 * 精致向右展开指示符 (细线 1.25)
 */
export const ChevronRightIcon: React.FC<IconProps> = ({
  size = 14,
  className,
  style,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={ICON_STROKE.fine}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
    aria-hidden="true"
    {...props}
  >
    <path d="M6.5 4.5L10 8L6.5 11.5" />
  </svg>
);

/**
 * Git 经典彩色分支节点图标 (来自官方资产库 git.svg)
 */
export const GitIcon: React.FC<IconProps> = ({
  size = 15,
  className,
  style,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    className={className}
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
    aria-hidden="true"
    {...props}
  >
    <path
      fill="#e64a19"
      d="M13.172 2.828 11.78 4.22l1.91 1.91 2 2A2.986 2.986 0 0 1 20 10.81a3.25 3.25 0 0 1-.31 1.31l2.06 2a2.68 2.68 0 0 1 3.37.57 2.86 2.86 0 0 1 .88 2.117 3.02 3.02 0 0 1-.856 2.109A2.9 2.9 0 0 1 23 19.81a2.93 2.93 0 0 1-2.13-.87 2.694 2.694 0 0 1-.56-3.38l-2-2.06a3 3 0 0 1-.31.12V20a3 3 0 0 1 1.44 1.09 2.92 2.92 0 0 1 .56 1.72 2.88 2.88 0 0 1-.878 2.128 2.98 2.98 0 0 1-2.048.871 2.981 2.981 0 0 1-2.514-4.719A3 3 0 0 1 16 20v-6.38a2.96 2.96 0 0 1-1.44-1.09 2.9 2.9 0 0 1-.56-1.72 2.9 2.9 0 0 1 .31-1.31l-3.9-3.9-7.579 7.572a4 4 0 0 0-.001 5.658l10.342 10.342a4 4 0 0 0 5.656 0l10.344-10.344a4 4 0 0 0 0-5.656L18.828 2.828a4 4 0 0 0-5.656 0"
    />
  </svg>
);

/**
 * 默认通用文件图标
 */
export const DefaultFileIcon: React.FC<IconProps> = ({
  size = 14,
  className,
  style,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={ICON_STROKE.fine}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
    aria-hidden="true"
    {...props}
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

export interface FileFormatIconProps {
  fileName: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 160+ 高频彩色文件格式图标组件
 * 自动识别文件名扩展名，渲染 icon-showcase.html 中对应的高保真 SVG
 */
export const FileFormatIcon: React.FC<FileFormatIconProps> = ({
  fileName,
  size = 14,
  className,
  style,
}) => {
  const svg = getFileIconSvg(fileName);
  if (svg) {
    return (
      <span
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          flexShrink: 0,
          ...style,
        }}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: svg }}
        aria-hidden="true"
      />
    );
  }
  return <DefaultFileIcon size={size} className={className} style={style} />;
};
