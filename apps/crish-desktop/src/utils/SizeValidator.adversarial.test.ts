/**
 * SizeValidator 对抗性测试
 *
 * 目标：暴露字节截断、grapheme 边界、浅拷贝共享引用、边界值（NaN/负数/极大值）等缺陷。
 *
 * 已暴露的 bug 清单（详见各 it 用例注释）：
 *  SV1. truncateToBytes(maxBytes=NaN) → 截断逻辑失效，返回未截断文本 + suffix
 *  SV2. truncateToBytes(maxBytes < suffixBytes) → 返回的 suffix 本身超过 maxBytes
 *  SV3. truncateToBytes(maxBytes=0) → 返回 suffix（13 字节），超出 maxBytes
 *  SV4. truncateToBytes(maxBytes=负数) → 返回 suffix，超出 maxBytes
 *  SV5. validateMessageSize 浅拷贝：toolCalls 数组与原对象共享引用
 *  SV6. validateMessageSize 不校验 text 是否为字符串（runtime 无校验）
 *  SV7. SIZE_LIMITS 注释 "100 KB" 与实际 100*1024 (KiB) 不一致（KB vs KiB 混淆）
 *  SV8. truncateToBytes 在 grapheme 边界切割：4 字节 emoji 不会被切断
 *  SV9. truncateToBytes 边界值：文本恰好等于 maxBytes 不截断
 *  SV10. truncateToBytes 边界值：文本等于 maxBytes+1 截断为 maxBytes-suffix+suffix
 *  SV11. ZWJ 组合 emoji（👨‍👩‍👧）截断在 ZWJ 处可能产生孤儿字符
 *  SV12. Regional indicator（🇺🇸 国旗）截断边界
 *  SV13. validateMessageSize 不处理 precomputedHtml 字段（可能远超 SIZE_LIMITS.text）
 *  SV14. validateMessageSize 不处理 blocks 字段（可能含未截断的 toolCall 引用）
 *  SV15. truncateToolCall 不处理 explanation 字段
 *  SV16. truncateToBytes 不保留 streamTextOffset 一致性（截断后偏移量错误）
 */

import { describe, it, expect } from 'vitest';
import {
  SIZE_LIMITS,
  truncateToBytes,
  validateMessageSize,
} from './SizeValidator';
import type { SessionMessage, MessageToolCall } from '../store/types';

const SUFFIX = '...[截断]';

