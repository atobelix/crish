// tests/unit/selection-protect.test.ts
// P3 B3 选区保护（docs/analysis/plan-A3-选区保护.md 方案 D：B 主 + A 兜底）
//
// 覆盖（任务书三项）：
// 1. shouldDirectStream 判定纯函数矩阵（方案 B 主）：有选区相交/不相交、
//    光标行中/行首/行尾、反向选区、末行区间为空、选区终点边界；
// 2. canDirect 集成：选区与末行相交 / 光标在末行行中 → 降级走常规
//    append 路径（store 同步提交、无 data-streaming-dirty、选区按
//    appendText 契约平移）；选区在末行之前 / 光标在行首 → 直刷照常
//    （dirty 标记出现、store 滞后、flush 后收敛）；
// 3. flush 后越界钳制（方案 A 兜底）：原生 DOM 选区轨无钳制写入的越界
//    选区（selectionStart/End/cursorPos > textLength）在 flush/降级
//    提交后 O(1) 收敛到 textLength（经 setSelection 既有边界收敛 +
//    装饰链路单帧重测）；
// 4. FindReplace 替换 Enter 竞态（plan-A3 §3 顺带修复）：面板在滚动
//    容器外、容器 capture flush 不触达——onBeforeReplace 接线先提交
//    直刷 pending，替换作用在最新 store（直刷文本不丢失）。
//
// 挂载模式仿 render-export/drag-select 测试：jsdom + FakeResizeObserver
// 收敛虚拟化窗口 + measure 模块 mock 固定坐标。
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import {
  MarkdownEngine,
  shouldDirectStream,
  type MarkdownEngineHandle,
} from '../../src/components/MarkdownEngine';
import { FindReplacePanel } from '../../src/components/FindReplacePanel';
import {
  createEditorStore,
  type EditorStore,
} from '../../src/core/EditorStore';

// measure 模块部分 mock：jsdom 无布局，固定测量结果（HiddenInput /
// CursorLayer / SelectionHighlight 只消费几何函数；BlockRenderer 依赖的
// checkIsActive 等渲染热路径保留真实实现——render-export 同款模式）
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
    toContainerCoords: (rect: {
      top: number;
      left: number;
      height: number;
    }) => ({
      top: rect.top,
      left: rect.left,
      height: rect.height,
      bottom: rect.height,
    }),
    getGlobalIndexFromDOMNode: () => null,
    getArrowNavigationIndex: () => null,
  };
});

// React 19 act 要求显式声明测试环境（与既有测试同款）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom 无布局/无 ResizeObserver：虚拟化容器尺寸恒 0 → tanstack 的
 * calculateRange 以 outerSize === 0 直接返回 null，行永不渲染。注入
 * 同步回调的假 ResizeObserver——observe 时立即上报固定尺寸（600×800），
 * 使虚拟化窗口在 act 内收敛（render-export 同款）。
 */
