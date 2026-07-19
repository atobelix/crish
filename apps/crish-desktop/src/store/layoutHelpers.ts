/**
 * layoutStore 纯辅助：不依赖 zustand set/get 闭包。
 * 可在 immer draft 上原地修改 WorkspaceState / Diff / Terminal 缓冲。
 */

import { MAX_DIFF_FILES } from '@crish/shared-utils/browser';
import { isDemoMode } from '../api/appMode';
import { hydrateSessionsFromDisk } from '../api/sessionPersistence';
import { GENERAL_FOLDER } from '../api/projectStore';
import { normalizeAssistantTimeline } from '../api/toolPresentation';
import {
  fillDefaultSessionTitles,
  pruneEmptyShellSessions,
} from '../api/sessionTitle';
import type {
  CardGroupState,
  CardState,
  ColumnState,
  FileDiff,
  WorkspaceState,
  SessionState,
} from './types';

// ── Panel titles ────────────────────────────────────────────────────────────

/** togglePanel / 打开侧栏工具时的展示名（标签栏短中文） */
export const PANEL_TITLE_MAP: Record<string, string> = {
  /** 子 agent 对话侧栏：纯聊天 UI；列表/管理在总览 */
  agent: '聊天',
  overview: '总览',
  files: '文件',
  preview: '预览',
  diff: '变更',
  terminal: '终端',
  tasks: '任务',
  runtime: '运行',
  chat: '对话',
  settings: '设置',
  plan: '计划',
};

export function getPanelTitle(cardId: string): string {
  return PANEL_TITLE_MAP[cardId] || cardId;
}

/**
 * 侧栏/toggle 用的面板 id 归一：
 * - browser → preview（同一面板）
 * - plan → tasks（计划进度走任务板）
 * - settings / runtime → null（浮层，不进 workspace 列）
 * - 空串 → null
 */
export function resolveWorkspacePanelKey(
  key: string | null | undefined,
): string | null {
  if (key == null) return null;
  const id = String(key).trim();
  if (!id) return null;
  if (id === 'settings' || id === 'runtime') return null;
  if (id === 'browser') return 'preview';
  if (id === 'plan') return 'tasks';
  return id;
}

/** 构造带标题的面板卡（不写 store） */
export function makePanelCard(cardId: string): CardState {
  return { id: cardId, title: getPanelTitle(cardId) };
}

/** 构造单卡 group；stamp 可注入以稳定测试 id */
export function makePanelGroup(
  cardId: string,
  wsId: string,
  opts?: { groupId?: string; heightRatio?: number },
): CardGroupState {
  return {
    id: opts?.groupId ?? `group-${cardId}-${wsId}`,
    activeCardId: cardId,
    cards: [makePanelCard(cardId)],
    heightRatio: opts?.heightRatio ?? 1,
  };
}

// ── Column / group geometry ─────────────────────────────────────────────────

/** 列 id 是否为 chat 锁列 */
export function isChatColumnId(colId: string): boolean {
  return colId.includes('chat');
}

/** 列是否为 chat 锁列 */
export function isChatColumn(col: ColumnState): boolean {
  return isChatColumnId(col.id);
}

/** 将各列 widthRatio 归一化为和为 1；非正宽度按 0 处理，全 0 时均分 */
export function normalizeColumnWidths(ws: WorkspaceState): void {
  if (ws.columns.length === 0) return;
  let sum = 0;
  for (const c of ws.columns) {
    if (!(c.widthRatio > 0)) c.widthRatio = 0;
    sum += c.widthRatio;
  }
  if (sum <= 0) {
    const even = 1 / ws.columns.length;
    ws.columns.forEach((c) => {
      c.widthRatio = even;
    });
    return;
  }
  ws.columns.forEach((c) => {
    c.widthRatio /= sum;
  });
}

/** 将列内各组 heightRatio 均分 */
export function rebalanceGroupHeights(col: ColumnState): void {
  if (col.groups.length === 0) return;
  const evenHeight = 1 / col.groups.length;
  col.groups.forEach((g) => {
    g.heightRatio = evenHeight;
  });
}

/** 去掉空列，但始终保留 chat 列；可选再归一化宽度 */
export function filterEmptyColumnsKeepingChat(
  ws: WorkspaceState,
  normalize = true,
): void {
  ws.columns = ws.columns.filter((c) => isChatColumn(c) || c.groups.length > 0);
  if (normalize && ws.columns.length > 0) {
    normalizeColumnWidths(ws);
  }
}

/**
 * 去掉列内空 group 并 rebalance；返回是否删过组。
 * 不删除列本身——配合 filterEmptyColumnsKeepingChat。
 */
export function pruneEmptyGroupsInColumn(col: ColumnState): boolean {
  const before = col.groups.length;
  col.groups = col.groups.filter((g) => g.cards.length > 0);
  if (col.groups.length === before) return false;
  if (col.groups.length > 0) rebalanceGroupHeights(col);
  return true;
}

/**
 * 全工作区：剪空组 → 剪空列（保 chat）→ 可选归一化列宽。
 * 关闭/移走标签后的统一收尾，避免残留空壳布局。
 */
export function pruneEmptyWorkspaceLayout(
  ws: WorkspaceState,
  normalize = true,
): void {
  for (const col of ws.columns) {
    pruneEmptyGroupsInColumn(col);
  }
  filterEmptyColumnsKeepingChat(ws, normalize);
}

