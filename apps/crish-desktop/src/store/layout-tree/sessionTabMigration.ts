/**
 * v2（leaf.sessionId + string tabs + 可含 tool 叶）→ v3 叶拥有 SessionTab[] 的一次迁移。
 *
 * 纯函数，无 store。失败回退 createDefaultTree()。
 */
import {
  createDefaultTree,
  isLeaf,
  isBranch,
  LAYOUT_TREE_VERSION,
  type LayoutLeaf,
  type LayoutNode,
  type LayoutTree,
  type SplitDirection,
} from './types';
import {
  createSessionTab,
  createDefaultDock,
  isDraftSessionId,
  isRealSessionId,
  mintDraftSessionId,
  normalizeSessionTab,
  PENDING_DRAFT_SESSION_ID,
  DEFAULT_WORKSPACE_KEY,
  type SessionTab,
  type RightToolDockState,
} from './sessionTabModel';

export interface LegacyOpenTab {
  sessionId: string;
  tabId?: string;
  title?: string;
  workspaceKey?: string;
  rightDock?: Partial<RightToolDockState>;
}

export interface MigrateToLeafOwnedTabsInput {
  tree: unknown;
  openTabs?: ReadonlyArray<LegacyOpenTab>;
  openTabsMap?: Readonly<Record<string, string[]>>;
  activeLeafId?: string | null;
  resolveMeta?: (
    sessionId: string
  ) => { title?: string; workspaceKey?: string } | undefined;
}

export type MigrateToLeafOwnedTabsResult =
  | { ok: true; tree: LayoutTree; didMigrate: boolean }
  | { ok: false; tree: LayoutTree; reason: 'unrecoverable' };

/** 与现码 clampDockWidthRatio 同区间，避免 layout-tree → shell 反向依赖 */
function clampDockWidthRatio(widthRatio: number): number {
  return Math.min(0.75, Math.max(0.2, widthRatio));
}

function fail(): MigrateToLeafOwnedTabsResult {
  return { ok: false, tree: createDefaultTree(), reason: 'unrecoverable' };
}

function normalizeWorkspaceKey(raw?: string): string {
  const k = (raw || '').trim();
  if (!k || k === '__general__') return DEFAULT_WORKSPACE_KEY;
  return k;
}

type LeafKind = 'v2' | 'v3' | 'unknown';

function classifyLeaf(n: Record<string, unknown>): LeafKind {
  const tabs = n.tabs;
  if (!Array.isArray(tabs)) return 'unknown';
  if (tabs.length === 0) {
    if (typeof n.activeTabId === 'string') return 'v3';
    return 'v2';
  }
  const first = tabs[0];
  if (typeof first === 'string') return 'v2';
  if (
    first &&
    typeof first === 'object' &&
    typeof (first as { tabId?: unknown }).tabId === 'string' &&
    typeof (first as { sessionId?: unknown }).sessionId === 'string'
  ) {
    return 'v3';
  }
  return 'unknown';
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** S0：结构门闩。混用 v2/v3 叶 → unknown */
function inspectStructure(
  node: unknown,
  kinds: Set<LeafKind>
): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as Record<string, unknown>;
  if (typeof n.id !== 'string' || !n.id) return false;
  if (n.type === 'leaf') {
    const kind = classifyLeaf(n);
    kinds.add(kind);
    return kind !== 'unknown';
  }
  if (n.type === 'branch') {
    if (n.direction !== 'horizontal' && n.direction !== 'vertical') return false;
    if (!isFiniteNumber(n.splitRatio)) return false;
    if (!Array.isArray(n.children) || n.children.length !== 2) return false;
    return (
      inspectStructure(n.children[0], kinds) &&
      inspectStructure(n.children[1], kinds)
    );
  }
  return false;
}

interface WorkLeaf {
  type: 'leaf';
  id: string;
  panelId: string;
  tabs: SessionTab[];
  activeTabId: string;
  legacySid: string;
}

