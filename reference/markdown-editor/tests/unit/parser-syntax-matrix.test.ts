/**
 * Parser 语法矩阵测试（R1-E：R1 正确性轮·测试矩阵固化）
 *
 * 表驱动结构：行 = 语法类型（25 族），列 = 正例 / 反例 / 边界。
 * 断言目标：AST 结构（行 type / headingLevel / blockquoteLevel /
 * 行内 token 类型与关键字段），而非 parser 内部实现——
 * 重构 parser 实现时只要语义不变，本矩阵即保持全绿。
 *
 * 矩阵口径（R1 轮引擎现状实测校准）：
 * - 覆盖 R1 全部新增能力：Setext 标题、缩进代码、自动链接、实体解码、
 *   引用链接、`_` 强调族围挡校验、链接目标校验、fence 边界、`<u>` 非 sub、
 *   HTML 块级；
 * - 覆盖既有核心：heading/hr/列表/任务/表格/引用/fence/math/HTML 元素/
 *   转义/强调族。
 */
import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';
import type { LineNode, InlineNode } from '../../src/core/ast';

// —— 断言 DSL：结构期望（行 / token 两级） ——

/** 行内 token 期望：type 必填，其余字段按需声明（undefined 即不断言） */
interface TokenExpect {
  type: string;
  content?: string;
  url?: string;
  tagName?: string;
  attributes?: Record<string, string>;
  isChecked?: boolean;
  children?: TokenExpect[];
}

/** 行期望：type 必填，可选 headingLevel / blockquoteLevel / 顶层 token 序列 */
interface RowExpect {
  type: string;
  headingLevel?: number;
  blockquoteLevel?: number;
  tokens?: TokenExpect[];
}

/** 矩阵单元格：一组 markdown 输入 + 期望 AST 结构 */
interface CellCase {
  md: string;
  rows: RowExpect[];
}

/** 矩阵行：语法族 × 正例/反例/边界三列 */
interface SyntaxMatrixRow {
  name: string;
  positive: CellCase;
  negative: CellCase;
  edge: CellCase;
}

/** 行内 token 期望构造器 */
const T = (
  type: string,
  opts?: Omit<TokenExpect, 'type'>
): TokenExpect => ({ type, ...opts });

/** 行期望构造器 */
const L = (
  type: string,
  opts?: Omit<RowExpect, 'type'>
): RowExpect => ({ type, ...opts });

/** 递归断言 token 结构（仅断言期望中声明的字段） */
function assertToken(actual: InlineNode, exp: TokenExpect, ctx: string): void {
  expect(actual.type, `${ctx}：token 类型`).toBe(exp.type);
  if (exp.content !== undefined) {
    expect(actual.content, `${ctx}：content`).toBe(exp.content);
  }
  if (exp.url !== undefined) {
    expect(actual.url, `${ctx}：url`).toBe(exp.url);
  }
  if (exp.tagName !== undefined) {
    expect(actual.tagName, `${ctx}：tagName`).toBe(exp.tagName);
  }
  if (exp.attributes !== undefined) {
    expect(actual.attributes, `${ctx}：attributes 存在`).toBeDefined();
    expect(actual.attributes, `${ctx}：attributes 值`).toEqual(exp.attributes);
  }
  if (exp.isChecked !== undefined) {
    expect(actual.isChecked, `${ctx}：isChecked`).toBe(exp.isChecked);
  }
  if (exp.children) {
    expect(actual.children, `${ctx}：children 存在`).toBeDefined();
    expect(actual.children!.length, `${ctx}：children 数量`).toBe(exp.children.length);
    exp.children.forEach((c, i) => {
      assertToken(actual.children![i], c, `${ctx}[${i}]`);
    });
  }
}

