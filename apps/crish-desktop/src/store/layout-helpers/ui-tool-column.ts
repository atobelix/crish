import type { CardState, WorkspaceState } from '../types';
import { makePanelCard, resolveWorkspacePanelKey } from './ui-panel';
import {
  ensureChatColumn,
  isChatColumn,
  normalizeColumnWidths,
  rebalanceGroupHeights,
} from './ui-workspace';

const TOOL_COL_STATE_SS_PREFIX = 'crish_tool_col_state_v1:';
const TOOL_COL_WIDTH_SS_PREFIX = 'crish_tool_col_w_v1:';

type ToolColRememberedState = { widthRatio: number; activeCardId?: string };

function toolColStateKey(wsId: string): string { return `${TOOL_COL_STATE_SS_PREFIX}${wsId}`; }
function toolColWidthKey(wsId: string): string { return `${TOOL_COL_WIDTH_SS_PREFIX}${wsId}`; }

function readToolColState(wsId: string): ToolColRememberedState {
  let widthRatio = 0.34;
  let activeCardId: string | undefined;
  try {
    const raw = sessionStorage.getItem(toolColStateKey(wsId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ToolColRememberedState>;
      const n = Number(parsed?.widthRatio);
      if (Number.isFinite(n) && n >= 0.15 && n <= 0.7) widthRatio = n;
      const id = typeof parsed?.activeCardId === 'string' ? parsed.activeCardId.trim() : '';
      if (id) activeCardId = id;
    } else {
      const legacy = sessionStorage.getItem(toolColWidthKey(wsId));
      const n = legacy ? parseFloat(legacy) : NaN;
      if (Number.isFinite(n) && n >= 0.15 && n <= 0.7) widthRatio = n;
    }
  } catch { /* ignore */ }
  return { widthRatio, ...(activeCardId !== undefined ? { activeCardId } : {}) };
}

function writeToolColState(wsId: string, state: ToolColRememberedState): void {
  try {
    sessionStorage.setItem(toolColStateKey(wsId), JSON.stringify(state));
    sessionStorage.setItem(toolColWidthKey(wsId), String(state.widthRatio));
  } catch { /* ignore */ }
}

export function collapseToolColumnPreserve(ws: WorkspaceState): boolean {
  ensureChatColumn(ws);
  const tool = ws.columns.find((c) => !isChatColumn(c));
  if (!tool || tool.groups.length === 0) return false;
  if (!tool.groups.some((g) => g.cards.length > 0)) return false;
  if (tool.widthRatio > 0 && tool.widthRatio < 0.04) return false;
  const activeCardId = tool.groups.find((g) => g.cards.some((c) => c.id === g.activeCardId))?.activeCardId
    || tool.groups[0]?.activeCardId || tool.groups[0]?.cards[0]?.id;
  writeToolColState(ws.id, {
    widthRatio: tool.widthRatio > 0.05 ? tool.widthRatio : 0.34,
    activeCardId: activeCardId || undefined,
  });
  tool.widthRatio = 0.001;
  const chat = ws.columns.find((c) => isChatColumn(c));
  if (chat) chat.widthRatio = 0.999;
  normalizeColumnWidths(ws);
  const t2 = ws.columns.find((c) => !isChatColumn(c));
  const c2 = ws.columns.find((c) => isChatColumn(c));
  if (t2 && c2) { t2.widthRatio = 0; c2.widthRatio = 1; }
  return true;
}

export function expandToolColumnIfCollapsed(ws: WorkspaceState): boolean {
  ensureChatColumn(ws);
  const tool = ws.columns.find((c) => !isChatColumn(c));
  if (!tool) return false;
  if (!tool.groups.some((g) => g.cards.length > 0)) return false;
  if (tool.widthRatio >= 0.08) return false;
  const saved = readToolColState(ws.id);
  tool.widthRatio = saved.widthRatio;
  if (saved.activeCardId) { for (const g of tool.groups) { if (g.cards.some((c) => c.id === saved.activeCardId)) { g.activeCardId = saved.activeCardId; break; } } }
  const chat = ws.columns.find((c) => isChatColumn(c));
  if (chat) chat.widthRatio = Math.max(0.3, 1 - saved.widthRatio);
  normalizeColumnWidths(ws);
  return true;
}

export function collapseToolColumnToTabs(ws: WorkspaceState): boolean {
  ensureChatColumn(ws);
  const toolCol = ws.columns.find((c) => !isChatColumn(c));
  if (!toolCol || toolCol.groups.length <= 1) return false;
  const seen = new Set<string>();
  const mergedCards: CardState[] = [];
  const preferredActive = toolCol.groups[0]?.activeCardId || '';
  for (const g of toolCol.groups) {
    for (const c of g.cards) {
      const id = resolveWorkspacePanelKey(c.id);
      if (!id || id === 'chat' || seen.has(id)) continue;
      seen.add(id);
      mergedCards.push(id === c.id ? c : makePanelCard(id));
    }
  }
  if (mergedCards.length === 0) { toolCol.groups = []; return true; }
  const active = preferredActive && mergedCards.some((c) => c.id === preferredActive) ? preferredActive : mergedCards[0]!.id;
  toolCol.groups = [{
    id: toolCol.groups[0]?.id || `group-tools-${ws.id}`,
    activeCardId: active, cards: mergedCards, heightRatio: 1,
  }];
  ensureChatColumn(ws);
  return true;
}

/** 合并标签关闭：每个工具卡独立成组（上下堆叠）。已是单卡组则 no-op。 */
export function splitToolColumnToStackedGroups(ws: WorkspaceState): boolean {
  ensureChatColumn(ws);
  const toolCol = ws.columns.find((c) => !isChatColumn(c));
  if (!toolCol) return false;
  const seen = new Set<string>();
  const cards: CardState[] = [];
  for (const g of toolCol.groups) {
    for (const c of g.cards) {
      const id = resolveWorkspacePanelKey(c.id);
      if (!id || id === 'chat' || seen.has(id)) continue;
      seen.add(id);
      cards.push(id === c.id ? c : makePanelCard(id));
    }
  }
  if (cards.length === 0) return false;
  const alreadyStacked =
    toolCol.groups.length === cards.length &&
    toolCol.groups.every((g) => g.cards.length === 1);
  if (alreadyStacked) return false;
  toolCol.groups = cards.map((card, i) => ({
    id: `group-${card.id}-${ws.id}-${i}`,
    activeCardId: card.id,
    cards: [card],
    heightRatio: 1 / cards.length,
  }));
  rebalanceGroupHeights(toolCol);
  ensureChatColumn(ws);
  return true;
}