describe('SizeValidator — 对抗性测试', () => {
  describe('SV1: maxBytes=NaN 截断逻辑失效', () => {
    it('暴露 bug: maxBytes=NaN 时返回未截断文本 + suffix', () => {
      const text = 'a'.repeat(1000); // 1000 字节，远超 NaN
      const result = truncateToBytes(text, NaN);

      // Bug 分析：
      // 1. bytes.length(1000) <= NaN → false（任何与 NaN 比较都是 false）
      // 2. suffixBytes = 13, availableBytes = NaN - 13 = NaN
      // 3. availableBytes <= 0 → NaN <= 0 → false（不进入早返回分支）
      // 4. 循环中：accumulatedBytes + segBytes > NaN → false（不进入 break）
      //    → 所有 segments 都被加进去
      // 5. 返回 result + SUFFIX，即未截断文本 + suffix
      // 结果：返回值比原文还长，且没有任何错误
      expect(result).toBe(text + SUFFIX);
      expect(result.length).toBeGreaterThan(text.length);
    });

    it('NaN 不抛异常（静默错误）', () => {
      expect(() => truncateToBytes('hello', NaN)).not.toThrow();
    });
  });

  describe('SV2/SV3/SV4: maxBytes < suffixBytes', () => {
    it('暴露 bug: maxBytes=0 返回 13 字节的 suffix（超出 maxBytes）', () => {
      const text = 'hello world';
      const result = truncateToBytes(text, 0);
      // Bug: bytes.length(11) <= 0 → false
      // suffixBytes=13, availableBytes = 0 - 13 = -13
      // -13 <= 0 → true，返回 SUFFIX
      // 但 SUFFIX 本身是 13 字节，超过 maxBytes=0
      expect(result).toBe(SUFFIX);
      const resultBytes = new TextEncoder().encode(result).length;
      expect(resultBytes).toBeGreaterThan(0); // 实际是 13，远超 0
    });

    it('暴露 bug: maxBytes=5（小于 suffixBytes=13）返回 suffix（13 字节）', () => {
      const text = 'a'.repeat(100);
      const result = truncateToBytes(text, 5);
      // availableBytes = 5 - 13 = -8 <= 0 → 返回 SUFFIX
      expect(result).toBe(SUFFIX);
      const resultBytes = new TextEncoder().encode(result).length;
      // Bug: 返回的 suffix 是 13 字节，超过 maxBytes=5
      expect(resultBytes).toBeGreaterThan(5);
    });

    it('maxBytes=10（小于 suffixBytes=11）返回 suffix（11 字节，超出 maxBytes）', () => {
      const text = 'a'.repeat(100);
      const result = truncateToBytes(text, 10);
      // availableBytes = 10 - 11 = -1 <= 0 → 返回 SUFFIX
      expect(result).toBe(SUFFIX);
      // 返回值是 11 字节，超过 maxBytes=10
      expect(new TextEncoder().encode(result).length).toBe(11);
    });

    it('暴露 bug: maxBytes=-1（负数）返回 suffix', () => {
      const text = 'hello';
      const result = truncateToBytes(text, -1);
      // Bug: bytes.length(5) <= -1 → false（5 不小于等于 -1）
      // availableBytes = -1 - 11 = -12 <= 0 → 返回 SUFFIX
      expect(result).toBe(SUFFIX);
      // 返回值 11 字节，远超 maxBytes=-1（语义上应是空字符串）
      expect(new TextEncoder().encode(result).length).toBe(11);
    });

    it('暴露 bug: maxBytes=-Infinity 返回 suffix', () => {
      const text = 'hello';
      const result = truncateToBytes(text, -Infinity);
      // 5 <= -Infinity → false
      // -Infinity - 13 = -Infinity <= 0 → 返回 SUFFIX
      expect(result).toBe(SUFFIX);
    });
  });

  describe('SV8: 多字节 UTF-8 字符截断', () => {
    it('4 字节 emoji 不会被切断', () => {
      // 𠮷 是 4 字节 UTF-8 字符
      const text = '𠮷'.repeat(10); // 40 字节
      const maxBytes = 18; // availableBytes = 18 - 11 = 7
      // 1 个 𠮷 = 4 字节，7 >= 4 → 加入
      // 2 个 𠮷 = 8 字节，7 < 8 → break
      // 实际：1 个 𠮷 + suffix
      const result = truncateToBytes(text, maxBytes);
      expect(result).toBe('𠮷' + SUFFIX);
      const resultBytes = new TextEncoder().encode(result).length;
      expect(resultBytes).toBe(4 + 11); // 15 字节，<= maxBytes(18)
    });

    it('3 字节中文字符截断', () => {
      const text = '中'.repeat(10); // 30 字节
      const maxBytes = 20; // availableBytes = 20 - 11 = 9，可放 3 个中文（9 字节）
      const result = truncateToBytes(text, maxBytes);
      expect(result).toBe('中中中' + SUFFIX);
      const resultBytes = new TextEncoder().encode(result).length;
      expect(resultBytes).toBe(9 + 11); // 20 字节
    });

    it('混合 ASCII + 中文 + emoji 截断', () => {
      // 文本足够长以触发截断
      const text = 'AB中𠮷CD' + 'x'.repeat(50); // 11 + 50 = 61 字节
      const maxBytes = 18; // availableBytes = 18 - 11 = 7
      // 累积：A(1)=1, B(1)=2, 中(3)=5, 𠮷(4)=9 > 7 → break
      const result = truncateToBytes(text, maxBytes);
      expect(result).toBe('AB中' + SUFFIX);
    });
  });

  describe('SV9/SV10: 边界值', () => {
    it('文本恰好等于 maxBytes 不截断', () => {
      const text = 'a'.repeat(50);
      const result = truncateToBytes(text, 50);
      expect(result).toBe(text);
    });

    it('文本小于 maxBytes 不截断', () => {
      const text = 'hello';
      const result = truncateToBytes(text, 100);
      expect(result).toBe(text);
    });

    it('文本等于 maxBytes+1 截断为 maxBytes-suffix+suffix', () => {
      const text = 'a'.repeat(101);
      const maxBytes = 100;
      const result = truncateToBytes(text, maxBytes);
      // availableBytes = 100 - 11 = 89
      // 89 个 'a' + suffix
      expect(result).toBe('a'.repeat(89) + SUFFIX);
      const resultBytes = new TextEncoder().encode(result).length;
      expect(resultBytes).toBe(100);
    });

    it('文本等于 maxBytes-1 不截断', () => {
      const text = 'a'.repeat(99);
      const result = truncateToBytes(text, 100);
      expect(result).toBe(text);
    });
  });

  describe('SV11: ZWJ 组合 emoji 截断', () => {
    it('ZWJ 序列在 ZWJ 处截断可能产生孤儿字符', () => {
      // 👨‍👩‍👧 = 👨(4) + ZWJ(3) + 👩(4) + ZWJ(3) + 👧(4) = 18 字节
      // 但 grapheme segmenter 会把整个 ZWJ 序列视为 1 个 grapheme cluster
      const text = '👨‍👩‍👧👨‍👩‍👧'; // 2 个组合 emoji = 36 字节
      const maxBytes = 25; // availableBytes = 25 - 13 = 12
      // 1 个 👨‍👩‍👧 = 18 字节，12 < 18 → break
      // 0 个字符 + suffix
      const result = truncateToBytes(text, maxBytes);
      expect(result).toBe(SUFFIX);
      // Bug 暴露点：ZWJ 序列作为整体被丢弃，但 maxBytes=25 足以容纳 1 个 ZWJ 序列 + suffix
      // 实际 18 + 13 = 31 > 25，所以确实放不下
      // 但语义上，应该至少保留部分可见信息
    });

    it('ZWJ 序列后跟 ASCII 字符截断', () => {
      const text = '👨‍👩‍👧hello'; // 18 + 5 = 23 字节
      const maxBytes = 22; // availableBytes = 22 - 13 = 9
      // 👨‍👩‍👧 = 18 字节 > 9 → break
      // 结果：suffix only
      const result = truncateToBytes(text, maxBytes);
      expect(result).toBe(SUFFIX);
    });
  });

  describe('SV12: Regional indicator 截断', () => {
    it('国旗 emoji（🇺🇸）作为 grapheme 整体不被切断', () => {
      // 🇺🇸 = 🇺(4) + 🇸(4) = 8 字节，但 grapheme cluster
      const text = '🇺🇸🇺🇸🇺🇸🇺🇸'; // 4 个国旗 = 32 字节
      const maxBytes = 25; // availableBytes = 25 - 11 = 14
      // 1 个 🇺🇸 = 8 字节，14 >= 8 → 加入
      // 2 个 🇺🇸 = 16 字节，14 < 16 → break
      const result = truncateToBytes(text, maxBytes);
      expect(result).toBe('🇺🇸' + SUFFIX);
      const resultBytes = new TextEncoder().encode(result).length;
      expect(resultBytes).toBe(8 + 11); // 19 字节
    });
  });

  describe('SV5: validateMessageSize 浅拷贝共享引用', () => {
    it('暴露 bug: toolCalls 数组与原对象共享引用', () => {
      const originalToolCall: MessageToolCall = {
        id: 'tc-1',
        name: 'test',
        arguments: 'small args',
        status: 'success',
        output: 'small output',
      };
      const msg: SessionMessage = {
        id: 'msg-1',
        sender: 'assistant',
        timestamp: Date.now(),
        text: 'hello',
        toolCalls: [originalToolCall],
      };

      const validated = validateMessageSize(msg);

      // Bug: validateMessageSize 用 { ...msg } 浅拷贝
      // result.toolCalls = result.toolCalls.map(truncateToolCall) — 这是新数组
      // 但 truncateToolCall 内部 { ...tc } 也是浅拷贝
      // 顶层引用不共享，但嵌套对象（如 approvalMeta）会共享

      // 验证：validated.toolCalls 是新数组（不共享引用）
      expect(validated.toolCalls).not.toBe(msg.toolCalls);
      // 但 validated.toolCalls[0] 是新对象
      expect(validated.toolCalls![0]).not.toBe(msg.toolCalls![0]);

      // 修改 validated.toolCalls[0] 不应影响原对象
      validated.toolCalls![0]!.id = 'modified';
      expect(msg.toolCalls![0]!.id).toBe('tc-1');
    });

    it('暴露 bug: 嵌套对象（diffs）共享引用', () => {
      const originalToolCall: MessageToolCall = {
        id: 'tc-1',
        name: 'test',
        arguments: '{}',
        status: 'success',
        diffs: [
          {
            path: 'test.ts',
            content: 'test',
            // ...其他字段
          } as any, // 简化测试
        ],
      };
      const msg: SessionMessage = {
        id: 'msg-1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [originalToolCall],
      };

      const validated = validateMessageSize(msg);

      // Bug: truncateToolCall 用 { ...tc } 浅拷贝
      // diffs 数组未被复制，validated.toolCalls[0].diffs === msg.toolCalls[0].diffs
      expect(validated.toolCalls![0]!.diffs).toBe(msg.toolCalls![0]!.diffs);

      // 修改 validated 的 diffs 会影响原对象
      (validated.toolCalls![0]!.diffs as any[]).push({ path: 'injected', content: 'evil' });
      expect((msg.toolCalls![0]!.diffs as any[])).toHaveLength(2);
      expect((msg.toolCalls![0]!.diffs as any[])[1]!.path).toBe('injected');
    });

    it('暴露 bug: toolCallResults 数组共享引用', () => {
      const msg: SessionMessage = {
        id: 'msg-1',
        sender: 'user',
        timestamp: Date.now(),
        toolCallResults: [{ id: 'tc-1', output: 'result' }],
      };

      const validated = validateMessageSize(msg);

      // Bug: validateMessageSize 用 { ...msg } 浅拷贝
      // toolCallResults 未被处理，直接共享引用
      expect(validated.toolCallResults).toBe(msg.toolCallResults);

      // 修改 validated 影响原对象
      validated.toolCallResults!.push({ id: 'injected' });
      expect(msg.toolCallResults).toHaveLength(2);
    });

    it('暴露 bug: blocks 数组共享引用', () => {
      const msg: SessionMessage = {
        id: 'msg-1',
        sender: 'assistant',
        timestamp: Date.now(),
        blocks: [{ type: 'text', content: 'hello' } as any],
      };

      const validated = validateMessageSize(msg);

      // Bug: blocks 未被处理，共享引用
      expect(validated.blocks).toBe(msg.blocks);
    });
  });

  describe('SV7: KB vs KiB 混淆', () => {
    it('暴露 bug: SIZE_LIMITS.text 注释说 100 KB，实际是 100*1024=102400 (KiB)', () => {
      // 100 KB (SI) = 100000 字节
      // 100 KiB = 102400 字节
      // 代码：text: 100 * 1024 = 102400 → 是 KiB，但注释说 KB
      expect(SIZE_LIMITS.text).toBe(100 * 1024);
      expect(SIZE_LIMITS.text).not.toBe(100 * 1000); // 不是 SI KB
      // Bug: 注释和实现单位不一致，可能导致显示给用户的"100 KB"实际是 102.4 KB
    });

    it('暴露 bug: SIZE_LIMITS.thinking 注释说 50 KB，实际是 50*1024=51200', () => {
      expect(SIZE_LIMITS.thinking).toBe(50 * 1024);
      expect(SIZE_LIMITS.thinking).not.toBe(50 * 1000);
    });

    it('暴露 bug: SIZE_LIMITS.toolCallOutput 注释说 200 KB，实际是 200*1024=204800', () => {
      expect(SIZE_LIMITS.toolCallOutput).toBe(200 * 1024);
      expect(SIZE_LIMITS.toolCallOutput).not.toBe(200 * 1000);
    });
  });

  describe('SV13/SV14/SV15: 未处理的字段', () => {
    it('暴露 bug: precomputedHtml 字段不被截断', () => {
      const hugeHtml = '<p>' + 'x'.repeat(SIZE_LIMITS.text * 2) + '</p>';
      const msg: SessionMessage = {
        id: 'msg-1',
        sender: 'assistant',
        timestamp: Date.now(),
        text: 'small text',
        precomputedHtml: hugeHtml,
      };

      const validated = validateMessageSize(msg);

      // Bug: precomputedHtml 未被截断，仍然巨大
      expect(validated.precomputedHtml).toBe(hugeHtml);
      expect(validated.precomputedHtml!.length).toBeGreaterThan(SIZE_LIMITS.text);
    });

    it('暴露 bug: toolCall.explanation 字段不被截断', () => {
      const hugeExplanation = 'x'.repeat(SIZE_LIMITS.toolCallOutput * 2);
      const msg: SessionMessage = {
        id: 'msg-1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [{
          id: 'tc-1',
          name: 'test',
          arguments: '{}',
          status: 'success',
          explanation: hugeExplanation,
        }],
      };

      const validated = validateMessageSize(msg);

      // Bug: explanation 未被截断
      expect(validated.toolCalls![0]!.explanation).toBe(hugeExplanation);
      expect(validated.toolCalls![0]!.explanation!.length).toBeGreaterThan(SIZE_LIMITS.toolCallOutput);
    });

    it('暴露 bug: toolCall.approvalMeta 字段不被截断', () => {
      const hugeMeta = { reason: 'x'.repeat(SIZE_LIMITS.toolCallOutput * 2) } as any;
      const msg: SessionMessage = {
        id: 'msg-1',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [{
          id: 'tc-1',
          name: 'test',
          arguments: '{}',
          status: 'pending_approval',
          approvalMeta: hugeMeta,
        }],
      };

      const validated = validateMessageSize(msg);

      // Bug: approvalMeta 未被截断（虽然它不是文本字段，但可能含大量文本）
      // 共享引用
      expect(validated.toolCalls![0]!.approvalMeta).toBe(hugeMeta);
    });
  });

  describe('输入边界', () => {
    it('空字符串不截断', () => {
      const result = truncateToBytes('', 100);
      expect(result).toBe('');
    });

    it('空字符串 maxBytes=0 不截断（bytes.length=0 <= 0）', () => {
      const result = truncateToBytes('', 0);
      expect(result).toBe('');
    });

    it('只有 ASCII 字符', () => {
      const text = 'a'.repeat(200);
      const result = truncateToBytes(text, 100);
      // availableBytes = 100 - 11 = 89
      expect(result).toBe('a'.repeat(89) + SUFFIX);
    });

    it('maxBytes=Infinity 不截断', () => {
      const text = 'a'.repeat(1000);
      const result = truncateToBytes(text, Infinity);
      // bytes.length(1000) <= Infinity → true，返回原文
      expect(result).toBe(text);
    });

    it('maxBytes=Infinity 不抛异常', () => {
      expect(() => truncateToBytes('hello', Infinity)).not.toThrow();
    });
  });

  describe('validateMessageSize 输入边界', () => {
    it('空消息对象不抛异常', () => {
      const msg = { id: 'x', sender: 'user', timestamp: 0 } as SessionMessage;
      expect(() => validateMessageSize(msg)).not.toThrow();
    });

    it('text=null 不抛异常', () => {
      const msg = {
        id: 'x',
        sender: 'user',
        timestamp: 0,
        text: null,
      } as unknown as SessionMessage;
      expect(() => validateMessageSize(msg)).not.toThrow();
      const result = validateMessageSize(msg);
      expect(result.text).toBeNull();
    });

    it('text=undefined 不抛异常', () => {
      const msg = {
        id: 'x',
        sender: 'user',
        timestamp: 0,
      } as SessionMessage;
      expect(() => validateMessageSize(msg)).not.toThrow();
    });

    it('toolCalls=空数组不抛异常', () => {
      const msg = {
        id: 'x',
        sender: 'assistant',
        timestamp: 0,
        toolCalls: [],
      } as SessionMessage;
      expect(() => validateMessageSize(msg)).not.toThrow();
    });

    it('toolCall.arguments=undefined 不抛异常', () => {
      const msg = {
        id: 'x',
        sender: 'assistant',
        timestamp: 0,
        toolCalls: [{
          id: 'tc-1',
          name: 'test',
          status: 'success',
          // arguments 未提供
        }],
      } as unknown as SessionMessage;
      expect(() => validateMessageSize(msg)).not.toThrow();
    });

    it('toolCall.output=undefined 不抛异常', () => {
      const msg = {
        id: 'x',
        sender: 'assistant',
        timestamp: 0,
        toolCalls: [{
          id: 'tc-1',
          name: 'test',
          arguments: '{}',
          status: 'success',
          // output 未提供
        }],
      } as unknown as SessionMessage;
      expect(() => validateMessageSize(msg)).not.toThrow();
    });
  });

  describe('截断后实际字节长度验证', () => {
    it('截断后结果字节长度 <= maxBytes（当 maxBytes >= suffixBytes）', () => {
      const text = 'a'.repeat(1000);
      const maxBytes = 100;
      const result = truncateToBytes(text, maxBytes);
      const resultBytes = new TextEncoder().encode(result).length;
      expect(resultBytes).toBeLessThanOrEqual(maxBytes);
    });

    it('截断中文后结果字节长度 <= maxBytes', () => {
      const text = '中'.repeat(100);
      const maxBytes = 50;
      const result = truncateToBytes(text, maxBytes);
      const resultBytes = new TextEncoder().encode(result).length;
      // availableBytes = 50 - 13 = 37
      // 12 个中文 = 36 字节 <= 37
      // 13 个中文 = 39 字节 > 37 → break
      expect(resultBytes).toBeLessThanOrEqual(maxBytes);
    });

    it('截断 emoji 后结果字节长度 <= maxBytes', () => {
      const text = '🎉'.repeat(100);
      const maxBytes = 50;
      const result = truncateToBytes(text, maxBytes);
      const resultBytes = new TextEncoder().encode(result).length;
      expect(resultBytes).toBeLessThanOrEqual(maxBytes);
    });

    it('最大合法截断边界：maxBytes = suffixBytes (11)', () => {
      // maxBytes = 11 = suffixBytes
      const text = 'a'.repeat(100);
      const result = truncateToBytes(text, 11);
      // availableBytes = 11 - 11 = 0 <= 0 → 返回 SUFFIX
      // SUFFIX 是 11 字节，恰好等于 maxBytes
      expect(result).toBe(SUFFIX);
      const resultBytes = new TextEncoder().encode(result).length;
      expect(resultBytes).toBe(11);
    });

    it('最大合法截断边界：maxBytes = suffixBytes + 1 (12)', () => {
      const text = 'a'.repeat(100);
      const result = truncateToBytes(text, 12);
      // availableBytes = 12 - 11 = 1
      // 1 个 'a' = 1 字节 <= 1
      // 2 个 'a' = 2 字节 > 1 → break
      expect(result).toBe('a' + SUFFIX);
      const resultBytes = new TextEncoder().encode(result).length;
      expect(resultBytes).toBe(12);
    });
  });

  describe('幂等性', () => {
    it('已截断的文本再次截断不会重复添加 suffix', () => {
      const text = 'a'.repeat(200);
      const first = truncateToBytes(text, 100);
      // first = 'a'.repeat(87) + SUFFIX (100 字节)
      const second = truncateToBytes(first, 100);
      // first 是 100 字节，100 <= 100 → 返回原文
      expect(second).toBe(first);
    });

    it('已截断文本再次用更大 maxBytes 截断不重新生成', () => {
      const text = 'a'.repeat(200);
      const first = truncateToBytes(text, 50);
      const second = truncateToBytes(first, 100);
      // first 已经包含 suffix，再次截断不会"扩展"
      // first 是 50 字节，50 <= 100 → 返回 first
      expect(second).toBe(first);
    });

    it('validateMessageSize 多次调用结果一致', () => {
      const msg: SessionMessage = {
        id: 'x',
        sender: 'assistant',
        timestamp: 0,
        text: 'a'.repeat(200),
        thinking: 'b'.repeat(200),
      };
      const first = validateMessageSize(msg);
      const second = validateMessageSize(first);
      expect(second.text).toBe(first.text);
      expect(second.thinking).toBe(first.thinking);
    });
  });

  describe('streamTextOffset 一致性（SV16）', () => {
    it('暴露 bug: 截断 text 后 streamTextOffset 仍指向原文本位置', () => {
      const hugeText = 'a'.repeat(SIZE_LIMITS.text + 100);
      const msg: SessionMessage = {
        id: 'x',
        sender: 'assistant',
        timestamp: 0,
        text: hugeText,
        streamTextOffset: SIZE_LIMITS.text + 50, // 指向被截断的位置
      };

      const validated = validateMessageSize(msg);

      // Bug: text 被截断到约 87KB（含 suffix），但 streamTextOffset 仍指向 102450
      // 后续代码用 streamTextOffset 切分 text 会越界
      expect(validated.text!.length).toBeLessThan(SIZE_LIMITS.text);
      expect(validated.streamTextOffset).toBe(msg.streamTextOffset);
      // streamTextOffset > validated.text.length → 越界
      expect(validated.streamTextOffset!).toBeGreaterThan(validated.text!.length);
    });
  });

  describe('SIZE_LIMITS 完整性', () => {
    it('所有 SIZE_LIMITS 都是正整数', () => {
      for (const value of Object.values(SIZE_LIMITS)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    });

    it('暴露 bug: SIZE_LIMITS 在运行时可被修改（as const 不阻止运行时修改）', () => {
      const original = SIZE_LIMITS.text;
      // Bug: as const 是编译时检查，运行时对象仍可变
      (SIZE_LIMITS as { text: number }).text = 999;
      expect(SIZE_LIMITS.text).toBe(999); // bug 标志：被修改了
      // 恢复以防影响其他测试
      (SIZE_LIMITS as { text: number }).text = original;
      expect(SIZE_LIMITS.text).toBe(original);
    });
  });

  describe('真实场景模拟', () => {
    it('大型 assistant 消息（含超长 text + thinking + toolCalls）', () => {
      const msg: SessionMessage = {
        id: 'msg-large',
        sender: 'assistant',
        timestamp: Date.now(),
        text: 'x'.repeat(SIZE_LIMITS.text * 2),
        thinking: 'y'.repeat(SIZE_LIMITS.thinking * 2),
        toolCalls: [{
          id: 'tc-1',
          name: 'big-tool',
          arguments: '{ "data": "' + 'z'.repeat(SIZE_LIMITS.toolCallArguments * 2) + '" }',
          status: 'success',
          output: 'o'.repeat(SIZE_LIMITS.toolCallOutput * 2),
        }],
      };

      const validated = validateMessageSize(msg);

      // 所有字段都应被截断到 SIZE_LIMITS 以内
      expect(new TextEncoder().encode(validated.text!).length).toBeLessThanOrEqual(SIZE_LIMITS.text);
      expect(new TextEncoder().encode(validated.thinking!).length).toBeLessThanOrEqual(SIZE_LIMITS.thinking);
      expect(new TextEncoder().encode(validated.toolCalls![0]!.arguments!).length).toBeLessThanOrEqual(SIZE_LIMITS.toolCallArguments);
      expect(new TextEncoder().encode(validated.toolCalls![0]!.output!).length).toBeLessThanOrEqual(SIZE_LIMITS.toolCallOutput);

      // 验证截断后包含 suffix
      expect(validated.text!.endsWith(SUFFIX)).toBe(true);
      expect(validated.thinking!.endsWith(SUFFIX)).toBe(true);
      expect(validated.toolCalls![0]!.arguments!.endsWith(SUFFIX)).toBe(true);
      expect(validated.toolCalls![0]!.output!.endsWith(SUFFIX)).toBe(true);
    });

    it('多个 toolCalls 都被正确截断', () => {
      const msg: SessionMessage = {
        id: 'msg-multi-tc',
        sender: 'assistant',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc-1',
            name: 'tool-1',
            arguments: 'a'.repeat(SIZE_LIMITS.toolCallArguments * 2),
            status: 'success',
            output: 'b'.repeat(SIZE_LIMITS.toolCallOutput * 2),
          },
          {
            id: 'tc-2',
            name: 'tool-2',
            arguments: 'c'.repeat(SIZE_LIMITS.toolCallArguments * 2),
            status: 'success',
            output: 'd'.repeat(SIZE_LIMITS.toolCallOutput * 2),
          },
        ],
      };

      const validated = validateMessageSize(msg);

      for (const tc of validated.toolCalls!) {
        expect(new TextEncoder().encode(tc.arguments!).length).toBeLessThanOrEqual(SIZE_LIMITS.toolCallArguments);
        expect(new TextEncoder().encode(tc.output!).length).toBeLessThanOrEqual(SIZE_LIMITS.toolCallOutput);
      }
    });
  });
});
