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
import { isLiveEventTimestamp, isRevealDegraded } from './toolRevealState';

export interface ToolNumericTextProps {
  text: string;
  /** 到达事件时间戳（工具行 = completedAt ?? startedAt） */
  eventTs?: number | undefined;
  /** 显式控制是否允许入场滚入（缺省为 false，克制动效） */
  animateOnView?: boolean;
  className?: string;
}

export const ToolNumericText: React.FC<ToolNumericTextProps> = ({
  text,
  eventTs,
  animateOnView = false,
  className,
}) => {
  // 严谨门控：必须同时满足（显式开启 + 未降级 + 时间戳落在实况窗口内）才允许从 0 滚入
  const shouldAnimate =
    animateOnView &&
    !isRevealDegraded() &&
    (eventTs !== undefined ? isLiveEventTimestamp(eventTs, Date.now()) : false);

  return (
    <NumericText
      text={text}
      animateOnView={shouldAnimate}
      className={className}
    />
  );
};

export default ToolNumericText;