/**
 * 工作区是否「仅对话」空工具态：
 * - 没有任何工具卡（非 chat 的 card）
 * - 或仅有 chat 列且无其它 group 卡片
 * 空 columns 也视为 empty tool surface。
 */
export function isChatOnlyWorkspace(ws: WorkspaceState): boolean {
  if (!ws.columns.length) return true;
  for (const col of ws.columns) {
    for (const g of col.groups) {
      for (const c of g.cards) {
        if (c.id !== 'chat') return false;
      }
    }
  }
  return true;
}

/** 统计工作区内全部卡片数（含 chat） */
export function countWorkspaceCards(ws: WorkspaceState): number {
  let n = 0;
  for (const col of ws.columns) {
    for (const g of col.groups) n += g.cards.length;
  }
  return n;
}

// ── Workspace group / card lookup（workspaceActions 共用，去掉 any）──────────

export type GroupLocation = {
  col: ColumnState;
  group: CardGroupState;
  colIdx: number;
  groupIdx: number;
};

/** 卡片在工作区内的完整坐标（含 card 引用，便于 immer 原地改） */
export type CardLocation = GroupLocation & {
  card: CardState;
  cardIdx: number;
};

/** 按 groupId 定位列与组 */
export function findGroupInWorkspace(
  ws: WorkspaceState,
  groupId: string,
): GroupLocation | null {
  for (let colIdx = 0; colIdx < ws.columns.length; colIdx++) {
    const col = ws.columns[colIdx];
    for (let groupIdx = 0; groupIdx < col.groups.length; groupIdx++) {
      const group = col.groups[groupIdx];
      if (group.id === groupId) {
        return { col, group, colIdx, groupIdx };
      }
    }
  }
  return null;
}

/** 按 cardId 定位首个匹配卡片（含 col/group/card 引用） */
export function findCardInWorkspace(
  ws: WorkspaceState,
  cardId: string,
): CardLocation | null {
  for (let colIdx = 0; colIdx < ws.columns.length; colIdx++) {
    const col = ws.columns[colIdx];
    for (let groupIdx = 0; groupIdx < col.groups.length; groupIdx++) {
      const group = col.groups[groupIdx];
      const cardIdx = group.cards.findIndex((c) => c.id === cardId);
      if (cardIdx !== -1) {
        return {
          col,
          group,
          colIdx,
          groupIdx,
          card: group.cards[cardIdx],
          cardIdx,
        };
      }
    }
  }
  return null;
}

/**
 * 聚焦已有面板卡：将所在 group 的 activeCardId 切到 cardId。
 * 纯函数（改 draft）；找不到返回 false。不新建面板。
 */
export function focusCardInWorkspace(ws: WorkspaceState, cardId: string): boolean {
  const loc = findCardInWorkspace(ws, cardId);
  if (!loc) return false;
  loc.group.activeCardId = cardId;
  return true;
}

/**
 * 从源组取出卡片（splice）；找不到返回 null。
 * 返回 removedIndex 供 afterCardRemovedFromGroup 优先切到左侧邻居。
 * 不清理空组——调用方决定是否 removeEmptyGroup / rebalance。
 */
export function extractCardFromGroup(
  ws: WorkspaceState,
  groupId: string,
  cardId: string,
): {
  card: CardState;
  sourceGroup: CardGroupState;
  sourceCol: ColumnState;
  removedIndex: number;
} | null {
  const loc = findGroupInWorkspace(ws, groupId);
  if (!loc) return null;
  const idx = loc.group.cards.findIndex((c) => c.id === cardId);
  if (idx === -1) return null;
  const [card] = loc.group.cards.splice(idx, 1);
  return { card, sourceGroup: loc.group, sourceCol: loc.col, removedIndex: idx };
}

/** 删除指定空 group，并 rebalance 该列高度 */
export function removeEmptyGroup(ws: WorkspaceState, groupId: string): void {
  for (const col of ws.columns) {
    const before = col.groups.length;
    col.groups = col.groups.filter((g) => g.id !== groupId);
    if (col.groups.length > 0 && col.groups.length !== before) {
      rebalanceGroupHeights(col);
    }
  }
}

/**
 * 关闭/移走标签后应激活的下标（浏览器式：优先左侧邻居）。
 * remainingLength 为 splice 后的长度；空组返回 -1。
 * 不假设存在 chat——关 agent 不会因此落到「重开对话」。
 */
export function pickActiveCardIndexAfterRemove(
  remainingLength: number,
  removedIndex?: number,
): number {
  if (remainingLength <= 0) return -1;
  if (removedIndex === undefined) return 0;
  // splice 后：左侧邻居在 removedIndex-1；若关的是首项则取新 0
  return Math.min(
    Math.max(0, removedIndex > 0 ? removedIndex - 1 : 0),
    remainingLength - 1,
  );
}

/**
 * 源组被掏空后：删组；否则若 active 被移走则优先切到左侧邻居（浏览器标签行为）。
 * removedIndex：splice 前的下标；缺省时落到 cards[0]。
 * 绝不强制创建/激活 chat——关闭 agent 等工具标签不会重开主对话。
 */
export function afterCardRemovedFromGroup(
  ws: WorkspaceState,
  sourceGroup: CardGroupState,
  sourceGroupId: string,
  removedCardId: string,
  removedIndex?: number,
): void {
  if (sourceGroup.cards.length === 0) {
    removeEmptyGroup(ws, sourceGroupId);
    return;
  }
  if (sourceGroup.activeCardId !== removedCardId) return;
  const pick = pickActiveCardIndexAfterRemove(sourceGroup.cards.length, removedIndex);
  if (pick < 0) return;
  sourceGroup.activeCardId = sourceGroup.cards[pick].id;
}

