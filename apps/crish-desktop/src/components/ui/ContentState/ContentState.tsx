/**
 * apps/crish-desktop/src/components/ui/ContentState/ContentState.tsx
 *
 * ui/ContentState 统一三态呈现（批 A · Cherry 深比 06-1）：把散落各面的
 * 加载 / 错误 / 空三态收敛为一个入口，口径三条钉死：
 * - loading = Spinner + 状态文案（不用骨架屏——用户裁决）；
 * - error 必带重试槽：传入 onRetry 即渲染重试按钮，不给错误态留
 *   「只有文案没有出路」的形态；
 * - empty = 标题 + 可选说明 + 可选行动槽，极简呈现。
 *
 * 首个消费方：消息列表（ChatMessageList）在会话切换 / 历史回填的真空窗
 * 期呈现 loading，水合停滞时呈现 error + 重试。其余列表/面板后续收编。
 * 视觉语言与 ChatEmptyState 同源：居中列、文字三级灰阶、无边框无底色，
 * 靠亮度台阶与留白区分，不引入新色。
 */

import React from 'react';
import { useI18n } from '../../../i18n';
import { Button } from '../Button';
import { Spinner } from '../Spinner';
import styles from './ContentState.module.css';

export type ContentStateKind = 'loading' | 'error' | 'empty';

export interface ContentStateProps {
  kind: ContentStateKind;
  /** 主文案：loading 的状态文案 / error 与 empty 的标题 */
  title: string;
  /** 副文案：error 的原因说明 / empty 的补充说明（loading 一般不传） */
  description?: string;
  /** error 态重试回调；提供时渲染重试按钮 */
  onRetry?: () => void;
  /** 重试按钮文案（默认取字典 common.retry） */
  retryLabel?: string;
  /** empty 态可选行动槽（调用方自定义行动，如跳转按钮） */
  action?: React.ReactNode;
  className?: string;
  testId?: string;
}

export const ContentState: React.FC<ContentStateProps> = ({
  kind,
  title,
  description,
  onRetry,
  retryLabel,
  action,
  className,
  testId,
}) => {
  const { t } = useI18n();
  const resolvedRetryLabel = retryLabel ?? t('common.retry');
  const rootClass = className
    ? `${styles.contentState} ${className}`
    : styles.contentState;
  return (
    <div
      className={rootClass}
      data-slot="content-state"
      data-kind={kind}
      data-testid={testId}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'loading' ? 'polite' : undefined}
      aria-busy={kind === 'loading' || undefined}
    >
      {kind === 'loading' ? <Spinner delayed /> : null}
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {kind === 'error' && onRetry ? (
        <Button
          type="button"
          variant="secondary"
          size="md"
          className={styles.retryButton}
          onClick={onRetry}
        >
          {resolvedRetryLabel}
        </Button>
      ) : null}
      {kind === 'empty' && action ? (
        <div className={styles.actionSlot}>{action}</div>
      ) : null}
    </div>
  );
};
