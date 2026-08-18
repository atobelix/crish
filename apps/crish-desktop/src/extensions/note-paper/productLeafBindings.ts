/**
 * H1 工作区键 → persist docId。禁止把对话 ctx.sessionId 当文档 id。
 *
 * 优先级只走 resolver 一条：显式 params.docId / `note:<docId>` →
 * recent persist（现码无 list/recent 命令，恒 null）→ pre-open bind →
 * 合成 `strict-${wsId}` 诚实空。≠ 打开完成。
 */
import { getActiveProjectId, getWorkspacePath } from '../../api/projectStore';
import {
  resolveProductStrictDocId,
  type ProductStrictDocResolution,
} from '../../components/workspace/workspaceEmptyStateStrictDoc';
import type { ViewRenderContext } from '../../services/view-registry';
import { resolveNoteUri } from './noteUri';

export type NotePaperDocContext = Pick<ViewRenderContext, 'params'> & {
  panelId?: string;
};

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

function asNonEmptyDocId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 显式档：`params.docId` 赢；否则 panelId 为 `note:<docId>`。
 * 不用 sessionId。空串 / 仅 `note:` 不算显式。
 */
export function resolveExplicitNoteDocId(
  ctx: NotePaperDocContext
): string | null {
  const fromParams = asNonEmptyDocId(ctx.params?.docId);
  if (fromParams) return fromParams;
  if (typeof ctx.panelId !== 'string') return null;
  return asNonEmptyDocId(resolveNoteUri(ctx.panelId)?.params.docId);
}

export function resolveNotePaperDoc(
  ctx: NotePaperDocContext
): ProductStrictDocResolution {
  const wsId = resolveNoteWorkspaceKey();
  return resolveProductStrictDocId({
    wsId,
    productStrictDocId: resolveExplicitNoteDocId(ctx),
    // 无 list/recent persist 命令；禁止编 IPC / localStorage 假账
    recentPersistedDocId: null,
  });
}