// ── Panel / card placement（toggle 开面板 / 工具列；不触 store 闭包）────────

export type PlacePanelResult = 'focused' | 'placed' | 'skipped';

/**
 * 取得或创建「工具列」（非 chat）。工具永远在 chat 旁，不进 chat 列。
 * 新建时默认 chat:0.66 / tools:0.34。
 */
export function ensureToolColumn(ws: WorkspaceState): ColumnState {
  ensureChatColumn(ws);
  let toolCol = ws.columns.find((c) => !isChatColumn(c));
  if (!toolCol) {
    toolCol = {
      id: `col-tools-${ws.id}`,
      widthRatio: 0.34,
      groups: [],
    };
    ws.columns.push(toolCol);
    const chatCol = ws.columns.find((c) => isChatColumn(c));
    if (chatCol) chatCol.widthRatio = 0.66;
  }
  return toolCol;
}

/** 右侧工具列折叠态：宽度 + 激活标签，session 内可恢复 */
const TOOL_COL_STATE_SS_PREFIX = 'crish_tool_col_state_v1:';
/** 兼容旧版仅宽度 key */
const TOOL_COL_WIDTH_SS_PREFIX = 'crish_tool_col_w_v1:';

type ToolColRememberedState = {
  widthRatio: number;
  activeCardId?: string;
};

function toolColStateKey(wsId: string): string {
  return `${TOOL_COL_STATE_SS_PREFIX}${wsId}`;
}

function toolColWidthKey(wsId: string): string {
  return `${TOOL_COL_WIDTH_SS_PREFIX}${wsId}`;
}

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
  } catch {
    /* ignore */
  }
  return { widthRatio, activeCardId };
}

function writeToolColState(wsId: string, state: ToolColRememberedState): void {
  try {
    sessionStorage.setItem(toolColStateKey(wsId), JSON.stringify(state));
    // 同步旧 key，避免其它路径只读宽度时丢记忆
    sessionStorage.setItem(toolColWidthKey(wsId), String(state.widthRatio));
  } catch {
    /* ignore */
  }
}

/** 工具列是否处于收起（宽比极小，但标签仍在） */
export function isToolColumnCollapsed(ws: WorkspaceState): boolean {
  const tool = ws.columns.find((c) => !isChatColumn(c));
  if (!tool) return true;
  if (tool.groups.every((g) => g.cards.length === 0)) return true;
  return tool.widthRatio > 0 && tool.widthRatio < 0.04;
}

/**
 * 收起右侧工具列：只压宽度，不删标签/不卸面板（会话内可恢复）。
 * 与「X 关闭标签」区分——关标签才销毁内容。
 * 会记住收起前的宽度与当前激活标签，展开时还原。
 */
export function collapseToolColumnPreserve(ws: WorkspaceState): boolean {
  ensureChatColumn(ws);
  const tool = ws.columns.find((c) => !isChatColumn(c));
  if (!tool || tool.groups.length === 0) return false;
  const hasCards = tool.groups.some((g) => g.cards.length > 0);
  if (!hasCards) return false;
  if (tool.widthRatio > 0 && tool.widthRatio < 0.04) return false;

  const activeCardId =
    tool.groups.find((g) => g.cards.some((c) => c.id === g.activeCardId))?.activeCardId ||
    tool.groups[0]?.activeCardId ||
    tool.groups[0]?.cards[0]?.id;

  writeToolColState(ws.id, {
    widthRatio: tool.widthRatio > 0.05 ? tool.widthRatio : 0.34,
    activeCardId: activeCardId || undefined,
  });

  tool.widthRatio = 0.001;
  const chat = ws.columns.find((c) => isChatColumn(c));
  if (chat) chat.widthRatio = 0.999;
  normalizeColumnWidths(ws);
  // 归一化后强制极小工具列（避免 0.001 被放大）
  const t2 = ws.columns.find((c) => !isChatColumn(c));
  const c2 = ws.columns.find((c) => isChatColumn(c));
  if (t2 && c2) {
    t2.widthRatio = 0;
    c2.widthRatio = 1;
  }
  return true;
}

/**
 * 展开已收起的工具列（恢复上次宽度与激活标签）。若列已有可见宽度则 no-op。
 */
export function expandToolColumnIfCollapsed(ws: WorkspaceState): boolean {
  ensureChatColumn(ws);
  const tool = ws.columns.find((c) => !isChatColumn(c));
  if (!tool) return false;
  const hasCards = tool.groups.some((g) => g.cards.length > 0);
  if (!hasCards) return false;
  if (tool.widthRatio >= 0.08) return false;

  const saved = readToolColState(ws.id);
  tool.widthRatio = saved.widthRatio;
  if (saved.activeCardId) {
    for (const g of tool.groups) {
      if (g.cards.some((c) => c.id === saved.activeCardId)) {
        g.activeCardId = saved.activeCardId;
        break;
      }
    }
  }
  const chat = ws.columns.find((c) => isChatColumn(c));
  if (chat) chat.widthRatio = Math.max(0.3, 1 - saved.widthRatio);
  normalizeColumnWidths(ws);
  return true;
}

