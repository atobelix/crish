/**
 * mergeAssistantTextPiece 终态权威语义测试（G3 / 04 §5.1-2、§5.4 边界表）。
 *
 * 语义锚点：
 * - 快速路径：prior 完整包含于 p（丢尾/丢头/修订补全）→ 返回更长者（终稿全文）；
 * - 终态权威：其余不一致（丢中段/真修订）→ 以 p 为准，不做 `\n\n` 拼接——
 *   消灭 R1「增量版 + 终稿版」两段共存；
 * - 多轮（跨 turn）分段由调用方（onMessageEnd 段数组 / hydrate turn 账本）负责，
 *   本纯函数只承诺单段内的终态权威语义。
 */
import { describe, expect, it } from 'vitest';
import { mergeAssistantTextPiece } from './eventUtils';

describe('mergeAssistantTextPiece 终态权威边界表（04 §5.4）', () => {
  it('空输入：piece 空返回 prior；prior 空返回 p', () => {
    expect(mergeAssistantTextPiece('abc', '')).toBe('abc');
    expect(mergeAssistantTextPiece('', 'abc')).toBe('abc');
    expect(mergeAssistantTextPiece('', '')).toBe('');
    expect(mergeAssistantTextPiece('abc', '   ')).toBe('abc');
  });

  it('完全一致（重发/幂等）：返回原文，不重复', () => {
    expect(mergeAssistantTextPiece('Hello world', 'Hello world')).toBe(
      'Hello world'
    );
  });

  it('丢尾：prior 是 p 前缀 → 返回终稿全文 p（补全差额）', () => {
    const prior = 'Hello world';
    const p = 'Hello world!';
    expect(mergeAssistantTextPiece(prior, p)).toBe(p);
  });

  it('丢头：prior 是 p 子串 → 返回更长者 p（恢复全文）', () => {
    const prior = 'world';
    const p = 'Hello world';
    expect(mergeAssistantTextPiece(prior, p)).toBe(p);
  });

  it('丢中段：prior 非 p 子串 → 终态权威以 p 为准（不做 \\n\\n 追加）', () => {
    const prior = 'Helloworld';
    const p = 'Hello brave new world';
    expect(mergeAssistantTextPiece(prior, p)).toBe(p);
  });

  it('修订：终稿与增量不一致 → 以终稿 p 为准（消灭两段共存）', () => {
    const prior = 'Hello world';
    const p = 'Hello beautiful world';
    expect(mergeAssistantTextPiece(prior, p)).toBe(p);
  });

  it('修订后终稿更短：判据全不中仍以终稿 p 为准（终态权威，不拼接不回退）', () => {
    const prior = 'Hello brave world';
    const p = 'Hello world';
    // 判据全不中（prior 非 p 子串）→ 终态权威返回 p；
    // 渲染层"只增不减"由 onMessageEnd 的 slice(prevLen) 差额守卫（不缩短已渲染文本）
    expect(mergeAssistantTextPiece(prior, p)).toBe(p);
  });

  it('多轮（跨 turn）由调用方分段：纯函数对无关内容返回终稿 p 而非拼接', () => {
    const prior = '第一轮完整文本';
    const p = '第二轮完整文本';
    // 跨 turn 分段在 onMessageEnd / hydrate 按 turnIndex 处理，此处锁定
    // 纯函数层面绝不做 `\n\n` 拼接（拼接语义上移给段数组 join）
    expect(mergeAssistantTextPiece(prior, p)).toBe(p);
  });

  it('piece trim 语义：前后空白不参与判定', () => {
    expect(mergeAssistantTextPiece('Hello', '  Hello world  ')).toBe(
      'Hello world'
    );
  });
});