interface WorkBranch {
  type: 'branch';
  id: string;
  direction: SplitDirection;
  children: [WorkNode, WorkNode];
  splitRatio: number;
}

type WorkNode = WorkLeaf | WorkBranch;

function isWorkLeaf(n: WorkNode): n is WorkLeaf {
  return n.type === 'leaf';
}

function collectWorkLeaves(node: WorkNode): WorkLeaf[] {
  if (isWorkLeaf(node)) return [node];
  return [...collectWorkLeaves(node.children[0]), ...collectWorkLeaves(node.children[1])];
}

function findWorkNode(node: WorkNode, id: string): WorkNode | null {
  if (node.id === id) return node;
  if (isWorkLeaf(node)) return null;
  return findWorkNode(node.children[0], id) ?? findWorkNode(node.children[1], id);
}

function findWorkParent(
  root: WorkNode,
  id: string
): { parent: WorkBranch; index: 0 | 1 } | null {
  if (isWorkLeaf(root)) return null;
  if (root.children[0].id === id) return { parent: root, index: 0 };
  if (root.children[1].id === id) return { parent: root, index: 1 };
  return (
    findWorkParent(root.children[0], id) ?? findWorkParent(root.children[1], id)
  );
}

function replaceWork(
  root: WorkNode,
  targetId: string,
  replacement: WorkNode
): WorkNode {
  if (root.id === targetId) return replacement;
  if (isWorkLeaf(root)) return root;
  const first = replaceWork(root.children[0], targetId, replacement);
  const second = replaceWork(root.children[1], targetId, replacement);
  if (first === root.children[0] && second === root.children[1]) return root;
  return { ...root, children: [first, second] };
}

function removeWorkNode(root: WorkNode, nodeId: string): WorkNode | null {
  if (root.id === nodeId) return null;
  const parentInfo = findWorkParent(root, nodeId);
  if (!parentInfo) return null;
  const { parent, index } = parentInfo;
  const keep = parent.children[index === 0 ? 1 : 0];
  if (root.id === parent.id) return keep;
  return replaceWork(root, parent.id, keep);
}

function isToolDomain(node: WorkNode): boolean {
  if (isWorkLeaf(node)) return node.panelId !== 'chat';
  return isToolDomain(node.children[0]) && isToolDomain(node.children[1]);
}