/**
 * 将工具列内多 group 折叠为单一标签组（合并标签页）。
 * 保留各卡顺序（按 group 再按 cards）；激活卡优先保留首组原 active，否则第一张。
 * 返回是否发生了折叠。
 */
export function collapseToolColumnToTabs(ws: WorkspaceState): boolean {
  ensureChatColumn(ws);
  const toolCol = ws.columns.find((c) => !isChatColumn(c));
  if (!toolCol || toolCol.groups.length <= 1) return false;

  const seen = new Set<string>();
  const mergedCards: CardState[] = [];
  let preferredActive = toolCol.groups[0]?.activeCardId || '';

  for (const g of toolCol.groups) {
    for (const c of g.cards) {
      const id = resolveWorkspacePanelKey(c.id);
      if (!id || id === 'chat' || seen.has(id)) continue;
      seen.add(id);
      mergedCards.push(id === c.id ? c : makePanelCard(id));
    }
  }
  if (mergedCards.length === 0) {
    toolCol.groups = [];
    return true;
  }

  const active =
    preferredActive && mergedCards.some((c) => c.id === preferredActive)
      ? preferredActive
      : mergedCards[0]!.id;

  toolCol.groups = [
    {
      id: toolCol.groups[0]?.id || `group-tools-${ws.id}`,
      activeCardId: active,
      cards: mergedCards,
      heightRatio: 1,
    },
  ];
  ensureChatColumn(ws);
  return true;
}

/**
 * 打开或聚焦工具面板（纯 draft）：
 * - 已存在 → 聚焦（focused）
 * - chat / 未解析 key → skipped（ensureChat 后返回）
 * - 否则放入工具列；tabMode 且已有 group 时并入首组
 */
export function placePanelCard(
  ws: WorkspaceState,
  key: string,
  opts?: { tabMode?: boolean; stamp?: number | string },
): PlacePanelResult {
  const cardId = resolveWorkspacePanelKey(key);
  if (!cardId || cardId === 'chat') {
    ensureChatColumn(ws);
    return 'skipped';
  }

  if (focusCardInWorkspace(ws, cardId)) {
    // 已有标签但列被收起时：展开，保留内容
    expandToolColumnIfCollapsed(ws);
    ensureChatColumn(ws);
    return 'focused';
  }

  ensureChatColumn(ws);
  const toolCol = ensureToolColumn(ws);
  const card = makePanelCard(cardId);
  const stamp = opts?.stamp ?? Date.now();

  // tabMode（产品默认）：始终并入同一工具标签栏，不堆叠新「工作分区」
  if (opts?.tabMode) {
    if (toolCol.groups.length > 1) collapseToolColumnToTabs(ws);
    if (toolCol.groups.length > 0) {
      const targetGroup = toolCol.groups[0]!;
      if (!targetGroup.cards.some((c) => c.id === cardId)) {
        targetGroup.cards.push(card);
      }
      targetGroup.activeCardId = cardId;
      // 合并后高度归一，避免残留堆叠比例
      targetGroup.heightRatio = 1;
      toolCol.groups = [targetGroup];
      expandToolColumnIfCollapsed(ws);
      ensureChatColumn(ws);
      normalizeColumnWidths(ws);
      expandToolColumnIfCollapsed(ws);
      return 'placed';
    }
    // 首块工具：单 group 起步，后续点击都并入
    toolCol.groups = [
      {
        id: `group-tools-${stamp}-${ws.id}`,
        activeCardId: cardId,
        cards: [card],
        heightRatio: 1,
      },
    ];
    ensureChatColumn(ws);
    normalizeColumnWidths(ws);
    expandToolColumnIfCollapsed(ws);
    return 'placed';
  }

  // tabMode 关闭：才允许独立成 group（可上下分栏）
  toolCol.groups.push({
    id: `group-${cardId}-${stamp}-${ws.id}`,
    activeCardId: cardId,
    cards: [card],
    heightRatio: 1,
  });
  rebalanceGroupHeights(toolCol);
  ensureChatColumn(ws);
  normalizeColumnWidths(ws);
  expandToolColumnIfCollapsed(ws);
  return 'placed';
}

/**
 * 关闭工具面板卡（不关 chat）。浏览器式 active 切到左侧邻居，再 prune 空壳。
 * 返回是否实际移除了至少一张卡。
 */
export function removePanelCard(ws: WorkspaceState, key: string): boolean {
  const cardId = resolveWorkspacePanelKey(key);
  if (!cardId || cardId === 'chat') {
    ensureChatColumn(ws);
    return false;
  }

  // 首个匹配即关（panel id 工作区内应唯一）；避免 after 删组时 for-of 跳组
  const loc = findCardInWorkspace(ws, cardId);
  if (!loc) {
    ensureChatColumn(ws);
    return false;
  }
  const { group, cardIdx } = loc;
  group.cards.splice(cardIdx, 1);
  afterCardRemovedFromGroup(ws, group, group.id, cardId, cardIdx);
  pruneEmptyWorkspaceLayout(ws, true);
  ensureChatColumn(ws);
  return true;
}

/**
 * 同组内 reorder：splice 取出后的目标下标修正。
 * remainingLength = 取出后的 cards.length。
 * targetIndex 缺省 → 追加到末尾（不再二次 -1，避免 append 偏到倒数第二）。
 * targetIndex 按「取出前」数组解释：若落在 fromIdx 右侧则 -1 填 gap。
 */
