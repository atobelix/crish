import type { WorkspaceState } from '../types';
import { makePanelCard, resolveWorkspacePanelKey } from './ui-panel';
import { ensureChatColumn, ensureToolColumn, normalizeColumnWidths, rebalanceGroupHeights } from './ui-workspace';
import { findCardInWorkspace, afterCardRemovedFromGroup, focusCardInWorkspace } from './ui-navigation';
import { expandToolColumnIfCollapsed, collapseToolColumnToTabs } from './ui-tool-column';
import { pruneEmptyWorkspaceLayout } from './ui-workspace';

export type PlacePanelResult = 'focused' | 'placed' | 'skipped';

export function placePanelCard(ws: WorkspaceState, key: string, opts?: { tabMode?: boolean; stamp?: number | string }): PlacePanelResult {
  const cardId = resolveWorkspacePanelKey(key);
  if (!cardId || cardId === 'chat') { ensureChatColumn(ws); return 'skipped'; }
  if (focusCardInWorkspace(ws, cardId)) { expandToolColumnIfCollapsed(ws); ensureChatColumn(ws); return 'focused'; }
  ensureChatColumn(ws);
  const toolCol = ensureToolColumn(ws);
  const card = makePanelCard(cardId);
  const stamp = opts?.stamp ?? Date.now();
  if (opts?.tabMode) {
    if (toolCol.groups.length > 1) collapseToolColumnToTabs(ws);
    if (toolCol.groups.length > 0) {
      const targetGroup = toolCol.groups[0]!;
      if (!targetGroup.cards.some((c) => c.id === cardId)) targetGroup.cards.push(card);
      targetGroup.activeCardId = cardId; targetGroup.heightRatio = 1;
      toolCol.groups = [targetGroup];
      expandToolColumnIfCollapsed(ws); ensureChatColumn(ws); normalizeColumnWidths(ws); expandToolColumnIfCollapsed(ws);
      return 'placed';
    }
    toolCol.groups = [{ id: `group-tools-${stamp}-${ws.id}`, activeCardId: cardId, cards: [card], heightRatio: 1 }];
    ensureChatColumn(ws); normalizeColumnWidths(ws); expandToolColumnIfCollapsed(ws);
    return 'placed';
  }
  toolCol.groups.push({ id: `group-${cardId}-${stamp}-${ws.id}`, activeCardId: cardId, cards: [card], heightRatio: 1 });
  rebalanceGroupHeights(toolCol); ensureChatColumn(ws); normalizeColumnWidths(ws); expandToolColumnIfCollapsed(ws);
  return 'placed';
}

export function removePanelCard(ws: WorkspaceState, key: string): boolean {
  const cardId = resolveWorkspacePanelKey(key);
  if (!cardId || cardId === 'chat') { ensureChatColumn(ws); return false; }
  const loc = findCardInWorkspace(ws, cardId);
  if (!loc) { ensureChatColumn(ws); return false; }
  const { group, cardIdx } = loc;
  group.cards.splice(cardIdx, 1);
  afterCardRemovedFromGroup(ws, group, group.id, cardId, cardIdx);
  pruneEmptyWorkspaceLayout(ws, true);
  ensureChatColumn(ws);
  return true;
}
