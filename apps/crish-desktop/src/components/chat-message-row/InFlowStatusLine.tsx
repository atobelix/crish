/**
 * InFlowStatusLine — 对话流内瞬态状态行（单轨收敛 docs/chat-notice-convergence §2.2）
 *
 * 会话运行时「重试进行中」的**唯一**可见承载体：
 * - 数据源唯一：SessionRuntimeStatusStore retrying 相位（reportRuntimeStatus 唯一写入）；
 * - 形态极简：左侧小图标 + 一行闪光流动文字（与「正在思考」同一视觉语言）；
 * - 生命周期：新 Token 到达 / run complete / 新一轮发送 / 切换会话 → 物理消失，对话流不留痕；
 * - 无按钮、无可展开详情、无倒计时（引擎不下发下次重试时刻，前端不臆造）。
 */
import React from 'react';
import styles from './InFlowStatusLine.module.css';
import { AppIcon } from '@/components/ui/icons';
import type { RuntimeRetryInfo } from '../../store';
import { formatRetryStatusText } from './inFlowStatusLineLib';

export interface InFlowStatusLineProps {
  retry: RuntimeRetryInfo;
}

export const InFlowStatusLine: React.FC<InFlowStatusLineProps> = React.memo(
  function InFlowStatusLine({ retry }) {
    return (
      <div
        className={styles.statusLine}
        role="status"
        aria-live="polite"
        data-testid="in-flow-status-line"
      >
        <AppIcon
          name="wifi"
          size={14}
          aria-hidden
          className={styles.statusIcon}
        />
        <span className={styles.statusText}>
          {formatRetryStatusText(retry)}
        </span>
      </div>
    );
  }
);

InFlowStatusLine.displayName = 'InFlowStatusLine';