/** 断言整份文档的 AST 结构 */
function assertDoc(actual: LineNode[], expected: RowExpect[], ctx: string): void {
  expect(actual.length, `${ctx}：行数`).toBe(expected.length);
  expected.forEach((row, i) => {
    const line = actual[i];
    expect(line.type, `${ctx}：第 ${i} 行类型`).toBe(row.type);
    if (row.headingLevel !== undefined) {
      expect(line.headingLevel, `${ctx}：第 ${i} 行 headingLevel`).toBe(row.headingLevel);
    }
    if (row.blockquoteLevel !== undefined) {
      expect(line.blockquoteLevel, `${ctx}：第 ${i} 行 blockquoteLevel`).toBe(row.blockquoteLevel);
    }
    if (row.tokens) {
      expect(line.inlineTokens.length, `${ctx}：第 ${i} 行 token 数`).toBe(row.tokens.length);
      row.tokens.forEach((t, j) => {
        assertToken(line.inlineTokens[j], t, `${ctx}：第 ${i} 行 token[${j}]`);
      });
    }
  });
}

/** 执行一个矩阵单元格：parse 后按期望断言 */
function runCell(cell: CellCase, ctx: string): void {
  const doc = MarkdownParser.parse(cell.md);
  assertDoc(doc.lines, cell.rows, ctx);
}

// —— 语法矩阵：25 族 × 3 列（正例 / 反例 / 边界） ——
// 断言值均以 R1 轮引擎实测 AST 校准（探测脚本逐例核对后落定）。

