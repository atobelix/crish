/** 共享工具 — 供所有 Tab 组件使用 */

import type { JSX } from 'preact';
import { appState, type ChangedFile, type RightSidebarTabType } from '../../core/app-state';
import { isBackendNotWiredError, TAURI_COMMAND_REGISTRY } from '../../core/tauri-command-registry';
import { IconChat, IconFolder, IconShield, IconPackage, IconZap, IconSettings, IconActivity, IconPlay, IconList } from '../icons';

// ==================== Tab Icons Map ====================

export const TAB_ICONS: Record<RightSidebarTabType, () => JSX.Element> = {
  chat: IconChat,
  project: IconFolder,
  approvals: IconShield,
  artifacts: IconPackage,
  tools: IconZap,
  settings: IconSettings,
  diagnostics: IconActivity,
  runs: IconPlay,
  sessions: IconChat,
  plan: IconList,
};

// ==================== Helpers ====================

export const normalizePath = (p: string) => p.replace(/\\/g, '/');

export function warnBridgeDiagnostic(error: unknown): void {
  if (isBackendNotWiredError(error)) {
    console.warn('[Workbench][backend-not-wired]', error.diagnostic);
  }
}

/** 依据命令注册表判断某后端能力是否真正可用 */
export function isCommandUsable(command: string): boolean {
  const entry = TAURI_COMMAND_REGISTRY.get(command);
  if (!entry) return false;
  const cap = entry.capabilityStatus ?? entry.status;
  return (entry.status === 'implemented' || entry.status === 'experimental') && cap !== 'unsupported' && cap !== 'backend-not-wired';
}


// ==================== Status Badge ====================

export function StatusBadge({ status }: { status: ChangedFile['status'] }) {
  const config = {
    created: { label: 'A', cls: 'added' },
    modified: { label: 'M', cls: 'modified' },
    deleted: { label: 'D', cls: 'removed' },
  }[status] ?? { label: '?', cls: '' };
  return <span class={`repl-rs-status-badge ${config.cls}`}>{config.label}</span>;
}

// ==================== HTML Escape ====================

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}