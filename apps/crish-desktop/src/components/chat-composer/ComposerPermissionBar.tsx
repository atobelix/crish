/**
 * Layer 1: 浮动权限审批条（Floating Permission Approval Bar）
 * 严格对齐 docs/ui-reference-alignment-audit/02-pixel-perfect-implementation-plan.md §4.2 与 reference/chat-composer-component/css/flow/permission-bar.css
 * - 上层（Line 1）：盾牌图标 + [低风险]/[高风险] 徽标 + 60s 倒计时槽位（slot-timer）+ 摘要 + 更多展开；
 * - 下层（Line 2）：真实待执行命令语法代码高亮 + [拒绝] [批准] [始终允许] 按钮组；
 * - 审批后瞬态渐变并平滑合拢。
 */
import React, { useEffect, useState } from 'react';

import styles from './ComposerPermissionBar.module.css';
import { Button, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';

export type PermissionRiskLevel = 'low' | 'medium' | 'high';

export interface ComposerPermissionBarProps {
  risk?: PermissionRiskLevel;
  title?: string;
  summary?: string;
  command?: string;
  countdownSeconds?: number;
  moreCount?: number;
  onAllow?: (remember?: boolean) => void;
  onDeny?: () => void;
  onAlwaysAllow?: () => void;
  busy?: boolean;
  resolved?: boolean;
  resolvedLabel?: string;
  className?: string;
}

export const ComposerPermissionBar: React.FC<ComposerPermissionBarProps> = ({
  risk = 'low',
  title = 'Shell 命令审批',
  summary = '请求执行命令',
  command = '',
  countdownSeconds = 60,
  moreCount = 0,
  onAllow,
  onDeny,
  onAlwaysAllow,
  busy = false,
  resolved = false,
  resolvedLabel = '已批准',
  className = '',
}) => {
  const [timeLeft, setTimeLeft] = useState(countdownSeconds);

  useEffect(() => {
    setTimeLeft(countdownSeconds);
  }, [countdownSeconds]);

  useEffect(() => {
    if (resolved || timeLeft <= 0) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [resolved, timeLeft]);

  const riskLabel =
    risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险';
  const timerClass =
    timeLeft <= 10
      ? styles.isExpired
      : timeLeft <= 30
        ? styles.isWarningFlash
        : timeLeft <= 60
          ? styles.isOrange
          : '';

  return (
    <div
      className={`${styles.flowPermissionBar} flow-permission-bar${resolved ? ` ${styles.flowPermissionBarResolved} is-resolved` : ''}${className ? ` ${className}` : ''}`}
      data-risk={risk}
      data-resolved={resolved ? 'true' : undefined}
      data-testid="composer-permission-bar"
      role="region"
      aria-label="权限确认审批条"
    >
      <div
        className={`${styles.flowPermissionBarLine1} flow-permission-bar__line1`}
      >
        <div
          className={`${styles.flowPermissionBarTitleGroup} flow-permission-bar__title-group`}
        >
          <AppIcon
            name="shield-alert"
            size={14}
            className={styles.shieldIcon}
            aria-hidden
          />
          <span
            className={`${styles.flowPermissionBarBadge} flow-permission-bar__badge`}
            data-risk={risk}
          >
            {title ? `${title} · ` : ''}[{riskLabel}]
          </span>
        </div>
        <div
          className={`${styles.flowPermissionBarMetaRight} flow-permission-bar__meta-right`}
        >
          {moreCount > 0 ? (
            <Tooltip content={`队列中还有 ${moreCount} 项待确认`}>
              <span
                className={`${styles.flowPermissionBarMore} flow-permission-bar__more`}
              >
                +{moreCount}
              </span>
            </Tooltip>
          ) : null}
          <Tooltip content={`审批剩余时间：${timeLeft} 秒`}>
            <span
              className={`${styles.flowPermissionBarTimer} ${styles.slotTimer} flow-permission-bar__timer slot-timer ${timerClass}`}
              aria-label={`倒计时 ${timeLeft} 秒`}
            >
              {resolved ? `✓ ${resolvedLabel}` : `${timeLeft}s`}
            </span>
          </Tooltip>
        </div>
      </div>

      <div
        className={`${styles.flowPermissionBarLine2} flow-permission-bar__line2`}
      >
        <code
          className={`${styles.flowPermissionCmd} flow-permission-bar__cmd`}
        >
          {command || summary}
        </code>
        <div
          className={`${styles.flowPermissionBarActions} flow-permission-bar__actions`}
        >
          <Button
            type="button"
            variant="ghost"
            className={`${styles.flowPermissionBtn} ${styles.flowPermissionBtnDeny} flow-permission-bar__btn flow-permission-bar__btn--deny`}
            disabled={busy || resolved}
            onClick={onDeny}
            aria-label="拒绝命令执行"
          >
            拒绝
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`${styles.flowPermissionBtn} ${styles.flowPermissionBtnAllow} flow-permission-bar__btn flow-permission-bar__btn--allow`}
            disabled={busy || resolved}
            onClick={() => onAllow?.(false)}
            aria-label="批准执行命令"
          >
            批准
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`${styles.flowPermissionBtn} ${styles.flowPermissionBtnAlways} flow-permission-bar__btn flow-permission-bar__btn--always`}
            disabled={busy || resolved}
            onClick={() => (onAlwaysAllow ? onAlwaysAllow() : onAllow?.(true))}
            aria-label="始终允许此类命令"
          >
            始终允许
          </Button>
        </div>
      </div>
    </div>
  );
};
