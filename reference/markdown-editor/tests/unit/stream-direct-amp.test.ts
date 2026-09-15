// tests/unit/stream-direct-amp.test.ts
// W0-1 包：`&` 加入 DIRECT_STREAM_FORBIDDEN_CHARS（直刷/解析分叉红线修复）
// 方案：docs/streaming-render/00-流式渲染极致化总方案.md（W0-1 行）
// 分析：.agent-outputs/2026-08-11-streaming-plan/02-渲染管线.md §1.1（P1）
//
// 背景：text token 的 content 会做 CommonMark 实体解码（parser.ts:3115-3119），
// 渲染层显示解码值（`&amp;` → `&`）；若含 `&` 的行通过 isPlainTextLine 走
// 直刷通道（tokenEl.textContent += chunk 写入字面文本，MarkdownEngine.tsx:868
// 区域），flush 后 React 按解析结果重渲染为解码值——同一行直刷期间与 flush
// 后显示不同，击穿通道设计目标「直刷与解析绝不分叉」（MarkdownEngine.tsx:71-77
// 注释）。修复：`&` 入禁集，含 `&` 的行一律拒绝直刷、走 store.appendText
// 常规路径（React 渲染天然一致）。
//
// 覆盖（W0-1 验收）：
// 1. S-T-0-01：含 `&amp;` / `&quot;` / `&nbsp;` / `&lt;` 的行 isPlainTextLine
//    返回 false（不直刷）；
// 2. 普通中文/英文行（无 `&` 与禁集字符）仍返回 true（不误伤）；
// 3. 纯 `&` 行 false；含 `&` 边界（行首/行中/行尾）全覆盖；
// 4. S-T-0-02：一致性矩阵——对每个实体形态，parseLine 渲染的 content 已
//    解码（≠ raw，若直刷必分叉），而 isPlainTextLine 恒 false（分叉被杜绝），
//    两者合并保证「直刷 vs parseLine 逐字符一致」。
// @vitest-environment jsdom

import './helpers/layout-fixture';
import { describe, it, expect } from 'vitest';
import { isPlainTextLine } from '../../src/components/MarkdownEngine';
import { MarkdownParser } from '../../src/core/parser';

describe('W0-1 直刷/解析分叉红线：`&` 入禁集（S-T-0-01）', () => {
  it('含 &amp; 的行不直刷', () => {
    expect(isPlainTextLine('AT&amp;T 官方说明')).toBe(false);
    expect(isPlainTextLine('价格 &amp; 说明')).toBe(false);
  });

  it('含 &quot; 的行不直刷', () => {
    expect(isPlainTextLine('他说 &quot;你好&quot;')).toBe(false);
  });

  it('含 &nbsp; 的行不直刷', () => {
    expect(isPlainTextLine('A&nbsp;B 宽度保持')).toBe(false);
  });

  it('含 &lt; 的行不直刷', () => {
    expect(isPlainTextLine('结果 &lt; 预期')).toBe(false);
  });

  it('未定义命名实体（&foo;）同样不直刷——裸 `&` 已在禁集', () => {
    expect(isPlainTextLine('未知实体 &foo; 保持字面')).toBe(false);
  });
});

describe('W0-1 不误伤普通正文行（直刷覆盖率保护）', () => {
  it('普通中文行仍可直刷', () => {
    expect(isPlainTextLine('这是一段纯中文正文行')).toBe(true);
  });

  it('普通英文行仍可直刷', () => {
    expect(isPlainTextLine('This is a plain english line')).toBe(true);
  });

  it('中英混排（无 & 与禁集字符）仍可直刷', () => {
    expect(isPlainTextLine('混合正文 mixed text 内容')).toBe(true);
  });

  it('禁集内其他字符的行仍拒绝直刷（回归哨兵：既有语义不变）', () => {
    expect(isPlainTextLine('**粗体**')).toBe(false);
    expect(isPlainTextLine('`code`')).toBe(false);
    expect(isPlainTextLine('# 标题')).toBe(false);
    expect(isPlainTextLine('1. 有序列表')).toBe(false);
  });
});

describe('W0-1 纯 `&` 与边界覆盖', () => {
  it('纯 `&` 行不直刷', () => {
    expect(isPlainTextLine('&')).toBe(false);
    expect(isPlainTextLine('&&')).toBe(false);
  });

  it('`&` 在行首时拒绝直刷', () => {
    expect(isPlainTextLine('&价格说明')).toBe(false);
    expect(isPlainTextLine('& start')).toBe(false);
  });

  it('`&` 在行中时拒绝直刷', () => {
    expect(isPlainTextLine('价&格')).toBe(false);
    expect(isPlainTextLine('a&b c')).toBe(false);
  });

  it('`&` 在行尾时拒绝直刷', () => {
    expect(isPlainTextLine('价格&')).toBe(false);
    expect(isPlainTextLine('end &')).toBe(false);
  });

  it('`&` 后接数字/分号的常见形态全部拒绝（防漏网）', () => {
    expect(isPlainTextLine('&#38; 数值实体')).toBe(false);
    expect(isPlainTextLine('&#x26; 十六进制实体')).toBe(false);
    expect(isPlainTextLine('x &amp; y')).toBe(false);
  });
});

describe('W0-1 直刷 vs parseLine 一致性矩阵（S-T-0-02）', () => {
  // 矩阵：实体形态 × 「parseLine 渲染 content 已解码（直刷必分叉）」×
  // 「isPlainTextLine 恒 false（分叉被杜绝）」。两条同时成立 → 含实体行的
  // 渲染结果永远由解析器权威决定，直刷与解析逐字符一致（S-EL-01）。
  const matrix: Array<{ name: string; line: string; decoded: string }> = [
    { name: '&amp;', line: 'AT&amp;T 说明', decoded: 'AT&T 说明' },
    { name: '&quot;', line: '他说 &quot;你好&quot;', decoded: '他说 "你好"' },
    { name: '&nbsp;', line: 'A&nbsp;B', decoded: 'A\u00A0B' },
    { name: '&lt;', line: '结果 &lt; 预期', decoded: '结果 < 预期' },
  ];

  for (const { name, line, decoded } of matrix) {
    it(`实体形态 ${name}：渲染 content 已解码、isPlainTextLine 恒 false`, () => {
      expect(isPlainTextLine(line)).toBe(false);
      const node = MarkdownParser.parseLine(line, 0, false);
      const textTokens = node.inlineTokens.filter((t) => t.type === 'text');
      expect(textTokens.length).toBeGreaterThan(0);
      const joined = textTokens.map((t) => t.content).join('');
      expect(joined).toBe(decoded);
      expect(joined).not.toBe(node.raw);
    });
  }

  it('裸 `&`（非实体形态，解析不解码）：保守禁集仍拒绝直刷', () => {
    // 裸 `&` 不构成实体引用（parseLine 不解码，content === raw），本身无分叉
    // 风险；但按「宁可少直刷不可误刷」保守口径一并入禁集（分析文档 §1.1 建议），
    // 覆盖直刷/解析一致性的最后一种 `&` 形态。
    const line = '价格 & 说明';
    expect(isPlainTextLine(line)).toBe(false);
    const node = MarkdownParser.parseLine(line, 0, false);
    const textTokens = node.inlineTokens.filter((t) => t.type === 'text');
    expect(textTokens.length).toBeGreaterThan(0);
    const joined = textTokens.map((t) => t.content).join('');
    expect(joined).toBe(line);
  });
});
