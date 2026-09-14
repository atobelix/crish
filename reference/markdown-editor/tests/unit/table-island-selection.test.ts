// tests/unit/table-island-selection.test.ts
// T5 岛内选区**单矩形覆盖层**（战役 table-systemic-remediation · ADR-6 / I6）
//
// 权威：docs/table-systemic-remediation/05-分维-选区覆盖层与交互范式.md（ADR-6）
//       docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（I6）
//
// 本文件直测**岛组件**（不经完整引擎）：给 `TableBlock` 注入确定性 props
// （固定列宽 + 固定行高估算），断言：
//   ① 选区 = **恰好一个** `.table-island-selection` 覆盖层（旧范式是 N 段
//      per-cell `inset box-shadow` 拼边——D7 的形态）；
//   ② 覆盖层几何 = 角单元格并集（`left/top/width/height` 逐项）；
//   ③ 编辑态（单元格就地编辑）不画覆盖层（与旧路径 `is-cell-editing` 一致）；
//   ④ 异表选区不画（身份隔离）；
//   ⑤ 岛内**抑制**旧路径逐格拼边的样式规则存在（否则会双画边框）。
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { TableBlock } from '../../src/components/TableBlock';
import { createEditorStore, type EditorStore } from '../../src/core/EditorStore';
import { useTableStore } from '../../src/core/TableStore';
import { DecorationSet } from '../../src/core/DecorationSet';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 4 行 × 2 列表（表区间 = 行 2..5：表头 / 分隔 / 两行数据）。 */
const DOC = ['# T', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
const TABLE_ID = 't-test';
const START = 2;
const END = 5;
/** 列宽 100 + 200；行高恒 40 → rowTops = [0,40,80,120,160]。 */
const COL_WIDTHS = [100, 200];
const ROW_H = 40;

const mountedRoots: Root[] = [];

beforeEach(() => {
  useTableStore.setState({ ...useTableStore.getState(), selectedCell: null });
});

afterEach(() => {
  for (const r of mountedRoots) {
    act(() => r.unmount());
  }
  mountedRoots.length = 0;
  document.body.innerHTML = '';
  useTableStore.setState({ ...useTableStore.getState(), selectedCell: null });
});

function mountIsland() {
  const store: EditorStore = createEditorStore();
  store.getState().setText(DOC);
  const decorations = new DecorationSet({ findLineIndex: () => 0 });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      React.createElement(TableBlock, {
        tableId: TABLE_ID,
        startLine: START,
        endLine: END,
        separatorLine: START + 1,
        cols: COL_WIDTHS.length,
        colWidths: COL_WIDTHS,
        visibleTop: 0,
        visibleHeight: 400,
        getLine: (i: number) => store.getState().getLine(i) ?? '',
        isCodeAt: () => 'none',
        decorations,
        decorationVersion: 0,
        store,
        streamTailLine: null,
        estimateRowHeight: () => ROW_H,
        onIslandHeight: () => {},
        onColWidths: () => {},
      })
    );
  });
  return container;
}

const select = (patch: Partial<{
  tableId: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  isEditing: boolean;
}>) => {
  act(() => {
    useTableStore.setState({
      ...useTableStore.getState(),
      selectedCell: {
        tableId: TABLE_ID,
        startLine: START,
        endLine: START,
        startCol: 0,
        endCol: 0,
        isEditing: false,
        ...patch,
      },
    });
  });
};

const overlays = () => Array.from(document.querySelectorAll<HTMLElement>('.table-island-selection'));

describe('T5 岛内选区单矩形覆盖层（ADR-6 / I6）', () => {
  it('无选区时零覆盖层', () => {
    const container = mountIsland();
    expect(container.querySelectorAll('.table-island-selection').length).toBe(0);
  });

  it('单格选区 → 恰好一个覆盖层，几何 = 该格', () => {
    const container = mountIsland();
    select({ startCol: 1, endCol: 1, endLine: START });
    const els = overlays();
    expect(els.length).toBe(1);
    const s = els[0].style;
    expect([s.left, s.top, s.width, s.height]).toEqual(['100px', '0px', '200px', '40px']);
    // 覆盖层不拦截单元格交互
    expect(els[0].getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('.table-island-selection').length).toBe(1);
  });

  it('2×2 选区 → 仍是**一个**矩形（角单元格并集），而非 N 段拼边', () => {
    mountIsland();
    select({ startLine: START, endLine: START + 2, startCol: 0, endCol: 1 });
    const els = overlays();
    expect(els.length).toBe(1);
    const s = els[0].style;
    // 行 0..2（相对）= 表头 + 分隔 + 首行数据 → 高 3×40；列 0..1 → 宽 300
    expect([s.left, s.top, s.width, s.height]).toEqual(['0px', '0px', '300px', '120px']);
  });

  it('反向拖拽（右下 → 左上）几何与正向恒等', () => {
    mountIsland();
    select({ startLine: START + 2, endLine: START, startCol: 1, endCol: 0 });
    const s = overlays()[0].style;
    expect([s.left, s.top, s.width, s.height]).toEqual(['0px', '0px', '300px', '120px']);
  });

  it('编辑态（单元格就地编辑）不画覆盖层——与旧路径 `is-cell-editing` 一致', () => {
    mountIsland();
    select({ isEditing: true });
    expect(overlays().length).toBe(0);
  });

  it('异表选区不画（身份隔离：tableId 不匹配）', () => {
    mountIsland();
    select({ tableId: 't-other' });
    expect(overlays().length).toBe(0);
  });

  it('越界选区被钳制在表内（不画到表外、不产生负尺寸）', () => {
    mountIsland();
    select({ startLine: START - 10, endLine: START + 99, startCol: -3, endCol: 99 });
    const s = overlays()[0].style;
    expect([s.left, s.top, s.width, s.height]).toEqual(['0px', '0px', '300px', '160px']);
  });

  it('岛内抑制旧路径逐格拼边（否则覆盖层与 per-cell 边框双画）', () => {
    // 路径口径与 `tests/unit/css-contract.test.ts` 一致（cwd 相对解析）
    const css = readFileSync(
      path.resolve(__dirname, '../../src/styles/table-island.css'),
      'utf-8'
    );
    // 岛作用域内取消 `is-cell-selected` 的 box-shadow（旧范式拼边）
    expect(css).toMatch(
      /\.table-island\s+\.token-table-cell\.is-cell-selected\s*\{[^}]*box-shadow:\s*none/
    );
    // 覆盖层自身样式：绝对定位 + 不拦截指针
    expect(css).toMatch(/\.table-island-selection\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.table-island-selection\s*\{[^}]*pointer-events:\s*none/);
  });
});
