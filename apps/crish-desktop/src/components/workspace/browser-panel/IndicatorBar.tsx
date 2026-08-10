/**
 * 指示条 / 接管层（P1-B2：12 文档 §5 + T-12/U-9 语义）。
 *
 * 呈现 12 §5.1 四态投影：idle / ai-busy（「AI 正在操作」）/ paused（「已暂停」）/
 * user-taking-over（「已接管，AI 在途已吊销」）。
 *
 * ## 职责边界（T-12/U-9③）
 * 本组件仅做 UI 呈现：状态由 usePanelStatus 驱动；暂停按钮仅推进前端状态机
 * （展示层）。引擎侧吊销链唯一入口为维度 15 的 Coordinator；接管信号 =
 * 用户输入（browser_input invoke 即天然信号，Rust 侧 InputPipeline 已 bump
 * 版本）——本层不直接 invoke 任何吊销/接管命令。
 *
 * ## 暂停/恢复按钮接线点（12 §5.2/§9）
 * 引擎侧暂停命令（browser_pause/browser_resume，12 §9 panel/commands.rs）
 * **未注册**：当前点击仅切换前端展示层状态机；引擎接线后应在
 * [IndicatorBarProps.onTogglePause] 内追加对应 invoke（AI 队列消费端订阅
 * pause watch，12 §5.2 暂停 = 挂起队列）。
 */
import React from 'react';
import styles from '../BrowserPanel.module.css';
import type { PanelStatus } from './browserPanelTypes';

export interface IndicatorBarProps {
  /** 协作状态（12 §5.1：idle/ai-busy/paused/user-taking-over）。 */
  status: PanelStatus;
  /** AI 动作文本（引擎事件携带时透出；未接线恒 null）。 */
  aiActionText: string | null;
  /** 暂停/恢复切换（paused 时语义 = 恢复；接线点见模块头）。 */
  onTogglePause: () => void;
}

/** 状态文案（12 §5.1 表；user-taking-over 展示「接管 + 吊销」语义）。 */
function indicatorStatusText(status: PanelStatus): string {
  switch (status) {
    case 'idle':
      return 'AI 空闲';
    case 'ai-busy':
      return 'AI 正在操作…';
    case 'paused':
      return '已暂停（AI 队列挂起）';
    case 'user-taking-over':
      return '已接管（AI 在途已吊销）';
  }
}

/** 暂停按钮可见性：仅在 AI 在途/挂起/接管态（idle 无动作可暂停）。 */
function showToggle(status: PanelStatus): boolean {
  return status === 'ai-busy' || status === 'paused' || status === 'user-taking-over';
}

export const IndicatorBar: React.FC<IndicatorBarProps> = ({
  status,
  aiActionText,
  onTogglePause,
}) => {
  const text = indicatorStatusText(status);
  const actionText = aiActionText ? `（${aiActionText}）` : '';
  return (
    <div
      className={styles.indicatorBar}
      data-status={status}
      role="status"
      aria-label="AI 协作状态"
    >
      <span className={styles.indicatorDot} aria-hidden />
      <span className={styles.indicatorText}>
        {text}
        {actionText}
      </span>
      {showToggle(status) ? (
        <button
          type="button"
          className={styles.indicatorToggle}
          onClick={onTogglePause}
          aria-label={status === 'paused' ? '恢复 AI 队列' : '暂停 AI 队列'}
        >
          {status === 'paused' ? '恢复' : '暂停'}
        </button>
      ) : null}
    </div>
  );
};
