// tests/unit/stream-direct-consistency.test.ts
// W2-2 包：isPlainTextLine 判定精细化的「直刷 vs parseLine 一致性矩阵」（S-T-2-05）
// 方案：docs/streaming-render/00-流式渲染极致化总方案.md（W2-2 行，S-T-2-05）
// 分析：.agent-outputs/2026-08-11-streaming-plan/02-渲染管线.md §1.2（P2 结构改法）
//
// 背景：W2-2 把直刷判定从「全字符黑名单」拆为「行首模式黑名单 + 行中白名单
// （仅禁成对语法字符）+ 配对模式检查」。每放开一个字符，都必须证明：
// 直刷文本（tokenEl.textContent += chunk 逐 chunk 累积，MarkdownEngine.tsx
// 直写语义）与 parseLine 渲染的 text token content **逐字符一致**（S-EL-01
// 红线：直刷绝不与解析分叉，W0-1 的 `&` 仍禁）。
//
// 矩阵结构（S-T-2-05）：
// 1. 放开项矩阵：数字/`.`/`=`/`+`/`(`/`)`/`!`/`^`/`-`/`{`/`}` 各构造
//    真实形态行 → 断言 isPlainTextLine=true 且直刷文本 = parseLine 渲染
//    文本逐字符一致（parseLine 仅产出 text token，零改形）；
// 2. 语义边界矩阵：`^`/`=` 单字符安全但成对形态触发 sup/mark 规则
//    （`x^2^`/`a==b==c`）——parseLine 确实产出 sup/mark token（改形），
//    判定必须拒绝（直刷会显示字面定界符 → 分叉）；
// 3. 行首黑名单矩阵：有序/无序列表、分隔线、Setext 候选——parseLine
//    改形（list_number/list_bullet/hr）必须拒绝；
// 4. 红线保留矩阵：`&`（实体解码分叉，W0-1）、成对语法字符（`*`/`_`/
//    `~`/`` ` ``/`[`/`]`/`<`/`>`/`\`/`#`/`|`/`$`）、行尾 2+ 空格
//    （hard_break 分叉）——全部保持禁入，无放开。
//
// 语义验证方法：每一行先经 MarkdownParser.parseLine 实测（以 parseLine
// 实际行为为准，不凭常识推断），再与直刷模拟逐字符比对。

import './helpers/layout-fixture';
import { describe, it, expect } from 'vitest';
import { isPlainTextLine } from '../../src/components/MarkdownEngine';
import { MarkdownParser } from '../../src/core/parser';

// ── 直刷路径模拟（MarkdownEngine.tsx 的 tokenEl.textContent += chunk）──
// 按 2 字符粒度切 chunk 逐次追加，模拟真实 token 流的渐进累积。
function simulateDirectStream(line: string): string {
  let textContent = '';
  for (let i = 0; i < line.length; i += 2) {
    textContent += line.slice(i, i + 2);
  }
  return textContent;
}

// ── parseLine 渲染文本（渲染层对 text token content 的消费语义）──
// 返回全部 token 的 content 拼接 + token 类型序列（供改形断言）。
function renderText(line: string): { text: string; tokenTypes: string[] } {
  const node = MarkdownParser.parseLine(line, 0, false);
  const tokens = node.inlineTokens;
  return {
    text: tokens.map((t) => t.content).join(''),
    tokenTypes: tokens.map((t) => t.type),
  };
}

// 一致性断言（放开项核心）：可直刷 + 直刷文本 = parseLine 渲染文本逐字符一致
function expectConsistent(line: string): void {
  expect(isPlainTextLine(line), `行应可直刷：${line}`).toBe(true);
  const direct = simulateDirectStream(line);
  expect(direct, '直刷模拟应完整累积整行').toBe(line);
  const rendered = renderText(line);
  expect(
    rendered.tokenTypes.every((t) => t === 'text'),
    `parseLine 不应改形（仅 text token）：${line} → ${rendered.tokenTypes.join(',')}`
  ).toBe(true);
  expect(rendered.text, '直刷 vs parseLine 渲染逐字符一致').toBe(direct);
}

// 拒绝断言（语义边界/行首黑名单）：不可直刷 + parseLine 确实改形（含某 token 类型）
function expectRejectedWithToken(line: string, tokenType: string): void {
  expect(isPlainTextLine(line), `行应拒绝直刷：${line}`).toBe(false);
  const rendered = renderText(line);
  expect(rendered.tokenTypes, `parseLine 应产出 ${tokenType}`).toContain(
    tokenType
  );
}