class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    this.cb(
      [
        {
          target: el,
          borderBoxSize: [{ blockSize: 28, inlineSize: 800 }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {}
  disconnect() {}
}

// —— 挂载生命周期管理（全部挂载实例 afterEach 统一卸载，防跨用例污染）——
const mountedRoots: Root[] = [];

// jsdom 无布局/无 ResizeObserver：虚拟化容器尺寸恒 0 → tanstack 的
// calculateRange 以 outerSize === 0 直接返回 null，行永不渲染。
// 每次挂载前 stub 全局 ResizeObserver 为同步上报尺寸的假实现
// （render-export.test.ts:121 同款），使虚拟化窗口在 act 内收敛。
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
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

function mountPanel(store: EditorStore, onBeforeReplace?: () => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(
      React.createElement(FindReplacePanel, {
        store,
        onGoToMatch: () => {},
        onSetHighlights: () => {},
        onBeforeReplace,
      })
    );
  });
  return { container };
}

// 受控 input 值设置（jsdom + React 19）：直接 el.value 赋值会命中 React
// 的 value tracker（lastValue 同步更新 → onChange 判定「未变」不触发）。
// 经原型 setter 写入绕过 tracker，再派发 input 事件 → React onChange
// 正常触发（@testing-library fireEvent.change 同款做法）。
function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  for (const r of mountedRoots) {
    act(() => r.unmount());
  }
  mountedRoots.length = 0;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// 行偏移 stub（行 i 起点 = i * 10；lastLineIdx = 2 → 末行区间 [20, 30)）
const STUB_OFFSETS = { getOffset: (i: number) => i * 10 };

describe('P3 B3 shouldDirectStream 判定纯函数矩阵（plan-A3 方案 B 主）', () => {
  it('无选区：光标在末行之前 / 行首 → 直刷', () => {
    // 光标在末行之前（末行起点 20 之前）
    expect(shouldDirectStream(5, 5, 5, 2, STUB_OFFSETS)).toBe(true);
    // 光标恰在末行行首（= 行起点，不算行中）
    expect(shouldDirectStream(20, 20, 20, 2, STUB_OFFSETS)).toBe(true);
  });

  it('无选区：光标在末行行中 → 降级（问题 6：flush 跳变修复）', () => {
    expect(shouldDirectStream(25, 25, 25, 2, STUB_OFFSETS)).toBe(false);
  });

  it('无选区：光标在末行行尾（> 行首）→ 保守降级（part 1 已提交行为）', () => {
    // 行尾/全文末尾也按「光标在末行内」保守降级——宁可多走常规提交，
    // 不冒险直刷写与用户编辑处并发（与 plan-A3 的理想区分是保守取舍）
    expect(shouldDirectStream(30, 30, 30, 2, STUB_OFFSETS)).toBe(false);
  });

  it('非折叠选区：完全在末行之前 → 直刷', () => {
    expect(shouldDirectStream(5, 15, 15, 2, STUB_OFFSETS)).toBe(true);
  });

  it('非折叠选区：完全在末行内 / 跨行尾部探入末行 / 覆盖行尾 → 降级', () => {
    // 完全在末行内 [22, 28)
    expect(shouldDirectStream(22, 28, 28, 2, STUB_OFFSETS)).toBe(false);
    // 跨行尾部探入末行 [15, 25)
    expect(shouldDirectStream(15, 25, 25, 2, STUB_OFFSETS)).toBe(false);
    // 选区终点 = 全文末尾（末行行尾），起点在末行行首 [20, 30)
    expect(shouldDirectStream(20, 30, 30, 2, STUB_OFFSETS)).toBe(false);
  });

  it('反向选区（起点 > 终点）按归一化区间判定', () => {
    // 反向且完全在末行内 [22, 28) → 降级
    expect(shouldDirectStream(28, 22, 22, 2, STUB_OFFSETS)).toBe(false);
    // 反向且在末行之前 [5, 15) → 直刷
    expect(shouldDirectStream(15, 5, 15, 2, STUB_OFFSETS)).toBe(true);
  });

  it('边界：末行起点恰为选区终点（不重叠）→ 保守降级（part 1 行为）', () => {
    // 选区 [5, 20) 与末行 [20, 30) 不重叠；判定按 e >= lineStart 保守
    // 降级——终点触及末行起点也走常规路径，不错位
    expect(shouldDirectStream(5, 20, 20, 2, STUB_OFFSETS)).toBe(false);
  });

  it('边界：末行区间为空（lastLineIdx < 0，空文档）→ 直刷', () => {
    expect(shouldDirectStream(0, 0, 0, -1, STUB_OFFSETS)).toBe(true);
  });

  it('readOnly 形态：引擎选区不活跃（0/0/0 折叠）→ 恒直刷（原生轨自愈）', () => {
    // readOnly 下引擎选区不被写入（无 HiddenInput 原生轨），选区字段
    // 恒折叠 0 → 判定自然通过，与 plan-A3 §1.3「readOnly 跳过判定」等价
    expect(shouldDirectStream(0, 0, 0, 2, STUB_OFFSETS)).toBe(true);
  });
});

describe('P3 B3 canDirect 集成：选区/光标在末行 → 降级常规路径', () => {
  it('无选区直刷照常：store 滞后、DOM 直写、渲染暴露 dirty、flush 后收敛（零开销）', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    const { container, getHandle } = mountEngine(store);

    act(() => {
      getHandle().streamAppend(' world');
    });
    // 直刷证据：store 滞后（降级则已提交）、DOM 已直写
    expect(store.getState().getText()).toBe('hello');
    expect(container.querySelector('[data-token-start]')?.textContent).toBe(
      'hello world'
    );
    // dirty 是渲染期属性（直刷命令式写 DOM 不触发 React 渲染）：模拟
    // 直刷期间用户光标移动（真实浏览器中 dirty 可见的场景）→ 重渲染
    // 暴露标记 + 冻结快照保护直刷文本不被旧 lineText 覆盖
    act(() => {
      store.getState().setCursorPos(1);
    });
    expect(container.querySelector('[data-streaming-dirty]')).not.toBeNull();
    expect(container.querySelector('[data-token-start]')?.textContent).toBe(
      'hello world'
    );

    // flush 收口：DOM 与 store 收敛一致，选区按 appendText 契约不动
    act(() => {
      getHandle().flushStream();
    });
    expect(container.querySelector('[data-streaming-dirty]')).toBeNull();
    expect(store.getState().getText()).toBe('hello world');
    const s = store.getState();
    expect(s.cursorPos).toBe(1);
    expect(s.selectionStart).toBe(1);
    expect(s.selectionEnd).toBe(1);
  });

  it('选区与末行相交 → 降级：store 逐 chunk 同步、无 dirty、选区按契约平移', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    store.getState().setSelection(2, 4);
    const { container, getHandle } = mountEngine(store);

    act(() => {
      getHandle().streamAppend(' world');
    });
    // W1-1（D-4）：降级 chunk 入帧聚合缓冲（rAF 帧边界提交）——断言前
    // 显式 flush（提交时点适配：帧聚合不改变「降级无直刷标记」语义）
    act(() => {
      getHandle().flushStream();
    });
    // 降级 = 常规 append 路径：无直刷标记，store 已提交
    expect(container.querySelector('[data-streaming-dirty]')).toBeNull();
    expect(store.getState().getText()).toBe('hello world');
    // 选区平移契约（appendText）：追加点（5）之前的选区不动
    const s = store.getState();
    expect(s.selectionStart).toBe(2);
    expect(s.selectionEnd).toBe(4);
    expect(s.cursorPos).toBe(4);
  });

  it('光标在末行行中（活跃编辑态）→ 降级（问题 6 修复）', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    store.getState().setCursorPos(3);
    const { container, getHandle } = mountEngine(store);

    act(() => {
      getHandle().streamAppend(' world');
    });
    act(() => {
      getHandle().flushStream();
    });
    expect(container.querySelector('[data-streaming-dirty]')).toBeNull();
    expect(store.getState().getText()).toBe('hello world');
    // 光标 < 追加点：不随追加推进（appendText 契约）
    expect(store.getState().cursorPos).toBe(3);
  });

  it('光标在末行行首 → 直刷照常（行首非行中）', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    store.getState().setCursorPos(0);
    const { container, getHandle } = mountEngine(store);

    act(() => {
      getHandle().streamAppend(' world');
    });
    // 直刷证据：store 滞后 + DOM 直写
    expect(store.getState().getText()).toBe('hello');
    expect(container.querySelector('[data-token-start]')?.textContent).toBe(
      'hello world'
    );
    // 渲染暴露 dirty 标记
    act(() => {
      store.getState().setCursorPos(2);
    });
    expect(container.querySelector('[data-streaming-dirty]')).not.toBeNull();
  });

  it('多行文档：选区在末行之前 → 直刷照常、flush 后收敛且选区不动', () => {
    const store = createEditorStore();
    store.getState().setText('alpha\nbeta');
    store.getState().setSelection(0, 2);
    const { container, getHandle } = mountEngine(store);

    act(() => {
      getHandle().streamAppend(' gamma');
    });
    // 选区 [0, 2) 与末行 [6, 10) 不相交 → 直刷：store 滞后 + 末行 DOM 直写
    expect(store.getState().getText()).toBe('alpha\nbeta');
    expect(
      container.querySelector('[data-line-start="6"] [data-token-start]')
        ?.textContent
    ).toBe('beta gamma');

    act(() => {
      getHandle().flushStream();
    });
    expect(store.getState().getText()).toBe('alpha\nbeta gamma');
    const s = store.getState();
    expect(s.selectionStart).toBe(0);
    expect(s.selectionEnd).toBe(2);
    expect(s.cursorPos).toBe(2);
  });
});

