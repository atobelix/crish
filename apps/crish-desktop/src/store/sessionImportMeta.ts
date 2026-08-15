import type { SessionImportMeta } from './types';

/** 规范化外部导入 meta；非法则丢弃（不写坏字段） */
export function normalizeImportMeta(
  raw: SessionImportMeta | undefined
): SessionImportMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source =
    raw.source === 'claude-code' || raw.source === 'codex' ? raw.source : null;
  const sourceSessionId =
    typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId.trim() : '';
  if (!source || !sourceSessionId) return undefined;
  const meta: SessionImportMeta = { source, sourceSessionId };
  if (typeof raw.sourcePath === 'string' && raw.sourcePath.trim()) {
    meta.sourcePath = raw.sourcePath.trim();
  }
  if (typeof raw.importedAt === 'string' && raw.importedAt.trim()) {
    meta.importedAt = raw.importedAt.trim();
  }
  return meta;
}
