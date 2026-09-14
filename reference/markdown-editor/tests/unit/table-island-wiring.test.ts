// tests/unit/table-island-wiring.test.ts
// T4 表格岛**接线**的引擎级运行时断言（战役 table-systemic-remediation）
//
// 权威：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
//       （§3.3 岛内窗口化 / §3.6 高度上报 / §3.7 测量时序契约）
//       docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-5）
//
// 覆盖的不变量（08-分维 §2 的运行时侧）：
//   - **I1（岛形态）**：岛路径下整表只有一个滚动所有者，旧路径的逐行
//     `.line-table` 容器在岛路径**零命中**；
//   - **A6 / ADR-2 单一虚拟项**：一张表在 `virtualizer` 里只有一个虚拟项
//     （岛宿主行），区间内部行**不成项、不渲染**；
//   - **I3 高度单源**：岛高上报计数只来自岛根（`recordIslandHeightReport`），
//     稳定后不再增长；区间内部行在 HeightMap 侧为 0（由宿主行承载整表高度）；
//   - **I8 无重复行节点**：岛内 `data-line-index` 与源码表行**一一对应**，
//     无重复、无遗漏；`data-index` 仍全局唯一（岛内行不占用该属性）；
//   - **I2 列宽无震荡的 jsdom 侧契约**：无布局引擎（探针 rect 恒 0）时
//     **零写入**——绝不把 0 宽喂给分配器污染真源（分配器确定性由
//     `tests/unit/table-island-allocator.test.ts` 覆盖）；
//   - **开关关闭零回归**：默认关闭下岛不参与渲染，旧逐行路径行为不变。
//
// 挂载模式仿 stream-table-lock / render-layer：jsdom + FakeResizeObserver
// （按元素类别上报尺寸）+ measure 模块 mock + offsetHeight stub。
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import {
  MarkdownEngine,
  type MarkdownEngineHandle,
} from '../../src/components/MarkdownEngine';
import { createEditorStore, type EditorStore } from '../../src/core/EditorStore';
import { useTableStore } from '../../src/core/TableStore';
import { resetTableIdentities } from '../../src/core/tableIdentity';
import {
  getIslandGridWriteStats,
  getIslandHeightStats,
  resetIslandGridWriteStats,
  resetIslandHeightStats,
  setTableIslandEnabled,
} from '../../src/core/tableIsland';

vi.mock('../../src/core/measure', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/measure')>();
  return {
    ...actual,
    getCoordinatesFromIndex: () => ({
      top: 0,
      left: 0,
      height: 20,
      bottom: 20,
    }),
    toContainerCoords: (rect: { top: number; left: number; height: number }) => ({
      top: rect.top,
      left: rect.left,
      height: rect.height,
      bottom: rect.height,
    }),
    getGlobalIndexFromDOMNode: () => null,
    getArrowNavigationIndex: () => null,
  };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 视口（滚动容器）尺寸：2000×800 → 28px 行高下约 71 行入窗（测试文档全部入窗）。 */
const VIEWPORT_W = 2000;
const VIEWPORT_H = 800;
/** 岛内行高（行级 RO 上报口径）。 */
const ISLAND_ROW_H = 40;
/** 岛根高度（岛根 RO 上报口径）= 4 行 × 40（与行高自洽，避免测量回环）。 */
const ISLAND_H = ISLAND_ROW_H * 4;

/**
 * 按元素类别上报尺寸的假 ResizeObserver：
 *   - 滚动容器（`.virtual-row` 之外的宿主）→ 视口尺寸（tanstack 依赖）；
 *   - 岛根（`.table-island`）→ 岛高；
 *   - 岛内行（`.table-island-row`）→ 行高。
 * 真实 RO 的 entry 形状（`contentRect` + `borderBoxSize`）必须都给——
 * 岛根读 `contentRect.height`，行读 `borderBoxSize[0].blockSize`。
 */
class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    const cls = (el as HTMLElement).className || '';
    const isIslandRoot = cls.includes('table-island') && !cls.includes('table-island-row');
    const isIslandRow = cls.includes('table-island-row');
    const w = isIslandRoot || isIslandRow ? 640 : VIEWPORT_W;
    const h = isIslandRoot ? ISLAND_H : isIslandRow ? ISLAND_ROW_H : VIEWPORT_H;
    this.cb(
      [
        {
          target: el,
          contentRect: { width: w, height: h } as DOMRectReadOnly,
          borderBoxSize: [{ blockSize: h, inlineSize: w }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {}
  disconnect() {}
}

const mountedRoots: Root[] = [];

/** 表格文档：表区间 = 行 2..5（宿主 2 / 分隔 3 / 数据 4,5），共 4 行。 */
const TABLE_DOC = [
  '# Title', // 0
  '', // 1
  '| a | b |', // 2 表头（宿主行）
  '| --- | --- |', // 3 分隔行
  '| 1 | 2 |', // 4
  '| 3 | 4 |', // 5
  '', // 6
  'After', // 7
].join('\n');
const TABLE_START = 2;
const TABLE_END = 5;

const origOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight'
);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 28;
    },
  });
  // 表格身份注册表与视图状态跨用例隔离（模块级单例）
  resetTableIdentities();
  useTableStore.setState({ ...useTableStore.getState(), tableWidths: {} });
  resetIslandHeightStats();
  resetIslandGridWriteStats();
  setTableIslandEnabled(false);
});

afterEach(() => {
  for (const r of mountedRoots) {
    act(() => r.unmount());
  }
  mountedRoots.length = 0;
  document.body.innerHTML = '';
  if (origOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origOffsetHeight);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .offsetHeight;
  }
  setTableIslandEnabled(false);
  vi.unstubAllGlobals();
});

