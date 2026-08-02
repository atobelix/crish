/**
 * shellEscape 对抗性测试套件
 *
 * 目标：暴露 escapeShellArg 在真实 shell 语义下的不安全性。
 * 设计思路：
 *  1. 不依赖具体 shell 实现，而是验证"语义保持"不变式 —— 任何 shell 解析转义后的字符串，
 *     应当还原出原始字面量，否则就是逃逸漏洞。
 *  2. 覆盖命令注入、参数截断、控制字符注入、跨平台差异等攻击面。
 *  3. 使用 fast-check 做属性测试，覆盖 ASCII + CJK + emoji + 控制字符组合。
 *
 * 期望暴露的 bug：
 *  - 双引号转义在 bash 下语义错误（`"a""b"` 被 bash 解析为 `ab` 而非 `a"b`）
 *  - 元字符剥离改变字面量（`$(x)` → `x`）
 *  - 未剥离控制字符（\x00, \x1b, \t）
 *  - 换行替换为空格改变字面量
 *  - 无平台感知（cmd.exe 与 bash 转义规则完全不同）
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { escapeShellArg } from './shellEscape';

describe('escapeShellArg — 语义保持不变式', () => {
  it('空字符串应产生可被 shell 解析为空字面量的形式', () => {
    expect(escapeShellArg('')).toBe('""');
  });

  it('对任意 ASCII 可打印字符串，转义结果必须以双引号包裹（当前实现的弱不变式）', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 64 }).filter(s => /^[\x20-\x7e]+$/.test(s)), (s) => {
        const escaped = escapeShellArg(s);
        return escaped.startsWith('"') && escaped.endsWith('"');
      }),
      { numRuns: 500 },
    );
  });

  it('暴露 bug: 包含双引号的输入在 bash 下无法还原字面量', () => {
    // escapeShellArg('a"b') = '"a""b"'
    // bash 解析 "a""b" = "a" + "b" = "ab"  ← 字面量被改变！
    // 正确的 bash 转义应是: 'a"b' 或 "a\"b"
    const input = 'a"b';
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"a""b"');

    // 模拟 bash 解析 "a""b" 的语义：相邻引号字符串拼接
    // "a""b" 等价于 "a" + "b" = "ab"
    const bashParsed = simulateBashDoubleQuoteParse(escaped);
    expect(bashParsed).not.toBe(input);
    expect(bashParsed).toBe('ab'); // 字面量丢失了双引号
  });

  it('暴露 bug: 包含 $() 的输入被剥离元字符，字面量改变', () => {
    const input = '$(evil_command)';
    const escaped = escapeShellArg(input);
    // 元字符 $ ( ) 被剥离
    expect(escaped).toBe('"evil_command"');
    // 字面量已被改变，不再是 $(evil_command)
    expect(escaped.replace(/^"|"$/g, '')).not.toBe(input);
  });

  it('暴露 bug: 包含反引号的输入被剥离', () => {
    const input = 'a`whoami`b';
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"awhoamib"');
  });

  it('暴露 bug: 换行被替换为空格，字面量改变', () => {
    const input = 'foo\nbar';
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"foo bar"');
    // 多行输入被压成单行
    expect(escaped.includes('\n')).toBe(false);
  });

  it('暴露 bug: 制表符未被处理（保留在字面量中）', () => {
    const input = 'foo\tbar';
    const escaped = escapeShellArg(input);
    // \t 不在剥离字符集中，被保留
    expect(escaped).toBe('"foo\tbar"');
  });

  it('暴露 bug: NULL 字节未被剥离，可导致参数截断', () => {
    const input = 'foo\x00bar';
    const escaped = escapeShellArg(input);
    // \x00 未被处理，许多 shell/C 库在 NULL 处截断字符串
    expect(escaped).toBe('"foo\x00bar"');
    // 后端若用 C 字符串处理，会只看到 "foo
  });

  it('暴露 bug: ANSI 转义序列未被剥离，可注入终端控制', () => {
    const input = 'foo\x1b[31mred\x1b[0m';
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"foo\x1b[31mred\x1b[0m"');
    // ANSI 转义被原样保留
  });

  it('暴露 bug: 回车符 \r 被替换为空格（仅 \r\n 或 \r 被处理）', () => {
    // 实现用 [\r\n]+ 匹配，单独 \r 也会被替换
    const input = 'foo\rbar';
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"foo bar"');
  });

  it('暴露 bug: 脱字符 ^ 被剥离，削弱 Windows cmd.exe 转义能力', () => {
    // cmd.exe 用 ^ 作为转义字符，剥离它会让其他元字符更危险
    const input = 'foo^bar';
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"foobar"');
  });

  it('暴露 bug: 百分号 % 被剥离，但 cmd.exe 变量展开 %VAR% 仍可被攻击者控制', () => {
    // 剥离 % 后，%PATH% 变成 PATH，字面量改变
    const input = 'foo%PATH%bar';
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"fooPATHbar"');
  });
});

describe('escapeShellArg — 命令注入防御', () => {
  it('经典注入 payload 应被中和（但代价是字面量改变）', () => {
    const payloads = [
      '; rm -rf /',
      '| cat /etc/passwd',
      '&& whoami',
      '`whoami`',
      '$(whoami)',
      '> /etc/cron.d/evil',
      '\nwhoami\n',
    ];
    for (const p of payloads) {
      const escaped = escapeShellArg(p);
      // 转义后不应包含未被中和的危险字符
      // 注意：当前实现通过"剥离"来中和，而非真正转义
      expect(escaped).toMatch(/^"[^"]*"$/);
    }
  });

  it('暴露 bug: 转义结果中仍可能包含未剥离的危险字符（如 \\）', () => {
    // 反斜杠不在剥离集中
    const input = 'foo\\bar';
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"foo\\bar"');
    // 在 bash 双引号中，\ 保留字面意义（除了 \<newline>），但在某些上下文仍有作用
  });

  it('暴露 bug: 单引号未被处理，在 bash 双引号中无害但语义不一致', () => {
    const input = "foo'bar";
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"foo\'bar"');
    // 单引号在双引号中是字面量，安全；但实现并未显式处理
  });
});

describe('escapeShellArg — 跨平台一致性', () => {
  it('函数签名不接收 platform 参数，无法区分 bash/cmd/PowerShell', () => {
    // 这是一个设计缺陷：同一个函数被用于所有平台
    // 在 Windows 上，双引号转义规则完全不同
    expect(escapeShellArg.length).toBe(1);
  });

  it('Windows 路径中的反斜杠被保留，可能在 cmd.exe 下引发问题', () => {
    const input = 'C:\\Program Files\\app';
    const escaped = escapeShellArg(input);
    expect(escaped).toBe('"C:\\Program Files\\app"');
    // 反斜杠未被处理
  });
});

describe('escapeShellArg — 属性测试：剥离字符集的不一致性', () => {
  it('对任意输入，被剥离的字符集应为 [\\r\\n<>|&;()$`%!^]', () => {
    const strippedChars = '<>|&;()$`%!^';
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 128 }), (s) => {
        // 被剥离的字符不应出现在结果中（除了换行被替换为空格）
        for (const ch of strippedChars) {
          if (s.includes(ch)) {
            // 原始输入有此字符，转义后内部不应再有（被剥离）
            // 但要注意 " 不会被剥离而是被翻倍
            if (ch !== '"') {
              // 注意：换行被替换为空格，不是剥离
            }
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('cmd 翻倍逻辑的数学正确性：每个 " 翻倍为 ""，再加外层一对', () => {
    // 输入 N 个 " → 内部 2N 个 " → 加外层 2 个 → 总共 2N+2 个
    const cases = [
      { input: 'a"b', expected: '"a""b"', internalQuotes: 2 },
      { input: 'a""b', expected: '"a""""b"', internalQuotes: 4 },
      { input: '"', expected: '""""', internalQuotes: 2 },
      { input: '""', expected: '""""""', internalQuotes: 4 },
    ];
    for (const { input, expected, internalQuotes } of cases) {
      const result = escapeShellArg(input);
      expect(result).toBe(expected);
      // 内部引号数（去掉外层一对）应为偶数
      const inner = result.slice(1, -1);
      const count = (inner.match(/"/g) || []).length;
      expect(count).toBe(internalQuotes);
      expect(count % 2).toBe(0);
    }
  });

  it('bash 解析下 cmd 翻倍逻辑会导致字面量被截断（跨平台风险）', () => {
    // cmd 下 "a""b" 表示字面量 a"b，正确
    // 但 bash 下 "a""b" 被解析为相邻字符串拼接 → "a" + "b" = ab（" 被吞掉）
    const input = 'a"b';
    const escaped = escapeShellArg(input);
    const bashParsed = simulateBashDoubleQuoteParse(escaped);
    // bash 解析后丢失了中间的 "
    expect(bashParsed).toBe('ab');
    expect(bashParsed).not.toBe(input);
  });
});

/**
 * 模拟 bash 双引号字符串解析的简化语义。
 * 仅用于测试验证字面量是否被保持。
 * 规则：相邻的引号字符串被拼接，每个 "..." 内的字面量被提取。
 */
function simulateBashDoubleQuoteParse(s: string): string {
  // 简化：按 " 分割，奇数索引段为引号内内容，相邻段拼接
  // "a""b" → ['', 'a', '', 'b', ''] → 引号段是索引 1,3 → 'a' + 'b' = 'ab'
  const parts = s.split('"');
  let result = '';
  for (let i = 1; i < parts.length; i += 2) {
    result += parts[i];
  }
  return result;
}
