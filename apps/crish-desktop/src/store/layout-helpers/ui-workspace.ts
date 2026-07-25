import type { CardState, ColumnState, WorkspaceState } from '../types';
import { isDemoMode } from '../../api/appMode';
import { makePanelCard } from './ui-panel';

export function isChatColumnId(colId: string): boolean { return colId.includes('chat'); }
export function isChatColumn(col: ColumnState): boolean { return isChatColumnId(col.id); }

export function normalizeColumnWidths(ws: WorkspaceState): void {
  if (ws.columns.length === 0) return;
  let sum = 0;
  for (const c of ws.columns) { if (!(c.widthRatio > 0)) c.widthRatio = 0; sum += c.widthRatio; }
  if (sum <= 0) { const even = 1 / ws.columns.length; ws.columns.forEach((c) => { c.widthRatio = even; }); return; }
  ws.columns.forEach((c) => { c.widthRatio /= sum; });
}

export function rebalanceGroupHeights(col: ColumnState): void {
  if (col.groups.length === 0) return;
  const evenHeight = 1 / col.groups.length;
  col.groups.forEach((g) => { g.heightRatio = evenHeight; });
}

export function filterEmptyColumnsKeepingChat(ws: WorkspaceState, normalize = true): void {
  ws.columns = ws.columns.filter((c) => isChatColumn(c) || c.groups.length > 0);
  if (normalize && ws.columns.length > 0) normalizeColumnWidths(ws);
}

export function pruneEmptyGroupsInColumn(col: ColumnState): boolean {
  const before = col.groups.length;
  col.groups = col.groups.filter((g) => g.cards.length > 0);
  if (col.groups.length === before) return false;
  if (col.groups.length > 0) rebalanceGroupHeights(col);
  return true;
}

export function pruneEmptyWorkspaceLayout(ws: WorkspaceState, normalize = true): void {
  for (const col of ws.columns) pruneEmptyGroupsInColumn(col);
  filterEmptyColumnsKeepingChat(ws, normalize);
}

export function isChatOnlyWorkspace(ws: WorkspaceState): boolean {
  if (!ws.columns.length) return true;
  for (const col of ws.columns) { for (const g of col.groups) { for (const c of g.cards) { if (c.id !== 'chat') return false; } } }
  return true;
}

export function countWorkspaceCards(ws: WorkspaceState): number {
  let n = 0;
  for (const col of ws.columns) { for (const g of col.groups) n += g.cards.length; }
  return n;
}

export function ensureChatColumn(ws: WorkspaceState): void {
  const chatCard = (): CardState => makePanelCard('chat');
  let chatCol = ws.columns.find((c) => isChatColumn(c));
  if (!chatCol) {
    chatCol = { id: `col-chat-${ws.id}`, widthRatio: 0.5, groups: [{ id: `group-chat-${ws.id}`, activeCardId: 'chat', cards: [chatCard()], heightRatio: 1 }] };
    ws.columns.unshift(chatCol);
  } else {
    let hasChat = false;
    for (const g of chatCol.groups) {
      if (g.cards.some((c) => c.id === 'chat')) { hasChat = true; if (!g.cards.some((c) => c.id === g.activeCardId)) g.activeCardId = 'chat'; break; }
    }
    if (!hasChat) {
      if (chatCol.groups.length === 0) chatCol.groups.push({ id: `group-chat-${ws.id}`, activeCardId: 'chat', cards: [chatCard()], heightRatio: 1 });
      else { chatCol.groups[0]!.cards.unshift(chatCard()); chatCol.groups[0]!.activeCardId = 'chat'; }
    }
  }
  ws.columns = ws.columns.filter((c) => isChatColumn(c) || c.groups.length > 0);
  if (!ws.columns.some((c) => isChatColumn(c))) ws.columns.unshift(chatCol);
}

export function ensureToolColumn(ws: WorkspaceState): ColumnState {
  ensureChatColumn(ws);
  let toolCol = ws.columns.find((c) => !isChatColumn(c));
  if (!toolCol) {
    toolCol = { id: `col-tools-${ws.id}`, widthRatio: 0.34, groups: [] };
    ws.columns.push(toolCol);
    const chatCol = ws.columns.find((c) => isChatColumn(c));
    if (chatCol) chatCol.widthRatio = 0.66;
  }
  return toolCol;
}

export function createDefaultWorkspace(id: string): WorkspaceState {
  if (!isDemoMode()) {
    return { id, columns: [{ id: `col-chat-${id}`, widthRatio: 1, groups: [{ id: `group-chat-${id}`, activeCardId: 'chat', cards: [{ id: 'chat', title: '对话' }], heightRatio: 1 }] }] };
  }
  return {
    id, columns: [
      { id: `col-chat-${id}`, widthRatio: 0.42, groups: [{ id: `group-chat-${id}`, activeCardId: 'chat', cards: [{ id: 'chat', title: '对话' }], heightRatio: 1.0 }] },
      { id: `col-1-${id}`, widthRatio: 0.29, groups: [{ id: `group-preview-${id}`, activeCardId: 'preview', cards: [{ id: 'preview', title: '预览' }], heightRatio: 1.0 }] },
      { id: `col-2-${id}`, widthRatio: 0.29, groups: [{ id: `group-diff-${id}`, activeCardId: 'diff', cards: [{ id: 'diff', title: '变更' }], heightRatio: 0.5 }, { id: `group-tasks-${id}`, activeCardId: 'tasks', cards: [{ id: 'tasks', title: '任务' }], heightRatio: 0.5 }] },
    ],
  };
}
