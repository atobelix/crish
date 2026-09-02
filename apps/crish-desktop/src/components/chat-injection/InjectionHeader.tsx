/**
 * InjectionHeader —— 注入卡片紧凑 Header 栏（图标槽位 / 分类徽章 / 标题 / 摘要 /
 * 右侧状态元数据：Token 胶囊、失败重试按钮、折叠箭头）。
 *
 * 交互语义（对齐 ChatToolCallBlock/ToolCallHeader 的 rowHead 惯例）：
 * - 整行 Header 以 role="button" + tabIndex=0 + Enter/Space/Escape 键盘展开；
 * - 行内重试按钮经 Tooltip 包裹（自定义提示，禁用原生 title）；
 * - rowHeadMeta 点击 stopPropagation，避免误触折叠。
 */
import React from 'react';
import { AlertCircle, ChevronRight, RotateCcw } from 'lucide-react';
import styles from './ContextInjectionBlock.module.css';
import { Tooltip } from '../ui';
import type { MessageContextInjection } from '../../store/types';
import type { InjectionIconComponent } from './contextInjectionUtils';
import {
  formatTokenCount,
  getInjectionKindLabel,
} from './contextInjectionUtils';

export interface InjectionHeaderProps {
  /** 注入项实体（展示字段来自本实体） */
  injection: MessageContextInjection;
  /** 分类语义图标组件（由行组件解析后传入，保持本文件纯净） */
  icon: InjectionIconComponent;
  /** 是否为可展开态 */
  canToggle: boolean;
  isOpen: boolean;
  isFailed: boolean;
  isPending: boolean;
  /** 展开/折叠切换回调 */
  onToggle: () => void;
  /** 行级 aria-label（含分类/标题/状态/开合） */
  rowAriaLabel: string;
  onRetryInjection?: ((injectionId: string) => void) | undefined;
}

export const InjectionHeader: React.FC<InjectionHeaderProps> = React.memo(
  function InjectionHeader({
    injection,
    icon: IconComponent,
    canToggle,
    isOpen,
    isFailed,
    isPending,
    onToggle,
    rowAriaLabel,
    onRetryInjection,
  }) {
    const bodyId = `injection-body-${injection.id}`;
    const kindLabel = getInjectionKindLabel(injection.kind);
    const chevron = canToggle ? (
      <span
        className={`${styles.chevronSlot} ${isOpen ? styles.open : ''}`}
        aria-hidden
      >
        <ChevronRight size={13} />
      </span>
    ) : null;

    const meta = (
      <span
        className={styles.rowHeadMeta}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {injection.tokenEstimate !== undefined ? (
          <Tooltip content={`估算占用上下文: ~${injection.tokenEstimate} Tokens`}>
            <span className={styles.tokenBadge} data-injection-token="true">
              {formatTokenCount(injection.tokenEstimate)}
            </span>
          </Tooltip>
        ) : null}
        {isFailed && onRetryInjection ? (
          <Tooltip content="重新注入此上下文">
            <button
              type="button"
              className={styles.retryBtn}
              onClick={() => onRetryInjection(injection.id)}
              aria-label="重试注入"
              data-injection-retry="true"
            >
              <RotateCcw size={12} aria-hidden />
            </button>
          </Tooltip>
        ) : null}
        {chevron}
      </span>
    );

    return (
      <div
        className={`${styles.rowHead}${canToggle ? '' : ' ' + styles.rowHeadStatic} injection-row-head${canToggle ? '' : ' injection-row-head-static'}`}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        aria-expanded={canToggle ? isOpen : undefined}
        aria-controls={canToggle ? bodyId : undefined}
        aria-label={canToggle ? rowAriaLabel : undefined}
        data-injection-head="true"
        onClick={() => {
          if (canToggle) onToggle();
        }}
        onKeyDown={(e) => {
          if (!canToggle) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
            return;
          }
          if (e.key === 'Escape' && isOpen) {
            e.preventDefault();
            e.stopPropagation();
            onToggle();
          }
        }}
      >
        <span className={styles.rowHeadMain}>
          <span className={styles.iconSlot} aria-hidden>
            {isPending ? (
              <span
                className={`${styles.pendingPulse} loading-spinner`}
                style={{ width: 12, height: 12, borderWidth: 1.5 }}
              />
            ) : isFailed ? (
              <AlertCircle size={14} className={styles.failIcon} />
            ) : (
              <IconComponent size={14} strokeWidth={1.8} />
            )}
          </span>
          <span className={styles.kindBadge}>{kindLabel}</span>
          <span className={styles.titleText} data-injection-title="true">
            {injection.title}
          </span>
          {injection.summary ? (
            <Tooltip content={injection.summary}>
              <span
                className={styles.summaryText}
                data-injection-summary="true"
              >
                {injection.summary}
              </span>
            </Tooltip>
          ) : null}
        </span>
        {meta}
      </div>
    );
  }
);

InjectionHeader.displayName = 'InjectionHeader';
