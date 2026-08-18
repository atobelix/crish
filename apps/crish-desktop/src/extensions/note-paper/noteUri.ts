import type { ViewUriResolver } from '../../services/view-registry';

export const NOTE_URI_PREFIX = 'note:';

/** `note:<docId>` → 扩展 view `note`（不进 ViewRegistry.initDefaultResolvers） */
export function resolveNoteUri(
  uri: string
): { viewId: string; params: Record<string, unknown> } | null {
  if (!uri.startsWith(NOTE_URI_PREFIX)) return null;
  const raw = uri.slice(NOTE_URI_PREFIX.length);
  let docId = raw;
  try {
    docId = decodeURIComponent(raw);
  } catch {
    docId = raw;
  }
  return { viewId: 'note', params: { docId } };
}

export const NOTE_URI_RESOLVER: ViewUriResolver = {
  prefix: NOTE_URI_PREFIX,
  resolve: resolveNoteUri,
};