const MATRIX: SyntaxMatrixRow[] = [
  {
    name: 'ATX 标题',
    positive: {
      md: '## H',
      rows: [
        L('heading', {
          headingLevel: 2,
          tokens: [T('heading_prefix'), T('text', { content: 'H' })],
        }),
      ],
    },
    negative: {
      // 井号后必须有空白：`#H` 是普通段落
      md: '#H',
      rows: [L('body', { tokens: [T('text', { content: '#H' })] })],
    },
    edge: {
      // 超过 6 个井号回退正文；恰好 6 个是合法最深标题
      md: '####### H\n###### H',
      rows: [
        L('body', { tokens: [T('text', { content: '####### H' })] }),
        L('heading', { headingLevel: 6, tokens: [T('heading_prefix'), T('text')] }),
      ],
    },
  },
  {
    name: 'Setext 标题（R1 新增）',
    positive: {
      // 上行为内容行（heading）、下划线行零输出（empty，raw 保留供守恒）
      md: 't\n===',
      rows: [
        L('heading', { headingLevel: 1, tokens: [T('text', { content: 't' })] }),
        L('empty'),
      ],
    },
    negative: {
      // 定义行后 `===` 是正文而非 Setext 下划线（spec 例 25 语义）
      md: '[foo]: /url\n===',
      rows: [
        L('empty'),
        L('body', { tokens: [T('text', { content: '===' })] }),
      ],
    },
    edge: {
      // 单个 `-` 也构成 level 2 下划线；`***` 是 hr 而非下划线（hr 优先）
      md: 'a\n-\n\ntext\n***',
      rows: [
        L('heading', { headingLevel: 2, tokens: [T('text', { content: 'a' })] }),
        L('empty'),
        L('empty'),
        L('body', { tokens: [T('text', { content: 'text' })] }),
        L('hr'),
      ],
    },
  },
  {
    name: '主题分隔线 hr',
    positive: {
      md: '---',
      rows: [L('hr')],
    },
    negative: {
      // 少于 3 个连字符不是分隔线
      md: '--',
      rows: [L('body', { tokens: [T('text', { content: '--' })] })],
    },
    edge: {
      // 星号/下划线同族分隔线；`- - -` 间隔形态也成立
      md: '***\n___\n- - -',
      rows: [L('hr'), L('hr'), L('hr')],
    },
  },
  {
    name: '列表（bullet / number）',
    positive: {
      md: '- a\n1. b',
      rows: [
        L('body', {
          tokens: [T('list_bullet'), T('text', { content: 'a' })],
        }),
        L('body', {
          tokens: [T('list_number'), T('text', { content: 'b' })],
        }),
      ],
    },
    negative: {
      // 括号有序列表不是列表语法（CommonMark 仅 `.`）
      md: '1) a',
      rows: [L('body', { tokens: [T('text', { content: '1) a' })] })],
    },
    edge: {
      // 嵌套缩进列表（第二级缩进由渲染层承担，AST 均产 list_bullet）
      md: '- a\n  - b',
      rows: [
        L('body', { tokens: [T('list_bullet'), T('text')] }),
        L('body', { tokens: [T('list_bullet'), T('text', { content: 'b' })] }),
      ],
    },
  },
  {
    name: '任务列表（R1 强化）',
    positive: {
      md: '- [x] done\n- [ ] todo',
      rows: [
        L('body', {
          tokens: [T('list_task', { isChecked: true }), T('text', { content: 'done' })],
        }),
        L('body', {
          tokens: [T('list_task', { isChecked: false }), T('text', { content: 'todo' })],
        }),
      ],
    },
    negative: {
      // 无任务文本时回退为 bullet + checkbox 组合
      md: '- [x]',
      rows: [
        L('body', {
          tokens: [T('list_bullet'), T('checkbox', { isChecked: true })],
        }),
      ],
    },
    edge: {
      // 大写 X 也识别为已勾选
      md: '- [X] caps',
      rows: [
        L('body', {
          tokens: [T('list_task', { isChecked: true }), T('text', { content: 'caps' })],
        }),
      ],
    },
  },
  {
    name: '表格（row / separator / 对齐）',
    positive: {
      md: '| a | b |\n| :-- | --: |\n| 1 | 2 |',
      rows: [
        L('table_row', {
          tokens: [
            T('table_pipe'),
            T('table_cell', { children: [T('text', { content: ' a ' })] }),
            T('table_pipe'),
            T('table_cell', { children: [T('text', { content: ' b ' })] }),
            T('table_pipe'),
          ],
        }),
        L('table_separator'),
        L('table_row'),
      ],
    },
    negative: {
      // 表头行不以 `|` 开头：首行按段落处理（分隔行独立成立）
      md: 'x | y\n- | -\n1 | 2',
      rows: [
        L('body', { tokens: [T('text'), T('table_pipe'), T('text')] }),
        L('table_separator'),
        L('body', { tokens: [T('text'), T('table_pipe'), T('text')] }),
      ],
    },
    edge: {
      // 单分隔行（无表头）也产出 table_separator
      md: '| --- | --- |',
      rows: [L('table_separator')],
    },
  },
  {
    name: '块引用（层级）',
    positive: {
      md: '> q\n> > deep',
      rows: [
        L('body', {
          blockquoteLevel: 1,
          tokens: [T('blockquote_prefix'), T('text', { content: 'q' })],
        }),
        L('body', {
          blockquoteLevel: 2,
          tokens: [T('blockquote_prefix'), T('text', { content: 'deep' })],
        }),
      ],
    },
    negative: {
      // 转义 `\>` 不是引用前缀
      md: '\\> q',
      rows: [L('body', { tokens: [T('text', { content: '> q' })] })],
    },
    edge: {
      // 连续引用行逐行独立产出前缀 token（不做段落合并）
      md: '> quote\n> cont',
      rows: [
        L('body', { blockquoteLevel: 1, tokens: [T('blockquote_prefix'), T('text')] }),
        L('body', { blockquoteLevel: 1, tokens: [T('blockquote_prefix'), T('text')] }),
      ],
    },
  },
  {
    name: '围栏代码（fence）',
    positive: {
      md: '```\na\n```',
      rows: [
        L('code_fence_start'),
        L('code', { tokens: [T('text', { content: 'a' })] }),
        L('code_fence_end'),
      ],
    },
    negative: {
      // 未闭合 fence：仅 start + code，无 end 行
      md: '```\na',
      rows: [L('code_fence_start'), L('code')],
    },
    edge: {
      // 波浪线 fence 同样成立；info 字符串随 start 行保留
      md: '~~~lang\nc\n~~~',
      rows: [
        L('code_fence_start'),
        L('code'),
        L('code_fence_end'),
      ],
    },
  },
  {
    name: 'fence 边界（3-in-4 / marker 校验，R1 新增）',
    positive: {
      // 3 反引号开头、4 反引号闭合：长度 ≥ 3 即可闭合
      md: '```\na\n````',
      rows: [
        L('code_fence_start'),
        L('code'),
        L('code_fence_end'),
      ],
    },
    negative: {
      // 3 反引号开头、2 反引号闭合：长度不足不闭合，保持 code 内
      md: '```\na\n``',
      rows: [L('code_fence_start'), L('code'), L('code')],
    },
    edge: {
      // marker 不同（反引号开、波浪线闭）不闭合
      md: '```\na\n~~~',
      rows: [L('code_fence_start'), L('code'), L('code')],
    },
  },
  {
    name: '缩进代码块（R1 新增）',
    positive: {
      md: '    a\n    b',
      rows: [L('code'), L('code')],
    },
    negative: {
      // 2 空格缩进不足 4 列，是普通段落
      md: '  a',
      rows: [L('body', { tokens: [T('text', { content: '  a' })] })],
    },
    edge: {
      // 8 空格行仍在代码块内，raw 保留完整原文（守恒）
      md: '    4 space\n       8 space',
      rows: [
        L('code', { tokens: [T('text', { content: '    4 space' })] }),
        L('code', { tokens: [T('text', { content: '       8 space' })] }),
      ],
    },
  },
  {
    name: '行内代码 span',
    positive: {
      md: '`c`',
      rows: [L('body', { tokens: [T('code', { content: 'c' })] })],
    },
    negative: {
      // 未闭合反引号按文本回退
      md: '`x',
      rows: [L('body', { tokens: [T('text', { content: '`x' })] })],
    },
    edge: {
      // 双反引号包裹含单个反引号的内容
      md: '``c`d``',
      rows: [L('body', { tokens: [T('code', { content: 'c`d' })] })],
    },
  },
  {
    name: '强调族（`*`）',
    positive: {
      md: '**b** *i* ***bi***',
      rows: [
        L('body', {
          tokens: [
            T('bold', { content: 'b', children: [T('text', { content: 'b' })] }),
            T('text', { content: ' ' }),
            T('italic', { content: 'i', children: [T('text', { content: 'i' })] }),
            T('text', { content: ' ' }),
            T('bold_italic', { content: 'bi', children: [T('text', { content: 'bi' })] }),
          ],
        }),
      ],
    },
    negative: {
      // 未闭合强调按文本回退
      md: '*a',
      rows: [L('body', { tokens: [T('text', { content: '*a' })] })],
    },
    edge: {
      // 嵌套：`*a **b** c*` 中内层加粗独立成 token
      md: '*a **b** c*',
      rows: [
        L('body', {
          tokens: [
            T('italic', {
              content: 'a **b** c',
              children: [
                T('text'),
                T('bold', { content: 'b', children: [T('text', { content: 'b' })] }),
                T('text'),
              ],
            }),
          ],
        }),
      ],
    },
  },
  {
    name: '强调族（`_`，R1 围挡校验）',
    positive: {
      md: '_i_ __b__ ___bi___',
      rows: [
        L('body', {
          tokens: [
            T('italic', { content: 'i', children: [T('text', { content: 'i' })] }),
            T('text', { content: ' ' }),
            T('bold', { content: 'b', children: [T('text', { content: 'b' })] }),
            T('text', { content: ' ' }),
            T('bold_italic', { content: 'bi', children: [T('text', { content: 'bi' })] }),
          ],
        }),
      ],
    },
    negative: {
      // 词内下划线不强调（`_` 族独有 intraword 限制）
      md: 'foo_bar_baz',
      rows: [L('body', { tokens: [T('text', { content: 'foo_bar_baz' })] })],
    },
    edge: {
      // 标点围挡可成立（前/后为标点或空白时允许）
      md: 'a _"foo"_',
      rows: [
        L('body', {
          tokens: [
            T('text', { content: 'a ' }),
            T('italic', { content: '"foo"', children: [T('text', { content: '"foo"' })] }),
          ],
        }),
      ],
    },
  },
  {
    name: 'strike / mark / spoiler / sub / sup',
    positive: {
      // 注意：正例整行不得含 `|`——行内出现未转义 `|` 会被表格行判定接管
      md: '~~s~~ ==m== ~sub~ ^sup^',
      rows: [
        L('body', {
          tokens: [
            T('strike', { content: 's', children: [T('text', { content: 's' })] }),
            T('text', { content: ' ' }),
            T('mark', { content: 'm', children: [T('text', { content: 'm' })] }),
            T('text', { content: ' ' }),
            T('sub', { content: 'sub' }),
            T('text', { content: ' ' }),
            T('sup', { content: 'sup' }),
          ],
        }),
      ],
    },
    negative: {
      // 未闭合均按文本回退
      md: '~~s ==m',
      rows: [L('body', { tokens: [T('text', { content: '~~s ==m' })] })],
    },
    edge: {
      // `||` 与表格判定共存：行含 `|` 时整行是 table_row，spoiler 落在单元格内
      md: 'x ||y||',
      rows: [
        L('table_row', {
          tokens: [
            T('table_cell', {
              children: [T('text', { content: 'x ' }), T('spoiler', { content: 'y' })],
            }),
          ],
        }),
      ],
    },
  },
  {
    name: '内联链接（label / 目标）',
    positive: {
      md: '[a](/ok) and [link [nested]](/u)',
      rows: [
        L('body', {
          tokens: [
            T('link', { content: 'a', url: '/ok' }),
            T('text', { content: ' and ' }),
            T('link', { content: 'link [nested]', url: '/u' }),
          ],
        }),
      ],
    },
    negative: {
      // 目标含未加尖括号的空白：校验失败整体回退文本
      md: '[a](bad url)',
      rows: [L('body', { tokens: [T('text', { content: '[a](bad url)' })] })],
    },
    edge: {
      // 尖括号目标允许空白；`[a]` 无目标回退文本（与邻近文本合并）
      md: '[a](<http://x y>) and [a]',
      rows: [
        L('body', {
          tokens: [
            T('link', { content: 'a', url: 'http://x y' }),
            T('text', { content: ' and [a]' }),
          ],
        }),
      ],
    },
  },
  {
    name: '链接目标校验（R1 新增）',
    positive: {
      // 目标内转义标点还原（`\*` → `*`、`\)` → `)`）
      md: '[a](\\*x\\))',
      rows: [L('body', { tokens: [T('link', { content: 'a', url: '*x)' })] })],
    },
    negative: {
      // 双 title 非法：整体回退文本
      md: '[a](/u "tit" "two")',
      rows: [L('body', { tokens: [T('text', { content: '[a](/u "tit" "two")' })] })],
    },
    edge: {
      // title 内实体解码（`&amp;` → `&`），随 url 字段输出
      md: '[a](/x "t &amp; t")',
      rows: [L('body', { tokens: [T('link', { content: 'a', url: '/x "t & t"' })] })],
    },
  },
  {
    name: '引用链接（R1 新增）',
    positive: {
      md: '[foo]: /url\n\n[foo]',
      rows: [
        L('empty'),
        L('empty'),
        L('body', { tokens: [T('link', { content: 'foo', url: '/url' })] }),
      ],
    },
    negative: {
      // 未定义引用：整体回退文本
      md: '[a][missing]',
      rows: [L('body', { tokens: [T('text', { content: '[a][missing]' })] })],
    },
    edge: {
      // 折叠式 `[foo][]` 与完整式 `[bar][foo]`；label 归一化（大小写+空白折叠）
      md: '[foo]: /url "t"\n\n[foo][] [BAR][foo]',
      rows: [
        L('empty'),
        L('empty'),
        L('body', {
          tokens: [
            T('link', { content: 'foo', url: '/url "t"' }),
            T('text', { content: ' ' }),
            T('link', { content: 'BAR', url: '/url "t"' }),
          ],
        }),
      ],
    },
  },
  {
    name: '自动链接（R1 新增）',
    positive: {
      md: '<http://example.com> <foo@bar.com> <mailto:foo@bar.com>',
      rows: [
        L('body', {
          tokens: [
            T('link', { content: 'http://example.com', url: 'http://example.com' }),
            T('text', { content: ' ' }),
            T('link', { content: 'foo@bar.com', url: 'mailto:foo@bar.com' }),
            T('text', { content: ' ' }),
            T('link', { content: 'mailto:foo@bar.com', url: 'mailto:foo@bar.com' }),
          ],
        }),
      ],
    },
    negative: {
      // scheme 过短（`m:` 仅 1 字符）、无 scheme 的裸域名均非自动链接
      md: '<m:abc> <www.example.com>',
      rows: [
        L('body', {
          tokens: [T('text', { content: '<m:abc> <www.example.com>' })],
        }),
      ],
    },
    edge: {
      // 自动链接与行内 HTML 元素相邻时各自正确接管（`<http://x>` 不再被 HTML 吞）
      md: '<http://x> <b>b</b>',
      rows: [
        L('body', {
          tokens: [
            T('link', { content: 'http://x', url: 'http://x' }),
            T('text', { content: ' ' }),
            T('html_element', { tagName: 'b', children: [T('text', { content: 'b' })] }),
          ],
        }),
      ],
    },
  },
  {
    name: '实体与字符引用（R1 新增）',
    positive: {
      md: '&amp; &#35; &#x22;',
      rows: [
        L('body', {
          tokens: [
            T('text', { content: '& # "' }),
          ],
        }),
      ],
    },
    negative: {
      // 无效实体（无分号 / 未知名）原样保留
      md: '&amp &ampx;',
      rows: [L('body', { tokens: [T('text', { content: '&amp &ampx;' })] })],
    },
    edge: {
      // code span 原子上下文内不解码（CommonMark：字面保留）
      md: '`&amp;`',
      rows: [L('body', { tokens: [T('code', { content: '&amp;' })] })],
    },
  },
  {
    name: '图片',
    positive: {
      md: '![alt](/img.png)',
      rows: [
        L('body', {
          tokens: [T('image', { content: '🖼️ alt', url: '/img.png' })],
        }),
      ],
    },
    negative: {
      // 未闭合图片语法按文本回退
      md: '![a',
      rows: [L('body', { tokens: [T('text', { content: '![a' })] })],
    },
    edge: {
      // 空 alt 使用默认占位文案；引用形式图片不支持（`!` 与邻近文本合并，
      // 仅 `[a][ref]` 被引用链接接管）
      md: '![](/img) ![a][ref]\n\n[ref]: /r',
      rows: [
        L('body', {
          tokens: [
            T('image', { content: '🖼️ 图片', url: '/img' }),
            T('text', { content: ' !' }),
            T('link', { content: 'a', url: '/r' }),
          ],
        }),
        L('empty'),
        L('empty'),
      ],
    },
  },
  {
    name: 'HTML 行内元素（`<u>` 非 sub，R1 修复）',
    positive: {
      md: '<u>x</u> <span style="color:red">r</span>',
      rows: [
        L('body', {
          tokens: [
            T('html_element', {
              content: 'x',
              tagName: 'u',
              children: [T('text', { content: 'x' })],
            }),
            T('text', { content: ' ' }),
            T('html_element', {
              content: 'r',
              tagName: 'span',
              attributes: { style: 'color:red' },
              children: [T('text', { content: 'r' })],
            }),
          ],
        }),
      ],
    },
    negative: {
      // `<u>` 必须按 raw HTML 透传（CommonMark 语义），严禁映射为 sub
      md: '<u>x</u>',
      rows: [
        L('body', {
          tokens: [
            T('html_element', { tagName: 'u', children: [T('text', { content: 'x' })] }),
          ],
        }),
      ],
    },
    edge: {
      // 特殊标签（sub/sup/kbd/ins）走编辑器扩展语义；未知标签仍为 html_element
      md: '<sub>s</sub> <ins>i</ins> <kbd>k</kbd> <tag>t</tag>',
      rows: [
        L('body', {
          tokens: [
            T('sub', { children: [T('text', { content: 's' })] }),
            T('text', { content: ' ' }),
            T('sub', { children: [T('text', { content: 'i' })] }),
            T('text', { content: ' ' }),
            T('kbd', { children: [T('text', { content: 'k' })] }),
            T('text', { content: ' ' }),
            T('html_element', { tagName: 'tag', children: [T('text', { content: 't' })] }),
          ],
        }),
      ],
    },
  },
  {
    name: 'HTML 块级（R1 新增）',
    positive: {
      md: '<div>\nraw\n</div>',
      rows: [L('html_block'), L('html_block'), L('html_block')],
    },
    negative: {
      // 行中出现的标签按行内元素处理（不升级为块）
      md: 'a <div>b</div> c',
      rows: [
        L('body', {
          tokens: [
            T('text', { content: 'a ' }),
            T('html_element', { tagName: 'div', children: [T('text', { content: 'b' })] }),
            T('text', { content: ' c' }),
          ],
        }),
      ],
    },
    edge: {
      // 注释块 / 声明块同样按 html_block 透传
      md: '<!-- c -->\n<!DOCTYPE html>',
      rows: [L('html_block'), L('html_block')],
    },
  },
  {
    name: '数学（行内 / 块式）',
    positive: {
      md: '$x$ $$y$$',
      rows: [
        L('body', {
          tokens: [
            T('math', { content: 'x' }),
            T('text', { content: ' ' }),
            T('math', { content: 'y' }),
          ],
        }),
      ],
    },
    negative: {
      // 内容两侧不能直接是空白 / 未闭合：按文本回退
      md: '$ x $ $$$',
      rows: [L('body', { tokens: [T('text', { content: '$ x $ $$$' })] })],
    },
    edge: {
      // 三重美元：拆为孤立 `$` + 内层 math
      md: '$$$x$$$',
      rows: [
        L('body', {
          tokens: [
            T('text', { content: '$' }),
            T('math', { content: 'x' }),
            T('text', { content: '$' }),
          ],
        }),
      ],
    },
  },
  {
    name: '反斜杠转义',
    positive: {
      // 可转义标点：反斜杠剥离，content 还原为字面标点
      md: '\\*not\\*',
      rows: [L('body', { tokens: [T('text', { content: '*not*' })] })],
    },
    negative: {
      // 非可转义字符（`\b`）：反斜杠原样保留
      md: '\\b',
      rows: [L('body', { tokens: [T('text', { content: '\\b' })] })],
    },
    edge: {
      // 转义反引号阻止 code span；raw 始终保留反斜杠原文（守恒）
      md: '\\` not code',
      rows: [L('body', { tokens: [T('text', { content: '` not code' })] })],
    },
  },
  {
    name: '脚注',
    positive: {
      md: '[^1] and [^A1]',
      rows: [
        L('body', {
          tokens: [
            T('footnote', { content: '1' }),
            T('text', { content: ' and ' }),
            T('footnote', { content: 'A1' }),
          ],
        }),
      ],
    },
    negative: {
      // 空标签 / 含空白标签均按文本回退
      md: '[^] [^a b]',
      rows: [L('body', { tokens: [T('text', { content: '[^] [^a b]' })] })],
    },
    edge: {
      // 未闭合方括号整体回退文本
      md: '[^1',
      rows: [L('body', { tokens: [T('text', { content: '[^1' })] })],
    },
  },
  {
    name: '空行与段落',
    positive: {
      md: 'x\n\ny',
      rows: [L('body'), L('empty'), L('body')],
    },
    negative: {
      // 连续两行普通文本：不合并段落（逐行 AST，渲染层负责段落感）
      md: 'a\nb',
      rows: [L('body', { tokens: [T('text', { content: 'a' })] }), L('body', { tokens: [T('text', { content: 'b' })] })],
    },
    edge: {
      // 引用定义不能打断段落：定义行混在段落中按普通文本处理
      md: 'line\n[foo]: /u\nnext',
      rows: [L('body'), L('body'), L('body')],
    },
  },
];

