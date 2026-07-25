/**
 * 旧 columns/groups → 二叉树布局迁移。
 *
 * 触发条件（全部满足才迁移）：
 * 1. 新 tree store 处于默认状态（仅单个 chat leaf，且无历史）
 * 2. 旧 localStorage['crish-layout-v1'] 存在且包含真实 workspace 数据
 * 3. 本次会话尚未迁移过（模块级标志，避免重复迁移）
 *
 * 迁移策略：
 * - 读取旧 store 第一个 workspace 的 columns
 * - 调用 migrateFromColumns 转为 LayoutTree
 * - 调用 setTree 写入新 store（推历史，可撤销）
 *
 * 幂等性：
 * - 若新 store 已有用户自定义布局（leaf 数 > 1 或 panelId !== 'chat'），跳过
 * - 迁移成功后设置模块级标志，本次会话不再迁移
 * - 用户清空 localStorage['crish-layout-tree-v1'] 后下次启动会重新迁移
 */

import { useLayoutTreeStore } from './layoutTreeStore';
import { migrateFromColumns, collectLeaves } from './operations';
import { createDefaultTree } from './types';
import type { LayoutTree } from './types';

/** 旧 store 的 localStorage key（与 layoutStore.ts withPersist 一致） */
const LEGACY_STORAGE_KEY = 'crish-layout-v1';

/** 本次会话是否已迁移过（模块级标志，避免重复迁移） */
let migratedThisSession = false;

/**
 * 检测新 tree store 是否处于默认状态（值得从旧数据迁移）。
 *
 * 判定：tree 与 createDefaultTree('chat') 结构等价（单 leaf、panelId === 'chat'）。
 * 注意：leaf id 是动态生成的，不能用 id 比较；用 collectLeaves 长度 + panelId。
 */
function isTreeInDefaultState(tree: LayoutTree): boolean {
  const leaves = collectLeaves(tree.root);
  if (leaves.length !== 1) return false;
  const leaf = leaves[0]!;
  // 默认树：单 chat leaf，tabs 仅 ['chat']
  return (
    leaf.panelId === 'chat' && leaf.tabs.length === 1 && leaf.tabs[0] === 'chat'
  );
}

/**
 * 从 localStorage 读取旧 layoutStore 的持久化数据。
 * zustand persist 的 JSON 格式：{ state: { workspaces: [...] }, version: N }
 */
function readLegacyColumns(): unknown[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: {
        workspaces?: Array<{ id: string; columns: unknown[] }>;
      };
    };
    const workspaces = parsed?.state?.workspaces;
    if (!Array.isArray(workspaces) || workspaces.length === 0) return null;
    const first = workspaces[0];
    if (!first || !Array.isArray(first.columns) || first.columns.length === 0)
      return null;
    return first.columns;
  } catch {
    return null;
  }
}

/**
 * 执行迁移（如果需要）。
 *
 * 安全性：
 * - 任何步骤失败都静默回退到默认 tree（不抛错，不阻断启动）
 * - 迁移后 setTree 会推入历史栈，用户可 undo 回到默认单面板
 *
 * @returns true 表示执行了迁移；false 表示跳过（已是自定义布局 / 无旧数据 / 已迁移）
 */
export function migrateLayoutIfNeeded(): boolean {
  if (migratedThisSession) return false;

  const store = useLayoutTreeStore.getState();
  const currentTree = store.tree;

  // 1. 新 store 必须处于默认状态才迁移（否则尊重用户已有布局）
  if (!isTreeInDefaultState(currentTree)) {
    migratedThisSession = true;
    return false;
  }

  // 2. 读取旧数据
  const legacyColumns = readLegacyColumns();
  if (!legacyColumns) {
    migratedThisSession = true;
    return false;
  }

  // 3. 迁移
  try {
    const migratedTree = migrateFromColumns(
      legacyColumns as Parameters<typeof migrateFromColumns>[0]
    );

    // 若迁移结果与默认树等价（旧数据也是空/单 chat），不写入（避免无意义历史）
    if (isTreeInDefaultState(migratedTree)) {
      migratedThisSession = true;
      return false;
    }

    store.setTree(migratedTree);
    migratedThisSession = true;
    return true;
  } catch {
    // 迁移失败：静默回退，下次会话重试
    return false;
  }
}

/**
 * 重置迁移标志（仅供测试用）。
 * 生产代码不应调用。
 */
export function __resetMigrationFlagForTests(): void {
  migratedThisSession = false;
}

/** 默认树（导出供测试比较） */
export { createDefaultTree };
