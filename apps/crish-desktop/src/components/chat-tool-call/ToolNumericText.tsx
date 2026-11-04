/**
 * ToolNumericText：工具行内的数字滚动（实况到达才从 0 滚入）。
 *
 * 门控与入场同口径（toolRevealState）：事件时间戳落在实况窗内才算
 * 「刚发生」→ 首次挂载从 0 滚到目标值；历史会话 / 滚动回屏的重挂载
 * 一律直出终值，不对旧内容重播。值在挂载后发生变化（活时长、聚合
 * 计数）则无论实况与否都原地滚动。系统减动效由 AnimatedCounter 内部兜底。
 */
import React from 'react';
import { NumericText } from '@/components/ui';
import { isRevealDegraded } from './toolRevealState';

export interface ToolNumericTextProps {
  text: string;
  /** 到达事件时间戳（工具行 = completedAt ?? startedAt） */
  eventTs?: number | undefined;
  /** 显式控制是否滚入（缺省为 true 随入场滚入） */
  animateOnView?: boolean;
  className?: string;
}

export const ToolNumericText: React.FC<ToolNumericTextProps> = ({
  text,
  eventTs: _eventTs,
  animateOnView = true,
  className,
}) => {
  return (
    <NumericText
      text={text}
      animateOnView={animateOnView && !isRevealDegraded()}
      className={className}
    />
  );
};
