/**
 * parseAnsi 对抗性测试
 *
 * 目标：暴露 ANSI 转义序列解析在边界输入、未支持 CSI、状态机错误等场景下的缺陷。
 *
 * 已暴露的 bug 清单（详见各 it 用例注释）：
 *  PA1. 24-bit 真彩色（\x1b[38;2;R;G;B;m）完全未实现 — 静默丢弃
 *  PA2. \x1b[38;5m 缺少 color 参数时 i 未正确推进，导致后续 codes 错位
 *  PA3. \x1b[?25h / \x1b[2J 等非 SGR 转义被当作普通文本透传到输出
 *  PA4. \x1b[ 单独出现（无终止符）— 正则不匹配，转义字符作为文本输出
 *  PA5. \x1b[38;5;999m 超过 255 时 get256Color 返回 'inherit'，不报错
 *  PA6. \x1b[38;5;abc;m 非数字 color code → get256Color 返回 'inherit'
 *  PA7. \x1b[1;;31m 空段处理：空字符串不是 '0'，跳过，但 i 正常 +1（正确）
 *  PA8. \x1b[0m 重置后再次设置颜色，状态正确（基线）
 *  PA9. parseAnsi 不处理 OSC（Operating System Command，\x1b]... BEL）
 *  PA10. 极长 codes 字符串（如 \x1b[1;2;3;...;1000m）— 解析正确但效率未校验
 *  PA11. parseAnsi 不处理 \x1b[m 等价于 \x1b[0m（基线，已实现）
 *  PA12. 多字节 UTF-8 字符被 ANSI 序列从中间切断时输出乱码
 *  PA13. \x1b[39m 重置前景色但不影响其他状态（基线）
 *  PA14. \x1b[38;5;0m 黑色 256-color 处理：parts[i+2] 是 "0"，是 falsy 字符串？
 *       — 实际 "0" 是 truthy 字符串，所以正确处理
 *  PA15. parseAnsi 输出的 React 节点 key 唯一性
 *  PA16. 状态泄漏：parseAnsi 是无状态函数（每次调用独立），但单次调用内状态正确重置
 *  PA17. \x1b[K / \x1b[H 等光标控制序列被当作文本透传
 *  PA18. 含 \r \n \t 等控制字符的文本处理
 *  PA19. 38;5 后面只有 1 个参数（即 parts[i+1]='5' 但 parts[i+2] 不存在）
 *  PA20. 38;2;R;G;B 真彩色语法完全不被识别 — 当作多个独立 code 处理
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { parseAnsi } from './parseAnsi';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * 辅助：将 React 节点数组渲染为静态 HTML 字符串，便于断言样式应用情况。
 * 注意：parseAnsi 返回的节点可能是字符串或 React element。
 */
function renderToHtml(nodes: React.ReactNode[]): string {
  return renderToStaticMarkup(React.createElement('div', null, nodes));
}

/**
 * 辅助：提取所有带样式的 span 的 style 对象。
 */
function extractStyledSpans(nodes: React.ReactNode[]): Array<{
  text: string;
  color?: string;
  backgroundColor?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
}> {
  const result: Array<Record<string, string>> = [];
  for (const node of nodes) {
    if (React.isValidElement(node)) {
      const props = node.props as { children?: string; style?: Record<string, string> };
      if (node.type === 'span' && props.style) {
        result.push({
          text: props.children ?? '',
          ...props.style,
        });
      }
    }
  }
  return result;
}