export function adjustSameGroupReorderIndex(
  fromIdx: number,
  targetIndex: number | undefined,
  remainingLength: number,
): number {
  if (remainingLength <= 0) return 0;
  if (targetIndex === undefined) return remainingLength;
  let toIdx = targetIndex;
  if (toIdx > fromIdx) toIdx = Math.max(0, toIdx - 1);
  return Math.min(Math.max(0, toIdx), remainingLength);
}

/**
 * 把卡插入目标 group；targetIndex 缺省则 append。激活该卡。
 * 不负责从源组抽出——调用方先 extract。
 */
export function insertCardIntoGroup(
  group: CardGroupState,
  card: CardState,
  targetIndex?: number,
): void {
  if (
    targetIndex !== undefined &&
    targetIndex >= 0 &&
    targetIndex <= group.cards.length
  ) {
    group.cards.splice(targetIndex, 0, card);
  } else {
    group.cards.push(card);
  }
  group.activeCardId = card.id;
}

// ── Split edges（DnD 落点几何；无 DOM，供 useTabDrag / 单测）────────────────

/** 与 useTabDrag 对齐的边缘感应宽度 */
export const SPLIT_EDGE_PADDING_X = 48;
export const SPLIT_EDGE_PADDING_Y = 36;
/** chat 列：左右新区比例（中间禁 merge） */
export const CHAT_COL_LEFT_ZONE = 0.45;
export const CHAT_COL_RIGHT_ZONE = 0.55;
/** 默认标签栏高度（无 DOM 测量时） */
export const DEFAULT_TAB_BAR_H = 36;

export type SplitEdgeDirection = 'top' | 'bottom' | 'left' | 'right' | 'merge';

export type ResolveSplitEdgeOptions = {
  edgePaddingX?: number;
  edgePaddingY?: number;
  /** 标签栏高度：落在其内可 merge（preferMergeInTabBar） */
  tabBarH?: number;
  /** 在 tab 栏区域优先 merge（跨组拖到标签区） */
  preferMergeInTabBar?: boolean;
  /** 目标为 chat 列：仅 left/right，中间 null */
  chatColumn?: boolean;
  /** 禁止左侧列拆分（如 colIdx===0 且非 chat 特殊规则） */
  disableLeft?: boolean;
  /** 禁止右侧列拆分 */
  disableRight?: boolean;
};

/**
 * 卡片矩形内相对坐标 → 落点方向（纯几何）。
 * 不处理「自悬停 / 冗余列」等业务过滤——调用方用 isRedundantSplit 等再筛。
 *
 * 优先级：chat 列分区 → tab 栏 merge → 左右边 → 上下边 → 半屏 top/bottom。
 */
export function resolveSplitEdgeFromPoint(
  relX: number,
  relY: number,
  width: number,
  height: number,
  options?: ResolveSplitEdgeOptions,
): SplitEdgeDirection | null {
  if (!(width > 0) || !(height > 0)) return null;
  const edgeX = options?.edgePaddingX ?? SPLIT_EDGE_PADDING_X;
  const edgeY = options?.edgePaddingY ?? SPLIT_EDGE_PADDING_Y;
  const tabBarH = options?.tabBarH ?? DEFAULT_TAB_BAR_H;
  const x = Math.max(0, Math.min(relX, width));
  const y = Math.max(0, Math.min(relY, height));

  if (options?.chatColumn) {
    if (x < width * CHAT_COL_LEFT_ZONE) {
      return options?.disableLeft ? null : 'left';
    }
    if (x > width * CHAT_COL_RIGHT_ZONE) {
      return options?.disableRight ? null : 'right';
    }
    return null;
  }

  if (options?.preferMergeInTabBar && y < tabBarH) {
    return 'merge';
  }

  if (x < edgeX) {
    return options?.disableLeft ? null : 'left';
  }
  if (x > width - edgeX) {
    return options?.disableRight ? null : 'right';
  }
  if (y < tabBarH + edgeY) return 'top';
  if (y > height - edgeY) return 'bottom';
  return y < height / 2 ? 'top' : 'bottom';
}

/** left → 插在 colIdx；right → 插在 colIdx+1 */
export function columnInsertIndexForSplit(
  colIdx: number,
  direction: 'left' | 'right',
): number {
  return direction === 'left' ? colIdx : colIdx + 1;
}

/**
 * top → 插在 groupIdx；bottom → groupIdx+1；夹到 [0, groupsLength]。
 */
export function groupInsertIndexForSplit(
  groupIdx: number,
  direction: 'top' | 'bottom',
  groupsLength: number,
): number {
  const raw = direction === 'top' ? groupIdx : groupIdx + 1;
  return Math.min(Math.max(0, raw), Math.max(0, groupsLength));
}

/**
 * 工具卡实时拖放目标列：禁止落到 chat 列（下标 0），夹到有效工具列。
 * columnsLength < 2 时返回 0（仅 chat 时调用方应先建列）。
 */
export function clampToolTargetColIdx(
  targetColIdx: number,
  columnsLength: number,
): number {
  if (columnsLength <= 1) return 0;
  return Math.min(Math.max(targetColIdx, 1), columnsLength - 1);
}

/**
 * 仅含单卡的列拖到自身邻接位置时，左右拆列是冗余的（会闪一列又消失）。
 * sourceColIdx 为拖源列；insertColIdx 为 columnInsertIndexForSplit 结果。
 */