describe('P3 B3 flush 后选区越界钳制（plan-A3 方案 A 兜底）', () => {
  it('原生轨越界选区 flush 后钳制：selectionEnd 收敛到 textLength', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    const { getHandle } = mountEngine(store);
    // 直刷累积 pending（DOM 长度 11 > store 5）
    act(() => {
      getHandle().streamAppend(' world');
    });
    // 模拟原生 DOM 选区轨无钳制写入（HiddenInput handleSelectionChange
    // 同款字段，DOM 坐标越界：8/11 > textLength 5）
    store.setState({
      cursorPos: 11,
      selectionStart: 8,
      selectionEnd: 11,
    });

    act(() => {
      getHandle().flushStream();
    });
    // 提交前先收敛越界值（8/11 → 5/5）再 appendText 平移（→ 11/11）：
    // 「提交前钳制 + shiftGE」与「shiftGE + 提交后钳制」结果一致
    // （plan-A3 §2.1）——最终选区收敛到文末（= 正确恢复目标：用户
    // 选中了直刷文本，flush 后文本已提交）
    const s = store.getState();
    expect(s.textLength).toBe(11);
    expect(s.selectionStart).toBe(11);
    expect(s.selectionEnd).toBe(11);
    expect(s.cursorPos).toBe(11);
  });

  it('选区起点合法、终点越界 → 钳制后选区延伸至文末', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    const { getHandle } = mountEngine(store);
    act(() => {
      getHandle().streamAppend(' world');
    });
    // 起点 3 在 store 内、终点 9 越界（用户拖选跨过直刷字符）
    store.setState({
      cursorPos: 9,
      selectionStart: 3,
      selectionEnd: 9,
    });

    act(() => {
      getHandle().flushStream();
    });
    const s = store.getState();
    // 提交前收敛终点（9 → 5）→ shiftGE 平移（→ 11）：起点保留、终点
    // 收敛文末 [3, 11)——与「shiftGE + 提交后钳制」结果一致
    expect(s.textLength).toBe(11);
    expect(s.selectionStart).toBe(3);
    expect(s.selectionEnd).toBe(11);
    expect(s.cursorPos).toBe(11);
  });

  it('合法选区 flush 后不动（appendText 平移契约保留，钳制不误伤）', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    const { getHandle } = mountEngine(store);
    act(() => {
      getHandle().streamAppend(' world');
    });
    // 选区完全在 store 内（3/4 < textLength 5）——原生轨合法写入
    store.setState({
      cursorPos: 4,
      selectionStart: 3,
      selectionEnd: 4,
    });

    act(() => {
      getHandle().flushStream();
    });
    const s = store.getState();
    // 追加点（5）之前的选区不平移、不越界 → 钳制不触发，原样保留
    expect(s.selectionStart).toBe(3);
    expect(s.selectionEnd).toBe(4);
    expect(s.cursorPos).toBe(4);
  });

  it('折叠光标越界 + 降级路径：streamAppend 常规提交后同样钳制', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    const { container, getHandle } = mountEngine(store);
    // 原生轨无钳制写入折叠光标（DOM 坐标越界 11 > 5）
    store.setState({
      cursorPos: 11,
      selectionStart: 11,
      selectionEnd: 11,
    });

    // 越界光标 > 末行行首 → shouldDirectStream 降级 → 常规 append 提交
    //（W1-1：入帧聚合缓冲，flush 后提交——断言前显式 flush）
    act(() => {
      getHandle().streamAppend(' world');
    });
    act(() => {
      getHandle().flushStream();
    });
    expect(container.querySelector('[data-streaming-dirty]')).toBeNull();
    const s = store.getState();
    expect(s.textLength).toBe(11);
    // 提交前钳制收敛越界光标（11 → 5）→ shiftGE 平移（→ 11）：
    // 越界值经 appendText 内部 assoc 计算前必须先收敛（否则行号越界
    // 崩溃）——提交前钳制是防崩 + 收敛的双保险
    expect(s.cursorPos).toBe(11);
    expect(s.selectionStart).toBe(11);
    expect(s.selectionEnd).toBe(11);
  });
});

