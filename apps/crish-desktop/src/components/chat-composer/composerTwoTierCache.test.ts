import { describe, expect, it, vi } from 'vitest';
import {
  ComposerImeDragGuard,
  DirtyBlockRangeLedger,
  TwoTierBlockEditorCache,
} from './composerTwoTierCache';

interface MockPmBlockNode {
  id: string;
  type: 'paragraph' | 'codeBlock' | 'heading';
  text: string;
}

function makeFingerprint(node: MockPmBlockNode): string {
  return `${node.type}:${node.text.length}:${node.text}`;
}

describe('TwoTierBlockEditorCache & DirtyBlockRangeLedger (W3-2)', () => {
  it('L1 WeakMap 直接命中：节点对象引用未变时 100% 命中 L1 且 0 重算', () => {
    const cache = new TwoTierBlockEditorCache<MockPmBlockNode, string>();
    const blocks: MockPmBlockNode[] = [
      { id: 'b0', type: 'paragraph', text: '第一段内容' },
      { id: 'b1', type: 'codeBlock', text: 'const x = 42;' },
      { id: 'b2', type: 'paragraph', text: '第三段内容' },
    ];

    const computeFn = vi.fn(
      (node: MockPmBlockNode, idx: number) => `[${idx}]${node.text}`
    );

    // 首次解析：3 个块执行计算并写入 L1 + L2
    const firstPass = blocks.map((node, idx) =>
      cache.getOrCompute(node, idx, makeFingerprint(node), computeFn)
    );
    expect(firstPass).toEqual([
      '[0]第一段内容',
      '[1]const x = 42;',
      '[2]第三段内容',
    ]);
    expect(computeFn).toHaveBeenCalledTimes(3);
    expect(cache.getStats()).toMatchObject({
      l1Hits: 0,
      l2HealHits: 0,
      computes: 3,
      l2Size: 3,
    });

    // 第二次遍历相同节点引用：100% 命中 L1 WeakMap，computeFn 调用 0 次
    computeFn.mockClear();
    const secondPass = blocks.map((node, idx) =>
      cache.getOrCompute(node, idx, makeFingerprint(node), computeFn)
    );
    expect(secondPass).toEqual(firstPass);
    expect(computeFn).toHaveBeenCalledTimes(0);
    expect(cache.getStats()).toMatchObject({
      l1Hits: 3,
      l2HealHits: 0,
      computes: 3,
    });
  });

  it('模拟 ProseMirror Undo / Transform 节点重建：非脏区间块 100% 触发 L2 自愈命中并回填 L1，computeFn 调用次数为 0', () => {
    const cache = new TwoTierBlockEditorCache<MockPmBlockNode, string>();
    const initialNodes: MockPmBlockNode[] = Array.from(
      { length: 10 },
      (_, i) => ({
        id: `block-${i}`,
        type: 'paragraph',
        text: `段落原始文本 #${i}`,
      })
    );

    const computeFn = vi.fn(
      (node: MockPmBlockNode) => `MD:${node.type}:${node.text}`
    );

    // 预热缓存
    for (let i = 0; i < initialNodes.length; i++) {
      const node = initialNodes[i]!;
      cache.getOrCompute(node, i, makeFingerprint(node), computeFn);
    }
    expect(computeFn).toHaveBeenCalledTimes(10);

    // 模拟 ProseMirror Undo / Transform.step()：全树节点重新分配全新对象引用
    computeFn.mockClear();
    cache.clearDirtyRanges();
    const rebuiltNodes: MockPmBlockNode[] = initialNodes.map((n) => ({ ...n }));

    for (let i = 0; i < rebuiltNodes.length; i++) {
      expect(rebuiltNodes[i]).not.toBe(initialNodes[i]);
      expect(cache.peekL1(rebuiltNodes[i]!)).toBeUndefined();
    }

    const healedResults = rebuiltNodes.map((node, i) =>
      cache.getOrCompute(node, i, makeFingerprint(node), computeFn)
    );

    // 断言：0 次重新计算，10 个块全部从 L2 自愈恢复并回填至新节点的 L1 WeakMap
    expect(computeFn).toHaveBeenCalledTimes(0);
    expect(healedResults).toHaveLength(10);
    expect(cache.getStats()).toMatchObject({
      l1Hits: 0,
      l2HealHits: 10,
      computes: 10,
    });

    // 验证新节点引用已成功回填至 L1 WeakMap，再次读取直接命中 L1
    for (let i = 0; i < rebuiltNodes.length; i++) {
      expect(cache.peekL1(rebuiltNodes[i]!)).toBeDefined();
    }
    const postHealPass = rebuiltNodes.map((node, i) =>
      cache.getOrCompute(node, i, makeFingerprint(node), computeFn)
    );
    expect(postHealPass).toEqual(healedResults);
    expect(computeFn).toHaveBeenCalledTimes(0);
    expect(cache.getStats().l1Hits).toBe(10);
  });

  it('脏块区间账本 [dirtyFrom, dirtyTo]：仅处于脏区间内的修改块触发重算，其余重建节点 100% 走 L2 自愈', () => {
    const cache = new TwoTierBlockEditorCache<MockPmBlockNode, string>();
    const baseNodes: MockPmBlockNode[] = Array.from({ length: 6 }, (_, i) => ({
      id: `b-${i}`,
      type: 'paragraph',
      text: `块内容-${i}`,
    }));

    const computeFn = vi.fn(
      (node: MockPmBlockNode, idx: number) => `PARSED(${idx}):${node.text}`
    );

    baseNodes.forEach((node, idx) => {
      cache.getOrCompute(node, idx, makeFingerprint(node), computeFn);
    });
    expect(computeFn).toHaveBeenCalledTimes(6);

    // 标记索引 [2, 3] 为脏块区间，同时全树节点发生不可变克隆重建
    computeFn.mockClear();
    cache.markDirtyRange(2, 3);

    const nextNodes: MockPmBlockNode[] = baseNodes.map((node, idx) => {
      if (idx === 2 || idx === 3) {
        return { ...node, text: `${node.text}-已编辑` };
      }
      return { ...node }; // 全新引用但内容未变
    });

    const outputs = nextNodes.map((node, idx) =>
      cache.getOrCompute(node, idx, makeFingerprint(node), computeFn)
    );

    // 仅块 2 与块 3 触发重算 (2 次)，其余 4 个非脏块 (0, 1, 4, 5) 全部走 L2 自愈
    expect(computeFn).toHaveBeenCalledTimes(2);
    expect(computeFn).toHaveBeenCalledWith(nextNodes[2], 2);
    expect(computeFn).toHaveBeenCalledWith(nextNodes[3], 3);
    expect(outputs[2]).toBe('PARSED(2):块内容-2-已编辑');
    expect(outputs[3]).toBe('PARSED(3):块内容-3-已编辑');
    expect(cache.getStats()).toMatchObject({
      l2HealHits: 4,
      computes: 8,
    });

    // 清理脏区间后再次重建（模拟 Undo 撤回至原文本）：由于原始指纹仍在 L2 中，6 个块全部 L2 自愈，0 重算
    computeFn.mockClear();
    cache.clearDirtyRanges();
    const undoNodes = baseNodes.map((n) => ({ ...n }));
    const undoOutputs = undoNodes.map((node, idx) =>
      cache.getOrCompute(node, idx, makeFingerprint(node), computeFn)
    );
    expect(computeFn).toHaveBeenCalledTimes(0);
    expect(undoOutputs[2]).toBe('PARSED(2):块内容-2');
    expect(cache.getStats().l2HealHits).toBe(10);
  });

  it('DirtyBlockRangeLedger 应正确合并重叠与相邻脏区间，且 L2 严格遵守有界 LRU 容量淘汰', () => {
    const ledger = new DirtyBlockRangeLedger();
    ledger.markDirtyRange(5, 2); // 逆序自动归一化为 [2, 5]
    ledger.markDirtyRange(6, 8); // 与 [2, 5] 相邻，合并为 [2, 8]
    ledger.markDirtyRange(12, 15);
    ledger.markDirtyRange(7, 13); // 跨接合并为 [2, 15]

    expect(ledger.getDirtyRanges()).toEqual([{ fromIndex: 2, toIndex: 15 }]);
    expect(ledger.isIndexDirty(1)).toBe(false);
    expect(ledger.isIndexDirty(2)).toBe(true);
    expect(ledger.isIndexDirty(10)).toBe(true);
    expect(ledger.isIndexDirty(16)).toBe(false);

    // 验证有界 LRU (容量 = 3)
    const boundedCache = new TwoTierBlockEditorCache<MockPmBlockNode, string>({
      maxL2Capacity: 3,
    });
    const makeNode = (i: number): MockPmBlockNode => ({
      id: `n-${i}`,
      type: 'paragraph',
      text: `text-${i}`,
    });

    for (let i = 0; i < 4; i++) {
      const n = makeNode(i);
      boundedCache.getOrCompute(n, i, makeFingerprint(n), (node) => node.text);
    }

    expect(boundedCache.getStats().l2Size).toBe(3);
    expect(boundedCache.peekL2(makeFingerprint(makeNode(0)))).toBeUndefined();
    expect(boundedCache.peekL2(makeFingerprint(makeNode(3)))).toBeDefined();
  });

  it('边界用例：空的脏块区间、全负数区间及 NaN 不应污染账本，高频极端连续击键仅触发修改块重算', () => {
    const ledger = new DirtyBlockRangeLedger();
    const initialEpoch = ledger.getEpoch();

    // 1. 全负数区间与 NaN 边界：不应递增 epoch，不应污染索引 0
    expect(ledger.markDirtyRange(-1, -1)).toBe(initialEpoch);
    expect(ledger.markDirtyRange(-5, -2)).toBe(initialEpoch);
    expect(ledger.markDirtyRange(NaN, 3)).toBe(initialEpoch);
    expect(ledger.markDirtyRange(2, NaN)).toBe(initialEpoch);
    expect(ledger.getDirtyRanges()).toHaveLength(0);
    expect(ledger.isIndexDirty(0)).toBe(false);
    expect(ledger.isIndexDirty(-1)).toBe(false);

    // 2. 极端连续 50 次单字符连续击键打字场景：
    // 模拟 10 块富文本草稿，用户在块 3 中以 10ms 间隔极速输入 50 个字符
    const cache = new TwoTierBlockEditorCache<MockPmBlockNode, string>();
    let currentNodes: MockPmBlockNode[] = Array.from(
      { length: 10 },
      (_, i) => ({
        id: `blk-${i}`,
        type: 'paragraph',
        text: `初始段落内容 #${i}`,
      })
    );

    const computeFn = vi.fn(
      (node: MockPmBlockNode, idx: number) => `MD[${idx}]:${node.text}`
    );

    // 初始预热解析：10 个块
    currentNodes.forEach((node, i) => {
      cache.getOrCompute(node, i, makeFingerprint(node), computeFn);
    });
    expect(computeFn).toHaveBeenCalledTimes(10);
    computeFn.mockClear();

    // 连续 50 次击键：ProseMirror 在每次击键后重建整棵语法树的节点对象引用
    for (let stroke = 1; stroke <= 50; stroke++) {
      cache.markDirtyRange(3, 3);
      currentNodes = currentNodes.map((n, idx) => {
        if (idx === 3) {
          return { ...n, text: `初始段落内容 #3 + 击键_${stroke}` };
        }
        return { ...n }; // 不可变克隆：全新对象引用但内容指纹不变
      });

      // 遍历解析全部 10 个块
      currentNodes.forEach((node, idx) => {
        cache.getOrCompute(node, idx, makeFingerprint(node), computeFn);
      });
    }

    // 核心断言：
    // - 仅脏块 3 每次触发重算 (50 次)
    // - 其余 9 个未修改块在 50 轮遍历中 (450 次读取) 100% 走 L2 自愈通道，computeFn 调用次数精确为 50！
    expect(computeFn).toHaveBeenCalledTimes(50);
    const stats = cache.getStats();
    expect(stats.computes).toBe(60); // 10 (初始) + 50 (击键)
    expect(stats.l2HealHits).toBe(450); // 9 个块 * 50 轮
  });
});