export function isRedundantColumnSplit(params: {
  isOnlyCardInCol: boolean;
  sourceColIdx: number;
  targetColIdx: number;
  direction: 'left' | 'right';
}): boolean {
  const { isOnlyCardInCol, sourceColIdx, targetColIdx, direction } = params;
  if (!isOnlyCardInCol) return false;
  if (direction === 'left') {
    return sourceColIdx === targetColIdx || sourceColIdx === targetColIdx - 1;
  }
  // right：新列插在 targetColIdx+1
  return sourceColIdx === targetColIdx || sourceColIdx === targetColIdx + 1;
}

/**
 * 垂直邻接且只是「贴着自己原位」的 top/bottom 拆分视为冗余。
 */
export function isRedundantGroupSplit(params: {
  sourceColIdx: number;
  sourceGroupIdx: number;
  targetColIdx: number;
  targetGroupIdx: number;
  direction: 'top' | 'bottom';
}): boolean {
  const {
    sourceColIdx,
    sourceGroupIdx,
    targetColIdx,
    targetGroupIdx,
    direction,
  } = params;
  if (sourceColIdx !== targetColIdx) return false;
  if (direction === 'top') return sourceGroupIdx === targetGroupIdx - 1;
  return sourceGroupIdx === targetGroupIdx + 1;
}

// ── Diff list（layoutStore setActiveDiffSource / pushDiffFile 共用）──────────

export const DIFF_LIST_MAX = MAX_DIFF_FILES;

/** 按 path 去重 upsert，并截断列表长度（原地修改） */
export function upsertDiffFile(
  diffFiles: FileDiff[],
  diff: FileDiff,
  max = DIFF_LIST_MAX,
): void {
  const i = diffFiles.findIndex((f) => f.filePath === diff.filePath);
  if (i >= 0) diffFiles[i] = diff;
  else diffFiles.unshift(diff);
  if (diffFiles.length > max) diffFiles.length = max;
}

// ── Terminal buffer ─────────────────────────────────────────────────────────

export const TERMINAL_HARD_MAX = 800;
export const TERMINAL_TRIM_TO = 600;

/** 追加一行；超长时截尾（原地修改，返回是否发生 trim） */
export function appendTerminalLine(
  buf: string[],
  line: string,
  hardMax = TERMINAL_HARD_MAX,
  trimTo = TERMINAL_TRIM_TO,
): boolean {
  buf.push(line);
  if (buf.length > hardMax) {
    buf.splice(0, buf.length - trimTo);
    return true;
  }
  return false;
}

// ── Chat column lock ────────────────────────────────────────────────────────

/** Chat column is always present and never removed. */
export function ensureChatColumn(ws: WorkspaceState): void {
  const chatCard = (): CardState => makePanelCard('chat');
  let chatCol = ws.columns.find((c) => isChatColumn(c));
  if (!chatCol) {
    chatCol = {
      id: `col-chat-${ws.id}`,
      widthRatio: 0.5,
      groups: [
        {
          id: `group-chat-${ws.id}`,
          activeCardId: 'chat',
          cards: [chatCard()],
          heightRatio: 1,
        },
      ],
    };
    ws.columns.unshift(chatCol);
  } else {
    // Ensure a chat card exists in the chat column
    let hasChat = false;
    for (const g of chatCol.groups) {
      if (g.cards.some((c) => c.id === 'chat')) {
        hasChat = true;
        // Prefer chat as active when group is empty of other focus
        if (!g.cards.some((c) => c.id === g.activeCardId)) {
          g.activeCardId = 'chat';
        }
        break;
      }
    }
    if (!hasChat) {
      if (chatCol.groups.length === 0) {
        chatCol.groups.push({
          id: `group-chat-${ws.id}`,
          activeCardId: 'chat',
          cards: [chatCard()],
          heightRatio: 1,
        });
      } else {
        chatCol.groups[0].cards.unshift(chatCard());
        chatCol.groups[0].activeCardId = 'chat';
      }
    }
  }
  // Never drop the chat column
  ws.columns = ws.columns.filter((c) => isChatColumn(c) || c.groups.length > 0);
  if (!ws.columns.some((c) => isChatColumn(c))) {
    ws.columns.unshift(chatCol);
  }
}

// ── Workspace factory ───────────────────────────────────────────────────────

export function createDefaultWorkspace(id: string): WorkspaceState {
  // Always start with a dedicated chat column. Side tools open beside it, never replace it.
  if (!isDemoMode()) {
    return {
      id,
      columns: [
        {
          id: `col-chat-${id}`,
          widthRatio: 1,
          groups: [
            {
              id: `group-chat-${id}`,
              activeCardId: 'chat',
              cards: [{ id: 'chat', title: '对话' }],
              heightRatio: 1,
            },
          ],
        },
      ],
    };
  }

  // Demo: multi-panel playground (chat still locked in first column)
  return {
    id,
    columns: [
      {
        id: `col-chat-${id}`,
        widthRatio: 0.42,
        groups: [
          {
            id: `group-chat-${id}`,
            activeCardId: 'chat',
            cards: [{ id: 'chat', title: '对话' }],
            heightRatio: 1.0,
          },
        ],
      },
      {
        id: `col-1-${id}`,
        widthRatio: 0.29,
        groups: [
          {
            id: `group-preview-${id}`,
            activeCardId: 'preview',
            cards: [{ id: 'preview', title: '预览' }],
            heightRatio: 1.0,
          },
        ],
      },
      {
        id: `col-2-${id}`,
        widthRatio: 0.29,
        groups: [
          {
            id: `group-diff-${id}`,
            activeCardId: 'diff',
            cards: [{ id: 'diff', title: '变更' }],
            heightRatio: 0.5,
          },
          {
            id: `group-tasks-${id}`,
            activeCardId: 'tasks',
            cards: [{ id: 'tasks', title: '任务' }],
            heightRatio: 0.5,
          },
        ],
      },
    ],
  };
}

