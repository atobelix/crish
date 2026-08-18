/**
 * Conversation Unit 绑定不变量 — integration-style 单元测试（R1 / A7）。
 *
 * 覆盖 acceptance §5 items 1–4 中可在纯函数 / 稳定 API 上验证的部分：
 *  1. 两 session 并排 → 各 session 唯一 chat leaf（§5.1 绑定前提）
 *  2. 拖同一 session 不克隆 pane（§5.2；纯 hasChatLeaf / duplicates）
 *  3. 关闭 tab 只移除该 unit（§5.3；文档 + 发现 helper）
 *  4. 右坞属 unit 而非全局（§5.1/§5.4；per-session projectDock / collapse / expand）
 *
 * @see docs/plans/2026-07-conversation-unit-shell.md §2.2 / §5
 * @see store/layout-tree/conversationUnit.ts
 */

import { describe, it, expect } from 'vitest';
import {
  createLeaf,
  createBranch,
  type LayoutNode,
  type LayoutTree,
} from '../layout-tree/types';
import { viewRegistry } from '../../services/view-registry';
import { collectLeaves, findNodeById } from '../layout-tree/operations';
import {
  findChatLeafBySessionId,
  findDuplicateSessionChatLeaves,
  findUnitRootId,
  hasChatLeafForSession,
  listChatLeaves,
  listToolLeaves,
} from '../layout-tree/conversationUnit';
import {
  normalizeToAdapterShape,
  countChatLeaves,
  projectDockOntoTree,
  collapseSessionUnitDock,
  expandSessionUnitDock,
} from './adapterShape';
import { createDefaultDock } from './types';

// ── fixtures ──────────────────────────────────────────────────────────

/** 两 session 水平并排，无 tool（dock 折叠） */
function multiChatTree(sessionA = 'sess-a', sessionB = 'sess-b'): {
  tree: LayoutTree;
  chatA: ReturnType<typeof createLeaf>;
  chatB: ReturnType<typeof createLeaf>;
} {
  const chatA = createLeaf('chat', ['chat'], 'chat', sessionA);
  const chatB = createLeaf('chat', ['chat'], 'chat', sessionB);
  const tree: LayoutTree = {
    version: 2,
    root: createBranch('horizontal', chatA, chatB, 0.5),
  };
  return { tree, chatA, chatB };
}

/**
 * 两 Conversation Unit 并排，各自带独立 tool dock：
 *   root = H( unitA=H(chatA|toolA) , unitB=H(chatB|toolB) )
 * 这是 Phase 2 目标布局（per-session right dock）。
 */
function multiUnitWithDocks(
  sessionA = 'sess-a',
  sessionB = 'sess-b'
): {
  tree: LayoutTree;
  unitA: LayoutNode;
  unitB: LayoutNode;
  chatA: ReturnType<typeof createLeaf>;
  chatB: ReturnType<typeof createLeaf>;
  toolA: ReturnType<typeof createLeaf>;
  toolB: ReturnType<typeof createLeaf>;
} {
  const chatA = createLeaf('chat', ['chat'], 'chat', sessionA);
  const toolA = createLeaf('terminal', ['terminal'], 'terminal');
  const unitA = createBranch('horizontal', chatA, toolA, 0.62);

  const chatB = createLeaf('chat', ['chat'], 'chat', sessionB);
  const toolB = createLeaf('files', ['files'], 'files');
  const unitB = createBranch('horizontal', chatB, toolB, 0.62);

  const tree: LayoutTree = {
    version: 2,
    root: createBranch('horizontal', unitA, unitB, 0.5),
  };
  return { tree, unitA, unitB, chatA, chatB, toolA, toolB };
}

// ── 1. multi-chat 1:1 session ↔ leaf ─────────────────────────────────

