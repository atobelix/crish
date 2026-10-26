/**
 * ui/Row 单行条目原子基元（P4 T-P4-01）
 *
 * 承载侧栏会话项、工具调用行、思考行、列表项等单行条目。
 * 遵循展示型容器 0 描边铁律（border: none），高度锁定 4 档标尺，
 * 交互状态统一取自 --state-* 交互叠加量。
 *
 * 分层契约：本组件只依赖 react 与 CSS 变量，严禁反向依赖任何业务模块。
 */
import React from 'react';
import styles from './Row.module.css';

export type RowHeight = 'dense' | 'list' | 'control' | 'chrome';

export interface RowProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 行高档位：dense(24px) | list(28px) | control(32px) | chrome(36px)，默认 'list' */
  height?: RowHeight;
  /** 前置槽位：图标、状态指示点、折叠指示 */
  leading?: React.ReactNode;
  /** 主标题或正文内容（自适应占据剩余宽度） */
  children?: React.ReactNode;
  /** 后置槽位：时间戳、快捷键、操作图标、Badge */
  trailing?: React.ReactNode;
  /** 是否选中态（背景注入 --state-selected，文字提升） */
  selected?: boolean;
  /** 是否可交互（开启 hover/active 响应，cursor: pointer） */
  interactive?: boolean;
  /** 点击回调（若提供，默认 interactive=true，且注入语义 role="button"） */
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
}

const HEIGHT_CLASS_MAP: Record<RowHeight, string | undefined> = {
  dense: styles.dense,
  list: styles.list,
  control: styles.control,
  chrome: styles.chrome,
};

export const Row = React.forwardRef<HTMLDivElement, RowProps>(function Row(
  {
    height = 'list',
    leading,
    children,
    trailing,
    selected = false,
    interactive,
    onClick,
    onKeyDown,
    role,
    tabIndex,
    className,
    ...restProps
  },
  ref
) {
  const isInteractive = Boolean(interactive || onClick);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (onClick && (event.key === 'Enter' || event.key === ' ')) {
      if (event.key === ' ') {
        event.preventDefault();
      }
      onClick(event as unknown as React.MouseEvent<HTMLDivElement>);
    }
  };

  const resolvedRole = role ?? (isInteractive ? 'button' : undefined);
  const resolvedTabIndex = tabIndex ?? (isInteractive ? 0 : undefined);

  const classNames = [
    styles.row,
    HEIGHT_CLASS_MAP[height],
    isInteractive && styles.interactive,
    selected && styles.selected,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={ref}
      className={classNames}
      role={resolvedRole}
      tabIndex={resolvedTabIndex}
      aria-selected={selected ? true : undefined}
      data-height={height}
      data-selected={selected ? 'true' : undefined}
      data-interactive={isInteractive ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={isInteractive ? handleKeyDown : onKeyDown}
      {...restProps}
    >
      {leading != null && <span className={styles.leading}>{leading}</span>}
      {children != null && <span className={styles.content}>{children}</span>}
      {trailing != null && <span className={styles.trailing}>{trailing}</span>}
    </div>
  );
});

Row.displayName = 'Row';
