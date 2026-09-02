/**
 * Shell 选择器与 legacy open-tabs map 读取（纯读取；运行期不写 map）。
 */

import { readScopedLocalStorageWithLegacyMigrate } from '../../api/shellWindowScope';
import {
  type OpenSessionTabsMap,
  OPEN_SESSION_TABS_KEY,
} from '../../api/workspaceChromeTabs';
import { pictureFromActiveLeaf } from './treeSessionQuery';

/** 读取 open-tabs map（仅冷启动迁移输入） */
export function loadLegacyOpenTabsMap(): OpenSessionTabsMap {
  try {
    const raw = readScopedLocalStorageWithLegacyMigrate(OPEN_SESSION_TABS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    return obj as OpenSessionTabsMap;
  } catch {
    return {};
  }
}

/** 画面会话 = 活动叶 active tab。忽略旧 openTabs 参数。 */
export function selectActiveTabSessionId(s?: {
  lastChatLeafId?: string | null;
}): string | null {
  return pictureFromActiveLeaf(s?.lastChatLeafId ?? null)?.sessionId ?? null;
}
