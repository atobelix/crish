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
import React, { useState } from 'react';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { emitUiEvent } from '../../api/uiEvents';
import {
  clearRuntimeStatus,
  useSessionRuntimeStatus,
} from '../../store/storeAccess';
import styles from './ComposerErrorBar.module.css';

export interface ComposerErrorBarProps {
  activeSessionId: string | null;
}

export const ComposerErrorBar: React.FC<ComposerErrorBarProps> = React.memo(
  function ComposerErrorBar({ activeSessionId }) {
    const status = useSessionRuntimeStatus(activeSessionId);
    const [detailOpen, setDetailOpen] = useState(false);

    if (!activeSessionId || status?.phase !== 'failed') return null;
    const sid = activeSessionId;

    const handleDismiss = () => {
      clearRuntimeStatus(sid);
    };

    const handleRetry = () => {
      // S4.2 单轨收敛：重试由 regenerateTurn 节流检查通过后清空运行时状态，
      // 此处不提前清态，防止节流阻断导致错误条丢失但请求未发
      emitUiEvent('retry-failed-turn', {
        sessionId: sid,
        userMsgId: status.turn.userMsgId,
        assistantMsgId: status.turn.assistantMsgId,
      });
    };

    return (
      <div
        className={styles.errorBar}
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="composer-error-bar"
        data-kind={status.kind}
      >
        <AppIcon
          name="alert-triangle"
          size={14}
          aria-hidden
          className={styles.errorIcon}
        />
        <span className={styles.errorText} data-testid="composer-error-text">
          {status.message}
        </span>
        {status.technicalDetail ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.detailToggle}
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((v) => !v)}
          >
            详情
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
          重试
        </Button>
        <Tooltip content="关闭">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.closeButton}
            aria-label="关闭错误提示"
            onClick={handleDismiss}
            data-testid="composer-error-close"
            icon={<AppIcon name="x" size={14} aria-hidden />}
          />
        </Tooltip>
        {detailOpen && status.technicalDetail ? (
          <div className={styles.detailBody} data-testid="composer-error-detail">
            {status.technicalDetail}
          </div>
        ) : null}
      </div>
    );
  }
);

ComposerErrorBar.displayName = 'ComposerErrorBar';