describe('ComposerImeDragGuard 分屏拖拽交互期 IME 与光标保护守卫 (W3-2)', () => {
  it('在中文拼音输入 (isComposing = true) 期间应拦截外部受控重同步，并在 compositionend 后无损恢复选区偏移', () => {
    const guard = new ComposerImeDragGuard<string>();
    const onExternalApply = vi.fn();

    // 记录拼音组合前的光标选区
    guard.captureSelection(6, 6, 'block-main');
    guard.onCompositionStart({
      selectionStart: 6,
      selectionEnd: 6,
      blockId: 'block-main',
    });

    expect(guard.isComposing()).toBe(true);
    expect(guard.shouldDeferExternalSync()).toBe(true);

    // 模拟外部 SWR 刷新或受控回流到来：必须被拦截挂起
    const appliedDuringIme = guard.tryApplyExternalSync(
      '外部SWR覆盖文本',
      onExternalApply
    );
    expect(appliedDuringIme).toBe(false);
    expect(onExternalApply).not.toHaveBeenCalled();

    // 拼音上屏完成 (compositionend)，选区推进至偏移 10
    const endResult = guard.onCompositionEnd({
      selectionStart: 10,
      selectionEnd: 10,
      blockId: 'block-main',
    });

    expect(guard.isComposing()).toBe(false);
    expect(guard.shouldDeferExternalSync()).toBe(false);
    expect(endResult.deferredValue).toBe('外部SWR覆盖文本');
    expect(endResult.restoredSelection).toEqual({
      selectionStart: 10,
      selectionEnd: 10,
      blockId: 'block-main',
    });

    // 验证对真实输入元素的光标偏移无损恢复
    const mockInput = {
      value: '已经输入中文内容之后的文本',
      selectionStart: 0,
      selectionEnd: 0,
      setSelectionRange: vi.fn(function (
        this: { selectionStart: number; selectionEnd: number },
        start: number,
        end: number
      ) {
        this.selectionStart = start;
        this.selectionEnd = end;
      }),
    };

    const restored = guard.restoreSelection(mockInput);
    expect(restored).toEqual({
      selectionStart: 10,
      selectionEnd: 10,
      blockId: 'block-main',
    });
    expect(mockInput.setSelectionRange).toHaveBeenCalledWith(10, 10);
    expect(mockInput.selectionStart).toBe(10);
  });

  it('在分屏拖拽冻结期 (isDragging = true) 及 IME 叠加态下应严格挂起外部同步，直至双重状态全部解除', () => {
    const guard = new ComposerImeDragGuard<string>();

    guard.beginDrag({
      selectionStart: 4,
      selectionEnd: 8,
      blockId: 'pane-leaf-1',
    });
    expect(guard.isDragging()).toBe(true);
    expect(guard.shouldDeferExternalSync()).toBe(true);

    // 拖拽途中用户同时触发中文输入法组合
    guard.onCompositionStart();
    expect(guard.tryApplyExternalSync('拖拽期SWR快照-1')).toBe(false);
    expect(guard.tryApplyExternalSync('拖拽期SWR快照-2')).toBe(false);

    // 拖拽先结束，但 IME 仍在组合中：依然禁止提前释放外部同步
    const afterDragEnd = guard.endDrag();
    expect(guard.isDragging()).toBe(false);
    expect(guard.isComposing()).toBe(true);
    expect(guard.shouldDeferExternalSync()).toBe(true);
    expect(afterDragEnd.deferredValue).toBeUndefined();

    // IME 组合随后结束：此时双重保护解除，释放最新挂起值并恢复光标快照
    const afterImeEnd = guard.onCompositionEnd({
      selectionStart: 12,
      selectionEnd: 12,
    });
    expect(guard.shouldDeferExternalSync()).toBe(false);
    expect(afterImeEnd.deferredValue).toBe('拖拽期SWR快照-2');
    expect(afterImeEnd.restoredSelection).toEqual({
      selectionStart: 12,
      selectionEnd: 12,
      blockId: 'pane-leaf-1',
    });

    // 验证分屏拖拽期间快捷键白名单分流契约
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'ArrowLeft' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'Backspace' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'z', ctrlKey: true })).toBe(
      true
    );
    expect(
      guard.isKeyWhitelistedDuringDrag({ key: 'F12', ctrlKey: true })
    ).toBe(false);
  });

  it('边界用例：拖拽期极端连续击键分流、Windows WebView2 Process 组合键与越界选区钳制', () => {
    const guard = new ComposerImeDragGuard<string>();

    // 1. Windows WebView2 IME 组合键 Process 与常规字符击键白名单
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'Process' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: '中' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'a' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: '9' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: ' ' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'Enter' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'c', ctrlKey: true })).toBe(
      true
    );
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'v', metaKey: true })).toBe(
      true
    );

    // 非编辑功能键应被拦截
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'F5' })).toBe(false);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'PageDown' })).toBe(false);

    // 2. 选区越界自动安全钳制：输入框文本长度仅 5，但快照记录偏移 50
    guard.captureSelection(50, 100, 'block-overflow');
    const mockShortInput = {
      value: 'hello',
      selectionStart: 0,
      selectionEnd: 0,
      setSelectionRange: vi.fn(function (
        this: { selectionStart: number; selectionEnd: number },
        s: number,
        e: number
      ) {
        this.selectionStart = s;
        this.selectionEnd = e;
      }),
    };

    const restored = guard.restoreSelection(mockShortInput);
    expect(restored).toEqual({
      selectionStart: 5,
      selectionEnd: 5,
      blockId: 'block-overflow',
    });
    expect(mockShortInput.selectionStart).toBe(5);
    expect(mockShortInput.selectionEnd).toBe(5);

    // 3. 负数选区坐标自动归一化
    const negativeSnap = guard.captureSelection(-10, -5);
    expect(negativeSnap.selectionStart).toBe(0);
    expect(negativeSnap.selectionEnd).toBe(0);
  });
});
