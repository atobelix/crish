/**
 * H1 工作区键 → persist docId。禁止把对话 ctx.sessionId 当文档 id。
 */
import { getActiveProjectId, getWorkspacePath } from '../../api/projectStore';
import {
  resolveProductStrictDocId,
  type ProductStrictDocResolution,
} from '../../components/workspace/workspaceEmptyStateStrictDoc';
import type { ViewRenderContext } from '../../services/view-registry';

/** 工作区键：活动项目 / 工作区路径 / default。不用 sessionId。 */
export function resolveNoteWorkspaceKey(): string {
  const projectId = getActiveProjectId();
  if (typeof projectId === 'string' && projectId.trim()) {
    return projectId.trim();
  }
  const wsPath = getWorkspacePath();
  if (typeof wsPath === 'string' && wsPath.trim()) {
    return wsPath.trim();
  }
  return 'default';
}

export function resolveNotePaperDoc(
  ctx: Pick<ViewRenderContext, 'params'>
): ProductStrictDocResolution {
  const wsId = resolveNoteWorkspaceKey();
  const raw = ctx.params?.docId;
  const productStrictDocId = typeof raw === 'string' ? raw : null;
  return resolveProductStrictDocId({
    wsId,
    productStrictDocId,
    recentPersistedDocId: null,
  });
}
