/**
 * Shell 选择器与 legacy open-tabs map 读取（纯读取助手，无副作用写）。
 */

import { readScopedLocalStorageWithLegacyMigrate } from '../../api/shellWindowScope';
import {
  type OpenSessionTabsMap,
  OPEN_SESSION_TABS_KEY,
} from '../../api/workspaceChromeTabs';
import type { WorkspaceShellState } from './types';

/** 读取 open-tabs map（window-scoped；main 可从 unscoped 一次性 migrate） */
export function loadLegacyOpenTabsMap(): OpenSessionTabsMap {
  try {
    // Same scoped path as workspaceChromeTabs so hydrate + chrome stay aligned.
    const raw = readScopedLocalStorageWithLegacyMigrate(OPEN_SESSION_TABS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    return obj as OpenSessionTabsMap;
  } catch {
    return {};
  }
}

export function selectActiveTabSessionId(
  s: WorkspaceShellState
): string | null {
  const t = s.openTabs.find((x) => x.tabId === s.activeTabId);
  return t?.sessionId ?? null;
}
