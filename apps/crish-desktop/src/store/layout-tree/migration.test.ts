/**
 * migration.ts 单测 — 旧 columns/groups → 二叉树布局迁移。
 *
 * 测试维度：
 * 1. 默认状态检测：何时应该迁移
 * 2. 触发条件：无旧数据 / 已有自定义布局 / 已迁移 → 跳过
 * 3. 迁移执行：单列单组、多列、多组 → 结构正确
 * 4. 幂等性：模块级标志防止本次会话重复迁移
 * 5. 安全性：脏数据 / 异常 → 静默回退不抛错
 * 6. 历史可撤销：迁移结果推入 past 栈
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  migrateLayoutIfNeeded,
  __resetMigrationFlagForTests,
} from './migration';
import { useLayoutTreeStore } from './layoutTreeStore';
import {
  createDefaultTree,
  createLeaf,
  createBranch,
  isLeaf,
  isBranch,
  type LayoutTree,
} from './types';
import { findNodeById, collectLeaves } from './operations';

// ── 测试夹具 ────────────────────────────────────────────────────────

const LEGACY_KEY = 'crish-layout-v1';
const TREE_KEY = 'crish-layout-tree-v1';

/** 旧 store 的 localStorage 持久化格式 */
interface LegacyPersisted {
  state?: {
    workspaces?: Array<{
      id: string;
      columns: Array<{
        id: string;
        widthRatio: number;
        groups: Array<{
          id: string;
          heightRatio: number;
          activeCardId: string;
          cards: Array<{ id: string; title: string }>;
        }>;
      }>;
    }>;
  };
  version?: number;
}

function setLegacyLayout(
  columns: LegacyPersisted['state'] extends {
    workspaces?: Array<{ columns: infer C }>;
  }
    ? C
    : never
): void {
  const payload: LegacyPersisted = {
    state: {
      workspaces: [{ id: 'ws-0', columns }],
    },
    version: 1,
  };
  localStorage.setItem(LEGACY_KEY, JSON.stringify(payload));
}

function clearLegacyLayout(): void {
  localStorage.removeItem(LEGACY_KEY);
}

/** 单列单组：chat 面板（与默认 tree 等价） */
function legacySingleChat() {
  return [
    {
      id: 'col-chat',
      widthRatio: 1,
      groups: [
        {
          id: 'g-0',
          heightRatio: 1,
          activeCardId: 'chat',
          cards: [{ id: 'chat', title: '对话' }],
        },
      ],
    },
  ];
}

/** 两列：chat + diff */
function legacyTwoColumns() {
  return [
    {
      id: 'col-chat',
      widthRatio: 0.6,
      groups: [
        {
          id: 'g-0',
          heightRatio: 1,
          activeCardId: 'chat',
          cards: [{ id: 'chat', title: '对话' }],
        },
      ],
    },
    {
      id: 'col-tools',
      widthRatio: 0.4,
      groups: [
        {
          id: 'g-1',
          heightRatio: 1,
          activeCardId: 'diff',
          cards: [{ id: 'diff', title: '变更' }],
        },
      ],
    },
  ];
}

/** 单列多组：chat + terminal（垂直分割） */
function legacyVerticalGroups() {
  return [
    {
      id: 'col-chat',
      widthRatio: 1,
      groups: [
        {
          id: 'g-0',
          heightRatio: 0.5,
          activeCardId: 'chat',
          cards: [{ id: 'chat', title: '对话' }],
        },
        {
          id: 'g-1',
          heightRatio: 0.5,
          activeCardId: 'terminal',
          cards: [{ id: 'terminal', title: '终端' }],
        },
      ],
    },
  ];
}

// ── 夹具：复位 store + localStorage ─────────────────────────────────

/**
 * 复位 layoutTreeStore 到默认单 chat leaf 状态。
 * 直接 setState（不走 setTree，避免推历史污染 past 栈），
 * 同时修正 activeLeafId 保持 store 一致性。
 */