function ingestNode(raw: unknown, kind: LeafKind): WorkNode {
  const n = raw as Record<string, unknown>;
  if (n.type === 'branch') {
    const children = n.children as [unknown, unknown];
    return {
      type: 'branch',
      id: n.id as string,
      direction: n.direction as SplitDirection,
      splitRatio: n.splitRatio as number,
      children: [ingestNode(children[0], kind), ingestNode(children[1], kind)],
    };
  }
  const panelId = typeof n.panelId === 'string' ? n.panelId : 'chat';
  const legacySid =
    typeof n.sessionId === 'string' ? n.sessionId.trim() : '';
  const toolTabs = Array.isArray(n.tabs)
    ? (n.tabs as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  const leaf: WorkLeaf & { toolTabs?: string[]; rawTabs?: unknown } = {
    type: 'leaf',
    id: n.id as string,
    panelId,
    tabs: [],
    activeTabId: '',
    legacySid,
    toolTabs,
    rawTabs: n.tabs,
  };
  if (kind === 'v3' && Array.isArray(n.tabs)) {
    leaf.tabs = (n.tabs as unknown[])
      .map((t) => {
        if (!t || typeof t !== 'object') return null;
        const o = t as Partial<SessionTab>;
        if (typeof o.tabId !== 'string' || typeof o.sessionId !== 'string') {
          return null;
        }
        return normalizeSessionTab(o);
      })
      .filter((t): t is SessionTab => t !== null);
    if (typeof n.activeTabId === 'string') leaf.activeTabId = n.activeTabId;
  }
  return leaf;
}

function makeTabFromSources(
  sid: string,
  openTabs: ReadonlyArray<LegacyOpenTab> | undefined,
  resolveMeta: MigrateToLeafOwnedTabsInput['resolveMeta'],
  dock?: Partial<RightToolDockState>
): SessionTab {
  const fromOpen = openTabs?.find((t) => (t.sessionId || '').trim() === sid);
  const meta = resolveMeta?.(sid);
  return createSessionTab({
    sessionId: sid,
    tabId: fromOpen?.tabId,
    title: fromOpen?.title ?? meta?.title,
    workspaceKey: normalizeWorkspaceKey(
      fromOpen?.workspaceKey ?? meta?.workspaceKey
    ),
    dock: dock ?? fromOpen?.rightDock,
  });
}

function finalizeLeaf(leaf: WorkLeaf): LayoutLeaf {
  const tabs = leaf.tabs.filter((t) => isRealSessionId(t.sessionId));
  const activeTabId = tabs.some((t) => t.tabId === leaf.activeTabId)
    ? leaf.activeTabId
    : '';
  return {
    type: 'leaf',
    id: leaf.id,
    panelId: 'chat',
    tabs,
    activeTabId,
    dock: createDefaultDock(),
  };
}

function finalizeNodeKeepIds(node: WorkNode): LayoutNode {
  if (isWorkLeaf(node)) return finalizeLeaf(node);
  return {
    type: 'branch',
    id: node.id,
    direction: node.direction,
    children: [
      finalizeNodeKeepIds(node.children[0]),
      finalizeNodeKeepIds(node.children[1]),
    ],
    splitRatio: node.splitRatio,
  };
}

function inferDockFromUnit(
  root: WorkNode,
  chatLeafId: string
): RightToolDockState | null {
  const chat = findWorkNode(root, chatLeafId);
  if (!chat || !isWorkLeaf(chat)) return null;
  const parentInfo = findWorkParent(root, chatLeafId);
  if (!parentInfo) return null;
  const { parent } = parentInfo;
  if (parent.direction !== 'horizontal') return null;
  const [first, second] = parent.children;
  let toolSide: WorkNode | null = null;
  let toolWidthRatio = 0.38;
  if (first.id === chatLeafId && isToolDomain(second)) {
    toolSide = second;
    toolWidthRatio = 1 - parent.splitRatio;
  } else if (second.id === chatLeafId && isToolDomain(first)) {
    toolSide = first;
    toolWidthRatio = parent.splitRatio;
  }
  if (!toolSide) return null;
  const { openPanelIds, activePanelId } = collectToolPanelIds(toolSide);
  if (openPanelIds.length === 0 && !activePanelId) return null;
  return {
    collapsed: false,
    openPanelIds: openPanelIds.length
      ? openPanelIds
      : activePanelId
        ? [activePanelId]
        : [],
    activePanelId: activePanelId ?? openPanelIds[0] ?? null,
    widthRatio: clampDockWidthRatio(toolWidthRatio),
  };
}

function collectToolPanelIds(node: WorkNode): {
  openPanelIds: string[];
  activePanelId: string | null;
} {
  const openPanelIds: string[] = [];
  let activePanelId: string | null = null;
  const walk = (n: WorkNode) => {
    if (isWorkLeaf(n)) {
      if (n.panelId === 'chat') return;
      const extra = n as WorkLeaf & { toolTabs?: string[] };
      const panelIds =
        extra.toolTabs && extra.toolTabs.length > 0
          ? extra.toolTabs
          : [n.panelId];
      for (const id of panelIds) {
        if (id && !openPanelIds.includes(id)) openPanelIds.push(id);
      }
      if (!activePanelId) {
        activePanelId = panelIds[0] ?? n.panelId;
      }
      return;
    }
    walk(n.children[0]);
    walk(n.children[1]);
  };
  walk(node);
  return { openPanelIds, activePanelId };
}

function stripToolLeaves(root: WorkNode): WorkNode | null {
  let current: WorkNode | null = root;
  for (let guard = 0; guard < 64 && current; guard++) {
    const tools = collectWorkLeaves(current).filter((l) => l.panelId !== 'chat');
    if (tools.length === 0) return current;
    const next = removeWorkNode(current, tools[0]!.id);
    if (next === current) break;
    current = next;
  }
  return current;
}

function pruneEmptyChatLeaves(root: WorkNode): WorkNode | null {
  let current: WorkNode | null = root;
  for (let guard = 0; guard < 64 && current; guard++) {
    const leaves = collectWorkLeaves(current);
    const empty = leaves.filter(
      (l) => l.panelId === 'chat' && l.tabs.length === 0
    );
    if (empty.length === 0) return current;
    if (leaves.length === 1) return current;
    const next = removeWorkNode(current, empty[0]!.id);
    if (next === current) break;
    current = next;
  }
  return current;
}

function sameShape(a: LayoutTree, b: LayoutTree): boolean {
  const dump = (n: LayoutNode): unknown => {
    if (isLeaf(n)) {
      return {
        id: n.id,
        panelId: n.panelId,
        activeTabId: n.activeTabId,
        tabs: n.tabs.map((t) => ({
          tabId: t.tabId,
          sessionId: t.sessionId,
          title: t.title,
          workspaceKey: t.workspaceKey,
          dock: t.dock,
        })),
      };
    }
    if (!isBranch(n)) return null;
    return {
      id: n.id,
      direction: n.direction,
      splitRatio: n.splitRatio,
      children: [dump(n.children[0]), dump(n.children[1])],
    };
  };
  return JSON.stringify(dump(a.root)) === JSON.stringify(dump(b.root));
}

export function migrateToLeafOwnedTabs(
  input: MigrateToLeafOwnedTabsInput
): MigrateToLeafOwnedTabsResult {
  try {
    const rawTree = input.tree;
    if (!rawTree || typeof rawTree !== 'object') return fail();
    const rawRoot = (rawTree as { root?: unknown }).root;
    const kinds = new Set<LeafKind>();
    if (!inspectStructure(rawRoot, kinds)) return fail();
    if (kinds.has('unknown')) return fail();
    if (kinds.has('v2') && kinds.has('v3')) return fail();

    const kind: LeafKind = kinds.has('v3') ? 'v3' : 'v2';
    let work = ingestNode(rawRoot, kind);
    const placed = new Set<string>();
    const chatLeaves = () =>
      collectWorkLeaves(work).filter((l) => l.panelId === 'chat');

    // S1：v2 按 leaf.sessionId 绑定；v3 已有 tabs，记 placed
    if (kind === 'v2') {
      for (const leaf of chatLeaves()) {
        const boundSid = leaf.legacySid;
        if (isRealSessionId(boundSid)) {
          leaf.tabs = [
            makeTabFromSources(boundSid, input.openTabs, input.resolveMeta),
          ];
          leaf.activeTabId = leaf.tabs[0]!.tabId;
          placed.add(boundSid);
        } else if (isDraftSessionId(boundSid)) {
          leaf.tabs = [];
          leaf.activeTabId = '';
        } else {
          leaf.tabs = [];
          leaf.activeTabId = '';
        }
      }
    } else {
      for (const leaf of chatLeaves()) {
        for (const tab of leaf.tabs) {
          if (tab.sessionId === PENDING_DRAFT_SESSION_ID) {
            tab.sessionId = mintDraftSessionId(tab.tabId);
          }
          if (isRealSessionId(tab.sessionId)) placed.add(tab.sessionId);
        }
      }
    }

    // S2：openTabs / map 里尚未出现的真实 session 并入活动 chat 叶
    const extras: string[] = [];
    const consider = (sidRaw: string | undefined) => {
      const sid = (sidRaw || '').trim();
      if (!isRealSessionId(sid) || placed.has(sid)) return;
      extras.push(sid);
      placed.add(sid);
    };
    for (const t of input.openTabs ?? []) consider(t.sessionId);
    const map = input.openTabsMap ?? {};
    for (const key of Object.keys(map).sort()) {
      const ids = map[key];
      if (!Array.isArray(ids)) continue;
      for (const id of ids) consider(id);
    }

    if (extras.length > 0) {
      const chats = chatLeaves();
      let target =
        (input.activeLeafId
          ? chats.find((c) => c.id === input.activeLeafId)
          : undefined) ?? chats[0];
      if (target) {
        for (const sid of extras) {
          target.tabs.push(
            makeTabFromSources(sid, input.openTabs, input.resolveMeta)
          );
        }
      }
    }

    // S3：坞从 unit 推断（树几何优先于 TabSurface.rightDock），然后丢掉 tool 叶
    for (const leaf of chatLeaves()) {
      const unitDock = inferDockFromUnit(work, leaf.id);
      for (const tab of leaf.tabs) {
        if (!isRealSessionId(tab.sessionId)) continue;
        const fromOpen = input.openTabs?.find(
          (t) => (t.sessionId || '').trim() === tab.sessionId
        );
        if (fromOpen?.rightDock) {
          tab.dock = createDefaultDock(fromOpen.rightDock);
        }
        const boundToThisLeaf =
          leaf.legacySid && tab.sessionId === leaf.legacySid;
        if (unitDock && (boundToThisLeaf || !leaf.legacySid)) {
          tab.dock = unitDock;
        }
      }
    }

    const stripped = stripToolLeaves(work);
    if (!stripped) return fail();
    work = stripped;

    if (chatLeaves().length === 0) return fail();

    // S5：真实 sessionId 去重（保留先序第一次）；草稿 tab 丢弃
    const seenReal = new Set<string>();
    for (const leaf of chatLeaves()) {
      const kept: SessionTab[] = [];
      for (const tab of leaf.tabs) {
        if (!isRealSessionId(tab.sessionId)) continue;
        if (seenReal.has(tab.sessionId)) continue;
        seenReal.add(tab.sessionId);
        kept.push(tab);
      }
      leaf.tabs = kept;
    }

    const pruned = pruneEmptyChatLeaves(work);
    if (!pruned) return fail();
    work = pruned;
    if (chatLeaves().length === 0) return fail();

    // S7：activeTabId 校正；panelId 强制 chat
    for (const leaf of chatLeaves()) {
      const prefer = leaf.legacySid
        ? leaf.tabs.find((t) => t.sessionId === leaf.legacySid)
        : undefined;
      if (prefer) leaf.activeTabId = prefer.tabId;
      else if (
        leaf.activeTabId &&
        !leaf.tabs.some((t) => t.tabId === leaf.activeTabId)
      ) {
        leaf.activeTabId = leaf.tabs[0]?.tabId ?? '';
      } else if (!leaf.activeTabId && leaf.tabs.length > 0) {
        /* 已是新对话界面，保留无选中 */
      }
      leaf.panelId = 'chat';
    }

    const out: LayoutTree = {
      version: LAYOUT_TREE_VERSION,
      root: finalizeNodeKeepIds(work),
    };

    const rawVersion = (rawTree as { version?: unknown }).version;
    let didMigrate = kind === 'v2' || rawVersion !== LAYOUT_TREE_VERSION;
    if (kind === 'v3' && !didMigrate) {
      // 无改写：与输入结构等价则 didMigrate=false
      try {
        const asInput = rawTree as LayoutTree;
        didMigrate = !sameShape(asInput, out);
      } catch {
        didMigrate = true;
      }
    }

    return { ok: true, tree: out, didMigrate };
  } catch {
    return fail();
  }
}
