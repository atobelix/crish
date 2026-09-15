/**
 * InlineRuler 行内规则插件体系测试（R5-B：规则插件体系 InlineRuler）
 *
 * 覆盖面：
 * - ruler 单元语义：add/remove/priority 降序扫描/同名替换/start 元数据/
 *   全局注册表（register/unregister/版本号）；
 * - 自定义规则经 MarkdownParser 生效：@mention 注册/生效/移除恢复 +
 *   行缓存键按全局注册版本隔离（防跨注册版本串扰）；
 * - 自定义起止符规则经 ctx.recurse 递归解析内层（插件 API 深度演示）；
 * - 失败位图记忆与 ruler 共存：未闭合起止标记链不爆炸；
 * - 现有语法零回归矩阵：迁移（INLINE_RULES → ruler 初始注册）后
 *   各语法族 AST 与迁移前一致（type/content/url/isChecked/children 关键字段）。
 *
 * 纪律：全局注册的规则在 afterEach 统一移除，不污染其它测试文件；
 * 断言采用字段式（与 parser-syntax-matrix 同风格），兼容 undefined 字段。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { InlineRuler } from '../../src/core/InlineRuler';
import type { InlineRuleContext } from '../../src/core/InlineRuler';
import { MarkdownParser } from '../../src/core/parser';
import type { InlineNode } from '../../src/core/ast';

// —— 测试用空上下文（纯 ruler 单元测试不使用引擎环境） ——
const emptyCtx: InlineRuleContext<unknown> = {
  refDefs: null,
  recurse: () => null,
  failedAt: new Set(),
  noClose: new Map(),
};

// —— 本文件注册的全局规则名（afterEach 统一清理） ——
const registeredNames: string[] = [];

function registerGlobal(rule: Parameters<typeof InlineRuler.register>[0]): void {
  InlineRuler.register(rule);
  if (!registeredNames.includes(rule.name)) registeredNames.push(rule.name);
}

afterEach(() => {
  while (registeredNames.length > 0) {
    InlineRuler.unregister(registeredNames.pop()!);
  }
});

// —— 断言工具：行内 token 期望（字段式） ——
interface TokenExpect {
  type: string;
  content?: string;
  url?: string;
  isChecked?: boolean;
  children?: { type: string; content?: string }[];
}

const T = (type: string, o?: Omit<TokenExpect, 'type'>): TokenExpect => ({
  type,
  ...o,
});

function tokensOf(md: string): InlineNode[] {
  return MarkdownParser.parse(md).lines[0].inlineTokens;
}

/** 指定行的行内 token（行级块判定会让某些语法在其它行落位） */
function lineTokensOf(md: string, lineIdx: number): InlineNode[] {
  return MarkdownParser.parse(md).lines[lineIdx].inlineTokens;
}

function assertTokens(md: string, expected: TokenExpect[], ctx: string): void {
  const tokens = tokensOf(md);
  expect(tokens.length, `${ctx}：token 数`).toBe(expected.length);
  expected.forEach((exp, i) => {
    const t = tokens[i];
    expect(t.type, `${ctx}[${i}]：类型`).toBe(exp.type);
    if (exp.content !== undefined) {
      expect(t.content, `${ctx}[${i}]：content`).toBe(exp.content);
    }
    if (exp.url !== undefined) {
      expect(t.url, `${ctx}[${i}]：url`).toBe(exp.url);
    }
    if (exp.isChecked !== undefined) {
      expect(t.isChecked, `${ctx}[${i}]：isChecked`).toBe(exp.isChecked);
    }
    if (exp.children) {
      expect(t.children, `${ctx}[${i}]：children 存在`).toBeDefined();
      exp.children.forEach((c, j) => {
        expect(t.children![j].type, `${ctx}[${i}].children[${j}]：类型`).toBe(
          c.type
        );
        if (c.content !== undefined) {
          expect(
            t.children![j].content,
            `${ctx}[${i}].children[${j}]：content`
          ).toBe(c.content);
        }
      });
    }
  });
}

