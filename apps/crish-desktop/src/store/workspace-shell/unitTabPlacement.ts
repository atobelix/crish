/**
 * Per-unit session tab placement — pure helpers (Phase R4 / D2).
 *
 * Conversation unit ≈ chat leaf（可选 sessionId）。openTabs 仍是打开会话的唯一源；
 * 本模块只回答「某 unit 的标签条应展示 openTabs 的哪一段」。
 *
 * 规则（Obsidian 式分屏顶栏）：
 * 1. 单 chat leaf：该 unit 条带展示当前 workspaceKey 下全部 openTabs（多标签单窗格）。
 * 2. 多 chat leaf：各 unit 条带仅展示绑定到该 leaf 的 session tab（1:1）；
 *    未绑定到任何 leaf 的 tab（unplaced）只出现在「活跃」unit 条带上。
 * 3. 活跃 unit：优先为绑定了 activeTab.sessionId 的 leaf；否则回退 allUnits[0]。
 *
 * @see docs/plans/2026-07-conversation-unit-shell.md §8
 */

import type { LayoutNode } from '../layout-tree/types';
import { listChatLeaves } from '../layout-tree/conversationUnit';
import type { TabSurface } from './types';

/** 布局中的 conversation unit 引用（chat leaf 级） */
export interface ChatUnitRef {
  leafId: string;
  sessionId?: string;
}

/**
 * 先序遍历列出全部 chat unit（每个 chat leaf 一个）。
 * sessionId 原样透传（可能 undefined）。
 */
export function listChatUnits(root: LayoutNode): ChatUnitRef[] {
  return listChatLeaves(root).map((leaf) => {
    const unit: ChatUnitRef = { leafId: leaf.id };
    if (leaf.sessionId !== undefined && leaf.sessionId !== '') {
      unit.sessionId = leaf.sessionId;
    }
    return unit;
  });
}

/** 树中恰好一个 chat leaf（多标签单窗格模式） */
export function isSingleChatUnit(root: LayoutNode): boolean {
  return listChatLeaves(root).length === 1;
}

function normalizeWorkspaceKey(key: string | null | undefined): string {
  return (key ?? '').trim();
}

function tabsInWorkspace(
  openTabs: readonly TabSurface[],
  workspaceKey: string
): TabSurface[] {
  const ws = normalizeWorkspaceKey(workspaceKey);
  return openTabs.filter(
    (t) => normalizeWorkspaceKey(t.workspaceKey) === ws
  );
}

/**
 * 绑定在任意 unit 上的 sessionId 集合（非空）。
 * 用于识别 unplaced：openTabs 中 sessionId 不在此集合内。
 */
function boundSessionIds(allUnits: readonly ChatUnitRef[]): Set<string> {
  const ids = new Set<string>();
  for (const u of allUnits) {
    const sid = (u.sessionId ?? '').trim();
    if (sid) ids.add(sid);
  }
  return ids;
}

/**
 * 哪个 unit 承载 unplaced tabs。
 * - 若 activeTab 的 session 绑定到某 unit → 该 unit
 * - 否则（无 active / unplaced active / 未知 tab）→ allUnits[0]
 */
function unitHostingUnplaced(
  allUnits: readonly ChatUnitRef[],
  openTabs: readonly TabSurface[],
  activeTabId: string | null | undefined
): ChatUnitRef | null {
  if (allUnits.length === 0) return null;

  const activeTab =
    activeTabId != null && activeTabId !== ''
      ? (openTabs.find((t) => t.tabId === activeTabId) ?? null)
      : null;

  if (activeTab) {
    const sid = (activeTab.sessionId ?? '').trim();
    if (sid) {
      const owner = allUnits.find(
        (u) => (u.sessionId ?? '').trim() === sid
      );
      if (owner) return owner;
    }
  }

  return allUnits[0] ?? null;
}

