/**
 * 叙事块纯函数：切片归属、pending 抽出、文档/代码路径分流。
 * 启发式结果一律前端派生；无 purpose_id。
 */
import type { PurposeNode } from '@crish/conversation-flow';
import type { ToolRenderItem } from '../../api/toolPresentation';
import type { MessageToolCall } from '../../store/types';

/** 思考折叠预览字数（方案锁 48–64） */
export const THINKING_PREVIEW_CHARS = 56;

const DOC_PATH_RE = /\.(md|markdown|txt|rst|adoc)$/i;

export function clipThinkingPreview(
  text: string,
  max: number = THINKING_PREVIEW_CHARS
): string {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

export function collectToolIds(items: readonly ToolRenderItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind === 'single') {
      ids.add(item.tc.id);
      continue;
    }
    for (const tc of item.tools) ids.add(tc.id);
  }
  return ids;
}

/**
 * 前端派生：Purpose 画在「首个 Action 所在」的 timeline 切片，避免拆组后重复挂树。
 */
export function purposesForSlice(
  purposes: readonly PurposeNode[],
  sliceIds: ReadonlySet<string>
): PurposeNode[] {
  const out: PurposeNode[] = [];
  for (const purpose of purposes) {
    const first = purpose.actions[0];
    if (first && sliceIds.has(first.id)) out.push(purpose);
  }
  return out;
}

/** pending_approval 不进 Purpose，S5 前仍走扁平行审批卡 */
export function extractPendingItems(
  items: readonly ToolRenderItem[]
): ToolRenderItem[] {
  const out: ToolRenderItem[] = [];
  for (const item of items) {
    if (item.kind === 'single') {
      if (item.tc.status === 'pending_approval') out.push(item);
      continue;
    }
    for (const tc of item.tools) {
      if (tc.status === 'pending_approval') {
        out.push({ kind: 'single', tc });
      }
    }
  }
  return out;
}

export function toolsByIdFromCalls(
  toolCalls: readonly MessageToolCall[] | undefined
): Map<string, MessageToolCall> {
  const map = new Map<string, MessageToolCall>();
  for (const tc of toolCalls ?? []) map.set(tc.id, tc);
  return map;
}

/** 前端派生：文档胶囊 vs 代码路径 */
export function isDocumentArtifactPath(path: string | undefined): boolean {
  if (!path) return false;
  return DOC_PATH_RE.test(path);
}

export function actionPathOf(
  action: { path?: string },
  tool: MessageToolCall | undefined
): string {
  if (action.path) return action.path;
  const args = tool?.arguments;
  if (!args) return '';
  try {
    const parsed: unknown = JSON.parse(args);
    if (!parsed || typeof parsed !== 'object') return '';
    const rec = parsed as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'filePath', 'target_file', 'file']) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    return '';
  }
  return '';
}
