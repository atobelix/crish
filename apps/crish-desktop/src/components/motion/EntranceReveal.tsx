/**
 * EntranceReveal：统一入场通道的组件形态（见 useEntranceReveal 文件头
 * 的通道约定）。供「根元素可由通道托管」的离散表面直接包裹使用：
 * 状态行、通知行、卡片、段容器等。需要把入场语义挂到既有根元素上
 * （不许多出一层 DOM）的表面用 useEntranceReveal 钩子形态，自行把
 * entering 类（.crish-entrance-fade）、--reveal-delay、data-entering、
 * onAnimationEnd 与 rootRef 挂到根元素——两种形态共用同一判定与呈现，
 * 禁止第三种写法。
 */
import React from 'react';
import {
  useEntranceReveal,
  type EntranceVariant,
} from './useEntranceReveal';

export interface EntranceRevealProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 呈现键（约定见 useEntranceReveal 文件头） */
  entranceKey: string;
  /** 到达事件时间戳（ms）；liveOnMount 面可缺省 */
  eventTs?: number | undefined;
  /** 入场变体：fade（默认）| grow */
  variant?: EntranceVariant | undefined;
  /** 仅运行时状态面可用：无事件戳时以挂载时刻为事件时刻 */
  liveOnMount?: boolean | undefined;
  /** 原地替换契约命中：禁入场 */
  replaceHit?: boolean | undefined;
  /** 门控未就绪时不判定 */
  disabled?: boolean | undefined;
  children?: React.ReactNode;
}

export const EntranceReveal: React.FC<EntranceRevealProps> = ({
  entranceKey,
  eventTs,
  variant = 'fade',
  liveOnMount,
  replaceHit,
  disabled,
  className = '',
  style,
  children,
  ...rest
}) => {
  const { entering, delayMs, handleAnimationEnd, rootRef } =
    useEntranceReveal({
      key: entranceKey,
      eventTs,
      variant,
      liveOnMount,
      replaceHit,
      disabled,
    });

  return (
    <div
      {...rest}
      ref={rootRef}
      className={`${className}${entering ? ' crish-entrance-fade' : ''}`}
      style={
        entering
          ? ({
              ...style,
              '--reveal-delay': `${delayMs}ms`,
            } as React.CSSProperties)
          : style
      }
      data-entering={entering ? 'true' : undefined}
      onAnimationEnd={handleAnimationEnd}
    >
      {children}
    </div>
  );
};

EntranceReveal.displayName = 'EntranceReveal';