describe('W2-2 S-T-2-05 放开项一致性矩阵（直刷 = parseLine 逐字符）', () => {
  // 放开项 × 真实形态：每项全部经 parseLine 实测为纯 text token，
  // 直刷累积与渲染 content 逐字符一致（S-EL-01）。
  const releasedMatrix: Array<{ item: string; lines: string[] }> = [
    {
      item: '数字 0-9（含行首数字非列表形态）',
      lines: [
        '123',
        '价格 2026 元',
        '版本 1.2.3',
        '共 3 个 5 次',
        '50% 完成度',
        '温度 36.5 度',
        '2026-08-11',
        '3.14',
        '192.168.1.1',
        'x2 结果正确',
      ],
    },
    {
      item: '句点 .（英文句点/版本号/省略号）',
      lines: [
        'a.b.c',
        '句号。',
        '等等...',
        'email.test@example.com',
        'v2.5.1 发布',
        '3.14 与 1.618',
      ],
    },
    {
      item: '等号 =（单字符赋值，非 == 配对）',
      lines: [
        'x=1',
        'a = b',
        'a==b 严格比较',
        '配置=开启',
        'E=mc^2 公式',
        '合计=128 项',
      ],
    },
    {
      item: '加号 +（行中/行首非列表形态）',
      lines: [
        'a+b',
        '1+2=3',
        'C++ 语言',
        'a + b = c',
        '电话 +86 138 0013 8000',
        '+86 138-0013-8000 已绑定',
      ],
    },
    {
      item: '括号 ( )（无 [ 前置不成链接）',
      lines: [
        '(text)',
        'a (b) c',
        '(1) 编号',
        '（注意）中文括号',
        '(c) 版权声明',
      ],
    },
    {
      item: '叹号 !（无 [ 后随不成图片）',
      lines: ['a!b', '好!', '!important', '100!', '惊讶! 真的吗!'],
    },
    {
      item: '脱字符 ^（单字符，非 ^...^ 上标对）',
      lines: ['a^2', 'x^y', '2026^3', 'E=mc^2', 'n^2 复杂度'],
    },
    {
      item: '连字符 -（行中/行首非列表非分隔线）',
      lines: [
        'user-id',
        '中文-英文',
        'a - b',
        '2026-08-11',
        '3-5 天',
        'order-001 完成',
        '--x 前导双连字符',
      ],
    },
    {
      item: '花括号 { }（无行内规则触发）',
      lines: ['{x}', 'a {b} c', '配置 {开启} 状态'],
    },
    {
      item: '组合形态（多放开项同现的真实正文）',
      lines: [
        '2026-08-11 完成 80%',
        '价格 3.14 元 (含税)',
        '版本 v2.5.1 发布!',
        'x=1, y=2, 结果=3',
        '截止 2026 年 8 月 11 日，共 128 项 (含 3 项豁免)',
      ],
    },
  ];

  for (const { item, lines } of releasedMatrix) {
    for (const line of lines) {
      it(`放开项「${item}」：直刷 = parseLine 渲染（${line}）`, () => {
        expectConsistent(line);
      });
    }
  }
});

describe('W2-2 S-T-2-05 语义边界矩阵（^/= 成对形态 parseLine 改形 → 必须拒绝）', () => {
  // `^`/`=` 单字符放开的边界：成对形态触发 sup/mark 规则（parser.ts:2953/2916），
  // parseLine 产出非 text token（改形）——直刷显示字面定界符必分叉。
  // 以 parseLine 实测为准断言「改形确实发生」，杜绝「凭常识放开」的漏网。
  it('上标对 ^...^：parseLine 产出 sup token，判定拒绝', () => {
    expectRejectedWithToken('x^2^', 'sup');
    expectRejectedWithToken('2^10^ = 1024', 'sup');
    expectRejectedWithToken('a^b^c', 'sup');
  });

  it('mark 对 ==...==：parseLine 产出 mark token，判定拒绝', () => {
    expectRejectedWithToken('a==b==c', 'mark');
    expectRejectedWithToken('x == y == z', 'mark');
    expectRejectedWithToken('== ==', 'mark');
  });

  it('单处 ==（无闭合）与单处 ^（无闭合）：parseLine 按文本渲染，可直刷', () => {
    expectConsistent('a==b 严格比较');
    expectConsistent('x == y 比较');
    expectConsistent('a^2');
    expectConsistent('a ^ b');
  });
});

