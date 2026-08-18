/**
 * H1 工作区键 → persist docId。禁止把对话 ctx.sessionId 当文档 id。
 *
 * 优先级只走 resolver 一条：显式 params.docId / `note:<docId>` →
 * recent persist（`note_document_recent` / `doc_meta`+`blocks`）→
 * pre-open bind → 合成 `strict-${wsId}` 诚实空。≠ 打开完成。
 */
import { noteDocumentRecent } from '../../api/noteApi';
import { getActiveProjectId, getWorkspacePath } from '../../api/projectStore';
import type { ViewRenderContext } from '../../services/view-registry';
import { resolveNoteUri } from './noteUri';
import {
  resolveProductStrictDocId,
  type ProductStrictDocResolution,
} from './productStrictDoc';

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

/**
 * 经 `noteDocumentRecent` 查最近一篇 persist 非空 doc（命令体+前端已有）。
 * 无命中 / 非 Tauri / invoke missing 或失败 → `null`；
 * HEAD rust `generate_handler` 未登记时真壳走 missing。**≠** 打开完成。
 */
export async function loadRecentPersistedDocId(): Promise<string | null> {
  return noteDocumentRecent();
}

export function resolveNotePaperDoc(
  ctx: NotePaperDocContext,
  recentPersistedDocId: string | null = null
): ProductStrictDocResolution {
  const wsId = resolveNoteWorkspaceKey();
  return resolveProductStrictDocId({
    wsId,
    productStrictDocId: resolveExplicitNoteDocId(ctx),
    recentPersistedDocId,
  });
}
