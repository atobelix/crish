import { describe, expect, it } from 'vitest';
import {
  IncrementalMarkdownParser,
  type IncrementalParseResult,
} from './IncrementalMarkdownParser';

/**
 * IncrementalMarkdownParser 单元测试
 *
 * 覆盖范围：
 *   1. 基础块级元素（段落 / 标题 / 水平线 / 引用 / 代码块）
 *   2. 列表（无序 / 有序 / 任务 / 嵌套 / 续行）
 *   3. 表格（标准 GFM / 列对齐 / 转义管道）
 *   4. 流式增量（多次 push / 缓存命中 / blockCount 单调）
 *   5. 边界情况（未闭合块 / 空字符串 / reset）
 *   6. 性能不变式（重复 push / 增量等价）
 *
 * 不 mock 任何依赖，直接测试真实 IncrementalMarkdownParser 类。
 */
describe('IncrementalMarkdownParser', () => {
  // ===========================================================================
  // 1. 基础块级元素
  // ===========================================================================
  describe('基础块级元素', () => {
    it('段落：普通文本作为开放段落保留在 tailBlock', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('Hello world');

      expect(r.finalizedBlocks).toHaveLength(0);
      expect(r.blockCount).toBe(0);
      expect(r.tailBlock).not.toBeNull();
      expect(r.tailBlock!.type).toBe('p');
      expect(r.tailBlock!.html).toContain('md-p');
      expect(r.tailBlock!.html).toContain('Hello world');
    });

    it('段落：多行文本累积到同一 paragraphBuffer', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('Line 1\nLine 2\nLine 3');

      expect(r.finalizedBlocks).toHaveLength(0);
      expect(r.tailBlock!.type).toBe('p');
      expect(r.tailBlock!.html).toContain('Line 1');
      expect(r.tailBlock!.html).toContain('Line 2');
      expect(r.tailBlock!.html).toContain('Line 3');
    });

    it('段落：空行后接新内容时闭合前一段为 finalizedBlock', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('First paragraph\n\nSecond paragraph');

      expect(r.finalizedBlocks).toHaveLength(1);
      expect(r.finalizedBlocks[0]!.type).toBe('p');
      expect(r.finalizedBlocks[0]!.html).toContain('First paragraph');
      expect(r.tailBlock).not.toBeNull();
      expect(r.tailBlock!.type).toBe('p');
      expect(r.tailBlock!.html).toContain('Second paragraph');
      expect(r.blockCount).toBe(1);
    });

    it('标题：h1-h4 单行即闭合，html 含 md-h{level} class', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('# H1\n\n## H2\n\n### H3\n\n#### H4');

      expect(r.finalizedBlocks).toHaveLength(4);
      expect(r.finalizedBlocks[0]!.type).toBe('h1');
      expect(r.finalizedBlocks[0]!.html).toContain('<h1 class="md-h1">');
      expect(r.finalizedBlocks[0]!.html).toContain('H1');
      expect(r.finalizedBlocks[1]!.type).toBe('h2');
      expect(r.finalizedBlocks[1]!.html).toContain('<h2 class="md-h2">');
      expect(r.finalizedBlocks[2]!.type).toBe('h3');
      expect(r.finalizedBlocks[2]!.html).toContain('<h3 class="md-h3">');
      expect(r.finalizedBlocks[3]!.type).toBe('h4');
      expect(r.finalizedBlocks[3]!.html).toContain('<h4 class="md-h4">');
      expect(r.tailBlock).toBeNull();
      expect(r.blockCount).toBe(4);
    });

    it('水平线：--- 不产生块，但会闭合前方段落', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('Before hr\n---\nAfter hr');

      // --- 闭合 "Before hr" 段落，自身不产生块，"After hr" 为开放段落
      expect(r.finalizedBlocks).toHaveLength(1);
      expect(r.finalizedBlocks[0]!.type).toBe('p');
      expect(r.finalizedBlocks[0]!.html).toContain('Before hr');
      expect(r.tailBlock).not.toBeNull();
      expect(r.tailBlock!.type).toBe('p');
      expect(r.tailBlock!.html).toContain('After hr');
    });

    it('水平线：单独 --- 产生 0 个块', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('---');

      expect(r.finalizedBlocks).toHaveLength(0);
      expect(r.tailBlock).toBeNull();
      expect(r.blockCount).toBe(0);
    });

    it('引用块：> 行在当前实现中作为段落文本处理（未产生 quote 块类型）', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('> Quote text');

      // 当前 parser 未实现 quote 块，> 行落入段落续行分支
      expect(r.finalizedBlocks).toHaveLength(0);
      expect(r.tailBlock).not.toBeNull();
      expect(r.tailBlock!.type).toBe('p');
      expect(r.tailBlock!.html).toContain('Quote text');
    });

    it('代码块：闭合 fence 产生 finalized fence 块', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('```js\nconst x = 1;\n```');

      // langFromFenceInfo 将 js 别名归一为 javascript
      expect(r.finalizedBlocks).toHaveLength(1);
      expect(r.finalizedBlocks[0]!.type).toBe('fence');
      expect(r.finalizedBlocks[0]!.html).toContain('md-code-block');
      expect(r.finalizedBlocks[0]!.html).toContain('language-javascript');
      expect(r.finalizedBlocks[0]!.html).toContain('data-lang="javascript"');
      // highlight.js 包裹关键字：const 在 hljs-keyword span 内
      expect(r.finalizedBlocks[0]!.html).toContain('hljs-keyword');
      expect(r.finalizedBlocks[0]!.html).toContain('const');
      expect(r.tailBlock).toBeNull();
    });

    it('代码块：无语言 fence 仍产生合法结构', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('```\nplain code\n```');

      expect(r.finalizedBlocks).toHaveLength(1);
      expect(r.finalizedBlocks[0]!.type).toBe('fence');
      expect(r.finalizedBlocks[0]!.html).toContain('md-code-block');
      expect(r.finalizedBlocks[0]!.html).toContain('plain code');
      expect(r.tailBlock).toBeNull();
    });
  });

  // ===========================================================================
  // 2. 列表
  // ===========================================================================
  describe('列表', () => {
    it('无序列表：- / * / + 标记均识别为 ul', () => {
      const dashParser = new IncrementalMarkdownParser();
      const dashR = dashParser.push('- dash item');
      expect(dashR.tailBlock!.type).toBe('ul');
      expect(dashR.tailBlock!.html).toContain('md-ul');
      expect(dashR.tailBlock!.html).toContain('dash item');

      const starParser = new IncrementalMarkdownParser();
      const starR = starParser.push('* star item');
      expect(starR.tailBlock!.type).toBe('ul');
      expect(starR.tailBlock!.html).toContain('star item');

      const plusParser = new IncrementalMarkdownParser();
      const plusR = plusParser.push('+ plus item');
      expect(plusR.tailBlock!.type).toBe('ul');
      expect(plusR.tailBlock!.html).toContain('plus item');
    });

    it('无序列表：多 item 累积到同一开放 list', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('- item 1\n- item 2\n- item 3');

      expect(r.tailBlock!.type).toBe('ul');
      expect(r.tailBlock!.html).toContain('item 1');
      expect(r.tailBlock!.html).toContain('item 2');
      expect(r.tailBlock!.html).toContain('item 3');
      expect(r.finalizedBlocks).toHaveLength(0);
    });

    it('无序列表：空行后接非缩进行时闭合为 finalizedBlock', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('- item 1\n- item 2\n\nText after');

      expect(r.finalizedBlocks).toHaveLength(1);
      expect(r.finalizedBlocks[0]!.type).toBe('ul');
      expect(r.finalizedBlocks[0]!.html).toContain('item 1');
      expect(r.finalizedBlocks[0]!.html).toContain('item 2');
      expect(r.tailBlock!.type).toBe('p');
      expect(r.tailBlock!.html).toContain('Text after');
    });

    it('有序列表：1. 2. 3. 标记识别为 ol，含 start 属性', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('1. first\n2. second\n3. third');

      expect(r.tailBlock!.type).toBe('ol');
      expect(r.tailBlock!.html).toContain('md-ol');
      expect(r.tailBlock!.html).toContain('start="1"');
      expect(r.tailBlock!.html).toContain('first');
      expect(r.tailBlock!.html).toContain('second');
      expect(r.tailBlock!.html).toContain('third');
    });

    it('任务列表：- [ ] / - [x] 识别为 task item', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('- [ ] todo\n- [x] done');

      // task kind 在 renderListHtml 中映射为 ul 容器
      expect(r.tailBlock!.type).toBe('ul');
      expect(r.tailBlock!.html).toContain('md-task-item');
      expect(r.tailBlock!.html).toContain('md-task-box');
      expect(r.tailBlock!.html).toContain('todo');
      expect(r.tailBlock!.html).toContain('done');
      // [x] 项应有 done / checked 标记
      expect(r.tailBlock!.html).toContain('done');
      expect(r.tailBlock!.html).toContain('checked');
    });

    it('嵌套列表：当前实现将嵌套项扁平化到同一列表（一级列表约束）', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('- parent\n  - child');

      // 实现注释明确：本实现只支持一级列表，嵌套留给完成态 Rust
      expect(r.tailBlock!.type).toBe('ul');
      expect(r.tailBlock!.html).toContain('parent');
      expect(r.tailBlock!.html).toContain('child');
    });

    it('列表续行：同缩进的非标记行追加到当前项内容', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('- item\n  continuation');

      expect(r.tailBlock!.type).toBe('ul');
      expect(r.tailBlock!.html).toContain('item');
      expect(r.tailBlock!.html).toContain('continuation');
    });
  });

  // ===========================================================================
  // 3. 表格
  // ===========================================================================
  describe('表格', () => {
    it('标准 GFM 表格：header + sep + rows 识别为 table', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('| H1 | H2 |\n| --- | --- |\n| a | b |');

      // 表格开放（无非表格行收尾），停留在 tailBlock
      expect(r.tailBlock!.type).toBe('table');
      expect(r.tailBlock!.html).toContain('md-table');
      expect(r.tailBlock!.html).toContain('<thead>');
      expect(r.tailBlock!.html).toContain('<tbody>');
      expect(r.tailBlock!.html).toContain('H1');
      expect(r.tailBlock!.html).toContain('H2');
      expect(r.tailBlock!.html).toContain('>a<');
      expect(r.tailBlock!.html).toContain('>b<');
      expect(r.finalizedBlocks).toHaveLength(0);
    });

    it('标准 GFM 表格：非表格行收尾时闭合为 finalizedBlock', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push(
        '| H1 | H2 |\n| --- | --- |\n| a | b |\nText after'
      );

      expect(r.finalizedBlocks).toHaveLength(1);
      expect(r.finalizedBlocks[0]!.type).toBe('table');
      expect(r.finalizedBlocks[0]!.html).toContain('H1');
      expect(r.finalizedBlocks[0]!.html).toContain('a');
      expect(r.tailBlock!.type).toBe('p');
      expect(r.tailBlock!.html).toContain('Text after');
    });

    it('列对齐：:--- / :---: / ---: 分别对应 left / center / right', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push(
        '| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |'
      );

      expect(r.tailBlock!.type).toBe('table');
      expect(r.tailBlock!.html).toContain('class="left"');
      expect(r.tailBlock!.html).toContain('class="center"');
      expect(r.tailBlock!.html).toContain('class="right"');
    });

    it('单元格转义管道：\\| 不作为列分隔符', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('| a \\| b | c |\n| --- | --- |\n| 1 | 2 |');

      expect(r.tailBlock!.type).toBe('table');
      // "a | b" 应作为单一单元格内容
      expect(r.tailBlock!.html).toContain('a | b');
    });
  });

  // ===========================================================================
  // 4. 流式增量
  // ===========================================================================
  describe('流式增量', () => {
    it('push 多次：finalizedBlocks 不重复合并，tailBlock 反映当前开放块', () => {
      const parser = new IncrementalMarkdownParser();
      const lines = [
        '# Heading', // 0: h1 即闭合
        '', // 1
        'Para line 1', // 2: 段落开放
        'Para line 2', // 3: 段落续行
        '', // 4: 闭合段落
        '- list item', // 5: 列表开放
        'more text', // 6: 非缩进续行 → 闭合列表，开启段落
        '', // 7: 闭合段落
        'Final para', // 8: 段落开放
      ];

      // 第一次推 3 行
      const r1 = parser.push(lines.slice(0, 3).join('\n'));
      expect(r1.blockCount).toBe(1);
      expect(r1.finalizedBlocks[0]!.type).toBe('h1');
      expect(r1.tailBlock).not.toBeNull();
      expect(r1.tailBlock!.type).toBe('p');
      expect(r1.tailBlock!.html).toContain('Para line 1');

      // 第二次推到 6 行
      const r2 = parser.push(lines.slice(0, 6).join('\n'));
      expect(r2.blockCount).toBe(2);
      expect(r2.finalizedBlocks[0]).toBe(r1.finalizedBlocks[0]); // 同一引用（缓存命中）
      expect(r2.finalizedBlocks[1]!.type).toBe('p');
      expect(r2.finalizedBlocks[1]!.html).toContain('Para line 1');
      expect(r2.finalizedBlocks[1]!.html).toContain('Para line 2');
      expect(r2.tailBlock).not.toBeNull();
      expect(r2.tailBlock!.type).toBe('ul');
      expect(r2.tailBlock!.html).toContain('list item');

      // 第三次推到 9 行（全部）
      const r3 = parser.push(lines.slice(0, 9).join('\n'));
      expect(r3.blockCount).toBeGreaterThanOrEqual(r2.blockCount);
      expect(r3.finalizedBlocks[0]).toBe(r1.finalizedBlocks[0]); // 仍是同一引用
      expect(r3.finalizedBlocks[1]).toBe(r2.finalizedBlocks[1]); // 仍是同一引用
      expect(r3.tailBlock).not.toBeNull();
      expect(r3.tailBlock!.type).toBe('p');
      expect(r3.tailBlock!.html).toContain('Final para');
    });

    it('blockCount 单调递增或保持（已闭合块不重解析）', () => {
      const parser = new IncrementalMarkdownParser();
      const full = ['# T1', '', 'P1', '', '# T2', '', 'P2', '', '# T3'].join(
        '\n'
      );

      let prevCount = 0;
      let last: IncrementalParseResult | null = null;
      for (let end = 1; end <= full.split('\n').length; end++) {
        const partial = full.split('\n').slice(0, end).join('\n');
        last = parser.push(partial);
        expect(last.blockCount).toBeGreaterThanOrEqual(prevCount);
        prevCount = last.blockCount;
      }
      // 最终一次性 push 应产出相同 blockCount
      const oneShot = new IncrementalMarkdownParser().push(full);
      expect(last!.blockCount).toBe(oneShot.blockCount);
    });
  });

  // ===========================================================================
  // 5. 边界情况
  // ===========================================================================
  describe('边界情况', () => {
    it('未闭合 fence：流式中间态 tailBlock 含 fence HTML', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('```js\nconst x = 1;\nconst y = 2;');

      // highlight.js 行级高亮：const 被 hljs-keyword span 包裹
      expect(r.finalizedBlocks).toHaveLength(0);
      expect(r.tailBlock).not.toBeNull();
      expect(r.tailBlock!.type).toBe('fence');
      expect(r.tailBlock!.html).toContain('md-code-block');
      expect(r.tailBlock!.html).toContain('hljs-keyword');
      expect(r.tailBlock!.html).toContain('const');
      expect(r.tailBlock!.html).toContain('x');
      expect(r.tailBlock!.html).toContain('y');
    });

    it('未闭合表格：仅 header + sep，无 row → tailBlock 含 table HTML', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('| H1 | H2 |\n| --- | --- |');

      expect(r.finalizedBlocks).toHaveLength(0);
      expect(r.tailBlock).not.toBeNull();
      expect(r.tailBlock!.type).toBe('table');
      expect(r.tailBlock!.html).toContain('<table');
      expect(r.tailBlock!.html).toContain('H1');
      expect(r.tailBlock!.html).toContain('H2');
    });

    it('未闭合段落：tailBlock 含 p HTML', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('Just a paragraph without closing');

      expect(r.finalizedBlocks).toHaveLength(0);
      expect(r.tailBlock).not.toBeNull();
      expect(r.tailBlock!.type).toBe('p');
      expect(r.tailBlock!.html).toContain('Just a paragraph');
    });

    it('空字符串 push：blockCount = 0, tailBlock = null', () => {
      const parser = new IncrementalMarkdownParser();
      const r = parser.push('');

      expect(r.blockCount).toBe(0);
      expect(r.finalizedBlocks).toHaveLength(0);
      expect(r.tailBlock).toBeNull();
    });

    it('reset() 后状态清空', () => {
      const parser = new IncrementalMarkdownParser();
      parser.push('# Heading\n\nParagraph\n\n- list item');

      // reset 清空所有状态
      parser.reset();

      const r = parser.push('');
      expect(r.blockCount).toBe(0);
      expect(r.finalizedBlocks).toHaveLength(0);
      expect(r.tailBlock).toBeNull();
    });

    it('dispose() 等价于 reset()', () => {
      const parser = new IncrementalMarkdownParser();
      parser.push('# Heading\n\n```js\ncode\n```');

      parser.dispose();

      const r = parser.push('');
      expect(r.blockCount).toBe(0);
      expect(r.tailBlock).toBeNull();
    });
  });

  // ===========================================================================
  // 6. 性能不变式
  // ===========================================================================
  describe('性能不变式', () => {
    it('push 同一文本 100 次：finalizedBlocks 数组长度恒定', () => {
      const parser = new IncrementalMarkdownParser();
      const text = 'Line 1\nLine 2\n\n# Heading';

      let last: IncrementalParseResult | null = null;
      for (let i = 0; i < 100; i++) {
        last = parser.push(text);
      }

      expect(last).not.toBeNull();
      // Line 1 + Line 2 段落 + # Heading 标题 = 2 个 finalized 块
      expect(last!.finalizedBlocks).toHaveLength(2);
      expect(last!.blockCount).toBe(2);
    });

    it('增量 push 仅处理新增行：与一次性 push 产出相同 blockCount', () => {
      const fullText = [
        '# Title',
        '',
        'First paragraph.',
        '',
        'Second paragraph.',
        '',
        '```js',
        'const x = 1;',
        '```',
        '',
        '- list item',
      ].join('\n');

      const chunks = [
        '# Title',
        '# Title\n\nFirst paragraph.',
        '# Title\n\nFirst paragraph.\n\nSecond paragraph.',
        '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\n```js\nconst x = 1;\n```',
        fullText,
      ];

      const incParser = new IncrementalMarkdownParser();
      let prevCount = 0;
      let incResult: IncrementalParseResult | null = null;
      for (const chunk of chunks) {
        incResult = incParser.push(chunk);
        expect(incResult.blockCount).toBeGreaterThanOrEqual(prevCount);
        prevCount = incResult.blockCount;
      }

      const oneShotParser = new IncrementalMarkdownParser();
      const oneShotResult = oneShotParser.push(fullText);

      expect(incResult!.blockCount).toBe(oneShotResult.blockCount);
    });
  });
});
