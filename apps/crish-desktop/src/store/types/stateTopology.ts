import type { FileDiff } from '../types';

/** 四级状态层级分类 */
export const StateTier = {
  /** Tier 1: 全局持久化与工作区物理状态 (terminalStore, settingsStore) */
  Tier1Durable: 'Tier1Durable',
  /** Tier 2: 会话专属物理隔离状态 (sessionStore) */
  Tier2Session: 'Tier2Session',
  /** Tier 3: 布局与视口瞬态几何 (layoutStore, layoutTreeStore) */
  Tier3Layout: 'Tier3Layout',
  /** Tier 4: 空白草稿起跑线 (Clean Slate) */
  Tier4CleanDraft: 'Tier4CleanDraft',
} as const;

export type StateTier = (typeof StateTier)[keyof typeof StateTier];

/** 白板纯净门闩状态断言契约 */
export interface CleanSlateGuardState {
  readonly onEmptySurface: boolean;
  readonly isCleanDraft: boolean;
  readonly messageCount: number;
  readonly sessionDiffCount: number;
}

/** 呈现层视觉直写配置模型 */
export interface VisualThemeConfig {
  readonly uiSize: 'small' | 'medium' | 'large';
  readonly uiScaleValue: string;
  readonly shellChromeMode: 'classic' | 'unified';
  readonly theme: 'light' | 'dark' | 'system';
}

/** 会话专属快照模型 */
export interface SessionScopedSnapshot {
  readonly sessionId: string;
  readonly activeAgentId: string | null;
  readonly panelAgentId: string | null;
  readonly messagesCount: number;
  readonly isProcessing: boolean;
  readonly sessionDiffFiles: readonly FileDiff[];
}
