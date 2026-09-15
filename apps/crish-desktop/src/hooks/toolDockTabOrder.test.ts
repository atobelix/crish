import { describe, expect, it } from 'vitest';
import {
  createBranch,
  createLeaf,
  isLeaf,
  type LayoutNode,
} from '../store/layout-tree/types';
import { reorderOpenPanelIds } from './toolDockTabOrder';

describe('reorderOpenPanelIds', () => {
  it('把 fromId 插到 beforeId 之前', () => {
    expect(reorderOpenPanelIds(['a', 'b', 'c'], 'c', 'a')).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(reorderOpenPanelIds(['a', 'b', 'c'], 'a', 'c')).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('beforeId 为 null 时移到末尾', () => {
    expect(reorderOpenPanelIds(['a', 'b', 'c'], 'a', null)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('fromId 不存在 / 与 beforeId 相同 → 原引用', () => {
    const ids = ['a', 'b', 'c'];
    expect(reorderOpenPanelIds(ids, 'x', 'a')).toBe(ids);
    expect(reorderOpenPanelIds(ids, 'a', 'a')).toBe(ids);
  });

  it('顺序未变 → 原引用', () => {
    const ids = ['a', 'b', 'c'];
    // a 已在 b 前
    expect(reorderOpenPanelIds(ids, 'a', 'b')).toBe(ids);
  });

  it('beforeId 不在列表中 → 追加到末尾', () => {
    expect(reorderOpenPanelIds(['a', 'b'], 'a', 'missing')).toEqual([
      'b',
      'a',
    ]);
  });
});

/**
 * v3 布局模型架构不变量守卫（取代原 listToolLeafIdsInUnit / findToolLeafIdForPanel 用例）。
 *
 * 这两个函数按 session 定位「tool 叶」，其前提（叶级 panelId + 叶级 sessionId +
 * 树上可存在 tool 叶）已在 v3 模型下被整体废止，函数随之删除。本块把该废止
 * 决策钉成不变量：任何一次「把 tool 叶重新塞回布局树」的回归都会在此变红。
 *
 * 证据链：
 * - `store/layout-tree/types.ts:26`  — `panelId: 'chat'` 字面量（类型级不可构造 tool 叶）
 * - `store/layout-tree/types.ts:3`   — 「树上只有 chat 叶；会话身份在 SessionTab.sessionId」
 * - `store/layout-tree/types.ts:147` — createLeaf「不再接受 panelId / 叶级 sessionId」
 * - `store/layout-tree/types.ts:38`  — 坞挂在 `LayoutLeaf.dock`
 * - `store/layout-tree/treePanelAccess.ts:32-33` — 「禁止再 split 出全局 tool leaf」
 */
describe('布局树不存在 tool 叶（I5 / Shell redesign 不变量）', () => {
  function collectLeaves(node: LayoutNode, out: LayoutNode[] = []): LayoutNode[] {
    if (isLeaf(node)) {
      out.push(node);
      return out;
    }
    collectLeaves(node.children[0], out);
    collectLeaves(node.children[1], out);
    return out;
  }

  it('createLeaf 产出的叶恒为 chat 叶：无叶级 sessionId、坞挂 leaf.dock', () => {
    const leaf = createLeaf({ id: 'leaf-x' });

    // 类型级不变量：panelId 只能是 'chat'
    expect(leaf.panelId).toBe('chat');
    // 叶级 sessionId 已迁走（迁到 tabs[].sessionId）——回归即红
    expect(leaf).not.toHaveProperty('sessionId');
    // 坞是本叶唯一 tool 承载面
    expect(leaf.dock).toBeDefined();
    expect(Object.keys(leaf).sort()).toEqual([
      'activeTabId',
      'dock',
      'id',
      'panelId',
      'tabs',
      'type',
    ]);
  });

  it('createLeaf 忽略旧签名位置参数：传入 panelId/sessionId 也产不出 tool 叶', () => {
    // v2 旧签名 createLeaf('files', ['files','diff'], 'files', 'sA')：
    // v3 入参为单对象，字符串入参的 .tabs/.id/.dock 全为 undefined
    const legacy = createLeaf('files' as unknown as Parameters<typeof createLeaf>[0]);
    expect(legacy.panelId).toBe('chat');
    expect(legacy.tabs).toEqual([]);
    expect(legacy.activeTabId).toBe('');
  });

  it('任意二叉树上的全部叶同构为 chat 叶，树上查不到 tool 叶', () => {
    // 直接按 v3 契约构造多叶树（旧夹具的 4 位置参数已失效）
    const root = createBranch(
      'horizontal',
      createBranch(
        'horizontal',
        createLeaf({ id: 'leaf-a1' }),
        createLeaf({ id: 'leaf-a2' }),
        0.6,
      ),
      createBranch(
        'vertical',
        createLeaf({ id: 'leaf-b1' }),
        createLeaf({ id: 'leaf-b2' }),
        0.5,
      ),
      0.5,
    );

    const leaves = collectLeaves(root);
    expect(leaves).toHaveLength(4);
    expect(leaves.every((l) => isLeaf(l) && l.panelId === 'chat')).toBe(true);
    // 不存在任何承载 tool panelId 的叶
    expect(leaves.some((l) => isLeaf(l) && l.panelId !== 'chat')).toBe(false);
  });
});
