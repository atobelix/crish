/**
 * 左右侧栏切换：圆角窗体 + 竖分栏，比通用 PanelLeft/Right 更软、更统一。
 */

type IconProps = {
  size?: number;
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
};

const svgProps = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  className,
  'aria-hidden': true as const,
});

/** 左栏：圆角框 + 左侧分栏 */
export function IconSidebarLeft({ size = 15, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect
        x="1.75"
        y="2.25"
        width="12.5"
        height="11.5"
        rx="3.25"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M6.25 2.5v11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 右栏：圆角框 + 右侧分栏 */
export function IconSidebarRight({ size = 15, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect
        x="1.75"
        y="2.25"
        width="12.5"
        height="11.5"
        rx="3.25"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M9.75 2.5v11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
