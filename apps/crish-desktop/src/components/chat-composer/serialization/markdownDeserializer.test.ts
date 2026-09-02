/**
 * apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.test.ts
 * 反序列化器输出契约测试（composer schema 收敛，SSOT）：
 * parseFromMarkdown 输出恒为 composer 行内 schema 形状——严禁出现 heading /
 * bulletList / orderedList / listItem / taskList / taskItem / blockquote /
 * horizontalRule 节点（schema 已禁用，出现即 setContent 抛错 → 水合静默丢失）。
 * 块级结构降维为段落并原样保留标记文本；codeBlock 与行内 mark 保真。
 */
import { describe, expect, it } from 'vitest';
import { parseFromMarkdown } from './markdownDeserializer';

/** composer schema 禁用的块级节点（与 TiptapEditorExtensions StarterKit 配置同源） */
const FORBIDDEN_BLOCK_TYPES = [
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'horizontalRule',
];

function collectTypes(node: unknown, acc: Set<string> = new Set()): Set<string> {
  const n = node as { type?: string; content?: unknown[] } | null;
  if (!n) return acc;
  if (n.type) acc.add(n.type);
  for (const child of n.content ?? []) collectTypes(child, acc);
  return acc;
}

/** 按段落序拼接文本（段内 text 节点顺序连接，段落间以换行分隔） */
function docText(node: unknown, acc: string[] = []): string[] {
  const n = node as { type?: string; text?: string; content?: unknown[] } | null;
  if (!n) return acc;
  if (n.type === 'paragraph' || n.type === 'doc') {
    for (const child of n.content ?? []) docText(child, acc);
    if (n.type === 'paragraph') acc.push('\n');
    return acc;
  }
  if (n.type === 'hardBreak') {
    acc.push('\n');
    return acc;
  }
  if (n.type === 'text' && typeof n.text === 'string') acc.push(n.text);
  if (n.type === 'codeBlock') acc.push('\n');
  for (const child of n.content ?? []) docText(child, acc);
  return acc;
}

function expectText(doc: unknown, needle: string): void {
  const joined = docText(doc).join('');
  expect(joined).toContain(needle);
}

describe('markdownDeserializer composer schema 契约', () => {
  it('工作流模板（slash + 列表 + 占位符）全部降维为段落，标记文本保真', () => {
    const template = [
      '/schedule 请帮我创建一个定时任务：',
      '- 任务目标：[描述希望定时执行的任务，例如：每日代码体检 / PR 总结]',
      '- 执行周期：[例如：每天 09:00 / 每 30 分钟 / 0 9 * * *]',
      '- 所属项目：[例如：当前项目 / 全局]',
      '- 具体指令：[每次触发时希望 Agent 执行的具体操作]',
    ].join('\n');
    const doc = parseFromMarkdown(template);
    const types = collectTypes(doc);
    for (const t of FORBIDDEN_BLOCK_TYPES) expect(types.has(t)).toBe(false);
    expectText(doc, '- 任务目标：[描述希望定时执行的任务，例如：每日代码体检 / PR 总结]');
    expectText(doc, '- 执行周期：[例如：每天 09:00 / 每 30 分钟 / 0 9 * * *]');
  });

  it('任务列表降维：- [ ] / - [x] 标记保真', () => {
    const doc = parseFromMarkdown('- [ ] 未完成项\n- [x] 已完成项');
    const types = collectTypes(doc);
    expect(types.has('taskList')).toBe(false);
    expect(types.has('taskItem')).toBe(false);
    expectText(doc, '- [ ] 未完成项');
    expectText(doc, '- [x] 已完成项');
  });

  it('有序列表降维：序号保真且延续起始号', () => {
    const doc = parseFromMarkdown('3. 第三项\n4. 第四项');
    const types = collectTypes(doc);
    expect(types.has('orderedList')).toBe(false);
    expect(types.has('listItem')).toBe(false);
    expectText(doc, '3. 第三项');
    expectText(doc, '4. 第四项');
  });

  it('标题降维：# 标记文本保留', () => {
    const doc = parseFromMarkdown('## 二级标题');
    const types = collectTypes(doc);
    expect(types.has('heading')).toBe(false);
    expectText(doc, '## 二级标题');
  });

  it('引用降维：> 前缀保留，多行引用经 hardBreak 折入单段', () => {
    const doc = parseFromMarkdown('> 第一行\n> 第二行');
    const types = collectTypes(doc);
    expect(types.has('blockquote')).toBe(false);
    // 降维契约：仅段首保留 '> ' 前缀；内层多行以 hardBreak 折入同一段落
    expectText(doc, '> 第一行\n第二行');
  });

  it('裸星号序列（cron 表达式）不误判斜体、星号文本零丢失（CommonMark 左侧翼）', () => {
    const doc = parseFromMarkdown('- 执行周期：[例如：每天 09:00 / 每 30 分钟 / 0 9 * * *]');
    expectText(doc, '- 执行周期：[例如：每天 09:00 / 每 30 分钟 / 0 9 * * *]');
  });

  it('水平分割线降维：原样保留 --- 文本段落', () => {
    const doc = parseFromMarkdown('上一段\n\n---\n\n下一段');
    const types = collectTypes(doc);
    expect(types.has('horizontalRule')).toBe(false);
    expect(JSON.stringify(doc)).toContain('---');
  });

  it('codeBlock 保真（schema 允许的块级节点）', () => {
    const doc = parseFromMarkdown('```rust\nfn main() {}\n```');
    const types = collectTypes(doc);
    expect(types.has('codeBlock')).toBe(true);
    expect(JSON.stringify(doc)).toContain('fn main() {}');
  });

  it('行内 mark（加粗/行内代码）保真', () => {
    const doc = parseFromMarkdown('**加粗** 与 `code` 混排');
    const types = collectTypes(doc);
    expect(types.has('text')).toBe(true);
    const text = JSON.stringify(doc);
    expect(text).toContain('bold');
    expect(text).toContain('code');
  });

  it('往返稳定：段落文本再解析不产生结构漂移', () => {
    const first = parseFromMarkdown('- 项目一：[描述]\n- 项目二：[描述]');
    expect(collectTypes(first).has('bulletList')).toBe(false);
    // 序列化输出中段落行以 "- " 开头；再次解析应得到等价的纯段落文档
    const line = (first.content?.[1] as { content?: Array<{ text?: string }> })
      ?.content?.[0]?.text;
    expect(line).toBe('- ');
  });
});
