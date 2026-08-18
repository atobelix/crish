/**
 * Crish 布局序列化器。
 *
 * 将 WorkspaceState 序列化为 JSON（可存储到 localStorage / 文件），
 * 并可从 JSON 恢复。
 *
 * 参考 VS Code SerializableGrid。
 */

import { logger } from '../services/LoggerService';

export interface SerializedLayout {
  version: number;
  root: SerializedBranch | SerializedLeaf;
}

export interface SerializedBranch {
  type: 'branch';
  direction: 'horizontal' | 'vertical';
  children: (SerializedBranch | SerializedLeaf)[];
  sizes: number[];
}

export interface SerializedLeaf {
  type: 'leaf';
  panelType: string;
  tabs: string[];
  activeTab: string;
  sessionId?: string;
}

import type { WorkspaceState, ColumnState, CardGroupState, CardState } from '../store/types';

/**
 * 将 WorkspaceState 序列化为 SerializedLayout。
 */
export function serializeLayout(ws: WorkspaceState): SerializedLayout {
  const columns = ws.columns;
  if (columns.length === 1) {
    return {
      version: 1,
      root: serializeColumn(columns[0]!),
    };
  }

  return {
    version: 1,
    root: {
      type: 'branch',
      direction: 'horizontal',
      children: columns.map((col) => serializeColumn(col)),
      sizes: columns.map((col) => col.widthRatio),
    },
  };
}

function serializeColumn(col: ColumnState): SerializedBranch | SerializedLeaf {
  const groups = col.groups;
  if (groups.length === 1) {
    return serializeGroup(groups[0]!);
  }

  return {
    type: 'branch',
    direction: 'vertical',
    children: groups.map((g) => serializeGroup(g)),
    sizes: groups.map((g) => g.heightRatio),
  } as SerializedBranch | SerializedLeaf;
}

function serializeGroup(group: CardGroupState): SerializedLeaf {
  return {
    type: 'leaf',
    panelType: group.activeCardId || group.cards[0]?.id || 'unknown',
    tabs: group.cards.map((c) => c.id),
    activeTab: group.activeCardId || group.cards[0]?.id || '',
  };
}

/**
 * 从 SerializedLayout 恢复 WorkspaceState。
 */
export function deserializeLayout(data: SerializedLayout, wsId: string): Partial<WorkspaceState> {
  if (data.version !== 1) {
    throw new Error(`Unsupported layout version: ${data.version}`);
  }

  const columns: ColumnState[] = [];
  const root = data.root;

  if (root.type === 'branch' && root.direction === 'horizontal') {
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i]!;
      const col = deserializeBranchToColumn(child, root.sizes[i] || (1 / root.children.length), wsId, i);
      columns.push(col);
    }
  } else {
    const col = deserializeBranchToColumn(root, 1, wsId, 0);
    columns.push(col);
  }

  return {
    id: wsId,
    columns,
  };
}

function deserializeBranchToColumn(
  node: SerializedBranch | SerializedLeaf,
  widthRatio: number,
  wsId: string,
  colIdx: number,
): ColumnState {
  const groups: CardGroupState[] = [];

  if (node.type === 'branch' && node.direction === 'vertical') {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      if (child.type === 'leaf') {
        groups.push(deserializeLeafToGroup(child, node.sizes[i] || (1 / node.children.length), wsId, colIdx, i));
      }
    }
  } else if (node.type === 'leaf') {
    groups.push(deserializeLeafToGroup(node, 1, wsId, colIdx, 0));
  }

  return {
    id: `col-${wsId}-${colIdx}`,
    widthRatio,
    groups,
  };
}

function deserializeLeafToGroup(leaf: SerializedLeaf, heightRatio: number, wsId: string, colIdx: number, groupIdx: number): CardGroupState {
  const cards: CardState[] = leaf.tabs.map((tabId) => ({
    id: tabId,
    title: tabId,
  }));

  const activeCardId = leaf.activeTab && cards.some((c) => c.id === leaf.activeTab)
    ? leaf.activeTab
    : cards[0]?.id || '';

  return {
    id: `group-${wsId}-${colIdx}-${groupIdx}`,
    heightRatio,
    activeCardId,
    cards,
  };
}

/**
 * 将当前布局快照保存到 localStorage。
 */
export function saveLayoutToStorage(ws: WorkspaceState, key = 'crish-layout'): void {
  try {
    const serialized = serializeLayout(ws);
    localStorage.setItem(key, JSON.stringify(serialized));
  } catch (err) {
    logger.error('[LayoutSerializer] save failed', {
      module: 'LayoutSerializer',
      err: err instanceof Error
        ? { message: err.message, stack: err.stack, name: err.name }
        : { message: String(err) },
    });
  }
}

/**
 * 从 localStorage 恢复布局快照。
 */
export function loadLayoutFromStorage(wsId: string, key = 'crish-layout'): Partial<WorkspaceState> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw) as SerializedLayout;
    return deserializeLayout(data, wsId);
  } catch {
    return null;
  }
}
