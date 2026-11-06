/**
 * ComposerErrorBar — 输入框上方错误条（单轨收敛 docs/chat-notice-convergence §2.3）
 *
 * 会话运行类终态错误的**唯一可见承载体**：
 * - 数据源唯一：SessionRuntimeStatusStore failed 相位（reportRuntimeStatus 唯一写入）；
 * - 非胶囊形态：与输入框等宽的全宽条带；文案可换行，不截断信息；
 * - 存续规则：无 TTL；仅 ①重试成功/新发送 ②切换会话 ③用户点关闭 ④network 类在 transport
 *   恢复时 消解；
 * - 「重试」：派发 retry-failed-turn，由 ChatCard 宿主复用 handleRegenerate **原位重发当轮**
 *   （按 userMsgId 现查提问、撤回失败的 assistant 节点后重跑，不新建用户消息）。
 */
import React, { useRef, useState } from 'react';
import { Button, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { emitUiEvent } from '../../api/uiEvents';
import { openSettings } from '../../store/storeAccess';
import { useI18n } from '../../i18n';
import {
  clearRuntimeStatus,
  useSessionRuntimeStatus,
} from '../../store/storeAccess';
import { isModelConfigurationError } from './chatStatusRibbonsLib';
import { useEntranceReveal } from '../motion/useEntranceReveal';
import { useClosingValue } from '../motion/useExitReveal';
import { useExitReveal } from '../motion/useExitReveal';
import styles from './ComposerErrorBar.module.css';

export interface ComposerErrorBarProps {
  activeSessionId: string | null;
  /** 可选：打开模型设置回调，未提供时默认调用 openSettings('models') */
  onOpenModelSettings?: () => void;
  /**
   * S4 退场：外部宿主（ChatStatusRibbons）发放的 closing 标志；与内部
   * 快照宿主或运算。closing=true 时错误条高度收敛 + 淡出。
   */
  closing?: boolean | undefined;
}

export const ComposerErrorBar: React.FC<ComposerErrorBarProps> = React.memo(
  function ComposerErrorBar({ activeSessionId, onOpenModelSettings, closing: closingProp = false }) {
    const status = useSessionRuntimeStatus(activeSessionId);
    const [detailOpen, setDetailOpen] = useState(false);
    const { t } = useI18n();

    const failedStatus = status?.phase === 'failed' ? status : null;
    // S4 退场宿主（内）：failed 相位离开后，条带自身按上一次 failed
    // 状态快照继续渲染退场帧——父级（ribbons）的保活只保挂载，不保
    // 内容；快照由本宿主持有。键取快照的 turn（与入场键同构）。
    const failedSnapshotRef = useRef(failedStatus);
    if (failedStatus) failedSnapshotRef.current = failedStatus;
    const keySource = failedStatus ?? failedSnapshotRef.current;
    const closingFailed = useClosingValue(failedStatus, {
      key:
        keySource && activeSessionId
          ? `errbar:${activeSessionId}:${keySource.turn.assistantMsgId ?? keySource.turn.userMsgId}`
          : '',
    });
    const renderStatus = closingFailed.value;
    const closing = closingFailed.closing || closingProp;
    // S4 退场：closing 翻 true 时收敛高度并淡出；退场期间入场生长让位。
    const exit = useExitReveal({ closing });

    // 统一入场通道：failed 相位自带 timestamp（实况窗判定），grow 变体
    // 让全宽错误条高度同步生长，不再瞬时顶开输入区（私有 errorBarIn
    // keyframes 已删除）。键/戳取退场快照，closing 期保持稳定。
    const entrance = useEntranceReveal({
      key:
        renderStatus && activeSessionId
          ? `errbar:${activeSessionId}:${renderStatus.turn.assistantMsgId ?? renderStatus.turn.userMsgId}`
          : '',
      eventTs: renderStatus?.timestamp,
      variant: 'grow',
    });

    if (!activeSessionId || !renderStatus) return null;
    const sid = activeSessionId;

    const isModelConfig = isModelConfigurationError(
      renderStatus.kind,
      renderStatus.message
    );

    const handleDismiss = () => {
      clearRuntimeStatus(sid);
    };

    const handleRetry = () => {
      // S4.2 单轨收敛：重试由 regenerateTurn 节流检查通过后清空运行时状态，
      // 此处不提前清态，防止节流阻断导致错误条丢失但请求未发
      emitUiEvent('retry-failed-turn', {
        sessionId: sid,
        userMsgId: renderStatus.turn.userMsgId,
        assistantMsgId: renderStatus.turn.assistantMsgId,
      });
    };

    const handleOpenSettings = () => {
      if (onOpenModelSettings) {
        onOpenModelSettings();
      } else {
        openSettings('models');
      }
    };

    return (
      <div
        ref={(el) => {
          entrance.rootRef(el);
          exit.rootRef(el);
        }}
        className={`${styles.errorBar}${entrance.entering ? ' crish-entrance-fade' : ''}${closing ? ' crish-exit-fade' : ''}`}
        style={{
          border:
            '1px solid color-mix(in srgb, var(--text-danger) 15%, var(--border-subtle))',
          borderLeft:
            '1px solid color-mix(in srgb, var(--text-danger) 15%, var(--border-subtle))',
          borderRadius: 'var(--radius-lg, 12px)',
          backgroundColor:
            'color-mix(in srgb, var(--text-danger) 5%, var(--bg-secondary))',
          color: 'var(--text-primary)',
          ...(closing ? { pointerEvents: 'none' } : null),
          ...(entrance.entering
            ? ({
                '--reveal-delay': `${entrance.delayMs}ms`,
              } as React.CSSProperties)
            : null),
        }}
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        aria-hidden={closing ? true : undefined}
        data-testid="composer-error-bar"
        data-kind={renderStatus.kind}
        data-entering={entrance.entering ? 'true' : undefined}
        data-exiting={closing ? 'true' : undefined}
        onAnimationEnd={entrance.handleAnimationEnd}
      >
        <AppIcon
          name="alert-triangle"
          size={14}
          aria-hidden
          className={styles.errorIcon}
        />
        <span className={styles.errorText} data-testid="composer-error-text">
          {renderStatus.message}
        </span>
        {isModelConfig ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleOpenSettings}
            data-testid="composer-error-settings"
            style={{
              flexShrink: 0,
              fontWeight: 500,
              color: 'var(--text-primary)',
              backgroundColor: 'var(--state-hover)',
              borderRadius: 'var(--radius-md, 8px)',
            }}
          >
            {t('common.configure', '去配置')}
          </Button>
        ) : null}
        {renderStatus.technicalDetail ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.detailToggle}
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((v) => !v)}
          >
            {t('common.details', '详情')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.retryButton}
          onClick={handleRetry}
          data-testid="composer-error-retry"
        >
          {t('common.retry', '重试')}
        </Button>
        <Tooltip content={t('common.close', '关闭')}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.closeButton}
            aria-label={t('common.closeNotice', '关闭错误提示')}
            onClick={handleDismiss}
            data-testid="composer-error-close"
            icon={<AppIcon name="x" size={14} aria-hidden />}
          />
        </Tooltip>
        {detailOpen && renderStatus.technicalDetail ? (
          <div
            className={styles.detailBody}
            data-testid="composer-error-detail"
          >
            {renderStatus.technicalDetail}
          </div>
        ) : null}
      </div>
    );
  }
);

ComposerErrorBar.displayName = 'ComposerErrorBar';
