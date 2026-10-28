/**
 * ComposerEmbeddedNotice.tsx
 * 输入坞内嵌通知顶槽组件（P6 T6-2）
 *
 * 替代原脱离卡片的 `.composerNoticeZone` / `ComposerNoticeBar`，
 * 直接内嵌于 `.composerCard` 顶部，与主输入区共享唯一闭合圆角矩形外框。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './ComposerEmbeddedNotice.module.css';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';
import {
  resolveLegacyNoticeType,
  resolveNoticeSeverity,
  type ComposerNotice,
} from './composerNoticeTypes';

export interface ComposerEmbeddedNoticeProps {
  notice: ComposerNotice | null;
  isClosing?: boolean;
  onDismiss: () => void;
  onFeedback?: (() => void) | undefined;
  className?: string;
}

const COPY_FEEDBACK_MS = 1200;

export const ComposerEmbeddedNotice: React.FC<ComposerEmbeddedNoticeProps> = ({
  notice,
  isClosing = false,
  onDismiss,
  onFeedback,
  className,
}) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    },
    []
  );

  const primaryText = notice?.text ?? notice?.message ?? '';

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const copyPayload = notice?.detail || primaryText;
      if (!copyPayload) return;
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(copyPayload);
      }
      setCopied(true);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, COPY_FEEDBACK_MS);
    },
    [notice, primaryText]
  );

  if (!notice) return null;

  const severity = resolveNoticeSeverity(notice);
  const noticeTypeAttr = notice.type ?? resolveLegacyNoticeType(severity);
  const tooltipDetail = notice.detail || primaryText;

  return (
    <div
      className={`${styles.embeddedNotice}${isClosing ? ` ${styles.noticeBarClosing}` : ''}${className ? ` ${className}` : ''}`}
      data-embedded-top-slot=""
      data-testid="composer-notice-bar"
      data-embedded-notice="true"
      data-notice-severity={severity}
      data-notice-type={noticeTypeAttr}
      data-notice-source={notice.source ?? 'default'}
      data-closing={isClosing ? 'true' : undefined}
      role="status"
      aria-live="polite"
    >
      <div className={styles.leadGroup}>
        <Tooltip content={tooltipDetail}>
          <span
            className={styles.severityBadge}
            data-testid="composer-notice-detail-badge"
            aria-label={tooltipDetail}
          >
            !
          </span>
        </Tooltip>
        <span className={styles.noticeText}>{primaryText}</span>
      </div>

      <div className={styles.actionGroup}>
        {notice.action ? (
          <Button
            bare
            type="button"
            className={styles.actionBtn}
            data-testid="composer-notice-action-pill"
            onClick={(e) => {
              e.stopPropagation();
              notice.action?.onClick();
            }}
          >
            {notice.action.label}
          </Button>
        ) : null}

        <Button
          bare
          type="button"
          className={styles.ghostBtn}
          data-testid="composer-notice-copy-btn"
          onClick={handleCopy}
          aria-label={
            copied
              ? t('common.copiedDetail', '已复制详情')
              : t('common.copyDetail', '复制详情')
          }
        >
          <AppIcon name={copied ? 'check' : 'copy'} size={12} aria-hidden />
          <span>
            {copied ? t('common.copied', '已复制') : t('common.copy', '复制')}
          </span>
        </Button>

        <Button
          bare
          type="button"
          className={styles.ghostBtn}
          data-testid="composer-notice-feedback-btn"
          onClick={(e) => {
            e.stopPropagation();
            onFeedback?.();
          }}
        >
          {t('common.feedback', '反馈')}
        </Button>

        <Button
          bare
          type="button"
          className={styles.closeBtn}
          data-testid="composer-notice-dismiss-btn"
          aria-label={t('common.closeNotice', '关闭提示')}
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <AppIcon name="x" size={12} aria-hidden />
        </Button>
      </div>
    </div>
  );
};
