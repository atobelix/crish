/**
 * IME 协同对抗与并发 CRDT 极限实证测试。
 *
 * 依据 Unit 7.3 规范：
 * 1. 模拟中文输入法合成期间并发注入 100 次远端二进制 / 协同 Update；
 * 2. 验证 CompositionPatchBuffer 增量缓冲区、DomPinningRegistry 呈现锁与 Emoji/多字节标量转换；
 * 3. 严格断言：
 *    - 0 吞字 (0 swallowed characters)
 *    - 0 错位 (0 coordinate position offsets)
 *    - 0 代理项撕裂 (0 surrogate pair tearing)
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { BlockId, ProjectionDiff } from '@crish/block-paper-contract';
import { CompositionPatchBuffer } from './CompositionPatchBuffer';
import { DomPinningRegistry } from '../viewport/domPinning';
import { ImeMachine } from './ImeMachine';
import {
  diffToReplace,
  isHighSurrogate,
  isLowSurrogate,
  isSurrogateCodePoint,
  utf16OffsetToUnicodeScalar,
  unicodeScalarToUtf16Offset,
  countUnicodeScalars,
} from '../diff/diffToReplace';

/**
 * 校验指定字符串中绝无任何撕裂的代理项（高位无低位跟从、或低位无高位先导）。
 */
function assertNoSurrogatePairTearing(str: string, contextLabel: string): void {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (isHighSurrogate(code)) {
      expect(isSurrogateCodePoint(code)).toBe(true);
      expect(
        i + 1 < str.length,
        `[${contextLabel}] 高位代理项 0x${code.toString(16)} 位于串尾，发生撕裂 (index: ${i})`
      ).toBe(true);
      const nextCode = str.charCodeAt(i + 1);
      expect(isSurrogateCodePoint(nextCode)).toBe(true);
      expect(
        isLowSurrogate(nextCode),
        `[${contextLabel}] 高位代理项 0x${code.toString(16)} 后跟非法字符 0x${nextCode.toString(16)} (index: ${i})`
      ).toBe(true);
      i++; // 跳过合法低位
    } else if (isLowSurrogate(code)) {
      expect(isSurrogateCodePoint(code)).toBe(true);
      expect(
        false,
        `[${contextLabel}] 孤立低位代理项 0x${code.toString(16)} 无前置高位代理项 (index: ${i})`
      ).toBe(true);
    } else {
      expect(isSurrogateCodePoint(code)).toBe(false);
    }
  }
}

