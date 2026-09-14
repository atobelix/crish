// ============================================================
// 逐行派生共享单元 单元测试（战役 table-systemic-remediation · T4）
//
// 权威：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
//       docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-5）
//       不变量 I10：行解析 / 活动态 / 表格身份**只有一个派生入口**（旧路径与岛路径共用），
//                   禁止岛内二次实现行解析口径
//
// 覆盖：deriveLineDecorations 行范围查询 / deriveActiveState 三态（selection 优先于 active）/
//       deriveLineNode（table_row / table_separator / callout 上下文注入 / 偏移与长度回填）/
//       deriveLineUnit（活动态、搜索标记、tableId 经 resolveTableId 解析、lineTokens）/
//       previewHint（isStreamingTail=false 零预演路径、未闭合标记预演、代码语义行不预演、已闭合不预演）。
//
// 说明（与任务描述不符处，已按**实际实现**写断言）：`LineUnitInput` **没有** `tableId` 入参，
//   `deriveLineUnit` 恒调用 `resolveTableId(getLine, index)`（见 src/core/lineUnit.ts:152）。
// ============================================================
import { describe, expect, it } from 'vitest';
import { DecorationSet } from '../../src/core/DecorationSet';
import {
  deriveActiveState,
  deriveLineDecorations,
  deriveLineNode,
  deriveLineUnit,
  lineTokens,
  type LineUnitInput,
} from '../../src/core/lineUnit';
import { MarkdownParser } from '../../src/core/parser';
import { resolveTableId } from '../../src/core/tableIdentity';

/** 行内偏移一律落到 0 号 bucket 的装饰集（行范围查询语义与行号无关，足够驱动派生） */
function makeDecorations(): DecorationSet {
  return new DecorationSet({ findLineIndex: () => 0 });
}

/** deriveLineUnit 入参构造器（默认：非流式、无装饰、非代码行） */
function unitInput(over: Partial<LineUnitInput> & { lineText: string }): LineUnitInput {
  return {
    index: 0,
    offset: 0,
    isCode: 'none',
    decorations: makeDecorations(),
    rowDecorationVersion: 0,
    getLine: () => over.lineText,
    isStreamingTail: false,
    ...over,
  };
}

// ── deriveLineDecorations ───────────────────────────────────────────────────

describe('逐行派生 · deriveLineDecorations（行范围 = [offset, offset + 行长)）', () => {
  it('委托 DecorationSet.query：结果与直接 query 等价', () => {
    const ds = makeDecorations();
    ds.add(5, 10, 'selection');
    expect(deriveLineDecorations(ds, 0, 20)).toEqual(ds.query(0, 20));
    expect(deriveLineDecorations(ds, 0, 20)).toHaveLength(1);
  });

  it('空装饰集 → 空数组（非 null）', () => {
    const ds = makeDecorations();
    expect(deriveLineDecorations(ds, 0, 10)).toEqual([]);
  });

  it('不相交的装饰不进入行装饰集', () => {
    const ds = makeDecorations();
    ds.add(100, 110, 'selection');
    expect(deriveLineDecorations(ds, 0, 10)).toEqual([]);
    expect(deriveLineDecorations(ds, 100, 10)).toHaveLength(1);
  });

  it('零长度光标装饰（active）在行首偏移处命中该行', () => {
    const ds = makeDecorations();
    ds.add(4, 4, 'active');
    const line = deriveLineDecorations(ds, 0, 10);
    expect(line.map((d) => d.kind)).toEqual(['active']);
  });
});

// ── deriveActiveState ───────────────────────────────────────────────────────

describe('逐行派生 · deriveActiveState（三态 + 优先级）', () => {
  it('有 selection → { cursor: to, selStart: from, selEnd: to }', () => {
    expect(deriveActiveState([{ from: 3, to: 9, kind: 'selection' }])).toEqual({
      cursor: 9,
      selStart: 3,
      selEnd: 9,
    });
  });

  it('仅有 active（选区折叠光标）→ { cursor: from }', () => {
    expect(deriveActiveState([{ from: 7, to: 7, kind: 'active' }])).toEqual({ cursor: 7 });
  });

  it('selection 优先于 active（同时存在时取 selection）', () => {
    expect(
      deriveActiveState([
        { from: 1, to: 1, kind: 'active' },
        { from: 3, to: 9, kind: 'selection' },
      ])
    ).toEqual({ cursor: 9, selStart: 3, selEnd: 9 });
  });

  it('仅 search / custom 装饰 → null（非活动行）', () => {
    expect(deriveActiveState([{ from: 0, to: 5, kind: 'search' }])).toBeNull();
    expect(deriveActiveState([{ from: 0, to: 5, kind: 'custom' }])).toBeNull();
  });

  it('空装饰列表 → null', () => {
    expect(deriveActiveState([])).toBeNull();
  });
});

// ── deriveLineNode ──────────────────────────────────────────────────────────

