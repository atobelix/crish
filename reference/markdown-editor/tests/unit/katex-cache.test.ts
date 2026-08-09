// tests/unit/katex-cache.test.ts
// R6-C 公式流式回归修复：KaTeX 渲染缓存 + 装饰集行级版本
//
// 覆盖：
// 1. renderMathToHtml 结果缓存——同 formula + displayMode 命中（mock
//    渲染器调用计数不增长）、displayMode 区分、空公式早退不触渲染器；
// 2. 缓存上限淘汰——超过 MATH_RENDER_CACHE_CAPACITY 后最久未用条目
//    被驱逐，重新渲染恢复调用；setMathRenderer 替换渲染器清空缓存；
// 3. DecorationSet 行级版本（decorationVersion 粒度修正）——光标在
//    行内平移（模拟 append 光标平移）只 bump 光标行，其他行版本不变；
//    跨行平移 bump 新旧两行；search 装饰只 bump 受影响行；remove
//    幂等空操作不 bump。
//
// 行为等价声明（R6-C）：行版本只影响 LineItem 的 memo 判定粒度，
// query/getKind 语义与 R5-D 完全一致（decoration-set.test.ts 的
// 1300+ 组合等价证明不受影响）。

import { describe, it, expect, afterEach } from 'vitest';
import {
  renderMathToHtml,
  setMathRenderer,
  getMathRenderer,
  clearMathRenderCache,
  MATH_RENDER_CACHE_CAPACITY,
  type MathRenderer,
} from '../../src/core/renderTheme';
import {
  DecorationSet,
  applyCursorSelectionDecorations,
  type DecorationLineResolver,
} from '../../src/core/DecorationSet';

// 测试后恢复默认渲染器并清空缓存（防污染其他测试/跨文件顺序执行）
afterEach(() => {
  setMathRenderer(null);
  clearMathRenderCache();
});

