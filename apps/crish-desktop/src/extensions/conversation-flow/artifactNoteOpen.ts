/**
 * 产物要编辑：只开已有 note 叶。无 docId 不调用、不 persist、不静默新建笔记。
 */
import { usableArtifactDocId } from '@crish/conversation-flow';

export type ArtifactNoteOpenResult = 'opened' | 'missing-docId';

export interface ArtifactNoteOpenInput {
  sessionId: string;
  docId?: string | null;
  openTool: (sessionId: string, panelId: string) => void;
}

/** 已有 docId 才 `openToolInSession(sid, 'note')`；缺省不创建 persist */
export function tryOpenExistingNoteForArtifact(
  input: ArtifactNoteOpenInput
): ArtifactNoteOpenResult {
  const docId = usableArtifactDocId(input.docId);
  if (!docId) return 'missing-docId';
  const sessionId = (input.sessionId || '').trim();
  if (!sessionId) return 'missing-docId';
  input.openTool(sessionId, 'note');
  return 'opened';
}
