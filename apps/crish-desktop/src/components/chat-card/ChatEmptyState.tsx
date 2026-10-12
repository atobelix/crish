/**
 * Chat 主列统一空态：无会话 / 过滤无命中 / 有会话无消息。
 * 视觉：透明底 + hairline chip，短文案；密钥引导由 soft-hint / FirstRun 负责。
 *
 * session-empty（新对话）不在此渲染可见内容：项目选择移到 composer 卡片外上方左侧
 * （ComposerProjectPicker），输入框改多行落地态；这里只保留读屏 / 状态锚点。
 *
 * 三态扫视锚点（DOM）：
 * - class: chat-empty-state--{kind}
 * - data-empty-kind / data-primary-action
 * - data-engine-ok / data-messages-loading / data-density
 *
 * 契约（与 api/chatEmptyState 纯函数对齐）：
 * - CTA 文案只走 resolveChatEmptyActionLabel 中文标签
 */
import React, { useId } from 'react';
import styles from './ChatEmptyState.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Button } from '../ui';
import {
  chatEmptyKindAriaLabel,
  isChatEmptyKind,
  resolveChatEmptyActionLabel,
  resolveChatEmptyCopy,
  resolveChatEmptyPrimaryAction,
  type ChatEmptyKind,
  type ChatEmptyPrimaryAction,
} from '../../api/chatEmptyState';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

export type ChatEmptyStateProps = {
  kind: ChatEmptyKind;
  filterQuery?: string;
  needsKeySetup?: boolean;
  needsModelSetup?: boolean;
  firstRunOpen?: boolean;
  /** engineHint.ok；false = daemon/引擎离线。未传/null 按就绪处理。 */
  engineOk?: boolean | null;
  /** 会话消息仍在从磁盘/引擎水合：仅打 data-messages-loading + 轻量指示。 */
  messagesLoading?: boolean;
  /** no-session */
  onCreateSession?: () => void;
  /** filter-empty */
  onClearFilter?: () => void;
};

function EmptyIcon({ kind }: { kind: ChatEmptyKind }) {
  const common = {
    size: 22 as const,
    strokeWidth: 1.5 as const,
    className: styles.chatEmptyIcon,
    'aria-hidden': true as const,
  };
  // 两态图标互不相同，辅助扫视（文案标题已区分）
  if (kind === 'no-session')
    return <AppIcon name="message-square-plus" {...common} />;
  return <AppIcon name="search-x" {...common} />;
}

function primaryActionHandler(
  action: ChatEmptyPrimaryAction,
  handlers: {
    onCreateSession?: () => void;
    onClearFilter?: () => void;
  }
): (() => void) | undefined {
  if (action === 'create-session') return handlers.onCreateSession;
  if (action === 'clear-filter') return handlers.onClearFilter;
  return undefined;
}

export const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({
  kind,
  filterQuery = '',
  needsKeySetup = false,
  needsModelSetup = false,
  firstRunOpen = false,
  engineOk = null,
  messagesLoading = false,
  onCreateSession,
  onClearFilter,
}) => {
  const reactId = useId();
  const { t } = useI18n();

  // 国际化文案：问候与占位文案（带回退）
  const greeting = t('chat.welcome', '欢迎');
  const placeholderText = t('chat.placeholder', '输入消息...');

  // 运行时守卫：非法 kind 不挂载，避免 class/data 污染
  if (!isChatEmptyKind(kind)) return null;

  const ariaLabel = chatEmptyKindAriaLabel(kind);
  // FirstRun 盖层打开时不抢读屏播报（向导独占）
  const ariaLive: 'polite' | 'off' = firstRunOpen ? 'off' : 'polite';
  const engineOkAttr =
    engineOk === false ? 'false' : engineOk === true ? 'true' : 'unknown';

  // 新对话落地面：可见内容全部交给 composer（上方项目选择胶囊 + 多行输入）
  if (kind === 'session-empty') {
    return (
      <div
        className={styles.sessionEmpty}
        data-empty-kind={kind}
        data-engine-ok={engineOkAttr}
        data-messages-loading={messagesLoading ? 'true' : 'false'}
        data-greeting={greeting}
        data-placeholder={placeholderText}
        role="status"
        aria-live={ariaLive}
        aria-label={ariaLabel}
      />
    );
  }

  const copy = resolveChatEmptyCopy({
    kind,
    filterQuery,
    needsKeySetup,
    needsModelSetup,
    firstRunOpen,
    engineOk,
  });

  // 主行动与中文 CTA：以纯函数为单一来源，避免 copy 分支漏接
  const primaryAction = resolveChatEmptyPrimaryAction(kind, { firstRunOpen });
  const actionLabel =
    resolveChatEmptyActionLabel(primaryAction) ?? copy.actionLabel;

  const titleId = `chat-empty-title-${kind}-${reactId}`;
  const subId = `chat-empty-sub-${kind}-${reactId}`;

  const actionFn = primaryActionHandler(primaryAction, {
    ...(onCreateSession !== undefined && { onCreateSession }),
    ...(onClearFilter !== undefined && { onClearFilter }),
  });
  // 与 copy.primaryAction 交叉校验：任一为 null / 无 handler 则隐藏
  const showAction = Boolean(
    actionLabel &&
    primaryAction &&
    primaryAction === copy.primaryAction &&
    actionFn
  );

  // 密度：向导盖层收紧（去装饰图标，少一层扫视噪音）
  const density: 'compact' | 'default' = firstRunOpen ? 'compact' : 'default';
  const showIcon = density === 'default';

  const kindClass =
    kind === 'no-session' ? styles.noSession : styles.filterEmpty;

  return (
    <AppErrorBoundary variant="minimal" title="空态出错">
      <div
        className={`${styles.chatEmptyState} ${kindClass}`}
        data-empty-kind={kind}
        data-primary-action={primaryAction ?? 'none'}
        data-first-run={firstRunOpen ? 'true' : 'false'}
        data-engine-ok={engineOkAttr}
        data-messages-loading={messagesLoading ? 'true' : 'false'}
        data-density={density}
        data-greeting={greeting}
        data-placeholder={placeholderText}
        role="status"
        aria-live={ariaLive}
        aria-label={ariaLabel}
        aria-labelledby={titleId}
        aria-describedby={subId}
      >
        {showIcon ? (
          <div className={styles.chatEmptyIconWrap} aria-hidden>
            <EmptyIcon kind={kind} />
          </div>
        ) : null}

        <h3 id={titleId} className={styles.chatEmptyTitle}>
          {copy.title}
        </h3>

        {messagesLoading && kind !== 'no-session' ? (
          <p className={styles.chatEmptyLoading} data-empty-region="loading">
            {t('common.loading', '正在加载消息')}
          </p>
        ) : null}

        {copy.sub ? (
          <p id={subId} className={styles.chatEmptySub}>
            {copy.sub}
          </p>
        ) : null}

        {showAction && actionLabel && actionFn ? (
          <Button
            type="button"
            variant="secondary"
            size="md"
            className={styles.chatEmptyAction}
            data-empty-action={primaryAction}
            aria-label={actionLabel}
            onClick={actionFn}
            icon={
              primaryAction === 'create-session' ? (
                <AppIcon name="plus" size={14} aria-hidden />
              ) : (
                <AppIcon name="eraser" size={14} aria-hidden />
              )
            }
          >
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </AppErrorBoundary>
  );
};
