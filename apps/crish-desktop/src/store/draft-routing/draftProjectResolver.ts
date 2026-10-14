/**
 * draftProjectResolver.ts — 最近活跃项目解析器（单一职责）。
 *
 * 核心规则（用户法旨）：
 * 1. 优先取当前活动会话（activeSessionId）所属的项目 folder（若非 GENERAL_FOLDER）；
 * 2. 其次遍历全量会话列表，按修改/创建时间戳降序排序，寻找最近活跃且绑有项目的会话 folder；
 * 3. 再次取当前激活项目 getActiveProjectId()；
 * 4. 若全系统无任何项目，兜底 GENERAL_FOLDER。
 */

import { isPendingDraft } from '../draftSession';
import type { SessionState } from '../types';
import {
  GENERAL_FOLDER,
  getActiveProjectId,
  listProjects,
  resolveFolderToProjectId,
} from '../../api/projectStore';

export interface SessionStateResolverInput {
  activeSessionId?: string | null;
  sessions?: SessionState[];
  sessionsById?: Record<string, SessionState>;
}

let sessionStateProvider: (() => SessionStateResolverInput | undefined) | null =
  null;

export function registerSessionStateProvider(
  provider: () => SessionStateResolverInput | undefined
): void {
  sessionStateProvider = provider;
}

function isValidProjectFolder(folder: string | null | undefined): boolean {
  const f = (folder || '').trim();
  if (
    !f ||
    f === GENERAL_FOLDER ||
    f === '会话' ||
    f === '常规会话' ||
    f === 'general'
  ) {
    return false;
  }
  // 若是内部 proj-* ID，必须在当前项目列表或别名中存在，否则为已删除项目的残留 ID
  if (/^proj-[a-z0-9_-]+$/i.test(f)) {
    const resolved = resolveFolderToProjectId(f);
    if (!resolved) {
      return false;
    }
    const projects = listProjects();
    if (projects.length > 0 && !projects.some((p) => p.id === resolved)) {
      return false;
    }
  }
  return true;
}

export function resolveMostActiveProjectFolder(
  inputState?: SessionStateResolverInput
): string {
  try {
    const sessionState = inputState ?? sessionStateProvider?.();
    if (sessionState) {
      const activeId = sessionState.activeSessionId;

      // 1. 优先取当前活动真会话所属项目
      if (activeId && !isPendingDraft(activeId)) {
        const activeSession =
          sessionState.sessionsById?.[activeId] ??
          sessionState.sessions?.find((s) => s.id === activeId);
        if (isValidProjectFolder(activeSession?.folder)) {
          return (
            resolveFolderToProjectId(activeSession!.folder!) ||
            activeSession!.folder!
          );
        }
      }

      // 2. 其次遍历全量会话列表，按时间降序查找最近活跃的项目
      const sessions = sessionState.sessions || [];
      const sorted = [...sessions].sort(
        (a, b) =>
          (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0)
      );
      for (const s of sorted) {
        if (isValidProjectFolder(s.folder)) {
          return resolveFolderToProjectId(s.folder!) || s.folder!;
        }
      }
    }

    // 3. 再次尝试获取当前 LocalStorage 激活的项目
    const activeProj = getActiveProjectId();
    if (isValidProjectFolder(activeProj)) {
      return activeProj!;
    }
  } catch {
    /* ignore error */
  }

  // 4. 兜底通用对话
  return GENERAL_FOLDER;
}