describe('Parser 语法矩阵（25 族 × 正例/反例/边界）', () => {
  for (const row of MATRIX) {
    it(`矩阵: ${row.name}`, () => {
      runCell(row.positive, `${row.name}（正例）`);
      runCell(row.negative, `${row.name}（反例）`);
      runCell(row.edge, `${row.name}（边界）`);
    });
  }
});

describe('Parser 语法矩阵（行级 token 覆盖守恒）', () => {
  // 全矩阵输入统一断言守恒不变量：每行顶层 token 的 raw 按序拼接 == 行 raw，
  // 文档各行 raw 拼接 == 输入原文（实体解码只发生在 content，raw 永不丢失）。
  const allMds = MATRIX.flatMap((row) => [
    row.positive.md,
    row.negative.md,
    row.edge.md,
  ]);

  it('矩阵全部 75 个输入满足守恒（拼接 == raw）', () => {
    for (const md of allMds) {
      const doc = MarkdownParser.parse(md);
      const joinedLines = doc.lines.map((l) => l.raw).join('\n');
      expect(joinedLines, `文档守恒违例：${JSON.stringify(md)}`).toBe(md);
      for (const line of doc.lines) {
        const joined = line.inlineTokens.map((t) => t.raw).join('');
        expect(joined, `行守恒违例：${JSON.stringify(md)} 第 ${line.localOffset} 行`).toBe(
          line.raw
        );
      }
    }
  });
});
