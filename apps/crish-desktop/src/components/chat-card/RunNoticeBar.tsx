/**
 * 系统 run-notice 播报条（错误 / 空回复等，明确非 AI 输出）。
 * polite / assertive 分级 + 空文案不挂载（防幽灵条）均来自
 * chatStatusRibbonsLib 纯函数，本组件只做装配。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './RunNoticeBar.module.css';
import { Tooltip } from '../Tooltip';
import type { RunNotice } from '../../hooks/useChatStream';
import {
  resolveRunNoticeAriaLabel,
  resolveRunNoticeAriaLive,
  shouldRenderRunNotice,
} from './chatStatusRibbonsLib';
export type RunNoticeBarProps = {
  runNotice: RunNotice | null;
  onDismiss: () => void;
};

export const RunNoticeBar: React.FC<RunNoticeBarProps> = ({
  runNotice,
  onDismiss,
}) => {
  const render = shouldRenderRunNotice(runNotice);
  if (!render) return null;
  const text = String(runNotice?.text ?? '').trim();
  return (
    <div
      className={styles.runNotice}
      role="status"
      aria-live={resolveRunNoticeAriaLive(runNotice?.kind)}
      aria-atomic="true"
      aria-label={resolveRunNoticeAriaLabel(text)}
    >
      <div className={styles.runNoticeMain}>
        <span className={styles.runNoticeKicker}>运行提示</span>
        <span className={styles.runNoticeText}>{text}</span>
        {runNotice?.detail ? (
          <Tooltip content={runNotice.detail}>
            <span className={styles.runNoticeDetail}>
              {runNotice.detail}
            </span>
          </Tooltip>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.runNoticeDismiss}
        aria-label="关闭提示"
        onClick={onDismiss}
      >
        <Lucide.X size={14} aria-hidden />
      </button>
    </div>
  );
};