describe('KaTeX 渲染缓存（R6-C）', () => {
  it('同公式两次调用只执行一次渲染器（缓存命中）', () => {
    let calls = 0;
    const mock: MathRenderer = (formula, displayMode) => {
      calls++;
      return `<span>${formula}-${displayMode}</span>`;
    };
    setMathRenderer(mock);
    const first = renderMathToHtml('x^2 + y^2', true);
    const second = renderMathToHtml('x^2 + y^2', true);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it('displayMode 参与缓存键（同一公式两种模式分别渲染）', () => {
    let calls = 0;
    setMathRenderer((formula, displayMode) => {
      calls++;
      return `${formula}:${displayMode}`;
    });
    renderMathToHtml('E = mc^2', true);
    renderMathToHtml('E = mc^2', false);
    renderMathToHtml('E = mc^2', true); // 命中块级缓存
    expect(calls).toBe(2);
  });

  it('不同公式不互相命中', () => {
    let calls = 0;
    setMathRenderer(() => {
      calls++;
      return '<x>';
    });
    renderMathToHtml('a+b', true);
    renderMathToHtml('a-b', true);
    expect(calls).toBe(2);
  });

  it('空公式早退：不触渲染器、不进缓存', () => {
    let calls = 0;
    setMathRenderer(() => {
      calls++;
      return '<x>';
    });
    expect(renderMathToHtml('', true)).toBe('');
    expect(renderMathToHtml('', false)).toBe('');
    expect(calls).toBe(0);
  });

  it('缓存上限淘汰：超过容量后最久未用条目被驱逐', () => {
    let calls = 0;
    setMathRenderer(() => {
      calls++;
      return '<x>';
    });
    // 连续渲染容量 + 1 个不同公式：第 1 个（最久未用）应被驱逐
    for (let i = 0; i <= MATH_RENDER_CACHE_CAPACITY; i++) {
      renderMathToHtml(`f_${i}`, true);
    }
    expect(calls).toBe(MATH_RENDER_CACHE_CAPACITY + 1);
    // 第 1 个已淘汰 → 未命中重渲染（重插时按 LRU 驱逐当前最旧的 f_1）
    renderMathToHtml('f_0', true);
    expect(calls).toBe(MATH_RENDER_CACHE_CAPACITY + 2);
    // 最近插入的条目（f_500）仍在缓存 → 命中，调用计数不增长
    renderMathToHtml(`f_${MATH_RENDER_CACHE_CAPACITY}`, true);
    expect(calls).toBe(MATH_RENDER_CACHE_CAPACITY + 2);
  });

  it('get 命中刷新 LRU 序（最近引用者不被驱逐）', () => {
    let calls = 0;
    setMathRenderer(() => {
      calls++;
      return '<x>';
    });
    for (let i = 0; i < MATH_RENDER_CACHE_CAPACITY; i++) {
      renderMathToHtml(`g_${i}`, true);
    }
    // 引用最旧条目（刷新其 LRU 序）
    renderMathToHtml('g_0', true);
    // 再插入一个：应驱逐 g_1（当前最久未用）而非 g_0
    renderMathToHtml('g_new', true);
    renderMathToHtml('g_0', true);
    expect(calls).toBe(MATH_RENDER_CACHE_CAPACITY + 1);
    renderMathToHtml('g_1', true);
    expect(calls).toBe(MATH_RENDER_CACHE_CAPACITY + 2);
  });

  it('setMathRenderer 替换渲染器后清空缓存（旧渲染器结果不复用）', () => {
    let callsA = 0;
    let callsB = 0;
    setMathRenderer(() => {
      callsA++;
      return '<A>';
    });
    renderMathToHtml('h(x)', true);
    renderMathToHtml('h(x)', true);
    expect(callsA).toBe(1);
    setMathRenderer(() => {
      callsB++;
      return '<B>';
    });
    renderMathToHtml('h(x)', true);
    expect(callsB).toBe(1);
    expect(callsA).toBe(1);
  });

  it('getMathRenderer 恢复默认（setMathRenderer(null)）', () => {
    setMathRenderer(() => '<x>');
    setMathRenderer(null);
    // 默认渲染器存在且输出为 KaTeX HTML（含 katex 类名标记）
    const html = renderMathToHtml('x', false);
    expect(html).toContain('katex');
  });
});

describe('装饰集行级版本（R6-C decorationVersion 粒度修正）', () => {
  // 行边界解析器：三行文档，行 0 [0,3]、行 1 [4,6]、行 2 [7,10]
  // （与 decoration-set.test.ts 的 makeResolver 同语义）
  function makeResolver(lineLengths: number[]): DecorationLineResolver {
    return {
      findLineIndex(pos: number): number {
        let acc = 0;
        for (let i = 0; i < lineLengths.length; i++) {
          acc += lineLengths[i] + 1;
          if (acc > pos) return i;
        }
        return lineLengths.length - 1;
      },
    };
  }

  it('初始状态：未装饰行版本为 0，光标所在行 > 0', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    applyCursorSelectionDecorations(ds, 5, 5, 5); // 光标 5 = 行 1
    expect(ds.getRowVersion(0)).toBe(0);
    expect(ds.getRowVersion(1)).toBeGreaterThan(0);
    expect(ds.getRowVersion(2)).toBe(0);
  });

  it('光标同行内平移（模拟 append 平移）：只 bump 光标行，其他行版本不变', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    applyCursorSelectionDecorations(ds, 5, 5, 5); // 光标 5 = 行 1
    const vRow0 = ds.getRowVersion(0);
    const vRow1 = ds.getRowVersion(1);
    const vRow2 = ds.getRowVersion(2);
    // 模拟 append 平移：光标在行 1 内 5 → 6（同行平移，selection/active
    // 判定结果对行 0/行 2 而言不变——版本不得变化）
    applyCursorSelectionDecorations(ds, 6, 6, 6);
    expect(ds.getRowVersion(0)).toBe(vRow0);
    expect(ds.getRowVersion(1)).toBeGreaterThan(vRow1);
    expect(ds.getRowVersion(2)).toBe(vRow2);
    // 连续多帧 append 平移：行 0/行 2 版本始终保持不变
    applyCursorSelectionDecorations(ds, 7, 7, 7); // 7 = 行 2 行首（跨行）
    expect(ds.getRowVersion(0)).toBe(vRow0);
  });

  it('光标跨行平移：bump 旧行（remove）与新行（add），无关行不变', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    applyCursorSelectionDecorations(ds, 5, 5, 5); // 行 1
    const vRow0 = ds.getRowVersion(0);
    const vRow1 = ds.getRowVersion(1);
    applyCursorSelectionDecorations(ds, 8, 8, 8); // 行 2
    expect(ds.getRowVersion(0)).toBe(vRow0);
    expect(ds.getRowVersion(1)).toBeGreaterThan(vRow1); // 旧光标行 remove
    expect(ds.getRowVersion(2)).toBeGreaterThan(0); // 新光标行 add
  });

  it('选区变化只 bump 选区覆盖行', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    applyCursorSelectionDecorations(ds, 5, 2, 8); // 选区 [2,8] 跨三行
    const vAll = [0, 1, 2].map((i) => ds.getRowVersion(i));
    expect(vAll.every((v) => v > 0)).toBe(true);
    // 选区收窄到行 0 内 [0,2]：行 1/行 2 不再覆盖
    applyCursorSelectionDecorations(ds, 0, 0, 2);
    expect(ds.getRowVersion(0)).toBeGreaterThan(vAll[0]);
    expect(ds.getRowVersion(1)).toBeGreaterThan(vAll[1]); // remove 清行 1
    expect(ds.getRowVersion(2)).toBeGreaterThan(vAll[2]); // remove 清行 2
  });

  it('search 装饰只 bump 受影响行；clearSearch 幂等空操作不 bump', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    const vBefore = [0, 1, 2].map((i) => ds.getRowVersion(i));
    ds.addSearchRange(0, 2); // 只覆盖行 0
    expect(ds.getRowVersion(0)).toBeGreaterThan(vBefore[0]);
    expect(ds.getRowVersion(1)).toBe(vBefore[1]);
    expect(ds.getRowVersion(2)).toBe(vBefore[2]);
    // clearSearch 移除行 0 的 search → 行 0 bump
    ds.clearSearch();
    expect(ds.getRowVersion(0)).toBeGreaterThan(vBefore[0] + 1);
    // 重复 clearSearch：无 search 装饰 → 空操作 → 所有行版本不变
    const vAfter = [0, 1, 2].map((i) => ds.getRowVersion(i));
    ds.clearSearch();
    expect([0, 1, 2].map((i) => ds.getRowVersion(i))).toEqual(vAfter);
  });

  it('clear 清空装饰并复位全部行版本', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    applyCursorSelectionDecorations(ds, 5, 2, 8);
    expect([0, 1, 2].some((i) => ds.getRowVersion(i) > 0)).toBe(true);
    ds.clear();
    expect(ds.getRowVersion(0)).toBe(0);
    expect(ds.getRowVersion(1)).toBe(0);
    expect(ds.getRowVersion(2)).toBe(0);
  });
});