// ── Session seed ────────────────────────────────────────────────────────────

const DEFAULT_SESSIONS: SessionState[] = [
  {
    id: 'sess-1',
    title: '分析酒馆对话主界面问题',
    folder: '审计与代码分析',
    isPinned: false,
    isArchived: false,
    timestamp: '10分钟前',
    messages: [
      { id: 'm1-1', sender: 'assistant', text: '你好！有什么关于酒馆对话界面的问题我可以帮您分析的？', timestamp: Date.now() - 600000 }
    ]
  },
  {
    id: 'sess-2',
    title: '审计三个项目的代码统一性问题',
    folder: '审计与代码分析',
    isPinned: false,
    isArchived: false,
    timestamp: '1小时前',
    messages: [
      {
        id: 'msg-1',
        sender: 'user',
        text: 'Let me try directly creating a test trigger to isolate the issue.',
        timestamp: Date.now() - 3600000
      },
      {
        id: 'msg-2',
        sender: 'assistant',
        text: 'The inline button DOES exist (1 found)! Let me find where it is:',
        timestamp: Date.now() - 3500000,
        toolCalls: [
          {
            id: 'tc-grep-1',
            name: 'grep_search',
            arguments: 'data-crish-inline="1"',
            status: 'success',
            explanation: '在工作区搜索冲突的行内按钮标签 data-crish-inline="1"',
            output: 'Searching pattern "data-crish-inline=\\"1\\""...\nFound 1 match in trigger-injector.ts:\nLine 42: <button data-crish-inline="1">F</button>'
          },
          {
            id: 'tc-read-1',
            name: 'read_file',
            arguments: 'trigger-injector.ts',
            status: 'success',
            explanation: '读取 trigger-injector.ts 以分析按钮挂载逻辑',
            output: 'Reading file "trigger-injector.ts"...\nFile size: 1042 bytes.\nFile contents read successfully.'
          }
        ]
      },
      {
        id: 'msg-3',
        sender: 'assistant',
        text: 'Found the culprit! Another extension is creating `<button data-crish-inline="1">F</button>`, and our code reuses it. Let me find which extension:',
        timestamp: Date.now() - 3400000,
        toolCalls: [
          {
            id: 'tc-grep-2',
            name: 'grep_search',
            arguments: 'crish-inline-style',
            status: 'success',
            explanation: '在整个工作区搜索 crish-inline-style 样式以排除命名冲突',
            output: 'Searching pattern "crish-inline-style"...\nFound 0 matches in workspace.'
          }
        ]
      },
      {
        id: 'msg-4',
        sender: 'assistant',
        text: '找到根源了！另一个扩展创建了 `<button data-crish-inline="1">F</button>`，我们的 `acquireInlineBtn` 找到并重用它，但没有覆盖它的 `innerHTML`，所以按钮只显示 "F"，而非 SVG 图标。',
        timestamp: Date.now() - 3200000,
        toolCalls: [
          {
            id: 'tc-edit-1',
            name: 'write_to_file',
            arguments: 'trigger-injector.ts',
            status: 'success',
            explanation: '修改 trigger-injector.ts，在 acquireInlineBtn 中重新创建并注入 SVG 按钮内容',
            diffs: [
              {
                filePath: 'trigger-injector.ts',
                additions: 12,
                deletions: 5,
                changes: [
                  { type: 'normal', content: 'function acquireInlineBtn() {' },
                  { type: 'deletion', content: '  let btn = document.querySelector("[data-crish-inline]");' },
                  { type: 'deletion', content: '  return btn;' },
                  { type: 'addition', content: '  let btn = document.querySelector("[data-crish-inline]");' },
                  { type: 'addition', content: '  if (btn && btn.innerHTML !== SVG_ICON) {' },
                  { type: 'addition', content: '    btn.innerHTML = SVG_ICON;' },
                  { type: 'addition', content: '  }' },
                  { type: 'addition', content: '  return btn;' },
                  { type: 'normal', content: '}' }
                ]
              }
            ]
          }
        ]
      },
      {
        id: 'msg-5',
        sender: 'assistant',
        text: 'Now rebuild and reload:',
        timestamp: Date.now() - 3000000,
        toolCalls: [
          {
            id: 'tc-build-1',
            name: 'run_command',
            arguments: 'npm run dev',
            status: 'success',
            explanation: '运行打包命令 npm run dev 以验证编译与变更',
            output: 'vite v8.0.16 building client environment for production...\ntransforming...\nrendering chunks...\ncomputing gzip size...\ndist/index.html                   0.46 kB │ gzip:  0.29 kB\ndist/assets/index-2PqGUG_A.css   30.11 kB │ gzip:  5.57 kB\ndist/assets/index-C068c687.js   270.20 kB │ gzip: 83.06 kB\n\n✓ built in 389ms'
          }
        ]
      },
      {
        id: 'msg-6',
        sender: 'assistant',
        text: '我已经追踪到这个问题的根源了，总结一下发现：\n\n**当前状态：**\n- 扩展已加载，service worker 正常\n- 内容脚本已注入 (overlay 面板创建成功)\n  - 但 `mountTrigger()` 函数没有正常执行——`crish-inline-style` style 元素没有被创建，触发按钮也没有生成\n\n**根源：** 还有一个其他扩展（如 "All API Hub" 或 "HiSider"）在页面上注入了 `<button data-crish-inline="1">F</button>`，我们的 `acquireInlineBtn` 会找到并重用这个按钮，但不会覆盖它的 `innerHTML`，导致按钮只显示 "F" 而不是 SVG 图标。\n\n我已经修复了 `acquireInlineBtn` 让它检测到外部按钮时重新创建。\n\n但现在有一个更基础的问题：在新加载 of 页面上，`mountTrigger` 根本没有被触发（连 `<style>` 元素都没有），这说明内容脚本执行到 `showCrishFab()` 时可能抛出了异常，被 `bootstrap()` 的 `try-catch` 吞掉了。\n\n需要你手动做：\n1. 打开 `chrome://extensions`\n2. 找到 "Chat Sync Bridge"，点 移除\n3. 点击 **加载已解压的扩展程序** ➔ 选择 `C:\\path\\to\\crish\\apps\\browser-extension\\dist`\n4. 刷新 Claude 或 ChatGPT 页面\n\n这次移除再重新加载会触发全新的内容脚本注册，应该能解决 `mountTrigger` 不触发的问题。',
        timestamp: Date.now() - 2800000
      }
    ]
  },
  {
    id: 'sess-3',
    title: 'Fix voice playback timing and overla',
    folder: '语音与播控',
    isPinned: false,
    isArchived: false,
    timestamp: '3天前',
    messages: [
      { id: 'm3-1', sender: 'assistant', text: '你好！这里可以帮您调试和修复语音播控的相关延时问题。', timestamp: Date.now() - 250000000 }
    ]
  },
  {
    id: 'sess-4',
    title: '定制菜单与滚动区域优化',
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: '5天前',
    messages: [
      { id: 'm4-1', sender: 'assistant', text: '你好！我可以协助您进行前端自定义菜单和隐藏滚动条样式的优化设计。', timestamp: Date.now() - 400000000 }
    ]
  },
  {
    id: 'sess-5',
    title: '添加终端与主题扩展',
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: '1周前',
    messages: [
      { id: 'm5-1', sender: 'assistant', text: '你好！想了解如何为开发面板新增本地终端视图或实现主题切换配置吗？', timestamp: Date.now() - 600000000 }
    ]
  },
];

