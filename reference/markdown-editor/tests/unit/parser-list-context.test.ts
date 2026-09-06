import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

/**
 * R1.5-B：parser 列表上下文（空行后列表项延续 / li 内代码块 / 出列表）
 *
 * 语义基准（CommonMark §5.2 与 spec 用例）：
 * - 例 255：`- one\n\n two`（缩进 1 < 内容缩进 2）→ 出列表，普通段落；
 * - 例 256：`- one\n\n  two`（缩进 2 ≥ 内容缩进 2）→ 同一 li 的第二个段落
 *   （listContinuation 标志 + listIndent = 列表缩进，AST 层与普通 body 区分）；
 * - 例 257：` -    one\n\n     two`（缩进 5 < 内容缩进 6）→ 出列表且 ≥4 列
 *   缩进按缩进代码块处理（`<pre><code> two`）；
 * - 例 258：` -    one\n\n      two`（缩进 6 ≥ 内容缩进 6）→ 同 li 第二段；
 * - 例 264/270/271：缩进 ≥ 内容缩进 + 4 → li 内缩进代码块（indent_code，
 *   块内空行保持状态）；
 * - 例 273/274（规范规则 #2）：首块为缩进代码的列表项内容缩进 = W + 1；
 * - 例 276：`-    foo\n\n  bar`（2 < 内容缩进 5）→ 出列表；
 * - 例 277：`-  foo\n\n   bar`（3 ≥ 内容缩进 3）→ 同 li；
 * - 紧邻延续（R1-A2b：`- one\n  two`）语义保持不变（不标 listContinuation）。
 */