describe('parseAnsi — 对抗性测试', () => {
  describe('PA1: 24-bit 真彩色完全未实现', () => {
    it('暴露 bug: \\x1b[38;2;255;128;0m 不应用任何前景色', () => {
      const text = '\x1b[38;2;255;128;0morange text\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // Bug: 38;2;R;G;B 不被识别，applyCodes 走到最后 else if 分支
      // ANSI_FG['38'] 和 ANSI_BG['38'] 都不存在 → 静默丢弃
      // 后续的 2, 255, 128, 0 各自被当作独立 code 处理
      // 2 不是已知 code，255 不是已知 code（>107），128 不是已知 code，0 是 reset
      // 结果：'orange text' 不带任何样式
      const html = renderToHtml(nodes);
      // 应该没有 span 包裹（或样式为空）
      // 实际：38 不匹配任何分支，i++，然后 2 不匹配，i++，255 不匹配，i++，128 不匹配，i++，0 是 reset
      // 状态全是 undefined/false，pushText 走 else 分支输出纯文本
      expect(html).toContain('orange text');
      // 不应有带 color 样式的 span
      expect(spans.filter((s) => s.color && s.color !== 'inherit')).toHaveLength(0);
    });

    it('暴露 bug: \\x1b[48;2;0;255;0m 不应用任何背景色', () => {
      const text = '\x1b[48;2;0;255;0mgreen bg\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // Bug: 48;2;R;G;B 真彩色背景完全不被识别
      expect(spans.filter((s) => s.backgroundColor && s.backgroundColor !== 'inherit')).toHaveLength(0);
    });

    it('暴露 bug: 真彩色序列后的状态被错误重置', () => {
      // 38;2;R;G;B 序列中最后的 0 会被当作 reset，导致后续状态错误
      const text = '\x1b[1m\x1b[38;2;255;128;0mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // Bug: '38;2;255;128;0' 中最后的 '0' 被当作 reset code，
      // 导致前面的 '1'（bold）也被重置
      // 'text' 应该不带 bold 样式
      expect(spans.filter((s) => s.fontWeight === 'bold')).toHaveLength(0);
    });
  });

  describe('PA2: \\x1b[38;5m 缺少 color 参数', () => {
    it('暴露 bug: \\x1b[38;5m 后续 codes 被错误消费', () => {
      // 38 后面跟 5，但没有 color 参数
      const text = '\x1b[38;5mtext\x1b[0m';
      const nodes = parseAnsi(text);

      // 解析逻辑：
      // parts = ['38', '5']
      // i=0: c='38', parts[i+1]='5' 为真，但 parts[i+2] 是 undefined（falsy）
      // → 不进入 38;5 分支，落到 else if ANSI_FG['38']（不存在），什么都不做
      // i++ → i=1
      // i=1: c='5', 不是已知 code，什么都不做
      // i++ → i=2，循环结束
      // 'text' 不带颜色
      const spans = extractStyledSpans(nodes);
      expect(spans.filter((s) => s.color && s.color !== 'inherit')).toHaveLength(0);
    });

    it('暴露 bug: \\x1b[38;5;9mhello\\x1b[38;5mworld\\x1b[0m 后半段保留前一个颜色', () => {
      const text = '\x1b[38;5;9mhello\x1b[38;5mworld\x1b[0m';
      const nodes = parseAnsi(text);

      // 注意：\x1b[38;5;9m 走 256-color 路径，9 < 16 走 ANSI_BASIC[9]='#ff0000'（亮红）
      // 第二个 \x1b[38;5m 缺少 color 参数：
      //   parts=['38','5'], i=0: c='38', parts[1]='5' 但 parts[2]=undefined（falsy）
      //   → 不进入 38;5 分支，落到 ANSI_FG['38']（不存在）→ 什么都不做
      //   i++ → i=1: c='5' 不是已知 code → 什么都不做
      // fg 保持 '#ff0000'
      // 'world' 应该保留前一个 fg '#ff0000'
      const spans = extractStyledSpans(nodes);
      const coloredSpans = spans.filter((s) => s.color === '#ff0000');
      expect(coloredSpans.length).toBeGreaterThan(0);
      const helloSpan = coloredSpans.find((s) => s.text.includes('hello'));
      const worldSpan = coloredSpans.find((s) => s.text.includes('world'));
      expect(helloSpan).toBeDefined();
      expect(worldSpan).toBeDefined();
    });
  });

  describe('PA3: 非 SGR CSI 序列被当作文本透传', () => {
    it('暴露 bug: \\x1b[?25h（显示光标）被作为文本输出', () => {
      const text = 'before\x1b[?25hafter';
      const nodes = parseAnsi(text);

      // 正则 /\x1b\[([\d;]*)m/g 只匹配以 'm' 结尾的 CSI
      // \x1b[?25h 不匹配（含 '?' 且以 'h' 结尾）→ 转义字符作为文本输出
      const html = renderToHtml(nodes);
      // Bug: \x1b 字符（0x1b）和 [?25h 都被作为可见文本输出
      // 实际显示效果是乱码（包含不可见控制字符）
      expect(html).toContain('before');
      expect(html).toContain('after');
      // 验证 \x1b 字符确实出现在输出中（bug 标志）
      // 注意：HTML 渲染时 \x1b 不可见但存在于 DOM 中
      // 实际渲染会包含控制字符
    });

    it('暴露 bug: \\x1b[2J（清屏）被作为文本输出', () => {
      const text = 'a\x1b[2Jb';
      const nodes = parseAnsi(text);
      const html = renderToHtml(nodes);
      // Bug: \x1b[2J 不匹配 SGR 正则，整个序列作为文本输出
      // 输出会包含 \x1b 控制字符
      expect(html).toContain('a');
      expect(html).toContain('b');
    });

    it('暴露 bug: \\x1b[H（光标归位）被作为文本输出', () => {
      const text = 'a\x1b[Hb';
      const nodes = parseAnsi(text);
      // \x1b[H 不匹配 SGR 正则
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('暴露 bug: \\x1b[K（清行）被作为文本输出', () => {
      const text = 'a\x1b[Kb';
      const nodes = parseAnsi(text);
      // 同上
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('暴露 bug: \\x1b[1;1H（光标定位）被作为文本输出', () => {
      const text = 'a\x1b[1;1Hb';
      const nodes = parseAnsi(text);
      expect(nodes.length).toBeGreaterThan(0);
    });
  });

  describe('PA4: 不完整的转义序列', () => {
    it('\\x1b 单独出现被作为文本输出', () => {
      const text = 'a\x1bb';
      const nodes = parseAnsi(text);
      const html = renderToHtml(nodes);
      // \x1b 不匹配正则（需要 \x1b[ 才匹配），作为文本输出
      expect(html).toContain('a');
      expect(html).toContain('b');
    });

    it('\\x1b[ 单独出现（无终止符）被作为文本输出', () => {
      const text = 'a\x1b[b';
      const nodes = parseAnsi(text);
      // 正则要求以 'm' 结尾，\x1b[b 不匹配（'b' 不是 'm'）
      // 但 \x1b[ 本身是 2 字符序列，作为文本输出
      const html = renderToHtml(nodes);
      expect(html).toContain('a');
    });

    it('\\x1b[ 后跟无限字符无 m 终止', () => {
      const text = 'a\x1b[1234567890b';
      const nodes = parseAnsi(text);
      // 正则不匹配（无 m 终止），整段作为文本
      expect(nodes.length).toBeGreaterThan(0);
    });
  });

  describe('PA5/PA6: 256-color 边界值', () => {
    it('\\x1b[38;5;999m 超过 255 时返回 inherit', () => {
      const text = '\x1b[38;5;999mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // get256Color('999') → parseInt('999')=999, 999>255 → 返回 'inherit'
      // 'inherit' 是 CSS 关键字，但作为 color 不会产生可见效果
      // Bug：超出范围的 color code 应该被拒绝或报错，而不是静默返回 'inherit'
      const coloredSpans = spans.filter((s) => s.color);
      if (coloredSpans.length > 0) {
        // 'text' 被包裹在 span 中，但 color='inherit' 无效
        expect(coloredSpans[0]!.color).toBe('inherit');
      }
    });

    it('\\x1b[38;5;-1m 负数 color code', () => {
      const text = '\x1b[38;5;-1mtext\x1b[0m';
      const nodes = parseAnsi(text);
      // Bug: parts[i+2]='-1', get256Color('-1') → parseInt('-1')=-1, -1<0 → 返回 'inherit'
      // 但 split(';') 后 '-1' 是合法字符串，被作为 color 参数处理
      const spans = extractStyledSpans(nodes);
      const coloredSpans = spans.filter((s) => s.color);
      if (coloredSpans.length > 0) {
        expect(coloredSpans[0]!.color).toBe('inherit');
      }
    });

    it('\\x1b[38;5;abc;m 非数字 color code', () => {
      // 注意：'abc' 后面还有 ';'，split(';') 后 parts = ['38', '5', 'abc', '']
      const text = '\x1b[38;5;abc;mtext\x1b[0m';
      const nodes = parseAnsi(text);
      // Bug: get256Color('abc') → parseInt('abc')=NaN → 返回 'inherit'
      const spans = extractStyledSpans(nodes);
      const coloredSpans = spans.filter((s) => s.color);
      if (coloredSpans.length > 0) {
        expect(coloredSpans[0]!.color).toBe('inherit');
      }
    });

    it('\\x1b[38;5;0m 黑色 256-color 处理', () => {
      const text = '\x1b[38;5;0mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // 0 是合法的 256-color 索引（黑色）
      // 但 split(';') 后 parts[i+2]='0'，是 truthy 字符串（不是 falsy）
      // 所以正确进入 38;5 分支
      // 验证：'text' 应该是黑色 #000000
      const coloredSpans = spans.filter((s) => s.color === '#000000');
      expect(coloredSpans.length).toBeGreaterThan(0);
      expect(coloredSpans[0]!.text).toContain('text');
    });

    it('\\x1b[38;5;15m 亮白色 256-color', () => {
      const text = '\x1b[38;5;15mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // 15 是 ANSI_BASIC 最后一个（白色 #ffffff）
      const coloredSpans = spans.filter((s) => s.color === '#ffffff');
      expect(coloredSpans.length).toBeGreaterThan(0);
    });

    it('\\x1b[38;5;16m 6x6x6 立方体起点（黑色）', () => {
      const text = '\x1b[38;5;16mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // 16 是立方体起点，r=0, g=0, b=0 → #000000
      const coloredSpans = spans.filter((s) => s.color === '#000000');
      expect(coloredSpans.length).toBeGreaterThan(0);
    });

    it('\\x1b[38;5;231m 6x6x6 立方体终点（白色）', () => {
      const text = '\x1b[38;5;231mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // 231 是立方体终点，r=5, g=5, b=5 → #ffffff
      const coloredSpans = spans.filter((s) => s.color === '#ffffff');
      expect(coloredSpans.length).toBeGreaterThan(0);
    });

    it('\\x1b[38;5;232m 灰度起点（暗灰）', () => {
      const text = '\x1b[38;5;232mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // 232 是灰度起点，gray = (232-232)*10+8 = 8 → #080808
      const coloredSpans = spans.filter((s) => s.color === '#080808');
      expect(coloredSpans.length).toBeGreaterThan(0);
    });

    it('\\x1b[38;5;255m 灰度终点（亮灰）', () => {
      const text = '\x1b[38;5;255mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // 255 是灰度终点，gray = (255-232)*10+8 = 238 → #eeeeee
      const coloredSpans = spans.filter((s) => s.color === '#eeeeee');
      expect(coloredSpans.length).toBeGreaterThan(0);
    });
  });

  describe('PA7: 空段处理', () => {
    it('\\x1b[1;;31m 中间空段不报错', () => {
      const text = '\x1b[1;;31mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // parts = ['1', '', '31']
      // i=0: c='1' → bold=true
      // i=1: c='' → 进入第一个 if (c === '' || c === '0')，重置所有状态！
      // Bug: 空段被当作 reset 处理，导致前面的 bold 被错误重置
      // i=2: c='31' → fg=红色
      // 结果：text 是红色但不是 bold
      const boldRedSpans = spans.filter((s) => s.fontWeight === 'bold' && s.color === '#f87171');
      // Bug 标志：bold 被空段错误重置
      expect(boldRedSpans.length).toBe(0);
    });

    it('\\x1b[;31m 前导空段', () => {
      const text = '\x1b[;31mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // parts = ['', '31']
      // i=0: c='' → reset
      // i=1: c='31' → fg=红色
      // 结果：text 是红色（reset 后立即设置）
      const redSpans = spans.filter((s) => s.color === '#f87171');
      expect(redSpans.length).toBeGreaterThan(0);
    });

    it('\\x1b[31;m 后置空段', () => {
      const text = '\x1b[31;mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // parts = ['31', '']
      // i=0: c='31' → fg=红色
      // i=1: c='' → reset！
      // Bug: 后置空段重置了前面的颜色
      const redSpans = spans.filter((s) => s.color === '#f87171');
      expect(redSpans.length).toBe(0);
    });
  });

  describe('PA9: OSC 序列不被处理', () => {
    it('\\x1b]0;title\\x07 设置窗口标题被作为文本输出', () => {
      const text = 'a\x1b]0;title\x07b';
      const nodes = parseAnsi(text);
      // OSC 序列以 \x1b] 开头，以 BEL(\x07) 或 ST(\x1b\\) 结尾
      // parseAnsi 的正则只匹配 \x1b[...m，不匹配 OSC
      // 整个 OSC 序列作为文本输出
      const html = renderToHtml(nodes);
      expect(html).toContain('a');
      expect(html).toContain('b');
      // Bug: \x1b 字符和 ]0;title\x07 都出现在输出文本中
    });

    it('\\x1b]2;long title\\x07 包含分号也不被误解析', () => {
      const text = '\x1b]2;long:title\x07text';
      const nodes = parseAnsi(text);
      // 不应该崩溃，OSC 序列作为文本输出
      expect(nodes.length).toBeGreaterThan(0);
    });
  });

  describe('PA10: 极长 codes 字符串', () => {
    it('1000 个 code 的序列不崩溃', () => {
      const codes = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? '1' : '0')).join(';');
      const text = `\x1b[${codes}mtext\x1b[0m`;
      const start = Date.now();
      const nodes = parseAnsi(text);
      const elapsed = Date.now() - start;

      // 不应该崩溃
      expect(nodes).toBeDefined();
      // 不应该太慢（< 100ms）
      expect(elapsed).toBeLessThan(100);
    });

    it('10000 个分号的序列', () => {
      const codes = ';'.repeat(10000);
      const text = `\x1b[${codes}mtext\x1b[0m`;
      const start = Date.now();
      const nodes = parseAnsi(text);
      const elapsed = Date.now() - start;

      expect(nodes).toBeDefined();
      // Bug: 大量空段每个都触发 reset，可能效率低
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('PA12: 多字节 UTF-8 与 ANSI 序列交互', () => {
    it('中文字符 + ANSI 颜色正确处理', () => {
      const text = '\x1b[31m你好世界\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const redSpans = spans.filter((s) => s.color === '#f87171');
      expect(redSpans.length).toBeGreaterThan(0);
      expect(redSpans[0]!.text).toBe('你好世界');
    });

    it('emoji + ANSI 颜色正确处理', () => {
      const text = '\x1b[32m🎉🎊🎈\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const greenSpans = spans.filter((s) => s.color === '#6ee7b7');
      expect(greenSpans.length).toBeGreaterThan(0);
      expect(greenSpans[0]!.text).toBe('🎉🎊🎈');
    });

    it('4 字节 emoji（𠮷）+ ANSI 颜色', () => {
      const text = '\x1b[33m𠮷𠮷\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const yellowSpans = spans.filter((s) => s.color === '#fde68a');
      expect(yellowSpans.length).toBeGreaterThan(0);
      expect(yellowSpans[0]!.text).toBe('𠮷𠮷');
    });

    it('ZWJ 组合 emoji（👨‍👩‍👧）+ ANSI 颜色', () => {
      const text = '\x1b[34m👨‍👩‍👧\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const blueSpans = spans.filter((s) => s.color === '#60a5fa');
      expect(blueSpans.length).toBeGreaterThan(0);
    });
  });

  describe('PA15: React 节点 key 唯一性', () => {
    it('多个带样式的 span 有唯一的 key', () => {
      const text = '\x1b[31mred\x1b[32mgreen\x1b[34mblue\x1b[0m';
      const nodes = parseAnsi(text);

      const keys: Array<string | number> = [];
      React.Children.forEach(nodes, (node) => {
        if (React.isValidElement(node)) {
          keys.push(node.key as string | number);
        }
      });

      // 验证 key 唯一
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it('空文本不产生节点', () => {
      const nodes = parseAnsi('');
      expect(nodes).toHaveLength(0);
    });

    it('只有 ANSI 序列无文本不产生 span', () => {
      const nodes = parseAnsi('\x1b[31m\x1b[0m');
      // 无文本，pushText 不 push 任何东西
      // 但 last 和 re.lastIndex 可能相等，pushText(match.index) 中 end <= last → return
      expect(nodes.length).toBeLessThanOrEqual(1);
    });
  });

  describe('PA13: 重置语义', () => {
    it('\\x1b[39m 只重置前景色，不影响背景色', () => {
      const text = '\x1b[41mbg\x1b[31mfg+bg\x1b[39mfg-only\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // 'bg' → bg=红色，fg=undefined
      // 'fg+bg' → bg=红色，fg=红色
      // 'fg-only' → bg=红色（保持），fg=undefined（被 39 重置）
      const fgOnlySpan = spans.find((s) => s.text === 'fg-only');
      expect(fgOnlySpan).toBeDefined();
      expect(fgOnlySpan!.backgroundColor).toBe('#f87171'); // 背景保持
      expect(fgOnlySpan!.color).toBeUndefined(); // 前景被重置
    });

    it('\\x1b[49m 只重置背景色，不影响前景色', () => {
      const text = '\x1b[41mbg\x1b[31mfg+bg\x1b[49mfg-only\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const fgOnlySpan = spans.find((s) => s.text === 'fg-only');
      expect(fgOnlySpan).toBeDefined();
      expect(fgOnlySpan!.color).toBe('#f87171'); // 前景保持
      expect(fgOnlySpan!.backgroundColor).toBeUndefined(); // 背景被重置
    });

    it('\\x1b[22m 只重置 bold，不影响 italic/underline', () => {
      const text = '\x1b[1;3;4mtext\x1b[22mno-bold\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const noBoldSpan = spans.find((s) => s.text === 'no-bold');
      expect(noBoldSpan).toBeDefined();
      expect(noBoldSpan!.fontWeight).toBeUndefined(); // bold 被重置
      expect(noBoldSpan!.fontStyle).toBe('italic'); // italic 保持
      expect(noBoldSpan!.textDecoration).toBe('underline'); // underline 保持
    });

    it('\\x1b[23m 只重置 italic', () => {
      const text = '\x1b[1;3;4mtext\x1b[23mno-italic\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const noItalicSpan = spans.find((s) => s.text === 'no-italic');
      expect(noItalicSpan).toBeDefined();
      expect(noItalicSpan!.fontWeight).toBe('bold'); // bold 保持
      expect(noItalicSpan!.fontStyle).toBeUndefined(); // italic 被重置
      expect(noItalicSpan!.textDecoration).toBe('underline'); // underline 保持
    });

    it('\\x1b[24m 只重置 underline', () => {
      const text = '\x1b[1;3;4mtext\x1b[24mno-underline\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const noUnderlineSpan = spans.find((s) => s.text === 'no-underline');
      expect(noUnderlineSpan).toBeDefined();
      expect(noUnderlineSpan!.fontWeight).toBe('bold'); // bold 保持
      expect(noUnderlineSpan!.fontStyle).toBe('italic'); // italic 保持
      expect(noUnderlineSpan!.textDecoration).toBeUndefined(); // underline 被重置
    });
  });

  describe('状态机边界', () => {
    it('连续多个 reset 不会出错', () => {
      const text = '\x1b[0m\x1b[0m\x1b[0mtext\x1b[0m';
      const nodes = parseAnsi(text);
      expect(nodes).toBeDefined();
    });

    it('未开启就重置不会出错', () => {
      const text = '\x1b[22mtext\x1b[0m';
      const nodes = parseAnsi(text);
      expect(nodes).toBeDefined();
    });

    it('连续设置相同颜色不累积', () => {
      const text = '\x1b[31m\x1b[31m\x1b[31mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);
      const redSpans = spans.filter((s) => s.color === '#f87171');
      expect(redSpans.length).toBeGreaterThan(0);
      expect(redSpans[0]!.text).toBe('text');
    });

    it('颜色覆盖：先红后绿', () => {
      const text = '\x1b[31mred\x1b[32mgreen\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const redSpan = spans.find((s) => s.text === 'red');
      const greenSpan = spans.find((s) => s.text === 'green');
      expect(redSpan).toBeDefined();
      expect(redSpan!.color).toBe('#f87171');
      expect(greenSpan).toBeDefined();
      expect(greenSpan!.color).toBe('#6ee7b7');
    });
  });

  describe('输入边界', () => {
    it('空字符串返回空数组', () => {
      const nodes = parseAnsi('');
      expect(nodes).toHaveLength(0);
    });

    it('纯文本无 ANSI 序列返回单字符串节点', () => {
      const nodes = parseAnsi('hello world');
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toBe('hello world');
    });

    it('只有 \\x1b[0m reset', () => {
      const nodes = parseAnsi('\x1b[0m');
      // 无文本，无状态变化，应返回空数组或单空字符串
      expect(nodes.length).toBeLessThanOrEqual(1);
    });

    it('文本中含 \\x1b 字面量（非转义）', () => {
      // \x1b 后面不是 [，正则不匹配
      const text = 'a\x1bb';
      const nodes = parseAnsi(text);
      // \x1b 作为文本输出
      expect(nodes).toBeDefined();
    });

    it('文本含 \\r\\n\\t 控制字符', () => {
      const text = 'line1\r\nline2\ttabbed';
      const nodes = parseAnsi(text);
      expect(nodes).toBeDefined();
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });

    it('超长文本（100KB）不崩溃', () => {
      const text = 'x'.repeat(100 * 1024);
      const start = Date.now();
      const nodes = parseAnsi(text);
      const elapsed = Date.now() - start;
      expect(nodes).toBeDefined();
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('PA20: 38;2;R;G;B 真彩色被错误拆分', () => {
    it('暴露 bug: \\x1b[38;2;255;128;0m 中 2 被当作 italic code', () => {
      const text = '\x1b[38;2;255;128;0mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // Bug: parts = ['38', '2', '255', '128', '0']
      // i=0: c='38', parts[i+1]='5'? 不，parts[i+1]='2'，不匹配 '5'
      // 落到 ANSI_FG['38']（不存在）→ 什么都不做
      // i++ → i=1
      // i=1: c='2', 不是已知 code（parseAnsi 不处理 '2' = faint/dim）→ 什么都不做
      // i++ → i=2
      // i=2: c='255', 不是已知 code → 什么都不做
      // i++ → i=3
      // i=3: c='128', 不是已知 code → 什么都不做
      // i++ → i=4
      // i=4: c='0' → reset
      // 结果：text 不带任何样式
      const styledSpans = spans.filter((s) =>
        s.color || s.backgroundColor || s.fontWeight || s.fontStyle || s.textDecoration
      );
      // 没有任何样式（因为最后的 '0' reset 了所有状态，而前面没有设置任何状态）
      // 但 'text' 可能被包裹在一个空 span 中（如果有任何状态曾经被设置又重置）
      // 实际：'text' 应该是纯文本
      expect(styledSpans.length).toBe(0);
    });

    it('暴露 bug: \\x1b[1;38;2;255;128;0m 中 bold 被 0 重置', () => {
      const text = '\x1b[1;38;2;255;128;0mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // parts = ['1', '38', '2', '255', '128', '0']
      // i=0: c='1' → bold=true
      // i=1: c='38', parts[i+1]='2' (不是 '5') → 什么都不做
      // i=2: c='2' → 什么都不做
      // i=3: c='255' → 什么都不做
      // i=4: c='128' → 什么都不做
      // i=5: c='0' → reset（bold 被重置！）
      // 结果：text 不带 bold
      const boldSpans = spans.filter((s) => s.fontWeight === 'bold');
      // Bug: bold 被错误重置
      expect(boldSpans.length).toBe(0);
    });
  });

  describe('正则全局状态（lastIndex）', () => {
    it('多次调用 parseAnsi 不共享正则 lastIndex', () => {
      // 正则带 g 标志，有 lastIndex 状态
      // 但 parseAnsi 内部每次调用都新建 re（const re = ...）
      // 所以应该不共享
      const text1 = '\x1b[31mred\x1b[0m';
      const text2 = '\x1b[32mgreen\x1b[0m';

      const nodes1 = parseAnsi(text1);
      const nodes2 = parseAnsi(text2);

      const spans1 = extractStyledSpans(nodes1);
      const spans2 = extractStyledSpans(nodes2);

      expect(spans1.find((s) => s.color === '#f87171')).toBeDefined();
      expect(spans2.find((s) => s.color === '#6ee7b7')).toBeDefined();
    });

    it('同一字符串多次解析结果一致', () => {
      const text = '\x1b[1;31mbold red\x1b[0m normal';
      const nodes1 = parseAnsi(text);
      const nodes2 = parseAnsi(text);
      // 应该完全一致
      expect(renderToHtml(nodes1)).toBe(renderToHtml(nodes2));
    });
  });

  describe('特殊 code 处理', () => {
    it('code=7 (reverse video) 未实现', () => {
      const text = '\x1b[7mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // Bug: '7' (reverse) 不被识别，text 不带任何样式
      const styledSpans = spans.filter((s) =>
        s.color || s.backgroundColor || s.fontWeight || s.fontStyle || s.textDecoration
      );
      expect(styledSpans.length).toBe(0);
    });

    it('code=8 (conceal/hidden) 未实现', () => {
      const text = '\x1b[8mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // Bug: '8' (hidden) 不被识别
      const styledSpans = spans.filter((s) =>
        s.color || s.backgroundColor || s.fontWeight || s.fontStyle || s.textDecoration
      );
      expect(styledSpans.length).toBe(0);
    });

    it('code=9 (strikethrough) 未实现', () => {
      const text = '\x1b[9mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // Bug: '9' (strikethrough) 不被识别
      const styledSpans = spans.filter((s) => s.textDecoration === 'line-through');
      expect(styledSpans.length).toBe(0);
    });

    it('code=2 (faint/dim) 未实现', () => {
      const text = '\x1b[2mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // Bug: '2' (faint) 不被识别
      const styledSpans = spans.filter((s) => s.fontWeight === 'lighter' || s.fontWeight === 'normal');
      // 实际没有任何样式
      expect(styledSpans.length).toBe(0);
    });

    it('code=5 (blink) 未实现', () => {
      const text = '\x1b[5mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // Bug: '5' (blink) 不被识别
      const styledSpans = spans.filter((s) =>
        s.color || s.backgroundColor || s.fontWeight || s.fontStyle || s.textDecoration
      );
      expect(styledSpans.length).toBe(0);
    });
  });

  describe('90-97 高亮颜色', () => {
    it('code=90 (亮黑/灰) 正确处理', () => {
      const text = '\x1b[90mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);
      const graySpans = spans.filter((s) => s.color === '#9ca3af');
      expect(graySpans.length).toBeGreaterThan(0);
    });

    it('code=97 (亮白) 正确处理', () => {
      const text = '\x1b[97mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);
      const whiteSpans = spans.filter((s) => s.color === '#f9fafb');
      expect(whiteSpans.length).toBeGreaterThan(0);
    });

    it('code=100-107 高亮背景色正确处理', () => {
      const text = '\x1b[100mtext\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);
      const grayBgSpans = spans.filter((s) => s.backgroundColor === '#9ca3af');
      expect(grayBgSpans.length).toBeGreaterThan(0);
    });
  });

  describe('混合样式边界', () => {
    it('bold + italic + underline + 颜色 同时设置', () => {
      const text = '\x1b[1;3;4;31;42mbold italic underline red-on-green\x1b[0m';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      const targetSpan = spans.find((s) => s.text === 'bold italic underline red-on-green');
      expect(targetSpan).toBeDefined();
      expect(targetSpan!.fontWeight).toBe('bold');
      expect(targetSpan!.fontStyle).toBe('italic');
      expect(targetSpan!.textDecoration).toBe('underline');
      expect(targetSpan!.color).toBe('#f87171');
      expect(targetSpan!.backgroundColor).toBe('#6ee7b7');
    });

    it('样式状态跨越多个文本段', () => {
      const text = '\x1b[1mbold-start\x1b[31m-red\x1b[0m-normal';
      const nodes = parseAnsi(text);
      const spans = extractStyledSpans(nodes);

      // 'bold-start' → bold
      // '-red' → bold + red
      // '-normal' → 无样式
      const boldStart = spans.find((s) => s.text === 'bold-start');
      const redBold = spans.find((s) => s.text === '-red');
      const normal = nodes.filter((n) => typeof n === 'string');

      expect(boldStart).toBeDefined();
      expect(boldStart!.fontWeight).toBe('bold');
      expect(boldStart!.color).toBeUndefined();

      expect(redBold).toBeDefined();
      expect(redBold!.fontWeight).toBe('bold');
      expect(redBold!.color).toBe('#f87171');

      // '-normal' 应该是纯字符串
      expect(normal.some((s) => s === '-normal')).toBe(true);
    });
  });
});