/** 覆盖守恒断言：行内 token 的 raw 按序拼接 == 行原文 */
function assertCoverage(md: string): void {
  const doc = MarkdownParser.parse(md);
  for (const line of doc.lines) {
    const joined = line.inlineTokens.map((t) => t.raw).join('');
    expect(joined, `覆盖守恒：${md} 行「${line.raw}」`).toBe(line.raw);
  }
}

// =====================================================================
// 1. ruler 单元语义（不经过 parser）
// =====================================================================

describe('InlineRuler 单元：add/remove/scan 优先级', () => {
  it('按 priority 降序尝试，首个命中返回（高优先级优先，即使后注册）', () => {
    const ruler = new InlineRuler();
    ruler.add({
      name: 'low',
      priority: 1,
      match: (t, p) =>
        t.startsWith('x', p)
          ? { type: 'low', raw: 'x', content: 'x', length: 1 }
          : null,
    });
    ruler.add({
      name: 'high',
      priority: 10,
      match: (t, p) =>
        t.startsWith('x', p)
          ? { type: 'high', raw: 'x', content: 'x', length: 1 }
          : null,
    });
    // high 后注册但 priority 更高 → 优先尝试
    expect(ruler.scan('xyz', 0, emptyCtx)!.type).toBe('high');
  });

  it('高优先级规则不命中时回落给低优先级', () => {
    const ruler = new InlineRuler();
    ruler.add({
      name: 'exact',
      priority: 10,
      match: (t, p) =>
        t.startsWith('yy', p)
          ? { type: 'exact', raw: 'yy', content: 'yy', length: 2 }
          : null,
    });
    ruler.add({
      name: 'single',
      priority: 1,
      match: (t, p) =>
        t.startsWith('y', p)
          ? { type: 'single', raw: 'y', content: 'y', length: 1 }
          : null,
    });
    // 位置 0 是 'yy'：exact 命中；位置 2 是 'z'：都不命中
    expect(ruler.scan('yy', 0, emptyCtx)!.type).toBe('exact');
    // 移除 exact 后 single 接管
    expect(ruler.remove('exact')).toBe(true);
    expect(ruler.scan('yy', 0, emptyCtx)!.type).toBe('single');
  });

  it('remove：未知名返回 false；全规则移除后 scan 返回 null', () => {
    const ruler = new InlineRuler();
    ruler.add({
      name: 'a',
      priority: 1,
      match: () => ({ type: 'a', raw: '', content: '', length: 0 }),
    });
    expect(ruler.remove('no_such_rule')).toBe(false);
    expect(ruler.remove('a')).toBe(true);
    expect(ruler.remove('a')).toBe(false);
    expect(ruler.scan('abc', 0, emptyCtx)).toBeNull();
  });

  it('同名 add 即替换（markdown-it at 语义），旧实现被顶掉', () => {
    const ruler = new InlineRuler();
    ruler.add({
      name: 'r',
      priority: 5,
      match: () => ({ type: 'v1', raw: 'x', content: 'x', length: 1 }),
    });
    ruler.add({
      name: 'r',
      priority: 5,
      match: () => ({ type: 'v2', raw: 'x', content: 'x', length: 1 }),
    });
    const m = ruler.scan('xx', 0, emptyCtx);
    expect(m!.type).toBe('v2');
    expect(ruler.remove('r')).toBe(true);
    expect(ruler.scan('xx', 0, emptyCtx)).toBeNull();
  });

  it('start 元数据：hasStartRule 精确匹配 / hasExactStart 按长度+首字符', () => {
    const ruler = new InlineRuler();
    ruler.add({
      name: 'bold',
      priority: 2,
      start: '**',
      match: () => null,
    });
    ruler.add({
      name: 'italic',
      priority: 1,
      start: '*',
      match: () => null,
    });
    expect(ruler.hasStartRule('**')).toBe(true);
    expect(ruler.hasStartRule('*')).toBe(true);
    expect(ruler.hasStartRule('***')).toBe(false);
    // 长度为 4 且首字符 '*' 的规则不存在（'****' 无精确规则接管）
    expect(ruler.hasExactStart(4, '*')).toBe(false);
    expect(ruler.hasExactStart(2, '*')).toBe(true);
    expect(ruler.hasExactStart(1, '*')).toBe(true);
    expect(ruler.hasExactStart(1, '_')).toBe(false);
  });
});