describe('W2-2 S-T-2-05 行首模式黑名单矩阵（parseLine 改形 → 必须拒绝）', () => {
  it('有序列表 \\d+[.)]：parseLine 产出 list_number，判定拒绝', () => {
    expectRejectedWithToken('1. 有序列表', 'list_number');
    expectRejectedWithToken('123. 超大数字', 'list_number');
    expectRejectedWithToken('0. 零开头', 'list_number');
    // `1) 文本`：CommonMark 兼容的有序列表另式（全量 parse 路径按列表处理），
    // 判定保守拒绝；行级 parseLine 无 `)` 列表规则按文本渲染——拒绝无分叉。
    expect(isPlainTextLine('1) 文本')).toBe(false);
    expect(isPlainTextLine('1)')).toBe(false);
    // 流式边界：chunk 停在 `1.`（后随 chunk 未到）时同样拒绝，防截断直刷
    expect(isPlainTextLine('1.')).toBe(false);
  });

  it('无序列表 - / +：parseLine 产出 list_bullet（渲染为 •），判定拒绝', () => {
    expectRejectedWithToken('- 文本', 'list_bullet');
    expectRejectedWithToken('+ 文本', 'list_bullet');
    expectRejectedWithToken('- -', 'list_bullet');
    expectRejectedWithToken('- 3.14 负号空格形态', 'list_bullet');
  });

  it('分隔线 -{3,}/+{3,}：parseLine 产出 hr（渲染为 <hr/>），判定拒绝', () => {
    expect(isPlainTextLine('---')).toBe(false);
    expect(isPlainTextLine('+++')).toBe(false);
    expect(isPlainTextLine('- - -')).toBe(false);
    expect(isPlainTextLine('+ + +')).toBe(false);
    expect(MarkdownParser.parseLine('---', 0, false).type).toBe('hr');
  });

  it('Setext 下划线候选 ={1,}：判定拒绝（全量 parse 升格标题的分叉防护）', () => {
    // 行级 parseLine（无 Setext 上下文）把 `===` 渲染为文本；但全量 parse 的
    // computeSetextContexts 会把上一段落升格为标题（parser.ts:1123），文档
    // 终态与直刷形态分叉——按方案（02 §1.2「连续 `=` 前缀必须拒」）保守拒绝。
    expect(isPlainTextLine('===')).toBe(false);
    expect(isPlainTextLine('==')).toBe(false);
    expect(isPlainTextLine('=')).toBe(false);
    // 非纯 run（`= 文本`/`=x`）不是 Setext 下划线，parseLine 按文本渲染
    expectConsistent('= 文本');
    expectConsistent('=x');
  });
});

describe('W2-2 S-T-2-05 红线保留矩阵（S-EL-01：不放开任何会解码/改形/成 token 的字符）', () => {
  it('`&` 红线保持（W0-1）：实体解码分叉，全部形态禁入', () => {
    expect(isPlainTextLine('价格 &amp; 说明')).toBe(false);
    expect(isPlainTextLine('AT&amp;T 官方说明')).toBe(false);
    expect(isPlainTextLine('A&nbsp;B')).toBe(false);
    expect(isPlainTextLine('裸 & 符号')).toBe(false);
    // 分叉证据：parseLine 渲染 content 已解码（≠ raw）——直刷必分叉
    const rendered = renderText('价格 &amp; 说明');
    expect(rendered.text).not.toBe('价格 &amp; 说明');
    expect(rendered.text).toBe('价格 & 说明');
  });

  it('成对语法字符保持禁入（* _ ~ ` [ ] < > \\ # | $）', () => {
    expect(isPlainTextLine('**粗体**')).toBe(false);
    expect(isPlainTextLine('*斜体*')).toBe(false);
    expect(isPlainTextLine('a_b')).toBe(false);
    expect(isPlainTextLine('~~删除线~~')).toBe(false);
    expect(isPlainTextLine('H~2~O')).toBe(false);
    expect(isPlainTextLine('`code`')).toBe(false);
    expect(isPlainTextLine('[链接](https://x)')).toBe(false);
    expect(isPlainTextLine('![图](https://x)')).toBe(false);
    expect(isPlainTextLine('# 标题')).toBe(false);
    expect(isPlainTextLine('> 引用')).toBe(false);
    expect(isPlainTextLine('| a | b |')).toBe(false);
    expect(isPlainTextLine('$x$')).toBe(false);
    expect(isPlainTextLine('<b>加粗</b>')).toBe(false);
    expect(isPlainTextLine('a \\ b')).toBe(false);
  });

  it('行尾 2+ 空格/tab（hard_break 分叉）：判定拒绝', () => {
    expectRejectedWithToken('foo  ', 'hard_break');
    expectRejectedWithToken('foo\t\t', 'hard_break');
    // 单个尾随空格不构成 hard_break（parseLine 按文本渲染），可直刷
    expectConsistent('foo ');
  });

  it('行首空白（缩进代码块/列表缩进）：判定拒绝', () => {
    expect(isPlainTextLine(' 缩进正文')).toBe(false);
    expect(isPlainTextLine('\t缩进正文')).toBe(false);
  });

  it('空行/纯空白行：判定拒绝（渲染为 <br/>，无 text token 可直写）', () => {
    expect(isPlainTextLine('')).toBe(false);
    expect(isPlainTextLine('   ')).toBe(false);
  });
});