/**
 * 计算某 unit 标签条应展示的 TabSurface 列表（保持 openTabs 相对顺序）。
 *
 * @param openTabs      workspaceShell 中全部打开的会话 tab
 * @param unit          目标 unit
 * @param allUnits      当前树全部 unit（与 listChatUnits(root) 一致）
 * @param activeTabId   当前激活 tabId（用于 unplaced 归属）
 * @param workspaceKey  当前工作区；只纳入同 workspace 的 tab
 */
/**
 * 解析条带工作区 key：优先 activeTab / leaf 绑定 session 的 tab，再回退传入 key。
 * 避免 getActiveProjectId 与 openTabs.workspaceKey 漂移时条带只剩 GENERAL「对话」草稿。
 */
export function resolveStripWorkspaceKey(
  openTabs: readonly TabSurface[],
  activeTabId: string | null | undefined,
  leafSessionId?: string | null,
  fallbackWorkspaceKey?: string | null
): string {
  const byActive =
    activeTabId != null && activeTabId !== ''
      ? openTabs.find((t) => t.tabId === activeTabId)
      : undefined;
  if (byActive?.workspaceKey) {
    return normalizeWorkspaceKey(byActive.workspaceKey);
  }

  const leafSid = (leafSessionId ?? '').trim();
  if (leafSid) {
    const byLeaf = openTabs.find((t) => (t.sessionId ?? '').trim() === leafSid);
    if (byLeaf?.workspaceKey) {
      return normalizeWorkspaceKey(byLeaf.workspaceKey);
    }
  }

  const fb = normalizeWorkspaceKey(fallbackWorkspaceKey);
  if (fb) return fb;

  // 最后：取第一个非空 workspaceKey
  for (const t of openTabs) {
    const k = normalizeWorkspaceKey(t.workspaceKey);
    if (k) return k;
  }
  return '';
}

export function tabsForUnit(
  openTabs: readonly TabSurface[],
  unit: ChatUnitRef,
  allUnits: readonly ChatUnitRef[],
  activeTabId: string | null | undefined,
  workspaceKey: string
): TabSurface[] {
  const unitSid = (unit.sessionId ?? '').trim();
  // 始终并入 leaf 绑定 session 与 active tab 所属 workspace 的 tabs，避免 key 漂移丢标签
  const effectiveWs = resolveStripWorkspaceKey(
    openTabs,
    activeTabId,
    unitSid || null,
    workspaceKey
  );
  const wsTabs = tabsInWorkspace(openTabs, effectiveWs);

  // 保证 active tab 与 leaf 绑定 session 的 tab 一定在候选池（跨 workspace 漂移时）
  const ensurePool: TabSurface[] = [...wsTabs];
  const seen = new Set(wsTabs.map((t) => t.tabId));
  const pushIfMissing = (tab: TabSurface | undefined) => {
    if (!tab || seen.has(tab.tabId)) return;
    seen.add(tab.tabId);
    ensurePool.push(tab);
  };
  if (activeTabId) {
    pushIfMissing(openTabs.find((t) => t.tabId === activeTabId));
  }
  if (unitSid) {
    pushIfMissing(
      openTabs.find((t) => (t.sessionId ?? '').trim() === unitSid)
    );
  }

  // 单 unit / 无 multi：条带 = 有效 workspace 全部 openTabs（+ 强制并入项）
  if (allUnits.length <= 1) {
    // 单窗：若有效 ws 过窄，展示 ensurePool；若仍空则退回全部 openTabs
    if (ensurePool.length > 0) return ensurePool;
    return openTabs.slice();
  }

  const bound = boundSessionIds(allUnits);
  const unplacedHost = unitHostingUnplaced(allUnits, openTabs, activeTabId);
  const hostsUnplaced = unplacedHost?.leafId === unit.leafId;

  return ensurePool.filter((tab) => {
    const sid = (tab.sessionId ?? '').trim();
    // 1:1：绑定到本 leaf 的 session 必展示
    if (unitSid && sid === unitSid) return true;
    // unplaced：仅活跃 unit
    if (hostsUnplaced && sid && !bound.has(sid)) return true;
    // 空 sessionId 的 tab 视为 unplaced
    if (hostsUnplaced && !sid) return true;
    return false;
  });
}