describe('Unit 7.3: IME 协同对抗与并发 CRDT 极限实证', () => {
  let patchBuffer: CompositionPatchBuffer;
  let pinRegistry: DomPinningRegistry;
  let imeMachine: ImeMachine;

  const ACTIVE_BLOCK_ID: BlockId = 'blk-ime-active-target';

  beforeEach(() => {
    patchBuffer = new CompositionPatchBuffer();
    pinRegistry = new DomPinningRegistry();
    imeMachine = new ImeMachine();
  });

  it('极限对抗：IME 组合态下并发注入 100 次远端 Update，断言 0 吞字、0 错位、0 代理项撕裂', () => {
    // 1. 初始本地块状态（含复杂 Emoji、中文字符与标点）
    const prefixText = '【CRDT初始正文🎉】';
    const suffixText = '【结尾定界符✨】';
    const initialFullText = `${prefixText}${suffixText}`;
    expect(countUnicodeScalars(initialFullText)).toBeGreaterThan(0);

    // 2. 本地触发 IME compositionstart（光标在 prefixText 之后）
    patchBuffer.beginComposition(ACTIVE_BLOCK_ID);
    pinRegistry.pin(ACTIVE_BLOCK_ID);
    imeMachine.startComposition(ACTIVE_BLOCK_ID);

    expect(patchBuffer.getIsComposing()).toBe(true);
    expect(pinRegistry.isPinned(ACTIVE_BLOCK_ID)).toBe(true);
    expect(imeMachine.isComposing()).toBe(true);

    // 模拟本地中文输入法候选字不断上屏的 preview 序列
    const imeCompositionSteps = [
      'c',
      'ch',
      'che',
      'chen',
      'cheng',
      '程',
      '程序',
      '程序猿',
      '程序猿👨‍💻',
      '程序猿👨‍💻正在输入中……🚀',
    ];

    for (const step of imeCompositionSteps) {
      imeMachine.updateComposition(step);
      expect(imeMachine.getSnapshot().preview).toBe(step);
    }

    // 3. 并发注入 100 次远端 Update
    const totalRemoteUpdates = 100;
    const remoteInjectedData: {
      id: number;
      insertText: string;
      scalarPos: number;
    }[] = [];
    const passedThroughDiffs: ProjectionDiff[] = [];

    for (let i = 0; i < totalRemoteUpdates; i++) {
      const mode = i % 10;

      if (mode < 4) {
        // 40% (40 次)：异块远端更新（不应打扰当前合成块，直接放行）
        const otherBlockId: BlockId = `blk-remote-peer-${i}`;
        const diffOther: ProjectionDiff = {
          docId: 'doc-collab-1',
          rev: i + 1,
          upserts: [{ id: otherBlockId, props: { text: `异块内容-${i}-🌟` } }],
          removes: [],
          textTouches: [otherBlockId],
        };

        const result = patchBuffer.intercept(diffOther);
        expect(result.passThrough).toBe(true);
        expect(result.buffered).toBe(false);
        passedThroughDiffs.push(diffOther);
      } else if (mode < 8) {
        // 40% (40 次)：同块远端文本并发编辑（包含 Emoji、代理项、多字节标量）
        const injectedChunk = `[远端协同#${i}:🎉👨‍👩‍👧‍👦𠮷]`;
        remoteInjectedData.push({
          id: i,
          insertText: injectedChunk,
          scalarPos: countUnicodeScalars(prefixText),
        });

        const diffActive: ProjectionDiff = {
          docId: 'doc-collab-1',
          rev: i + 1,
          upserts: [
            {
              id: ACTIVE_BLOCK_ID,
              props: {
                delta: {
                  insert: injectedChunk,
                  pos: countUnicodeScalars(prefixText),
                },
              },
            },
          ],
          removes: [],
          textTouches: [ACTIVE_BLOCK_ID],
        };

        const result = patchBuffer.intercept(diffActive);
        expect(result.passThrough).toBe(false);
        expect(result.buffered).toBe(true);
      } else if (mode === 8) {
        // 10% (10 次)：同块结构性变动尝试（例如远端尝试删除或拆分当前输入块）
        const diffRemove: ProjectionDiff = {
          docId: 'doc-collab-1',
          rev: i + 1,
          upserts: [],
          removes: [ACTIVE_BLOCK_ID],
          textTouches: [],
        };

        const result = patchBuffer.intercept(diffRemove);
        expect(result.passThrough).toBe(false);
        expect(result.buffered).toBe(true);

        // IME 状态机也必须硬性拒绝结构操作
        const intentResult = imeMachine.tryAcceptIntent({
          type: 'structure_key',
          kind: 'split_block',
          blockId: ACTIVE_BLOCK_ID,
          intentId: `struct-${i}`,
        });
        expect(intentResult.ok).toBe(false);
      } else {
        // 10% (10 次)：虚拟滚动器尝试调度卸载候选
        const unmountCandidates: BlockId[] = [
          ACTIVE_BLOCK_ID,
          `blk-unmount-candidate-${i}-a`,
          `blk-unmount-candidate-${i}-b`,
        ];

        const removalPlan = pinRegistry.filterSafeRemovals(unmountCandidates);
        // 当前合成块必须被呈现锁牢牢保护在 deferredRemovals 中，绝不能进入 safeRemovals
        expect(removalPlan.deferredRemovals).toContain(ACTIVE_BLOCK_ID);
        expect(removalPlan.safeRemovals).not.toContain(ACTIVE_BLOCK_ID);
        expect(removalPlan.safeRemovals).toEqual([
          `blk-unmount-candidate-${i}-a`,
          `blk-unmount-candidate-${i}-b`,
        ]);

        const unmountPlan = pinRegistry.filterSafeUnmounts(
          unmountCandidates.map((id) => ({ id, height: 40 }))
        );
        expect(unmountPlan.retained.map((r) => r.id)).toContain(
          ACTIVE_BLOCK_ID
        );
        expect(unmountPlan.allowed.map((a) => a.id)).not.toContain(
          ACTIVE_BLOCK_ID
        );
      }
    }

    // 验证缓冲区中暂存的补丁总数（40 次文本编辑 + 10 次结构操作 = 50 条）
    expect(patchBuffer.getQueueLength()).toBe(50);
    expect(passedThroughDiffs).toHaveLength(40);

    // 4. 用户完成 IME 选词上屏，触发 compositionend
    const finalizedImeText = '程序猿👨‍💻正在输入中……🚀';
    const endResult = imeMachine.endComposition(finalizedImeText);
    expect(endResult.committedText).toBe(finalizedImeText);
    expect(imeMachine.isComposing()).toBe(false);

    pinRegistry.unpin(ACTIVE_BLOCK_ID);
    expect(pinRegistry.isPinned(ACTIVE_BLOCK_ID)).toBe(false);

    // 5. 吐出增量缓冲区中的全部暂存补丁
    const flushedPatches = patchBuffer.endComposition();
    expect(flushedPatches).toHaveLength(50);
    expect(patchBuffer.getIsComposing()).toBe(false);
    expect(patchBuffer.getQueueLength()).toBe(0);

    // 6. 执行协同合并与坐标系单射变换
    // 将本地 IME 提交的内容插入当前文档（在 prefixText 与 suffixText 之间）
    let currentDocText = `${prefixText}${finalizedImeText}${suffixText}`;
    assertNoSurrogatePairTearing(currentDocText, '本地 IME 提交状态');

    // 逐一合入 50 条暂存补丁中的文本部分
    for (const patch of flushedPatches) {
      if (patch.type === 'text_edit') {
        const patchDiff = patch.diff;
        const upsert = patchDiff.upserts.find((u) => u.id === ACTIVE_BLOCK_ID);
        const propsRecord = upsert?.props as
          Record<string, unknown> | undefined;
        const delta = propsRecord?.delta as
          { insert: string; pos: number } | undefined;
        if (delta && typeof delta.insert === 'string') {
          // 使用 diffToReplace 与 Unicode 标量转换执行精确定位插入
          const targetScalarPos = delta.pos;
          const u16Offset = unicodeScalarToUtf16Offset(
            currentDocText,
            targetScalarPos
          );

          const before = currentDocText.slice(0, u16Offset);
          const after = currentDocText.slice(u16Offset);
          const newDocText = `${before}${delta.insert}${after}`;

          // 计算差分替换验证
          const diffResult = diffToReplace(currentDocText, newDocText);

          // 断言替换边界绝不切断 Emoji 代理项
          if (
            diffResult.start > 0 &&
            diffResult.start < currentDocText.length
          ) {
            expect(
              isLowSurrogate(currentDocText.charCodeAt(diffResult.start))
            ).toBe(false);
          }
          if (diffResult.end > 0 && diffResult.end <= currentDocText.length) {
            expect(
              isHighSurrogate(currentDocText.charCodeAt(diffResult.end - 1))
            ).toBe(false);
          }

          // 验证 Unicode 标量偏移与 UTF-16 偏移单射一致
          const recomputedScalarStart = utf16OffsetToUnicodeScalar(
            currentDocText,
            diffResult.start
          );
          expect(recomputedScalarStart).toBe(diffResult.startScalar);

          const recomputedU16Start = unicodeScalarToUtf16Offset(
            currentDocText,
            diffResult.startScalar
          );
          expect(recomputedU16Start).toBe(diffResult.start);

          currentDocText = newDocText;
          assertNoSurrogatePairTearing(
            currentDocText,
            `合入补丁 rev=${patchDiff.rev}`
          );
        }
      }
    }

    // 7. 终极断言验证

    // 断言 1: 0 吞字 (0 swallowed characters)
    // 验证初始前缀、后缀、本地输入法最终上屏文本、以及全部 40 次远端注入文本完整存在
    expect(currentDocText).toContain(prefixText);
    expect(currentDocText).toContain(suffixText);
    expect(currentDocText).toContain(finalizedImeText);
    for (const chunk of remoteInjectedData) {
      expect(currentDocText).toContain(chunk.insertText);
    }

    // 断言 2: 0 错位 (0 position offsets)
    const totalScalars = countUnicodeScalars(currentDocText);
    const convertedScalar = utf16OffsetToUnicodeScalar(
      currentDocText,
      currentDocText.length
    );
    expect(convertedScalar).toBe(totalScalars);
    const convertedU16 = unicodeScalarToUtf16Offset(
      currentDocText,
      totalScalars
    );
    expect(convertedU16).toBe(currentDocText.length);

    // 断言 3: 0 代理项撕裂 (0 surrogate pair tearing)
    assertNoSurrogatePairTearing(currentDocText, '最终协同收敛状态');
  });

  it('Emoji、ZWJ 与多字节标量极限转换：验证 0 代理项撕裂与坐标单射', () => {
    const complexUnicodeStrings = [
      '👨‍👩‍👧‍👦', // 7 scalars, 11 utf-16 units
      '🇨🇳🇯🇵🇺🇸', // 6 scalars, 12 utf-16 units
      '🎉🎊🚀🔥✨', // 5 scalars, 10 utf-16 units
      '𠮷野家与𠀋字', // CJK 扩展汉字
      '∑(i=1..n) ∫_{0}^{∞} e^{-x^2} dx',
      '👋🏽 肤色修饰符与 🧑🏾‍🦰 复合发色表情',
      'Unicode标量\uD83C\uDF89边界测试\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66完成',
    ];

    for (const text of complexUnicodeStrings) {
      assertNoSurrogatePairTearing(text, '基准输入');
      const scalarLen = countUnicodeScalars(text);

      for (let s = 0; s <= scalarLen; s++) {
        const u16Offset = unicodeScalarToUtf16Offset(text, s);
        const mappedScalar = utf16OffsetToUnicodeScalar(text, u16Offset);
        expect(mappedScalar).toBe(s);

        // 验证切片绝不位于高低代理项之间
        if (u16Offset > 0 && u16Offset < text.length) {
          const prev = text.charCodeAt(u16Offset - 1);
          const curr = text.charCodeAt(u16Offset);
          const isSplitPair = isHighSurrogate(prev) && isLowSurrogate(curr);
          expect(
            isSplitPair,
            `标量偏移 ${s} 映射到 UTF16 偏移 ${u16Offset} 时切断了代理项对`
          ).toBe(false);
        }
      }
    }
  });
});