describe('InlineRuler 全局注册表（静态 register/unregister）', () => {
  it('register 后所有实例生效；unregister 恢复；同名 register 替换', () => {
    InlineRuler.register({
      name: 'grule',
      priority: 50,
      match: (t, p) =>
        t.startsWith('g', p)
          ? { type: 'g', raw: 'g', content: 'g', length: 1 }
          : null,
    });
    registeredNames.push('grule');
    const v1 = InlineRuler.getGlobalVersion();
    // 新实例也能扫到全局规则
    const ruler = new InlineRuler();
    expect(ruler.scan('go', 0, emptyCtx)!.type).toBe('g');
    // 同名替换：实例侧无需任何操作，编译缓存自动按版本失效
    InlineRuler.register({
      name: 'grule',
      priority: 50,
      match: (t, p) =>
        t.startsWith('g', p)
          ? { type: 'g2', raw: 'g', content: 'g', length: 1 }
          : null,
    });
    expect(InlineRuler.getGlobalVersion()).toBeGreaterThan(v1);
    expect(ruler.scan('go', 0, emptyCtx)!.type).toBe('g2');
    expect(InlineRuler.unregister('grule')).toBe(true);
    expect(InlineRuler.unregister('grule')).toBe(false);
    expect(ruler.scan('go', 0, emptyCtx)).toBeNull();
  });
});

// =====================================================================
// 2. 自定义 @mention 规则经 MarkdownParser 生效
// =====================================================================

