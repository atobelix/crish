import type { CardState, CardGroupState, ColumnState, WorkspaceState } from '../types';
import { rebalanceGroupHeights } from './ui-workspace';

export type GroupLocation = { col: ColumnState; group: CardGroupState; colIdx: number; groupIdx: number };
export type CardLocation = GroupLocation & { card: CardState; cardIdx: number };

export function findGroupInWorkspace(ws: WorkspaceState, groupId: string): GroupLocation | null {
  for (let colIdx = 0; colIdx < ws.columns.length; colIdx++) {
      const col = ws.columns[colIdx]!;
      for (let groupIdx = 0; groupIdx < col.groups.length; groupIdx++) {
        const group = col.groups[groupIdx]!;
        if (group.id === groupId) return { col, group, colIdx, groupIdx };
      }
  }
  return null;
}

export function findCardInWorkspace(ws: WorkspaceState, cardId: string): CardLocation | null {
  for (let colIdx = 0; colIdx < ws.columns.length; colIdx++) {
      const col = ws.columns[colIdx]!;
      for (let groupIdx = 0; groupIdx < col.groups.length; groupIdx++) {
        const group = col.groups[groupIdx]!;
        const cardIdx = group.cards.findIndex((c) => c.id === cardId);
        if (cardIdx !== -1) return { col, group, colIdx, groupIdx, card: group.cards[cardIdx]!, cardIdx };
      }
  }
  return null;
}

export function focusCardInWorkspace(ws: WorkspaceState, cardId: string): boolean {
  const loc = findCardInWorkspace(ws, cardId);
  if (!loc) return false;
  loc.group.activeCardId = cardId;
  return true;
}

export function extractCardFromGroup(ws: WorkspaceState, groupId: string, cardId: string): {
  card: CardState; sourceGroup: CardGroupState; sourceCol: ColumnState; removedIndex: number;
} | null {
  const loc = findGroupInWorkspace(ws, groupId);
  if (!loc) return null;
  const idx = loc.group.cards.findIndex((c) => c.id === cardId);
  if (idx === -1) return null;
  const card = loc.group.cards.splice(idx, 1)[0]!;
  return { card, sourceGroup: loc.group, sourceCol: loc.col, removedIndex: idx };
}

export function removeEmptyGroup(ws: WorkspaceState, groupId: string): void {
  for (const col of ws.columns) {
    const before = col.groups.length;
    col.groups = col.groups.filter((g) => g.id !== groupId);
    if (col.groups.length > 0 && col.groups.length !== before) rebalanceGroupHeights(col);
  }
}

export function pickActiveCardIndexAfterRemove(remainingLength: number, removedIndex?: number): number {
  if (remainingLength <= 0) return -1;
  if (removedIndex === undefined) return 0;
  return Math.min(Math.max(0, removedIndex > 0 ? removedIndex - 1 : 0), remainingLength - 1);
}

export function afterCardRemovedFromGroup(ws: WorkspaceState, sourceGroup: CardGroupState, sourceGroupId: string, removedCardId: string, removedIndex?: number): void {
  if (sourceGroup.cards.length === 0) { removeEmptyGroup(ws, sourceGroupId); return; }
  if (sourceGroup.activeCardId !== removedCardId) return;
  const pick = pickActiveCardIndexAfterRemove(sourceGroup.cards.length, removedIndex);
  if (pick < 0) return;
  sourceGroup.activeCardId = sourceGroup.cards[pick]!.id;
}

export function adjustSameGroupReorderIndex(fromIdx: number, targetIndex: number | undefined, remainingLength: number): number {
  if (remainingLength <= 0) return 0;
  if (targetIndex === undefined) return remainingLength;
  let toIdx = targetIndex;
  if (toIdx > fromIdx) toIdx = Math.max(0, toIdx - 1);
  return Math.min(Math.max(0, toIdx), remainingLength);
}

export function insertCardIntoGroup(group: CardGroupState, card: CardState, targetIndex?: number): void {
  if (targetIndex !== undefined && targetIndex >= 0 && targetIndex <= group.cards.length) group.cards.splice(targetIndex, 0, card);
  else group.cards.push(card);
  group.activeCardId = card.id;
}