describe('R1.5-B parser 列表上下文（空行后列表项延续）', () => {
  it('例 255：空行后缩进 < 内容缩进 → 出列表（普通 body，无延续标志）', () => {
    const doc = MarkdownParser.parse('- one\n\n two');
    expect(doc.lines[0].listPrefix).toBe('-');
    expect(doc.lines[0].listIndent).toBe(0);
    expect(doc.lines[1].type).toBe('empty');
    expect(doc.lines[2].type).toBe('body');
    expect(doc.lines[2].listContinuation).toBeUndefined();
  });

  it('例 256：空行后缩进 ≥ 内容缩进 → 同一 li 的第二个段落（AST 层区分）', () => {
    const doc = MarkdownParser.parse('- one\n\n  two');
    expect(doc.lines[2].type).toBe('body');
    expect(doc.lines[2].listContinuation).toBe(true);
    expect(doc.lines[2].listIndent).toBe(0);
    expect(doc.lines[2].listPrefix).toBeUndefined();
  });

  it('例 256 vs 255：相同文本行在不同上下文产出不同节点（缓存键隔离）', () => {
    // 先解析带列表上下文的文档（`  two` 被标记为延续），再解析无列表文档——
    // 行级缓存不得把延续标志串扰到普通段落（同文本不同上下文必须异键）。
    MarkdownParser.parse('- one\n\n  two');
    const plain = MarkdownParser.parse('foo\n\n  two');
    expect(plain.lines[2].type).toBe('body');
    expect(plain.lines[2].listContinuation).toBeUndefined();
  });

  it('例 257：出列表且缩进 ≥4 → 缩进代码块（`<pre><code> two`）', () => {
    const doc = MarkdownParser.parse(' -    one\n\n     two');
    expect(doc.lines[0].listIndent).toBe(1);
    expect(doc.lines[2].type).toBe('code');
  });

  it('例 258：标记后 4 空格的列表项内容缩进为 6（含前导缩进 1）', () => {
    const doc = MarkdownParser.parse(' -    one\n\n      two');
    expect(doc.lines[2].listContinuation).toBe(true);
    expect(doc.lines[2].listIndent).toBe(1);
  });

  it('例 262：两个空行后缩进 ≥ 内容缩进仍是同一 li 的延续', () => {
    const doc = MarkdownParser.parse('- foo\n\n\n  bar');
    expect(doc.lines[3].listContinuation).toBe(true);
    expect(doc.lines[3].listIndent).toBe(0);
  });

  it('例 264：缩进 ≥ 内容缩进 + 4 → li 内缩进代码块，块内空行保持状态', () => {
    const doc = MarkdownParser.parse('- Foo\n\n      bar\n\n\n      baz');
    expect(doc.lines[0].listPrefix).toBe('-');
    expect(doc.lines[2].type).toBe('code');
    // 代码块内空行保持 indent_code 状态（块内空行也是代码块的一部分）
    expect(doc.lines[3].type).toBe('code');
    expect(doc.lines[4].type).toBe('code');
    expect(doc.lines[5].type).toBe('code');
  });

  it('例 265：长序号列表标记（9 位）', () => {
    const doc = MarkdownParser.parse('123456789. ok');
    expect(doc.lines[0].type).toBe('body');
    expect(doc.lines[0].listPrefix).toBe('123456789.');
    expect(doc.lines[0].listIndent).toBe(0);
  });

  it('例 270：`- foo` 后 6 空格 → li 内缩进代码块候选', () => {
    const doc = MarkdownParser.parse('- foo\n\n      bar');
    expect(doc.lines[2].type).toBe('code');
  });

  it('例 271：`  10.  foo` 内容缩进 7，11 空格 → li 内缩进代码块候选', () => {
    const doc = MarkdownParser.parse('  10.  foo\n\n           bar');
    expect(doc.lines[0].listIndent).toBe(2);
    expect(doc.lines[2].type).toBe('code');
  });

  it('例 273（规则 #2）：首块为缩进代码的列表项内容缩进 = W + 1', () => {
    const doc = MarkdownParser.parse(
      '1.     indented code\n\n   paragraph\n\n       more code'
    );
    // `   paragraph`（3 列 = W+1）仍是列表项延续
    expect(doc.lines[2].listContinuation).toBe(true);
    // `       more code`（7 列 = W+1+4）是 li 内缩进代码块
    expect(doc.lines[4].type).toBe('code');
  });

  it('例 276：`-    foo` 内容缩进 5，2 空格不足 → 出列表', () => {
    const doc = MarkdownParser.parse('-    foo\n\n  bar');
    expect(doc.lines[2].type).toBe('body');
    expect(doc.lines[2].listContinuation).toBeUndefined();
  });

  it('例 277：`-  foo` 内容缩进 3，3 空格 → 同 li 延续', () => {
    const doc = MarkdownParser.parse('-  foo\n\n   bar');
    expect(doc.lines[2].listContinuation).toBe(true);
  });

  it('紧邻延续（R1-A2b）保持：`- one\n  two` 不标延续标志（投影器按段落合并）', () => {
    const doc = MarkdownParser.parse('- one\n  two');
    expect(doc.lines[1].type).toBe('body');
    expect(doc.lines[1].listContinuation).toBeUndefined();
  });

  it('嵌套列表标记更新列表上下文：延续以嵌套列表内容缩进为基准', () => {
    const doc = MarkdownParser.parse('- a\n\n    - b\n\n      c');
    expect(doc.lines[2].listIndent).toBe(4);
    expect(doc.lines[2].listPrefix).toBe('-');
    // `      c`（6 列 = 嵌套标记行缩进 4 + 内容缩进 2）→ 嵌套列表项延续
    expect(doc.lines[4].listContinuation).toBe(true);
    expect(doc.lines[4].listIndent).toBe(4);
  });

  it('空行后 hr 形态行不误标延续（块级形态优先）', () => {
    const doc = MarkdownParser.parse('- a\n\n  ---');
    expect(doc.lines[2].type).toBe('hr');
    expect(doc.lines[2].listContinuation).toBeUndefined();
  });

  it('列表项包含管道符或剧透（||Spoiler|| / |）时，严格保持列表语义不被误劫持为表格', () => {
    const doc = MarkdownParser.parse(
      '* KR 2.1：原生支持保密剧透行内遮罩 `||Spoiler||`，保障投屏分享零泄密。\n- [x] 任务项 | 备注 | 状态'
    );
    expect(doc.lines[0].type).toBe('body');
    expect(doc.lines[0].listPrefix).toBe('*');
    expect(doc.lines[0].inlineTokens?.[0].type).toBe('list_bullet');

    expect(doc.lines[1].type).toBe('body');
    expect(doc.lines[1].listPrefix).toBe('- [x]');
    expect(doc.lines[1].inlineTokens?.[0].type).toBe('list_task');
  });
});
