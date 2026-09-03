/**
 * draftProjectResolver.ts — 最近活跃项目解析器（单一职责）。
 *
 * 核心规则（用户法旨）：
 * 1. 优先取当前活动会话（activeSessionId）所属的项目 folder（若非 GENERAL_FOLDER）；
 * 2. 其次遍历全量会话列表，按修改/创建时间戳降序排序，寻找最近活跃且绑有项目的会话 folder；
 * 3. 再次取当前激活项目 getActiveProjectId()；
 * 4. 若全系统无任何项目，兜底 GENERAL_FOLDER。
 */

import { useSessionStore } from '../sessionStore';
import { isPendingDraft } from '../draftSession';
import { GENERAL_FOLDER, getActiveProjectId } from '../../api/projectStore';

export function resolveMostActiveProjectFolder(): string {
  try {
    const sessionState = useSessionStore.getState();
    const activeId = sessionState.activeSessionId;

    // 1. 优先取当前活动真会话所属项目
    if (activeId && !isPendingDraft(activeId)) {
      const activeSession =
        sessionState.sessionsById?.[activeId] ??
        sessionState.sessions?.find((s) => s.id === activeId);
      if (
        activeSession?.folder &&
        activeSession.folder !== GENERAL_FOLDER &&
        activeSession.folder.trim() !== ''
      ) {
        return activeSession.folder;
      }
    }

    // 2. 其次遍历全量会话列表，按时间降序查找最近活跃的项目
    const sessions = sessionState.sessions || [];
    const sorted = [...sessions].sort(
      (a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0)
    );
    for (const s of sorted) {
      if (s.folder && s.folder !== GENERAL_FOLDER && s.folder.trim() !== '') {
        return s.folder;
      }
    }

    // 3. 再次尝试获取当前 LocalStorage 激活的项目
    const activeProj = getActiveProjectId();
    if (activeProj && activeProj !== GENERAL_FOLDER) {
      return activeProj;
    }
  } catch {
    /* ignore error */
  }

  // 4. 兜底通用对话
  return GENERAL_FOLDER;
}