describe('binding §5.1 — multi-chat 1:1 session ↔ chat leaf', () => {
  it('两 sessionId 并排 → findChatLeafBySessionId 各自唯一命中', () => {
    const { tree, chatA, chatB } = multiChatTree('s-alpha', 's-beta');

    const leafA = findChatLeafBySessionId(tree.root, 's-alpha');
    const leafB = findChatLeafBySessionId(tree.root, 's-beta');

    expect(leafA).not.toBeNull();
    expect(leafB).not.toBeNull();
    expect(leafA!.id).toBe(chatA.id);
    expect(leafB!.id).toBe(chatB.id);
    expect(leafA!.id).not.toBe(leafB!.id);

    // 每个 session 恰好 1 个 chat leaf
    const chats = listChatLeaves(tree.root);
    expect(chats).toHaveLength(2);
    expect(chats.filter((c) => c.sessionId === 's-alpha')).toHaveLength(1);
    expect(chats.filter((c) => c.sessionId === 's-beta')).toHaveLength(1);
  });

  it('hasChatLeafForSession 对两 session 均为 true，对未知为 false', () => {
    const { tree } = multiChatTree('s1', 's2');
    expect(hasChatLeafForSession(tree.root, 's1')).toBe(true);
    expect(hasChatLeafForSession(tree.root, 's2')).toBe(true);
    expect(hasChatLeafForSession(tree.root, 's3')).toBe(false);
  });

  it('多 unit 带 dock 时 session 查找仍落到对应 chat leaf（非 tool）', () => {
    const { tree, chatA, chatB } = multiUnitWithDocks();

    const a = findChatLeafBySessionId(tree.root, 'sess-a');
    const b = findChatLeafBySessionId(tree.root, 'sess-b');
    expect(a!.id).toBe(chatA.id);
    expect(b!.id).toBe(chatB.id);
    expect(viewRegistry.isPrimary(a!.panelId)).toBe(true);
    expect(viewRegistry.isPrimary(b!.panelId)).toBe(true);

    // unit root = H(chat|tool) branch，不是 chat leaf 本身
    expect(findUnitRootId(tree.root, 'sess-a')).not.toBe(chatA.id);
    expect(findUnitRootId(tree.root, 'sess-b')).not.toBe(chatB.id);
  });
});

// ── 2. duplicates + drag no-clone ────────────────────────────────────

describe('binding §5.2 — duplicates map & drag no-clone 不变量', () => {
  it('findDuplicateSessionChatLeaves 检出同一 session 两片 chat leaf', () => {
    const first = createLeaf('chat', ['chat'], 'chat', 'dup-sess');
    const second = createLeaf('chat', ['chat'], 'chat', 'dup-sess');
    const other = createLeaf('chat', ['chat'], 'chat', 'unique');
    const pair = createBranch('horizontal', first, second, 0.5);
    const root = createBranch('horizontal', pair, other, 0.5);

    const dups = findDuplicateSessionChatLeaves(root);
    expect(dups.size).toBe(1);
    expect(dups.has('dup-sess')).toBe(true);
    expect(dups.get('dup-sess')!.map((l) => l.id).sort()).toEqual(
      [first.id, second.id].sort()
    );
    expect(dups.has('unique')).toBe(false);
  });

  it('合法 multi-chat（不同 session）duplicates 为空', () => {
    const { tree } = multiChatTree();
    expect(findDuplicateSessionChatLeaves(tree.root).size).toBe(0);
  });

  /**
   * 拖拽幂等（acceptance §5.2 / U3）：
   * 顶栏同一 session tab 反复拖入画布，不得再 split 出新 chat leaf。
   *
   * 纯判定：hasChatLeafForSession(root, sid) === true 时，
   * commitSessionSplit 应 move/focus 已有 leaf，而不是 splitLeaf + bind。
   * （useTopBarDrag 实现侧：A2；此处锁死检测用的纯 API 契约。）
   */
  it('已绑定 session → hasChatLeafForSession 为 true（禁止再 clone 的门闩）', () => {
    const { tree, chatA } = multiChatTree('drag-me', 'other');

    // 模拟「再次拖入 drag-me」前的检查
    expect(hasChatLeafForSession(tree.root, 'drag-me')).toBe(true);
    const existing = findChatLeafBySessionId(tree.root, 'drag-me');
    expect(existing!.id).toBe(chatA.id);

    // 正确路径：只 focus 已有 leaf，树形态与 duplicates 不变
    expect(findDuplicateSessionChatLeaves(tree.root).size).toBe(0);
    expect(listChatLeaves(tree.root)).toHaveLength(2);
  });

  it('错误路径（再 bind 一片同 session）会被 duplicates map 捕获', () => {
    const { tree, chatA } = multiChatTree('drag-me', 'other');
    // 模拟 bug：commitSessionSplit 未检查 hasChatLeaf 又 split 了一片
    const clone = createLeaf('chat', ['chat'], 'chat', 'drag-me');
    const broken: LayoutNode = createBranch('horizontal', tree.root, clone, 0.5);

    const dups = findDuplicateSessionChatLeaves(broken);
    expect(dups.has('drag-me')).toBe(true);
    expect(dups.get('drag-me')!).toHaveLength(2);
    // find 仍返回先序第一个（稳定）
    expect(findChatLeafBySessionId(broken, 'drag-me')!.id).toBe(chatA.id);
  });
});

// ── 3. multi-unit dock 模型（纯树；投影 API 见 skip 块） ─────────────