function resetStoreFully(): void {
  const defaultTree = createDefaultTree('chat');
  useLayoutTreeStore.setState({
    tree: defaultTree,
    activeLeafId: defaultTree.root.id,
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
  });
}

beforeEach(() => {
  // 复位 localStorage
  localStorage.removeItem(LEGACY_KEY);
  localStorage.removeItem(TREE_KEY);
  // 复位 store
  resetStoreFully();
  // 复位迁移标志
  __resetMigrationFlagForTests();
});

afterEach(() => {
  localStorage.removeItem(LEGACY_KEY);
  localStorage.removeItem(TREE_KEY);
  __resetMigrationFlagForTests();
});

// ── 测试用例 ────────────────────────────────────────────────────────

describe('migrateLayoutIfNeeded — 跳过条件', () => {
  it('无旧数据时返回 false，不修改 tree', () => {
    clearLegacyLayout();
    const beforeTree = useLayoutTreeStore.getState().tree;

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(false);
    expect(useLayoutTreeStore.getState().tree).toBe(beforeTree);
  });

  it('新 store 已有自定义布局时跳过（不覆盖用户配置）', () => {
    // 准备：新 store 已有两 panel 的自定义树
    const customTree: LayoutTree = {
      root: createBranch(
        'horizontal',
        createLeaf('chat'),
        createLeaf('diff'),
        0.5
      ),
      version: 2,
    };
    useLayoutTreeStore.setState({ tree: customTree });

    // 准备：旧数据存在
    setLegacyLayout(legacyTwoColumns() as never);

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(false);
    // 树未被覆盖
    expect(useLayoutTreeStore.getState().tree).toBe(customTree);
  });

  it('本次会话已迁移过 → 第二次调用直接跳过', () => {
    setLegacyLayout(legacyTwoColumns() as never);

    const first = migrateLayoutIfNeeded();
    expect(first).toBe(true);

    // 修改 localStorage（模拟用户在另一处又写了旧数据）
    setLegacyLayout(legacyVerticalGroups() as never);

    const second = migrateLayoutIfNeeded();
    expect(second).toBe(false);
  });

  it('旧数据存在但内容与默认树等价 → 不写入（避免无意义历史）', () => {
    setLegacyLayout(legacySingleChat() as never);
    const beforeTree = useLayoutTreeStore.getState().tree;
    const beforePastLen = useLayoutTreeStore.getState().past.length;

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(false);
    expect(useLayoutTreeStore.getState().tree).toBe(beforeTree);
    expect(useLayoutTreeStore.getState().past.length).toBe(beforePastLen);
  });
});

describe('migrateLayoutIfNeeded — 迁移执行', () => {
  it('两列布局 → 水平 branch + 两个 leaf', () => {
    setLegacyLayout(legacyTwoColumns() as never);

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(true);
    const { tree, past } = useLayoutTreeStore.getState();

    // 结构：root 为 branch，两个 leaf
    expect(isBranch(tree.root)).toBe(true);
    const leaves = collectLeaves(tree.root);
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.panelId).sort()).toEqual(['chat', 'diff']);

    // 历史：原默认树推入 past（可 undo）
    expect(past.length).toBe(1);
  });

  it('垂直多组布局 → vertical branch', () => {
    setLegacyLayout(legacyVerticalGroups() as never);

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(true);
    const { tree } = useLayoutTreeStore.getState();
    expect(isBranch(tree.root)).toBe(true);
    const branch = tree.root as ReturnType<typeof createBranch>;
    expect(branch.direction).toBe('vertical');

    const leaves = collectLeaves(tree.root);
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.panelId).sort()).toEqual(['chat', 'terminal']);
  });

  it('迁移后 activeLeafId 仍指向有效 leaf', () => {
    setLegacyLayout(legacyTwoColumns() as never);

    migrateLayoutIfNeeded();

    const { tree, activeLeafId } = useLayoutTreeStore.getState();
    expect(activeLeafId).not.toBeNull();
    const found = findNodeById(tree.root, activeLeafId!);
    expect(found).not.toBeNull();
  });

  it('迁移后可 undo 回到默认单面板', () => {
    setLegacyLayout(legacyTwoColumns() as never);

    migrateLayoutIfNeeded();
    expect(useLayoutTreeStore.getState().canUndo()).toBe(true);

    useLayoutTreeStore.getState().undo();

    const { tree } = useLayoutTreeStore.getState();
    expect(isLeaf(tree.root)).toBe(true);
    expect((tree.root as ReturnType<typeof createLeaf>).panelId).toBe('chat');
  });
});

