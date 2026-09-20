/**
 * ComposerNoticeBar: 输入框上方高级提示条组件
 *
 * 紧凑单行水平弹性布局，承载输入框上方的 info / warning / error 状态通告，
 * 支持详情 Tooltip、一键复制（带 1.2s 对勾反馈）、用户反馈跳转及关闭。
 * 严格遵循 AGENTS.md §13（微变焦点与克制对比度）与 §14（色彩规范）。
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import styles from './ComposerNoticeBar.module.css';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';

export interface ComposerNotice {
  id: string;
  type: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
}

export interface ComposerNoticeBarProps {
  notice: ComposerNotice | null;
  onDismiss: () => void;
  onFeedback?: () => void;
  className?: string;
}

export const ComposerNoticeBar: React.FC<ComposerNoticeBarProps> = ({
  notice,
  onDismiss,
  onFeedback,
  className = '',
}) => {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setCopied(false);
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [notice?.id]);

  const handleCopy = useCallback(() => {
    if (!notice) return;
    const textToCopy = notice.detail || notice.message;
    try {
      void navigator?.clipboard?.writeText?.(textToCopy)?.catch(() => {});
    } catch {
      // 忽略静默环境剪贴板读写异常
    }
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }
    setCopied(true);
    copyTimerRef.current = setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 1200);
  }, [notice]);

  if (!notice) {
    return null;
  }

  const renderIcon = () => {
    switch (notice.type) {
      case 'info':
        return <AppIcon name="info" size={14} className={styles.icon} aria-hidden="true" />;
      case 'warning':
        return <AppIcon name="alert-triangle" size={14} className={styles.icon} aria-hidden="true" />;
      case 'error':
      default:
        return <AppIcon name="alert-circle" size={14} className={styles.icon} aria-hidden="true" />;
    }
  };

  const rootClasses = [
    styles.noticeBar,
    styles[notice.type],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const detailContent = notice.detail || notice.message;

  return (
    <div
      className={rootClasses}
      role="status"
      aria-live="polite"
      data-testid="composer-notice-bar"
      data-notice-type={notice.type}
    >
      {/* a. 图标 */}
      {renderIcon()}

      {/* b. 问题简述文本 */}
      <Tooltip content={notice.message}>
        <span className={styles.message}>
          {notice.message}
        </span>
      </Tooltip>

      {/* c. 错误详情叹号徽标 */}
      <Tooltip content={detailContent}>
        <Button
          type="button"
          variant="ghost"
          className={styles.detailBadge}
          aria-label="查看详细信息"
          data-testid="composer-notice-detail-badge"
        >
          !
        </Button>
      </Tooltip>

      {/* d. 复制错误按钮 */}
      <Button
        type="button"
        variant="ghost"
        className={styles.copyBtn}
        onClick={handleCopy}
        aria-label={copied ? '已复制' : '复制'}
        data-testid="composer-notice-copy-btn"
      >
        {copied ? (
          <>
            <AppIcon name="check" size={13} className={styles.btnIcon} aria-hidden="true" />
            <span>已复制</span>
          </>
        ) : (
          <>
            <AppIcon name="copy" size={13} className={styles.btnIcon} aria-hidden="true" />
            <span>复制</span>
          </>
        )}
      </Button>

      {/* e. 反馈按钮 */}
      <Button
        type="button"
        variant="ghost"
        className={styles.feedbackBtn}
        onClick={() => onFeedback?.()}
        aria-label="反馈"
        data-testid="composer-notice-feedback-btn"
      >
        <AppIcon name="message-square-plus" size={13} className={styles.btnIcon} aria-hidden="true" />
        <span>反馈</span>
      </Button>

      {/* f. 删除/关闭按钮 */}
      <Button
        type="button"
        variant="ghost"
        className={styles.dismissBtn}
        onClick={onDismiss}
        aria-label="关闭提示"
        data-testid="composer-notice-dismiss-btn"
      >
        <AppIcon name="x" size={14} aria-hidden="true" />
      </Button>
    </div>
  );
};

export default ComposerNoticeBar;