describe('自定义 @mention 规则（InlineRuler.register + MarkdownParser）', () => {
  it('注册后 @mention 语法生效：type/content/raw/length 正确', () => {
    registerGlobal({
      name: 'mention',
      // 高于全部内置规则（34..1）：@ 前缀不会被其它规则抢占
      priority: 100,
      match: (text, pos) => {
        const m = /^@([A-Za-z0-9_]{1,50})\b/.exec(text.slice(pos));
        if (!m || m.index !== 0) return null;
        return {
          type: 'mention',
          raw: m[0],
          content: m[1],
          length: m[0].length,
        };
      },
    });
    assertTokens('Hello @alice and @bob!', [
      T('text', { content: 'Hello ' }),
      T('mention', { content: 'alice' }),
      T('text', { content: ' and ' }),
      T('mention', { content: 'bob' }),
      T('text', { content: '!' }),
    ], '@mention 多实例');
    const t = tokensOf('hi @alice')[1];
    expect(t.raw).toBe('@alice');
    expect(t.length).toBe(6);
    assertCoverage('Hello @alice and @bob!');
  });

  it('unregister 后恢复默认解析（同文本不再产出 mention）', () => {
    // 注册→解析→移除→解析：同一文本三轮，AST 随注册状态正确变化
    const md = 'hi @alice';
    // 未注册时整行回退为单个 text token（无规则边界，flush 只发生在命中时）
    const before = tokensOf(md).map((t) => t.type);
    expect(before).toEqual(['text']);

    registerGlobal({
      name: 'mention2',
      priority: 100,
      match: (text, pos) => {
        const m = /^@([A-Za-z0-9_]{1,50})\b/.exec(text.slice(pos));
        if (!m || m.index !== 0) return null;
        return {
          type: 'mention',
          raw: m[0],
          content: m[1],
          length: m[0].length,
        };
      },
    });
    expect(tokensOf(md).map((t) => t.type)).toEqual(['text', 'mention']);

    InlineRuler.unregister('mention2');
    const idx = registeredNames.indexOf('mention2');
    if (idx !== -1) registeredNames.splice(idx, 1);
    expect(tokensOf(md).map((t) => t.type)).toEqual(['text']);
  });

  it('自定义规则与内置规则共存：mention 旁的内置语法照常解析', () => {
    registerGlobal({
      name: 'mention3',
      priority: 100,
      match: (text, pos) => {
        const m = /^@([A-Za-z0-9_]{1,50})\b/.exec(text.slice(pos));
        if (!m || m.index !== 0) return null;
        return {
          type: 'mention',
          raw: m[0],
          content: m[1],
          length: m[0].length,
        };
      },
    });
    // **bold** + @mention + code span 同段共存
    assertTokens('**b** @u `c`', [
      T('bold', { content: 'b' }),
      T('text', { content: ' ' }),
      T('mention', { content: 'u' }),
      T('text', { content: ' ' }),
      T('code', { content: 'c' }),
    ], '共存段落');
    // 原子上下文内不解析 mention（code span 内 @x 保持字面）
    assertTokens('`@x`', [
      T('code', { content: '@x' }),
    ], 'code span 内不解析');
    assertCoverage('**b** @u `c`\n`@x`');
  });

  it('行缓存键按全局注册版本隔离：注册/移除后同文本解析不串扰', () => {
    // 首次解析（未注册）写入缓存 → 注册后同文本必须重新解析
    const md = 'hi @alice';
    expect(tokensOf(md).map((t) => t.type)).toEqual(['text']);
    registerGlobal({
      name: 'mention4',
      priority: 100,
      match: (text, pos) => {
        const m = /^@([A-Za-z0-9_]{1,50})\b/.exec(text.slice(pos));
        if (!m || m.index !== 0) return null;
        return {
          type: 'mention',
          raw: m[0],
          content: m[1],
          length: m[0].length,
        };
      },
    });
    // 若不进缓存键会命中「未注册」时的行缓存，产出错误 text token
    expect(tokensOf(md).map((t) => t.type)).toEqual(['text', 'mention']);
  });
});

// =====================================================================
// 3. 自定义起止符规则经 ctx.recurse 递归解析（插件 API 深度）
// =====================================================================

describe('自定义起止符规则（ctx.recurse 递归解析内层）', () => {
  const exclaimRule: Parameters<typeof InlineRuler.register>[0] = {
    name: 'exclaim',
    priority: 100,
    start: '!!',
    match: (text, pos, ctx) => {
      if (!text.startsWith('!!', pos)) return null;
      const res = ctx.recurse('!!', '!!', 'mark', pos);
      if (!res) return null;
      return {
        type: 'exclaim',
        raw: text.substring(pos, pos + res.length),
        content: text.substring(pos + 2, pos + res.length - 2),
        children: res.tokens,
        length: res.length,
      };
    },
  };

  it('起止符消费 + 内层按完整规则集解析（嵌套 italic）', () => {
    registerGlobal(exclaimRule);
    assertTokens('say !!ok *yes*!! done', [
      T('text', { content: 'say ' }),
      T('exclaim', {
        content: 'ok *yes*',
        children: [
          { type: 'text', content: 'ok ' },
          { type: 'italic', content: 'yes' },
        ],
      }),
      T('text', { content: ' done' }),
    ], '嵌套内层');
    assertCoverage('say !!ok *yes*!! done');
  });

  it('内层未闭合：整体回退文本（失败位图记忆共存，不爆炸）', () => {
    registerGlobal(exclaimRule);
    assertTokens('!!oops', [T('text', { content: '!!oops' })], '未闭合回退');
    // 同文本重复解析结果一致（失败记忆按调用隔离，不跨解析串扰）
    expect(tokensOf('!!oops').map((t) => t.type)).toEqual(['text']);
    // 未闭合起止符链（N 个开符无闭合）：解析快速完成且无残留结构
    const chain = '!!'.repeat(3000) + 'z';
    const start = performance.now();
    const doc = MarkdownParser.parse(chain);
    const duration = performance.now() - start;
    expect(duration, `未闭合链解析耗时 ${duration.toFixed(1)}ms 超预算`).toBeLessThan(200);
    expect(doc.lines[0].inlineTokens.length).toBeGreaterThan(0);
    assertCoverage(chain);
  });
});