describe('migrateLayoutIfNeeded — 容错', () => {
  it('localStorage 为脏 JSON → 静默返回 false', () => {
    localStorage.setItem(LEGACY_KEY, '{not valid json');

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(false);
    // 树未被修改（仍是默认）
    const { tree } = useLayoutTreeStore.getState();
    expect(isLeaf(tree.root)).toBe(true);
    expect((tree.root as ReturnType<typeof createLeaf>).panelId).toBe('chat');
  });

  it('旧数据 workspaces 为空数组 → 静默跳过', () => {
    const payload: LegacyPersisted = {
      state: { workspaces: [] },
      version: 1,
    };
    localStorage.setItem(LEGACY_KEY, JSON.stringify(payload));

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(false);
  });

  it('旧数据 columns 为空数组 → 静默跳过', () => {
    const payload: LegacyPersisted = {
      state: { workspaces: [{ id: 'ws-0', columns: [] }] },
      version: 1,
    };
    localStorage.setItem(LEGACY_KEY, JSON.stringify(payload));

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(false);
  });

  it('旧数据结构完全错位（无 workspaces 字段）→ 静默跳过', () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ state: { foo: 'bar' }, version: 1 })
    );

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(false);
  });
});

describe('migrateLayoutIfNeeded — 幂等性', () => {
  it('迁移成功后再次调用不重复写入', () => {
    setLegacyLayout(legacyTwoColumns() as never);

    migrateLayoutIfNeeded();
    const treeAfterFirst = useLayoutTreeStore.getState().tree;
    const pastAfterFirst = useLayoutTreeStore.getState().past.length;

    const second = migrateLayoutIfNeeded();

    expect(second).toBe(false);
    expect(useLayoutTreeStore.getState().tree).toBe(treeAfterFirst);
    expect(useLayoutTreeStore.getState().past.length).toBe(pastAfterFirst);
  });

  it('重置迁移标志后，若新 store 仍为默认状态可再次迁移', () => {
    setLegacyLayout(legacyTwoColumns() as never);

    migrateLayoutIfNeeded();
    // 手动复位到默认
    resetStoreFully();
    __resetMigrationFlagForTests();

    const second = migrateLayoutIfNeeded();

    expect(second).toBe(true);
  });
});

describe('migrateLayoutIfNeeded — 默认状态检测', () => {
  it('单 chat leaf + tabs=["chat"] 视为默认状态', () => {
    // 这是迁移的初始条件；不直接调用 isTreeInDefaultState（私有），
    // 而是通过行为验证：默认状态 + 旧数据 → 触发迁移
    setLegacyLayout(legacyTwoColumns() as never);
    const result = migrateLayoutIfNeeded();
    expect(result).toBe(true);
  });

  it('单 leaf 但 panelId !== "chat" 视为非默认（用户自定义）', () => {
    // 用户已将默认 chat leaf 改为 diff
    useLayoutTreeStore.setState({
      tree: { root: createLeaf('diff'), version: 2 },
    });
    setLegacyLayout(legacyTwoColumns() as never);

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(false);
  });

  it('单 chat leaf 但 tabs 含多个元素视为非默认', () => {
    useLayoutTreeStore.setState({
      tree: { root: createLeaf('chat', ['chat', 'agent'], 'chat'), version: 2 },
    });
    setLegacyLayout(legacyTwoColumns() as never);

    const result = migrateLayoutIfNeeded();

    expect(result).toBe(false);
  });
});