function mountEngine(store: EditorStore) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  let handle: MarkdownEngineHandle | null = null;
  act(() => {
    root.render(
      React.createElement(MarkdownEngine, {
        store,
        ref: (r: MarkdownEngineHandle | null) => {
          handle = r;
        },
      })
    );
  });
  return { container, getHandle: () => handle! };
}

function mountWithTable() {
  const store = createEditorStore();
  store.getState().setText(TABLE_DOC);
  const { container } = mountEngine(store);
  return { store, container };
}

/**
 * 岛内行的 `data-line-index`（升序）。
 *
 * 选择器必须限定到**行容器** `.table-island-row`：单元格
 * （`.token-table-cell`）自身也带 `data-line-index`（`InlineRenderer.tsx:458,547`
 * 供单元格交互定位），两者都算会得到「行数 × 列数」的重复计数。
 */
function islandRowIndexes(): number[] {
  return Array.from(
    document.querySelectorAll('.table-island-row[data-line-index]')
  )
    .map((el) => Number(el.getAttribute('data-line-index')))
    .sort((a, b) => a - b);
}

describe('T4 表格岛接线 · 开关关闭（旧路径零回归）', () => {
  it('默认关闭：岛不参与渲染，旧逐行路径照常（每行一个 .line-table）', () => {
    const { container } = mountWithTable();
    expect(container.querySelectorAll('.table-island').length).toBe(0);
    expect(container.querySelectorAll('[data-island-host]').length).toBe(0);
    // 岛内**行容器**零命中（单元格上的 data-line-index 属旧路径既有形态）
    expect(container.querySelectorAll('.table-island-row').length).toBe(0);
    // 旧路径：4 个表格行各自一个横向滚动容器（根因断层 D1 的现状形态）
    expect(container.querySelectorAll('.line-table').length).toBe(4);
    // 零岛高上报（开关关闭时高度协议整体短路）
    expect(getIslandHeightStats().totalCalls).toBe(0);
  });

  it('默认关闭：`data-index` 覆盖全部源码行（虚拟项未被折叠）', () => {
    const { container } = mountWithTable();
    const indexes = Array.from(container.querySelectorAll('[data-index]'))
      .map((el) => Number(el.getAttribute('data-index')))
      .sort((a, b) => a - b);
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('T4 表格岛接线 · 开关开启（ADR-2 单一虚拟项 / I1 / I8）', () => {
  beforeEach(() => {
    setTableIslandEnabled(true);
  });

  it('整表折叠为**一个**虚拟项（岛宿主行 = 表首行）', () => {
    const { container } = mountWithTable();
    const hosts = container.querySelectorAll('[data-island-host]');
    expect(hosts.length).toBe(1);
    expect(hosts[0].getAttribute('data-index')).toBe(String(TABLE_START));
    // 区间内部行**不成虚拟项**（不是靠返回 null 跳过，而是根本不成项）
    const indexes = Array.from(container.querySelectorAll('[data-index]'))
      .map((el) => Number(el.getAttribute('data-index')))
      .sort((a, b) => a - b);
    expect(indexes).toEqual([0, 1, TABLE_START, 6, 7]);
  });

  it('I1：岛路径零 `.line-table`（每行滚动所有者被拔除）', () => {
    const { container } = mountWithTable();
    expect(container.querySelectorAll('.line-table').length).toBe(0);
    expect(container.querySelectorAll('.table-island').length).toBe(1);
  });

  it('I8：岛内行与源码表行一一对应（无重复、无遗漏）', () => {
    mountWithTable();
    const rows = islandRowIndexes();
    expect(rows).toEqual([TABLE_START, 3, 4, TABLE_END]);
    // 去重后数量 == 岛内行数（同一 lineIndex 不得出现两个节点）
    expect(new Set(rows).size).toBe(rows.length);
    // `data-index` 全局唯一：岛宿主行与岛内行**不得**争用同一属性
    const dataIndex = Array.from(document.querySelectorAll('[data-index]')).map(
      (el) => el.getAttribute('data-index')
    );
    expect(new Set(dataIndex).size).toBe(dataIndex.length);
  });

  it('I8：表头行与分隔行语义落位（表头类 / 分隔行 0 高类）', () => {
    mountWithTable();
    const header = document.querySelector(
      `[data-line-index="${TABLE_START}"]`
    );
    expect(header?.className).toContain('table-header-row');
    const sep = document.querySelector('[data-line-index="3"]');
    expect(sep?.className).toContain('table-island-separator-row');
  });

  it('I3：岛高上报来自岛根（唯一源），稳定后不再增长', () => {
    mountWithTable();
    const after = getIslandHeightStats().totalCalls;
    expect(after).toBeGreaterThanOrEqual(1);
    // 稳定点：同一高度重复上报被 `STABLE_EPSILON` 护栏拦下（不增长）
    act(() => {
      // 触发一次无内容变更的重渲染（滚动/光标帧等价物）
      window.dispatchEvent(new Event('resize'));
    });
    expect(getIslandHeightStats().totalCalls).toBe(after);
  });

  it('I2（jsdom 侧契约）：无布局引擎时探针零写入——不污染列宽真源', () => {
    mountWithTable();
    // jsdom 无布局：探针 rect 恒 0 → 岛跳过定型（绝不写 0 宽）
    expect(getIslandGridWriteStats().totalCalls).toBe(0);
    expect(useTableStore.getState().tableWidths).toEqual({});
  });
});