export function populateBlocksForSessions(
  sessions: SessionState[],
  opts?: { keepSessionIds?: Iterable<string> | null },
): SessionState[] {
  const normalized = sessions.map((sess) => ({
    ...sess,
    messages: (sess.messages || []).map((msg) =>
      msg.sender === 'assistant' ? normalizeAssistantTimeline(msg) : msg,
    ),
  }));
  // 磁盘/演示种子：默认标题且已有用户消息 → 补短标题
  const titled = fillDefaultSessionTitles(normalized);
  // 剪掉落盘脏数据里的幽灵空壳（保留活动会话 id）
  return pruneEmptyShellSessions(titled, { keepIds: opts?.keepSessionIds });
}

export function seedSessions(): {
  sessions: SessionState[];
  activeSessionId: string;
  folderOrder: string[];
} {
  if (isDemoMode()) {
    return {
      sessions: populateBlocksForSessions(DEFAULT_SESSIONS),
      activeSessionId: 'sess-2',
      folderOrder: ['审计与代码分析', '语音与播控', '常规会话'],
    };
  }

  // 正式版：从本地索引 + JSONL 恢复；不自动新建会话
  const disk = hydrateSessionsFromDisk();
  if (disk.sessions.length > 0) {
    // 有历史时恢复上次活动会话；若无效则不强制选中（空态可新建）
    // 活动会话若是空壳仍保留（用户上次停在空白新建），其余空壳剪掉
    const activeCandidate =
      disk.activeSessionId && disk.sessions.some((s) => s.id === disk.activeSessionId)
        ? disk.activeSessionId
        : '';
    const sessions = populateBlocksForSessions(disk.sessions, {
      keepSessionIds: activeCandidate ? [activeCandidate] : [],
    });
    const active =
      activeCandidate && sessions.some((s) => s.id === activeCandidate)
        ? activeCandidate
        : '';
    const fromSessions = Array.from(new Set(sessions.map((s) => s.folder)));
    const folders =
      disk.folderOrder && disk.folderOrder.length > 0
        ? Array.from(new Set([...disk.folderOrder, ...fromSessions, GENERAL_FOLDER]))
        : [GENERAL_FOLDER, ...fromSessions.filter((f) => f !== GENERAL_FOLDER)];
    // 强制触发一次磁盘镜像落盘，以便在切换 app identifier 时，旧数据能够自动安全落地到通用 ~/.crish/sessions 目录中
    import('../api/sessionDiskMirror').then(({ mirrorSessionsToDisk }) => {
      void mirrorSessionsToDisk(sessions, active, folders);
    }).catch(() => undefined);

    return {
      sessions,
      activeSessionId: active,
      folderOrder: folders,
    };
  }

  return {
    sessions: [],
    activeSessionId: '',
    folderOrder: [GENERAL_FOLDER],
  };
}