// =====================================================================
// 4. 现有语法零回归矩阵（迁移后 AST 与迁移前一致）
// =====================================================================

describe('迁移零回归：现有语法 AST 断言矩阵', () => {
  interface MatrixCase extends TokenExpect {
    name: string;
    md: string;
    tokens: TokenExpect[];
    /** 断言的行号（缺省 0；引用链接等在定义行之后落位） */
    line?: number;
  }

  const CASES: MatrixCase[] = [
    // —— 强调族（* / _） ——
    { name: '加粗', md: '**bold**', tokens: [T('bold', { content: 'bold' })] },
    { name: '斜体', md: '*em*', tokens: [T('italic', { content: 'em' })] },
    { name: '粗斜体', md: '***bi***', tokens: [T('bold_italic', { content: 'bi' })] },
    { name: '_ 族加粗', md: '__b__', tokens: [T('bold', { content: 'b' })] },
    { name: '_ 族斜体', md: '_i_', tokens: [T('italic', { content: 'i' })] },
    { name: '_ 族词内不解析', md: 'foo_bar_baz', tokens: [T('text', { content: 'foo_bar_baz' })] },
    { name: '* 族词内保持解析', md: 'foo*bar*baz', tokens: [
      T('text', { content: 'foo' }),
      T('italic', { content: 'bar' }),
      T('text', { content: 'baz' }),
    ] },
    { name: '嵌套强调', md: '**bold *em* **', tokens: [T('bold', {
      content: 'bold *em* ',
      children: [
        { type: 'text', content: 'bold ' },
        { type: 'italic', content: 'em' },
        { type: 'text', content: ' ' },
      ],
    })] },
    { name: '未闭合强调回退文本', md: '**bold', tokens: [T('text', { content: '**bold' })] },
    // —— code span / 转义 / 实体 ——
    { name: 'code span', md: '`code`', tokens: [T('code', { content: 'code' })] },
    { name: '转义标点', md: '\\*esc\\*', tokens: [T('text', { content: '*esc*' })] },
    { name: '命名实体解码', md: '&amp;', tokens: [T('text', { content: '&' })] },
    // —— 链接 / 图片 / 自动链接 / 引用 ——
    { name: '内联链接', md: '[link](https://a.b)', tokens: [T('link', { content: 'link', url: 'https://a.b' })] },
    { name: '内联链接优先于 checkbox', md: '[x](https://a.b)', tokens: [T('link', { content: 'x', url: 'https://a.b' })] },
    { name: '图片', md: '![alt](img.png)', tokens: [T('image', { content: 'alt', url: 'img.png' })] },
    { name: 'URI 自动链接', md: '<https://x.com>', tokens: [T('link', { content: 'https://x.com', url: 'https://x.com' })] },
    { name: '邮件自动链接', md: '<a@b.com>', tokens: [T('link', { content: 'a@b.com', url: 'mailto:a@b.com' })] },
    { name: '引用链接', md: '[foo]: /url\n\n[foo]', tokens: [T('link', { content: 'foo', url: '/url' })], line: 2 },
    // —— checkbox / footnote ——
    { name: 'checkbox 勾选', md: 'a [x] b', tokens: [
      T('text', { content: 'a ' }),
      T('checkbox', { content: '', isChecked: true }),
      T('text', { content: ' b' }),
    ] },
    { name: 'checkbox 未勾选', md: 'a [ ] b', tokens: [
      T('text', { content: 'a ' }),
      T('checkbox', { content: '', isChecked: false }),
      T('text', { content: ' b' }),
    ] },
    { name: 'footnote', md: '[^1] note', tokens: [
      T('footnote', { content: '1' }),
      T('text', { content: ' note' }),
    ] },
    // —— 删除线 / 高亮 / 剧透 / 上下标 ——
    { name: '删除线', md: '~~del~~', tokens: [T('strike', { content: 'del' })] },
    { name: '高亮', md: '==hl==', tokens: [T('mark', { content: 'hl' })] },
    { name: '剧透（标题行内，行级表格启发式会让裸 || 行变 table）', md: '### ||sp||', tokens: [
      T('heading_prefix'),
      T('spoiler', { content: 'sp' }),
    ] },
    { name: '下标波浪', md: 'x~sub~', tokens: [T('text', { content: 'x' }), T('sub', { content: 'sub' })] },
    { name: '上标尖号', md: 'x^sup^', tokens: [T('text', { content: 'x' }), T('sup', { content: 'sup' })] },
    // —— 数学 ——
    { name: '行内数学', md: '$a$', tokens: [T('math', { content: 'a' })] },
    { name: '块级数学', md: '$$a$$', tokens: [T('math', { content: 'a' })] },
    // —— HTML ——
    { name: 'HTML 元素（含子 token）', md: '<b>hi</b>', tokens: [T('html_element', {
      children: [{ type: 'text', content: 'hi' }],
    })] },
    { name: '<u> 非 sub（raw HTML 语义）', md: '<u>x</u>', tokens: [T('html_element', {
      children: [{ type: 'text', content: 'x' }],
    })] },
    { name: 'HTML 自闭合标签', md: 'a<br>b', tokens: [
      T('text', { content: 'a' }),
      T('html_tag'),
      T('text', { content: 'b' }),
    ] },
    { name: '孤立 HTML 标签（行中，行首会触发块级 html_block）', md: 'a<div>b', tokens: [
      T('text', { content: 'a' }),
      T('html_tag'),
      T('text', { content: 'b' }),
    ] },
    // —— 表格管道 ——
    { name: '表格管道', md: 'a | b', tokens: [
      T('text', { content: 'a ' }),
      T('table_pipe'),
      T('text', { content: ' b' }),
    ] },
  ];

  for (const c of CASES) {
    it(`零回归：${c.name}`, () => {
      const tokens = c.line ? lineTokensOf(c.md, c.line) : tokensOf(c.md);
      expect(tokens.length, `${c.name}：token 数`).toBe(c.tokens.length);
      c.tokens.forEach((exp, i) => {
        const t = tokens[i];
        expect(t.type, `${c.name}[${i}]：类型`).toBe(exp.type);
        if (exp.content !== undefined) {
          expect(t.content, `${c.name}[${i}]：content`).toBe(exp.content);
        }
        if (exp.url !== undefined) {
          expect(t.url, `${c.name}[${i}]：url`).toBe(exp.url);
        }
        if (exp.isChecked !== undefined) {
          expect(t.isChecked, `${c.name}[${i}]：isChecked`).toBe(exp.isChecked);
        }
        if (exp.children) {
          expect(t.children, `${c.name}[${i}]：children 存在`).toBeDefined();
          exp.children.forEach((c2, j) => {
            expect(t.children![j].type, `${c.name}[${i}].children[${j}]：类型`).toBe(c2.type);
            if (c2.content !== undefined) {
              expect(t.children![j].content, `${c.name}[${i}].children[${j}]：content`).toBe(c2.content);
            }
          });
        }
      });
    });
  }

  it('覆盖守恒：矩阵文档集逐行 raw 拼接 == 原文', () => {
    for (const c of CASES) {
      assertCoverage(c.md);
    }
  });
});
