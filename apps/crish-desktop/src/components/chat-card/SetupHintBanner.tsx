/**
 * 引导态 soft-hint 条：engine / needs-key / needs-model / sync-engine 四种互斥。
 * 纯渲染：文案与可见性门闩由 chatStatusRibbonsLib 计算后传入。
 * 只展示一条（kind 非 null 时挂载），配合 data-setup-hint 走模块样式差异。
 */
import React from 'react';

import styles from './SetupHintBanner.module.css';
import type { SetupHintKind } from './chatStatusRibbonsLib';
import { Button } from '../ui';
import { AppIcon } from '../ui/icons/index';

/** 单条 soft-hint 的完整渲染状态（文案层已在壳组件算好）。 */
export type SetupHintState = {
  kind: SetupHintKind;
  text: string;
  actionLabel: string;
  actionAriaLabel: string;
};

export type SetupHintBannerProps = {
  /** null = 不展示任何 setup 条（互斥出口已收敛） */
  state: SetupHintState | null;
  /** 按 kind 派发动作：needs-key / engine-down → 模型设置；needs-model / sync-engine → 模型下拉 */
  onAction: (kind: SetupHintKind) => void;
};

/** 每种 setup kind 的图标（与抽出前一一对应）。 */
const SETUP_HINT_ICON: Record<SetupHintKind, React.ReactNode> = {
  'engine-down': <AppIcon name="cloud-off" size={14} aria-hidden />,
  'needs-key': <AppIcon name="key" size={14} aria-hidden />,
  'needs-model': <AppIcon name="cpu" size={14} aria-hidden />,
  'sync-engine': <AppIcon name="refresh" size={14} aria-hidden />,
};

export const SetupHintBanner: React.FC<SetupHintBannerProps> = ({
  state,
  onAction,
}) => {
  if (!state) return null;
  return (
    <div
      className={styles.chatSoftHint}
      data-setup-hint={state.kind}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className={styles.chatSoftHintIcon}>{SETUP_HINT_ICON[state.kind]}</span>
      <span className={styles.chatSoftHintText}>{state.text}</span>
      <Button
        variant="ghost"
        type="button"
        className={styles.chatSoftHintAction}
        aria-label={state.actionAriaLabel}
        onClick={() => onAction(state.kind)}
      >
        {state.actionLabel}
      </Button>
    </div>
  );
};
