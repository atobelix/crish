import React from 'react';
import { UsageSection } from './UsageSection';

export interface OverviewStatsProps {
  open: boolean;
  /** 引擎费用三态展示串 */
  estimated: string;
  inputTokens: number;
  outputTokens: number;
  onToggle: () => void;
}

/**
 * 统计卡片与 Usage 渲染组件
 */
export const OverviewStats: React.FC<OverviewStatsProps> = React.memo(
  function OverviewStats({
    open,
    estimated,
    inputTokens,
    outputTokens,
    onToggle,
  }) {
    return (
      <UsageSection
        open={open}
        estimated={estimated}
        inputTokens={inputTokens}
        outputTokens={outputTokens}
        onToggle={onToggle}
      />
    );
  }
);