describe('binding §5.1 — multi-unit 独立 dock 树模型', () => {
  it('两 unit 各自 tool leaf 共存；listToolLeaves 长度为 2', () => {
    const { tree, toolA, toolB } = multiUnitWithDocks();
    const tools = listToolLeaves(tree.root);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.id).sort()).toEqual(
      [toolA.id, toolB.id].sort()
    );
    expect(countChatLeaves(tree.root)).toBe(2);
  });

  it('findUnitRootId 分别指向各自 H(chat|tool)，互不串台', () => {
    const { tree, unitA, unitB } = multiUnitWithDocks('s1', 's2');
    expect(findUnitRootId(tree.root, 's1')).toBe(unitA.id);
    expect(findUnitRootId(tree.root, 's2')).toBe(unitB.id);

    // unit 子树内可找到对应 chat + 一个 tool
    const rootA = findNodeById(tree.root, unitA.id)!;
    const rootB = findNodeById(tree.root, unitB.id)!;
    expect(listChatLeaves(rootA).map((c) => c.sessionId)).toEqual(['s1']);
    expect(listChatLeaves(rootB).map((c) => c.sessionId)).toEqual(['s2']);
    expect(listToolLeaves(rootA)).toHaveLength(1);
    expect(listToolLeaves(rootB)).toHaveLength(1);
    expect(listToolLeaves(rootA)[0]!.panelId).toBe('terminal');
    expect(listToolLeaves(rootB)[0]!.panelId).toBe('files');
  });

  it('normalizeToAdapterShape 保留多 unit + 各 dock（不折叠）', () => {
    const { tree } = multiUnitWithDocks();
    const next = normalizeToAdapterShape(tree);
    expect(countChatLeaves(next.root)).toBe(2);
    expect(listToolLeaves(next.root)).toHaveLength(2);
    expect(findDuplicateSessionChatLeaves(next.root).size).toBe(0);
    expect(findChatLeafBySessionId(next.root, 'sess-a')).not.toBeNull();
    expect(findChatLeafBySessionId(next.root, 'sess-b')).not.toBeNull();
  });
});

// ── 4. close / remove unit（文档 + 发现契约） ─────────────────────────

describe('binding §5.3 — close/remove unit 期望行为', () => {
  /**
   * Expected close/remove unit behavior
   * ────────────────────────────────────
   * Product model §2.2.6 / acceptance §5.3:
   *
   * 关闭顶栏 session tab 时，必须**只**移除该 session 的 ConversationUnit：
   *   - UnitRoot = findUnitRootId(root, sessionId)
   *     · dock 折叠：UnitRoot = chat leaf id
   *     · dock 打开：UnitRoot = H(chatLeaf, toolSubtree) branch id
   *   - 移除 UnitRoot 整棵子树（chat + 其 tool 子树），邻居 unit 回流
   *   - 其它 sessionId 的 chat leaf / tool dock **不得**被删除或改写
   *   - openTabs 去掉该 tab；activeTab 切到邻居（或 mint draft）
   *   - 切 active 后 applyDock 仅作用于新 active 的 unit（A3），不拆邻居 dock
   *
   * 实现归属：A4 `workspaceShellStore.closeTab` + unit-remove 树操作。
   * 当前 closeTab 仍主要改 openTabs + 全局 applyDockToTree，尚未按 UnitRoot 摘树；
   * 此处锁死 close 路径将依赖的纯发现 API，避免 A4 落地时绑错节点。
   */
  it('close 目标发现：dock 折叠时 UnitRoot = chat leaf', () => {
    const { tree, chatA, chatB } = multiChatTree('close-me', 'keep-me');

    // 关闭 close-me 时要摘掉的节点
    expect(findUnitRootId(tree.root, 'close-me')).toBe(chatA.id);
    // 邻居 unit 识别
    expect(findUnitRootId(tree.root, 'keep-me')).toBe(chatB.id);
    expect(findChatLeafBySessionId(tree.root, 'keep-me')!.id).toBe(chatB.id);
  });

  it('close 目标发现：dock 打开时 UnitRoot = H(chat|tool)，含 tool 子树', () => {
    const { tree, unitA, unitB, chatB, toolB } = multiUnitWithDocks(
      'close-me',
      'keep-me'
    );

    // 关闭 close-me → 移除整个 unitA（chatA + toolA）
    expect(findUnitRootId(tree.root, 'close-me')).toBe(unitA.id);
    // keep-me 的 unit / chat / tool 在「摘除前」均可定位（移除后应仍在）
    expect(findUnitRootId(tree.root, 'keep-me')).toBe(unitB.id);
    expect(findChatLeafBySessionId(tree.root, 'keep-me')!.id).toBe(chatB.id);
    expect(
      listToolLeaves(findNodeById(tree.root, unitB.id)!).map((t) => t.id)
    ).toEqual([toolB.id]);
  });

  it('移除 unitA 后的期望残留（手写 promote 邻居，模拟 close 树手术）', () => {
    const { tree, unitA, unitB, chatB, toolB } = multiUnitWithDocks(
      'close-me',
      'keep-me'
    );

    // 模拟：UnitRoot=unitA 被摘掉，兄弟 unitB 提升为新 root
    // （与 removeBranch(root, unitA.id, keepSibling) 语义一致）
    expect(tree.root.type).toBe('branch');
    const rootBranch = tree.root as ReturnType<typeof createBranch>;
    expect(rootBranch.children[0].id).toBe(unitA.id);
    expect(rootBranch.children[1].id).toBe(unitB.id);

    const afterClose: LayoutTree = {
      version: tree.version,
      root: unitB, // promote sibling = 仅保留 keep-me unit
    };

    // close-me 完全消失
    expect(findChatLeafBySessionId(afterClose.root, 'close-me')).toBeNull();
    expect(findUnitRootId(afterClose.root, 'close-me')).toBeNull();
    // keep-me unit 完整保留（chat + files dock）
    expect(findChatLeafBySessionId(afterClose.root, 'keep-me')!.id).toBe(
      chatB.id
    );
    expect(findUnitRootId(afterClose.root, 'keep-me')).toBe(unitB.id);
    expect(listToolLeaves(afterClose.root).map((t) => t.id)).toEqual([
      toolB.id,
    ]);
    expect(listChatLeaves(afterClose.root)).toHaveLength(1);
  });
});

