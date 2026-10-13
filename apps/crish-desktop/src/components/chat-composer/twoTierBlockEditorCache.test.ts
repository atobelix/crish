import { describe, expect, it, vi } from 'vitest';
import {
  DirtyBlockRangeLedger,
  IncrementalMarkdownSerializer,
  TwoTierBlockEditorCache,
  computeBlockFingerprint,
  type ProseMirrorBlockNodeLike,
  type ProseMirrorDocLike,
} from './twoTierBlockEditorCache';
import {
  serializeToMarkdown,
  type JSONContent,
} from './serialization/markdownSerializer';

interface MockBlock {
  id: string;
  type: string;
  text: string;
}

describe('twoTierBlockEditorCache (Stage 05 §3 & Audit 03 §7.1)', () => {
  describe('computeBlockFingerprint', () => {
    it('对相同输入生成确定性 FNV-1a 指纹，对不同 nodeType / textContent / attrsJson 严格区分', () => {
      const fp1 = computeBlockFingerprint('paragraph', 'hello world', '');
      const fp2 = computeBlockFingerprint('paragraph', 'hello world', '');
      const fpDiffText = computeBlockFingerprint(
        'paragraph',
        'hello world!',
        ''
      );
      const fpDiffType = computeBlockFingerprint('heading', 'hello world', '');
      const fpDiffAttrs = computeBlockFingerprint(
        'heading',
        'hello world',
        'level=2'
      );

      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^paragraph:11:[0-9a-z]+$/);
      expect(fp1).not.toBe(fpDiffText);
      expect(fp1).not.toBe(fpDiffType);
      expect(fpDiffType).not.toBe(fpDiffAttrs);
    });
  });

  describe('DirtyBlockRangeLedger', () => {
    it('支持乱序插入、重叠归并、相邻闭区间归并与二分查询', () => {
      const ledger = new DirtyBlockRangeLedger();
      expect(ledger.getEpoch()).toBe(0);

      ledger.markDirtyRange(10, 12);
      ledger.markDirtyRange(2, 4);
      ledger.markDirtyRange(5, 7); // 与 [2, 4] 相邻，应归并为 [2, 7]
      ledger.markDirtyRange(6, 10); // 连接 [2, 7] 与 [10, 12]，应归并为 [2, 12]

      expect(ledger.getDirtyRanges()).toEqual([
        { from: 2, to: 12, fromIndex: 2, toIndex: 12 },
      ]);

      expect(ledger.isIndexDirty(1)).toBe(false);
      expect(ledger.isIndexDirty(2)).toBe(true);
      expect(ledger.isIndexDirty(8)).toBe(true);
      expect(ledger.isIndexDirty(12)).toBe(true);
      expect(ledger.isIndexDirty(13)).toBe(false);

      ledger.clearDirtyRanges();
      expect(ledger.getDirtyRanges()).toEqual([]);
      expect(ledger.isIndexDirty(5)).toBe(false);
    });
  });

  describe('TwoTierBlockEditorCache', () => {
    it('L1 WeakMap 命中：同一块引用且未标脏时 O(1) 命中 L1，不触发重算', () => {
      const cache = new TwoTierBlockEditorCache<MockBlock, string>();
      const block: MockBlock = {
        id: 'b-0',
        type: 'paragraph',
        text: 'const x = 1;',
      };
      const fp = computeBlockFingerprint(block.type, block.text);
      const computeSpy = vi.fn(() => `<p>${block.text}</p>`);

      const first = cache.getOrCompute(block, fp, computeSpy, 0);
      expect(first).toBe('<p>const x = 1;</p>');
      expect(computeSpy).toHaveBeenCalledTimes(1);
      expect(cache.getStats()).toMatchObject({
        l1Hits: 0,
        l2Hits: 0,
        misses: 1,
      });

      const second = cache.getOrCompute(block, fp, computeSpy, 0);
      expect(second).toBe('<p>const x = 1;</p>');
      expect(computeSpy).toHaveBeenCalledTimes(1);
      expect(cache.getStats()).toMatchObject({
        l1Hits: 1,
        l2Hits: 0,
        misses: 1,
      });
    });

    it('兄弟块浅拷贝自愈：新对象引用但内容指纹一致时 100% 命中 L2 并回填 L1', () => {
      const cache = new TwoTierBlockEditorCache<MockBlock, string>();
      const original: MockBlock = {
        id: 'b-1',
        type: 'paragraph',
        text: 'sibling content',
      };
      const fp = computeBlockFingerprint(original.type, original.text);
      const computeSpy = vi.fn(() => `rendered:${original.text}`);

      cache.getOrCompute(original, fp, computeSpy, 1);
      expect(computeSpy).toHaveBeenCalledTimes(1);

      // 模拟状态更新导致兄弟块被浅拷贝（对象引用改变，内容指纹不变）
      const shallowClone: MockBlock = { ...original };
      const healedResult = cache.getOrCompute(shallowClone, fp, computeSpy, 1);

      expect(healedResult).toBe('rendered:sibling content');
      expect(computeSpy).toHaveBeenCalledTimes(1);
      expect(cache.getStats()).toMatchObject({
        l1Hits: 0,
        l2Hits: 1,
        misses: 1,
      });
      expect(cache.peekL1(shallowClone)?.value).toBe(
        'rendered:sibling content'
      );

      // 下一轮访问该浅拷贝对象时直接命中 L1
      cache.getOrCompute(shallowClone, fp, computeSpy, 1);
      expect(cache.getStats().l1Hits).toBe(1);
    });

    it('审计 §7.1 关键断言：ProseMirror Undo 标脏块且重建 Node 引用时，解绑 !isDirty 阻断后 100% 命中 L2 并自愈回填 L1', () => {
      const cache = new TwoTierBlockEditorCache<MockBlock, string>();

      // 初始版本 v1
      const blockV1: MockBlock = {
        id: 'b-0',
        type: 'paragraph',
        text: 'initial paragraph',
      };
      const fpV1 = computeBlockFingerprint(blockV1.type, blockV1.text);
      const computeV1 = vi.fn(() => 'MD:initial paragraph');

      expect(cache.getOrCompute(blockV1, fpV1, computeV1, 0)).toBe(
        'MD:initial paragraph'
      );
      expect(computeV1).toHaveBeenCalledTimes(1);

      // 用户输入修改块 0 为 v2（事务标脏块 0）
      cache.markDirtyRange(0, 0);
      const blockV2: MockBlock = {
        id: 'b-0',
        type: 'paragraph',
        text: 'initial paragraph edited',
      };
      const fpV2 = computeBlockFingerprint(blockV2.type, blockV2.text);
      const computeV2 = vi.fn(() => 'MD:initial paragraph edited');

      expect(cache.getOrCompute(blockV2, fpV2, computeV2, 0)).toBe(
        'MD:initial paragraph edited'
      );
      expect(computeV2).toHaveBeenCalledTimes(1);
      cache.clearDirtyRanges();

      // 用户按下 Ctrl+Z (Undo)：ProseMirror 事务将块 0 标脏，并创建全新的 Node 引用 blockV1Undo，但内容恢复为 v1
      cache.markDirtyRange(0, 0);
      const blockV1Undo: MockBlock = {
        id: 'b-0',
        type: 'paragraph',
        text: 'initial paragraph',
      };
      const computeUndoShouldNotRun = vi.fn(() => 'SHOULD_NOT_RECOMPUTE');

      const undoResult = cache.getOrCompute(
        blockV1Undo,
        fpV1,
        computeUndoShouldNotRun,
        0
      );

      // 必须 100% 命中 L2 历史指纹，严禁触发重算
      expect(undoResult).toBe('MD:initial paragraph');
      expect(computeUndoShouldNotRun).not.toHaveBeenCalled();
      expect(cache.getStats()).toMatchObject({
        l2Hits: 1,
        misses: 2, // 仅 v1 初次与 v2 编辑两次 miss，Undo 零 miss
        dirtyQueries: 2,
      });

      // 验证 Undo 块引用已自愈写回 L1，清理脏区间后下一次直接命中 L1
      expect(cache.peekL1(blockV1Undo)?.value).toBe('MD:initial paragraph');
      cache.clearDirtyRanges();

      const nextFrameResult = cache.getOrCompute(
        blockV1Undo,
        fpV1,
        computeUndoShouldNotRun,
        0
      );
      expect(nextFrameResult).toBe('MD:initial paragraph');
      expect(cache.getStats().l1Hits).toBe(1);
    });

    it('L2 有界 512 容量与标量时钟 LRU 淘汰：高频命中条目免于被淘汰', () => {
      const maxEntries = 16;
      const cache = new TwoTierBlockEditorCache<MockBlock, string>(maxEntries);

      const block0: MockBlock = { id: '0', type: 'p', text: 'block-0' };
      const fp0 = computeBlockFingerprint('p', 'block-0');
      cache.getOrCompute(block0, fp0, () => 'val-0', 0);

      for (let i = 1; i < maxEntries; i++) {
        const b: MockBlock = { id: `${i}`, type: 'p', text: `block-${i}` };
        const fp = computeBlockFingerprint('p', `block-${i}`);
        cache.getOrCompute(b, fp, () => `val-${i}`, i);
      }

      // 访问 block0（通过 L1 命中刷新 L2 LRU 时钟），此时最老条目变为 block-1
      cache.getOrCompute(block0, fp0, () => 'val-0', 0);

      // 插入第 17 个条目，触发容量上限淘汰
      const block16: MockBlock = { id: '16', type: 'p', text: 'block-16' };
      const fp16 = computeBlockFingerprint('p', 'block-16');
      cache.getOrCompute(block16, fp16, () => 'val-16', 16);

      const fp1 = computeBlockFingerprint('p', 'block-1');
      expect(cache.getStats().l2Size).toBe(maxEntries);
      expect(cache.getStats().l2Evictions).toBe(1);
      expect(cache.peekL2(fp0)).toBeDefined();
      expect(cache.peekL2(fp1)).toBeUndefined();
    });
  });

  describe('IncrementalMarkdownSerializer', () => {
    it('500 块文档单块编辑：499 个未变块走 O(1) L1 命中，仅对 1 个脏块调用 toJSON 与序列化，且 Undo 走 L2 命中', () => {
      const serializer = new IncrementalMarkdownSerializer();
      const toJsonSpies: Array<ReturnType<typeof vi.fn>> = [];

      const createPmBlock = (
        index: number,
        text: string
      ): ProseMirrorBlockNodeLike => {
        const toJSON = vi.fn((): JSONContent => ({
          type: 'paragraph',
          content: [{ type: 'text', text }],
        }));
        toJsonSpies[index] = toJSON;
        return {
          type: { name: 'paragraph' },
          textContent: text,
          childCount: 1,
          child: () => ({
            type: { name: 'text' },
            text,
          }),
          toJSON,
        };
      };

      const blocks = Array.from({ length: 500 }, (_, i) =>
        createPmBlock(i, `Paragraph line ${i}`)
      );

      const makeDoc = (
        list: ProseMirrorBlockNodeLike[]
      ): ProseMirrorDocLike => ({
        childCount: list.length,
        child: (idx: number) => list[idx],
      });

      // 首次全量序列化热身
      const initialMd = serializer.serializeDoc(makeDoc(blocks));
      expect(serializer.getCache().getStats()).toMatchObject({
        l1Hits: 0,
        l2Hits: 0,
        misses: 500,
      });

      // 重置 toJSON 调用计数
      toJsonSpies.forEach((spy) => spy.mockClear());

      // 模拟用户在第 250 块打字：仅第 250 块引用替换为新 Node，其余 499 块保持原引用
      const originalBlock250 = blocks[250];
      blocks[250] = createPmBlock(250, 'Paragraph line 250 updated');
      serializer.markDirtyRange(250, 250);

      const updatedMd = serializer.serializeDoc(makeDoc(blocks));
      expect(updatedMd).toContain('Paragraph line 250 updated');
      expect(updatedMd).not.toBe(initialMd);

      // 499 个未修改块全部命中 L1，且它们的 toJSON 零调用！
      expect(serializer.getCache().getStats()).toMatchObject({
        l1Hits: 499,
        l2Hits: 0,
        misses: 501,
      });
      expect(toJsonSpies[250]).toHaveBeenCalledTimes(1);
      expect(toJsonSpies[0]).not.toHaveBeenCalled();
      expect(toJsonSpies[499]).not.toHaveBeenCalled();

      // 模拟用户按下 Undo：第 250 块标脏，且重建了全新的 Node 引用（内容与初始一致）
      blocks[250] = createPmBlock(250, 'Paragraph line 250');
      serializer.markDirtyRange(250, 250);

      const undoMd = serializer.serializeDoc(makeDoc(blocks));
      expect(undoMd).toBe(initialMd);
      // Undo 块命中 L2，不调用 toJSON！
      expect(toJsonSpies[250]).not.toHaveBeenCalled();
      expect(serializer.getCache().getStats()).toMatchObject({
        l1Hits: 499 + 499,
        l2Hits: 1,
        misses: 501,
      });
      // 且新的第 250 块引用已被自愈回填至 L1
      expect(serializer.getCache().peekL1(originalBlock250)).toBeDefined();
      expect(serializer.getCache().peekL1(blocks[250])).toBeDefined();
    });

    it('复杂文档结构（标题/列表/代码块/引用/提及/行内样式/尾部空段落）与全量 serializeToMarkdown 输出 100% 严格一致', () => {
      const complexDoc: JSONContent = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Stage 05 标题' }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '普通文本 ' },
              { type: 'text', text: '加粗', marks: [{ type: 'bold' }] },
              { type: 'text', text: ' 与 ' },
              {
                type: 'mention',
                attrs: { id: 'src/app.ts', label: 'app.ts', kind: 'file' },
              },
            ],
          },
          {
            type: 'codeBlock',
            attrs: { language: 'ts' },
            content: [{ type: 'text', text: '  const a = 1;\n  return a;' }],
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '列表项 1' }],
                  },
                ],
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '列表项 2' }],
                  },
                ],
              },
            ],
          },
          {
            type: 'paragraph',
          },
        ],
      };

      const serializer = new IncrementalMarkdownSerializer();
      const incrementalOut = serializer.serializeJsonDoc(complexDoc);
      const fullOut = serializeToMarkdown(complexDoc);

      expect(incrementalOut).toBe(fullOut);
    });
  });
});
