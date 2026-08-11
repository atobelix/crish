// tests/unit/table-stream-parse.test.ts
// 表格流式解析的 ground-truth 测试（W3-3 处置：由 _scratch-table-stream
// 探索文件转正——内容有价值：parseLine 表格行类型判定边界 + 流式 append
// 期间表格行类型一致性，其他既有测试未覆盖的「真实流式路径」断言）。
//
// 覆盖：
// 1. parseLine 表格行类型判定（node 纯函数路径，与 table-parser-ast
//    互补——本文件覆盖「管道数量/前导管道」边界，table-parser-ast 覆盖
//    「行内 token 结构」主路径）：
//    - `| a | b |`（前后管道齐全）→ table_row；
//    - `| --- | --- |` → table_separator；
//    - `a | b`（无前导管道、单管道）→ body（非表格）；
//    - `| a | b`（前导管道但仅 1 个管道）→ table_row；
// 2. 流式 append 期间表格行类型一致性（EditorStore.streamTail 路径）：
//    表头行落库后 streamTailCodeState 为 'none'、classifyLine 判
//    table_row；分隔行到达后三行类型 = [table_row, table_separator,
//    table_row]；flushStreamTail 后行数保持（尾段合并不丢行）。

import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';
import { createEditorStore } from '../../src/core/EditorStore';
import { classifyLine } from '../../src/core/HeightMap';

describe('表格流式解析 ground truth（parseLine 类型判定 + 流式 append 一致性）', () => {
  it('parseLine：`| a | b |`（前后管道齐全）→ table_row，单元格 token 结构完整', () => {
    const node = MarkdownParser.parseLine('| a | b |', 0, 'none');
    expect(node.type).toBe('table_row');
    const cells = node.inlineTokens?.filter((t) => t.type === 'table_cell');
    expect(cells).toHaveLength(2);
    // 单元格文本在 children[0]（text token，content 保留原空格）
    expect(cells![0].children?.[0].content).toBe(' a ');
    expect(cells![1].children?.[0].content).toBe(' b ');
  });

  it('parseLine：`| --- | --- |` → table_separator', () => {
    const node = MarkdownParser.parseLine('| --- | --- |', 0, 'none');
    expect(node.type).toBe('table_separator');
  });

  it('parseLine：`a | b`（无前导管道、单管道）→ body（非表格）', () => {
    const node = MarkdownParser.parseLine('a | b', 0, 'none');
    expect(node.type).toBe('body');
  });

  it('parseLine：`| a | b`（前导管道但仅 1 个管道）→ table_row', () => {
    const node = MarkdownParser.parseLine('| a | b', 0, 'none');
    expect(node.type).toBe('table_row');
  });

  it('流式 append：表头行落库后 streamTailCodeState 为 none，classifyLine 判 table_row', () => {
    const store = createEditorStore();
    store.getState().appendText('| a | b |');
    const s = store.getState();
    expect(s.getLine(0)).toBe('| a | b |');
    expect(s.getLineCount()).toBe(1);
    // 尾段状态：管道行应为 none（CodeState 无 table 态）
    expect(s.streamTailCodeState[0]).toBe('none');
    expect(classifyLine('| a | b |', 'none')).toBe('table_row');
  });

  it('流式 append：分隔行到达后三行类型一致（table_row / table_separator / table_row）', () => {
    const store = createEditorStore();
    store.getState().appendText('| a | b |');
    store.getState().appendText('\n| --- | --- |');
    store.getState().appendText('\n| 1 | 2 |');
    const s = store.getState();
    expect(s.getLineCount()).toBe(3);
    const types = [0, 1, 2].map(
      (i) =>
        MarkdownParser.parseLine(s.getLine(i), 0, s.streamTailCodeState[i]).type
    );
    expect(types).toEqual(['table_row', 'table_separator', 'table_row']);
  });

  it('流式 append：flushStreamTail 合并尾段不丢行（行数保持、streamTail 清空）', () => {
    const store = createEditorStore();
    store.getState().appendText('| a | b |\n| --- | --- |');
    store.getState().flushStreamTail();
    const s = store.getState();
    expect(s.getLineCount()).toBe(2);
    expect(s.streamTail.length).toBe(0);
  });
});