// ── 5. applyDockToTree per-session（A3 dock-per-unit-project） ───────

describe('binding §5.1 — applyDockToTree 不影响邻居 unit dock', () => {
  it('collapse session A dock 不移除 session B tools', () => {
    const { tree, toolB, chatA } = multiUnitWithDocks();
    expect(listToolLeaves(tree.root)).toHaveLength(2);

    const next = collapseSessionUnitDock(tree, 'sess-a');
    // 等价 projectDock collapsed
    const viaProject = projectDockOntoTree(
      tree,
      createDefaultDock({ collapsed: true }),
      'sess-a'
    );

    for (const result of [next, viaProject]) {
      expect(findChatLeafBySessionId(result.root, 'sess-b')).toBeTruthy();
      expect(findChatLeafBySessionId(result.root, 'sess-a')!.id).toBe(chatA.id);
      expect(findUnitRootId(result.root, 'sess-a')).toBe(chatA.id);
      const tools = listToolLeaves(result.root);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.id).toBe(toolB.id);
      expect(tools[0]!.panelId).toBe('files');
    }
  });

  it('open/replace session A dock panels 不改写 session B tool tabs', () => {
    const { tree, toolB } = multiUnitWithDocks();
    expect(toolB.panelId).toBe('files');

    const next = expandSessionUnitDock(
      tree,
      'sess-a',
      ['diff'],
      'diff',
      0.38
    );
    // B files 仍在
    const tools = listToolLeaves(next.root);
    expect(tools.some((t) => t.id === toolB.id && t.panelId === 'files')).toBe(
      true
    );
    // A unit 有 diff
    const unitA = findNodeById(next.root, findUnitRootId(next.root, 'sess-a')!);
    expect(unitA && unitA.type === 'branch').toBe(true);
    if (unitA && unitA.type === 'branch') {
      const toolSide = unitA.children[1];
      expect(toolSide.type).toBe('leaf');
      if (toolSide.type === 'leaf') {
        expect(toolSide.activeTab).toBe('diff');
        expect(toolSide.tabs).toEqual(['diff']);
      }
    }
  });
});

// ── 6. pure / no mutation smoke ──────────────────────────────────────

describe('binding — pure helpers 不修改输入树', () => {
  it('查询 API 不 mutate multi-unit fixture', () => {
    const { tree } = multiUnitWithDocks();
    const before = JSON.stringify(tree);

    void findChatLeafBySessionId(tree.root, 'sess-a');
    void findChatLeafBySessionId(tree.root, 'sess-b');
    void hasChatLeafForSession(tree.root, 'sess-a');
    void findDuplicateSessionChatLeaves(tree.root);
    void findUnitRootId(tree.root, 'sess-a');
    void listChatLeaves(tree.root);
    void listToolLeaves(tree.root);
    void collectLeaves(tree.root);
    void normalizeToAdapterShape(tree);

    expect(JSON.stringify(tree)).toBe(before);
  });
});