describe('逐行派生 · deriveLineNode（行解析唯一真源 = MarkdownParser.parseLine）', () => {
  it('表格数据行 → table_row，行内 token 为 pipe/cell 交替形态', () => {
    const node = deriveLineNode({
      index: 0,
      lineText: '| a | b |',
      offset: 0,
      isCode: 'none',
      getLine: () => '| a | b |',
    });
    expect(node.type).toBe('table_row');
    expect(node.inlineTokens[0].type).toBe('table_pipe');
    expect(node.inlineTokens.some((t) => t.type === 'table_cell')).toBe(true);
  });

  it('表格分隔行 → table_separator', () => {
    const node = deriveLineNode({
      index: 0,
      lineText: '| --- | --- |',
      offset: 0,
      isCode: 'none',
      getLine: () => '| --- | --- |',
    });
    expect(node.type).toBe('table_separator');
    expect(node.inlineTokens[0].type).toBe('table_pipe');
  });

  it('与 MarkdownParser.parseLine 同源（type / raw / 行内 token 形态一致）', () => {
    const text = '| a | b |';
    const node = deriveLineNode({
      index: 0,
      lineText: text,
      offset: 0,
      isCode: 'none',
      getLine: () => text,
    });
    const direct = MarkdownParser.parseLine(text, 0, 'none');
    expect(node.type).toBe(direct.type);
    expect(node.raw).toBe(direct.raw);
    expect(node.inlineTokens).toEqual(direct.inlineTokens);
  });

  it('普通段落 → body；空行 → empty', () => {
    expect(
      deriveLineNode({ index: 0, lineText: 'hello', offset: 0, isCode: 'none', getLine: () => 'hello' })
        .type
    ).toBe('body');
    expect(
      deriveLineNode({ index: 0, lineText: '', offset: 0, isCode: 'none', getLine: () => '' }).type
    ).toBe('empty');
  });

  it('offset 与 length 回填到行节点（渲染层 data-offset 依赖）', () => {
    const node = deriveLineNode({
      index: 0,
      lineText: '| a | b |',
      offset: 42,
      isCode: 'none',
      getLine: () => '| a | b |',
    });
    expect(node.localOffset).toBe(42);
    expect(node.length).toBe('| a | b |'.length);
  });

  it('callout 头行：经 getLine 注入上下文后行节点携带 calloutType / calloutTitle / isCalloutHeader', () => {
    const lines = ['> [!WARNING] 注意', '> 正文甲'];
    const getLine = (i: number) => lines[i] ?? '';
    const head = deriveLineNode({
      index: 0,
      lineText: lines[0],
      offset: 0,
      isCode: 'none',
      getLine,
    });
    expect(head.type).toBe('body');
    expect(head.calloutType).toBe('warning');
    expect(head.calloutTitle).toBe('注意');
    expect(head.isCalloutHeader).toBe(true);
    // 引用前缀是行内 token 的一部分（渲染层据此渲染 `>` 标记）
    expect(head.inlineTokens[0].type).toBe('blockquote_prefix');
  });

  it('callout 延续行：继承头行上下文但 isCalloutHeader 非 true', () => {
    const lines = ['> [!WARNING] 注意', '> 正文甲'];
    const getLine = (i: number) => lines[i] ?? '';
    const body = deriveLineNode({
      index: 1,
      lineText: lines[1],
      offset: 0,
      isCode: 'none',
      getLine,
    });
    expect(body.calloutType).toBe('warning');
    expect(body.calloutTitle).toBe('注意');
    expect(body.isCalloutHeader).not.toBe(true);
  });

  it('普通引用行（非 callout）→ calloutType 为 undefined', () => {
    const node = deriveLineNode({
      index: 0,
      lineText: '> 普通引用乙',
      offset: 0,
      isCode: 'none',
      getLine: () => '> 普通引用乙',
    });
    expect(node.type).toBe('body');
    expect(node.calloutType).toBeUndefined();
    expect(node.isCalloutHeader).not.toBe(true);
  });

  it('非引用行不触发 callout 探测（calloutType 恒 undefined）', () => {
    const node = deriveLineNode({
      index: 0,
      lineText: '正文丙',
      offset: 0,
      isCode: 'none',
      getLine: () => '正文丙',
    });
    expect(node.calloutType).toBeUndefined();
  });
});

// ── deriveLineUnit · previewHint ────────────────────────────────────────────

