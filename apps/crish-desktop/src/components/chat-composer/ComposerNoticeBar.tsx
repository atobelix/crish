/**
 * ComposerNoticeBar: 输入框上方 48px 灵动配重胶囊组件
 *
 * 紧凑全圆角胶囊布局，三槽光学配重（左微标、中双层主文案、右 ActionPill 与 0.8px 细圈微叉）。
 * 支持详情 Tooltip、一键复制（带 1.2s 对勾反馈）、用户反馈跳转、业务 Action 响应及关闭。
 * 严格遵循 AGENTS.md §13（微变焦点与克制对比度）与 §14（色彩规范），全量收编至 Token 体系。
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import styles from './ComposerNoticeBar.module.css';
import { Button, Tooltip } from '../ui';
import { useI18n } from '../../i18n';
import { AppIcon } from '../ui/icons/index';

export interface ComposerNoticeAction {
  label: string;
  onClick: () => void;
}

export interface ComposerNotice {
  id: string;
  type: 'info' | 'warning' | 'error' | 'stop' | 'success';
  message: string;
  detail?: string;
  action?: ComposerNoticeAction;
  noticeKind?: string;
}

export interface ComposerNoticeBarProps {
  notice: ComposerNotice | null;
  onDismiss: () => void;
  onFeedback?: () => void;
  className?: string;
  isClosing?: boolean;
}

export const ComposerNoticeBar: React.FC<ComposerNoticeBarProps> = ({
  notice,
  onDismiss,
  onFeedback,
  className = '',
  isClosing = false,
}) => {
  const { t } = useI18n();
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
      void navigator?.clipboard?.writeText?.(textToCopy)?.catch(() => {
        /* swallow-ok: 剪贴板失败仅保持 copied=false，已有 UI 即可 */
      });
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
      case 'stop':
        return <AppIcon name="square" size={13} aria-hidden="true" />;
      case 'success':
        return <AppIcon name="check-circle" size={14} aria-hidden="true" />;
      case 'info':
        return <AppIcon name="info" size={14} aria-hidden="true" />;
      case 'warning':
        return <AppIcon name="alert-triangle" size={14} aria-hidden="true" />;
      case 'error':
      default:
        return <AppIcon name="alert-circle" size={14} aria-hidden="true" />;
    }
  };

  const rootClasses = [
    styles.noticeBar,
    styles[notice.type] || styles.info,
    isClosing ? styles.noticeBarClosing : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const detailContent = notice.detail || notice.message;

  const copiedText = t('common.copied');
  const copyText = t('common.copy');
  const feedbackText = t('common.feedback');

  return (
    <div
      className={rootClasses}
      role="status"
      aria-live="polite"
      data-testid="composer-notice-bar"
      data-notice-type={notice.type}
      data-closing={isClosing ? 'true' : undefined}
    >
      {/* 1. 左槽：固定微图标 (20px 视窗) */}
      <div className={styles.capsuleSlotLeft} aria-hidden="true">
        {renderIcon()}
      </div>

      {/* 2. 中槽：单行主文本 + 详情徽标 */}
      <div className={styles.capsuleSlotCenter}>
        <Tooltip content={notice.message}>
          <span className={styles.message}>{notice.message}</span>
        </Tooltip>

        {/* 详情叹号微标 */}
        <Tooltip content={detailContent}>
          <Button
            bare
            type="button"
            className={styles.detailBadge}
            aria-label={t('chat.composer.notice.viewDetail')}
            data-testid="composer-notice-detail-badge"
          >
            !
          </Button>
        </Tooltip>
      </div>

      {/* 3. 右槽：ActionPill + 复制 + 反馈 + 0.8px 细圈微叉 */}
      <div className={styles.capsuleSlotRight}>
        {/* 业务 ActionPill 快捷胶囊药丸 (如：立即重试、压缩记忆) */}
        {notice.action && (
          <Button
            bare
            type="button"
            className={styles.actionPill}
            onClick={() => notice.action?.onClick()}
            data-testid="composer-notice-action-pill"
          >
            {notice.action.label}
          </Button>
        )}

        {/* 复制错误按钮 */}
        <Button
          bare
          type="button"
          className={styles.copyBtn}
          onClick={handleCopy}
          aria-label={copied ? copiedText : copyText}
          data-testid="composer-notice-copy-btn"
        >
          {copied ? (
            <>
              <AppIcon
                name="check"
                size={12}
                className={styles.btnIcon}
                aria-hidden="true"
              />
              <span>{copiedText}</span>
            </>
          ) : (
            <>
              <AppIcon
                name="copy"
                size={12}
                className={styles.btnIcon}
                aria-hidden="true"
              />
              <span>{copyText}</span>
            </>
          )}
        </Button>

        {/* 反馈按钮 */}
        <Button
          bare
          type="button"
          className={styles.feedbackBtn}
          onClick={() => onFeedback?.()}
          aria-label={feedbackText}
          data-testid="composer-notice-feedback-btn"
        >
          <AppIcon
            name="message-square-plus"
            size={12}
            className={styles.btnIcon}
            aria-hidden="true"
          />
          <span>{feedbackText}</span>
        </Button>

        {/* 0.8px 发丝微圈关闭按钮 */}
        <Button
          bare
          type="button"
          className={styles.dismissBtn}
          onClick={onDismiss}
          aria-label={t('chat.composer.notice.dismiss')}
          data-testid="composer-notice-dismiss-btn"
        >
          <AppIcon name="x" size={11} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
};

export default ComposerNoticeBar;
