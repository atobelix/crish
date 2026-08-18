import type { CardState, CardGroupState } from '../types';
import { viewRegistry } from '../../services/view-registry';

export function getPanelTitle(cardId: string): string {
  return viewRegistry.getTitle(cardId);
}

export function resolveWorkspacePanelKey(key: string | null | undefined): string | null {
  if (key == null) return null;
  const id = String(key).trim();
  if (!id) return null;
  if (id === 'settings' || id === 'runtime') return null;
  return id;
}

export function makePanelCard(cardId: string): CardState {
  return { id: cardId, title: getPanelTitle(cardId) };
}

export function makePanelGroup(cardId: string, wsId: string, opts?: { groupId?: string; heightRatio?: number }): CardGroupState {
  return {
    id: opts?.groupId ?? `group-${cardId}-${wsId}`,
    activeCardId: cardId, cards: [makePanelCard(cardId)],
    heightRatio: opts?.heightRatio ?? 1,
  };
}