describe('逐行派生 · previewHint（流式末行预演）', () => {
  it('isStreamingTail=false → 恒 null（零预演开销路径，含未闭合标记的行）', () => {
    for (const text of ['**bold', '`code', '$x', '~~a', '*i', 'plain', '| a | b |']) {
      const unit = deriveLineUnit(unitInput({ lineText: text, isStreamingTail: false }));
      expect(unit.previewHint).toBeNull();
    }
  });

  it('流式末行 + 未闭合标记 → 非 null，且 previewStart / hint 精确', () => {
    const cases: Array<[string, number, string]> = [
      ['**bold', 2, 'bold'],
      ['`code', 1, 'code'],
      ['$x', 1, 'math'],
      ['~~a', 2, 'strike'],
      ['*i', 1, 'italic'],
    ];
    for (const [text, start, hint] of cases) {
      const unit = deriveLineUnit(unitInput({ lineText: text, isStreamingTail: true }));
      expect(unit.previewHint).not.toBeNull();
      expect(unit.previewHint!.previewStart).toBe(start);
      expect(unit.previewHint!.hint).toBe(hint);
    }
  });

  it('流式末行但标记已闭合 → null（无预演）', () => {
    for (const text of ['**bold**', '`code`', '$x$', '~~a~~']) {
      const unit = deriveLineUnit(unitInput({ lineText: text, isStreamingTail: true }));
      expect(unit.previewHint).toBeNull();
    }
  });

  it('代码语义行（isCode ≠ none）即使流式末行也不预演', () => {
    expect(
      deriveLineUnit(unitInput({ lineText: '**bold', isStreamingTail: true, isCode: 'code' }))
        .previewHint
    ).toBeNull();
    expect(
      deriveLineUnit(unitInput({ lineText: '**bold', isStreamingTail: true, isCode: 'fence_start' }))
        .previewHint
    ).toBeNull();
  });
});

// ── deriveLineUnit · 其余字段 ───────────────────────────────────────────────

describe('逐行派生 · deriveLineUnit 字段派生', () => {
  it('搜索装饰命中 → hasSearchDecoration = true；无搜索装饰 → false', () => {
    const hit = makeDecorations();
    hit.addSearchRange(0, 5);
    expect(
      deriveLineUnit(unitInput({ lineText: 'hello', decorations: hit })).hasSearchDecoration
    ).toBe(true);
    expect(deriveLineUnit(unitInput({ lineText: 'hello' })).hasSearchDecoration).toBe(false);
  });

  it('选区装饰 → activeState 带 selStart / selEnd；无装饰 → null', () => {
    const ds = makeDecorations();
    ds.add(2, 7, 'selection');
    const unit = deriveLineUnit(unitInput({ lineText: 'hello world', decorations: ds }));
    expect(unit.activeState).toEqual({ cursor: 7, selStart: 2, selEnd: 7 });
    expect(deriveLineUnit(unitInput({ lineText: 'hello world' })).activeState).toBeNull();
  });

  it('光标装饰（active）→ activeState = { cursor }（无 selStart）', () => {
    const ds = makeDecorations();
    ds.add(3, 3, 'active');
    const unit = deriveLineUnit(unitInput({ lineText: 'hello world', decorations: ds }));
    expect(unit.activeState).toEqual({ cursor: 3 });
    expect(unit.activeState!.selStart).toBeUndefined();
  });

  it('tableId：表格行恒经 resolveTableId(getLine, index) 解析，非表格行 undefined', () => {
    const lines = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '段落丁'];
    const getLine = (i: number) => lines[i] ?? '';
    const base = { offset: 0, isCode: 'none' as const, decorations: makeDecorations(), rowDecorationVersion: 0, getLine, isStreamingTail: false };

    const host = deriveLineUnit({ ...base, index: 0, lineText: lines[0] });
    const inner = deriveLineUnit({ ...base, index: 2, lineText: lines[2] });
    const para = deriveLineUnit({ ...base, index: 3, lineText: lines[3] });

    expect(typeof host.tableId).toBe('string');
    expect(host.tableId).toBe(resolveTableId(getLine, 0)); // 唯一入口：无 tableId 入参可覆盖
    expect(inner.tableId).toBe(host.tableId); // 同表同身份
    expect(para.tableId).toBeUndefined();
  });

  it('lineTokens(unit) 恒等于 lineNode.inlineTokens（空 token 时返回空数组而非 undefined）', () => {
    const table = deriveLineUnit(unitInput({ lineText: '| a | b |' }));
    expect(lineTokens(table)).toBe(table.lineNode.inlineTokens);
    expect(lineTokens(table).length).toBeGreaterThan(0);

    const plain = deriveLineUnit(unitInput({ lineText: 'hello' }));
    expect(lineTokens(plain)).toBe(plain.lineNode.inlineTokens);
    expect(lineTokens(plain).length).toBeGreaterThan(0);
  });

  it('lineNode 与 tableId / 活动态在同一单元内一致派生（表格行 + 选区）', () => {
    const lines = ['| a | b |', '| --- | --- |'];
    const getLine = (i: number) => lines[i] ?? '';
    const ds = makeDecorations();
    ds.add(0, 3, 'selection');
    const unit = deriveLineUnit({
      index: 0,
      lineText: lines[0],
      offset: 0,
      isCode: 'none',
      decorations: ds,
      rowDecorationVersion: 0,
      getLine,
      isStreamingTail: false,
    });
    expect(unit.lineNode.type).toBe('table_row');
    expect(typeof unit.tableId).toBe('string');
    expect(unit.activeState).toEqual({ cursor: 3, selStart: 0, selEnd: 3 });
    expect(unit.previewHint).toBeNull();
  });
});