describe('P3 B3 FindReplace 替换 Enter 竞态（plan-A3 §3 顺带修复）', () => {
  it('面板层：替换当前在 applyChange 前调用 onBeforeReplace', async () => {
    vi.useFakeTimers();
    const store = createEditorStore();
    store.getState().setText('foo foo foo');
    const onBefore = vi.fn();
    const { container } = mountPanel(store, onBefore);

    // Ctrl+F 打开查找面板
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    const qInput = container.querySelector(
      'input[aria-label="查找"]'
    ) as HTMLInputElement;
    expect(qInput).not.toBeNull();
    // 输入查询 → 防抖触发搜索（'foo' 命中 3 处）
    act(() => {
      setInputValue(qInput, 'foo');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(
      container.querySelector('[data-find-count="true"]')?.textContent
    ).toBe('1/3');

    // Ctrl+H 切替换模式 → 输入替换文本 → 替换 Enter
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'h',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    const rInput = container.querySelector(
      'input[aria-label="替换为"]'
    ) as HTMLInputElement;
    expect(rInput).not.toBeNull();
    act(() => {
      setInputValue(rInput, 'X');
    });
    act(() => {
      rInput.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      );
    });
    // 前置回调先于 applyChange 执行；替换落在最新 store
    expect(onBefore).toHaveBeenCalledTimes(1);
    expect(store.getState().getText()).toBe('X foo foo');
    // 消化替换后防抖重搜（防 unmount 残留定时器）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  });

  it('面板层：全部替换同样在 applyChange 前调用 onBeforeReplace', async () => {
    vi.useFakeTimers();
    const store = createEditorStore();
    store.getState().setText('foo foo foo');
    const onBefore = vi.fn();
    const { container } = mountPanel(store, onBefore);

    // Ctrl+F 打开 → 输入查询 → 防抖搜索完成
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    const qInput = container.querySelector(
      'input[aria-label="查找"]'
    ) as HTMLInputElement;
    act(() => {
      setInputValue(qInput, 'foo');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Ctrl+H → 替换文本 → Shift+Enter（全部替换）
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'h',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    const rInput = container.querySelector(
      'input[aria-label="替换为"]'
    ) as HTMLInputElement;
    act(() => {
      setInputValue(rInput, 'X');
    });
    act(() => {
      rInput.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    // 全部替换（单事务合并 3 处命中）同样前置调用 + 落在最新 store
    expect(onBefore).toHaveBeenCalledTimes(1);
    expect(store.getState().getText()).toBe('X X X');
    // 消化替换后防抖重搜（防 unmount 残留定时器）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  });

  it('引擎接线端到端：直刷 pending 期间替换不吞文本（竞态消除）', async () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    const { container, getHandle } = mountEngine(store);

    // 直刷累积 pending：store 滞后（'hello'）、DOM 已 'hello world'
    act(() => {
      getHandle().streamAppend(' world');
    });
    expect(store.getState().getText()).toBe('hello');
    expect(container.querySelector('[data-token-start]')?.textContent).toBe(
      'hello world'
    );

    vi.useFakeTimers();
    // Ctrl+F 打开面板（面板在滚动容器外——容器 capture flush 监听不
    // 触达面板 keydown，pending 保持未提交：这正是 plan-A3 登记的竞态）
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    const qInput = container.querySelector(
      'input[aria-label="查找"]'
    ) as HTMLInputElement;
    expect(qInput).not.toBeNull();
    // 搜索基于滞后 store 快照（'hello' 命中 [0, 5)）——竞态前提成立
    act(() => {
      setInputValue(qInput, 'hello');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(store.getState().getText()).toBe('hello');

    // Ctrl+H → 替换 Enter：onBeforeReplace = flushStreamInternal 先提交
    // 直刷 pending，applyChange 再作用在最新 store 上
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'h',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    const rInput = container.querySelector(
      'input[aria-label="替换为"]'
    ) as HTMLInputElement;
    act(() => {
      setInputValue(rInput, 'X');
    });
    act(() => {
      rInput.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      );
    });
    // 若无 flush 通道：applyChange 作用在 'hello' 上 → 直刷文本被吞
    // （结果为 'X'）；接线后替换落在 'hello world' → 'X world'
    expect(store.getState().getText()).toBe('X world');
    expect(container.querySelector('[data-streaming-dirty]')).toBeNull();
    // 消化替换后防抖重搜（防 unmount 残留定时器）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  });
});
