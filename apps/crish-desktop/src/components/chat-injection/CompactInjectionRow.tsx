/**
 * CompactInjectionRow —— 对话流可见注入卡片单行组件。
 *
 * 视觉对齐 CompactToolRow：圆角卡片 + 语义色调微光（左缘 + 图标槽着色）+
 * 分类徽章 + 标题/摘要 + Token 胶囊 + 折叠展开详情。
 *
 * 折叠状态：
 * - 受控优先（expandedInjections[injection.id]），缺省回落本地 state；
 * - 默认折叠判定：defaultFolded ?? content.length > 160。
 *
 * 状态语义：
 * - pending → 图标槽旋转脉冲；failed → 标红 + AlertCircle + 重试按钮；
 * - 其余状态展示分类语义图标。
 *
 * aria 完整性：整行 role="article"，data 属性承载 id/kind/status/testid；
 * 展开区经 aria-controls/aria-expanded 与 Header 关联。
 */
import React, { useCallback, useMemo, useState } from 'react';
import styles from './ContextInjectionBlock.module.css';
import { Tooltip } from '../ui';
import type { CompactInjectionRowProps } from './contextInjectionTypes';
import {
  INJECTION_COLLAPSE_CHAR_THRESHOLD,
  type ContextInjectionSharedProps,
} from './contextInjectionTypes';
import { InjectionBody } from './InjectionBody';
import { InjectionHeader } from './InjectionHeader';
import {
  getInjectionIcon,
  getInjectionKindLabel,
  getInjectionToneClass,
  isContextStateInjection,
  formatContextStateDisplayText,
} from './contextInjectionUtils';

/** 从共享 props 中切出本组件需要的回调（与详案 02 装配语义一致） */
type RowProps = CompactInjectionRowProps &
  Pick<
    ContextInjectionSharedProps,
    'onToggleInjection' | 'onOpenPath' | 'onOpenDiff' | 'onRetryInjection'
  >;

export const CompactInjectionRow: React.FC<RowProps> = React.memo(
  function CompactInjectionRow({
    injection,
    rowKey,
    expandedInjections,
    onToggleInjection,
    onOpenPath,
    onOpenDiff,
    onRetryInjection,
  }) {
    // 状态切换感知项（模型/服务商/权限/档位切换通知）：以 20px 极简发丝微提示呈现，
    // 杜绝大卡片、粗彩边框、图标徽章、折叠箭头与 100% 冗余复读的展开 Body
    if (isContextStateInjection(injection)) {
      const displayText = formatContextStateDisplayText(injection);
      return (
        <Tooltip content={displayText} side="top" key={rowKey}>
          <div
            className={styles.contextStateNotice}
            role="status"
            aria-live="polite"
            tabIndex={0}
            data-injection-id={injection.id}
            data-injection-kind={injection.kind}
            data-testid={`context-state-notice-${injection.id}`}
          >
            <span className={styles.contextStateText}>{displayText}</span>
          </div>
        </Tooltip>
      );
    }

    const hasContent = (injection.content || '').trim().length > 0;
    const hasDiffs = (injection.diffs?.length ?? 0) > 0;
    const hasPaths = (injection.targetPaths?.length ?? 0) > 0;
    // 可折叠 = 有正文或有关联展示（Diff/路径）且未被显式禁折
    const canToggle = injection.isFoldable !== false && (hasContent || hasDiffs || hasPaths);

    // file_context 默认折叠（不霸道铺屏，清晰呈现文件上下文并保留展开阅读能力）
    const defaultOpen =
      injection.defaultFolded !== undefined
        ? !injection.defaultFolded
        : injection.kind === 'file_context'
          ? false
          : !((injection.content || '').length > INJECTION_COLLAPSE_CHAR_THRESHOLD);
    const [localOpen, setLocalOpen] = useState(defaultOpen);
    // 受控优先：容器传入 expandedInjections 时以其为准；否则本地 state
    const controlled = expandedInjections?.[injection.id];
    const isOpen = controlled ?? localOpen;

    const handleToggle = useCallback(() => {
      const next = !isOpen;
      if (controlled === undefined) setLocalOpen(next);
      onToggleInjection?.(injection.id, next);
    }, [isOpen, controlled, injection.id, onToggleInjection]);

    const IconComponent = useMemo(
      () => getInjectionIcon(injection.kind),
      [injection.kind]
    );
    const toneClass = useMemo(
      () => getInjectionToneClass(injection.kind, styles),
      [injection.kind]
    );
    const kindLabel = useMemo(
      () => getInjectionKindLabel(injection.kind),
      [injection.kind]
    );

    const isFailed = injection.status === 'failed';
    const isPending = injection.status === 'pending';
    const statusText = (() => {
      switch (injection.status) {
        case 'pending':
          return '准备中';
        case 'failed':
          return '注入失败';
        case 'active':
          return '持续生效';
        case 'expired':
          return '已过期';
        default:
          return '已注入';
      }
    })();

    const rowAriaLabel = [
      '系统上下文注入',
      kindLabel,
      injection.title,
      injection.summary || null,
      statusText,
      canToggle ? (isOpen ? '已展开' : '已折叠') : null,
      canToggle ? (isOpen ? '按 Enter 或空格折叠' : '按 Enter 或空格展开') : null,
    ]
      .filter(Boolean)
      .join('，');

    const openStateClass = canToggle
      ? isOpen
        ? styles.isOpen
        : styles.isCollapsed
      : '';

    return (
      <div
        key={rowKey}
        className={`${styles.injectionRow} ${toneClass} ${openStateClass} ${isFailed ? styles.isFailed : ''} ${isPending ? styles.isPending : ''} injection-row`}
        data-injection-id={injection.id}
        data-injection-kind={injection.kind}
        data-injection-status={injection.status}
        data-testid={`injection-row-${injection.id}`}
      >
        <InjectionHeader
          injection={injection}
          icon={IconComponent}
          canToggle={canToggle}
          isOpen={isOpen}
          isFailed={isFailed}
          isPending={isPending}
          onToggle={handleToggle}
          rowAriaLabel={rowAriaLabel}
          onOpenPath={onOpenPath}
          onOpenDiff={onOpenDiff}
          onRetryInjection={onRetryInjection}
        />
        {canToggle && isOpen ? (
          <InjectionBody
            injection={injection}
            onOpenPath={onOpenPath}
            onOpenDiff={onOpenDiff}
          />
        ) : null}
      </div>
    );
  }
);

CompactInjectionRow.displayName = 'CompactInjectionRow';

export const ContextInjectionCard = CompactInjectionRow;
