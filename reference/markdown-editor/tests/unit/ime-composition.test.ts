// tests/unit/ime-composition.test.ts
// R4-C IME 状态机测试（jsdom 构造 CompositionEvent / InputEvent 序列）
//
// 覆盖（04 §2 深水区 / R4-C 任务书三项 + 接线回归）：
// 1. compositionGroupId 状态机：start 开组（id 递增）→ end 闭组；
//    composition 期间变更缓冲到组内不丢（不清空 value、不逐次提交）；
//    compositionend 以 textarea.value 为准（不依赖 e.data）+
//    50ms pending flush 延迟窗口提交。
// 2. beforeinput 接线：组外 insertReplacementText（候选替换/拼写纠错）/
//    deleteContentBackward（Android Backspace 合成语义）——
//    composition 内不重复 insert（缓冲期 beforeinput 一律放行不干预）。
// 3. 撤销粒度：同 compositionGroupId 变更（组内多次候选替换、中途 flush
//    的多轮会话）最终一次提交 = 一个 undo 步，undo 一步回退整段组合。
// 4. 组合内 Backspace 不删文档；普通输入（非组合）行为回归。
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useEditorStore } from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';
import { HiddenInput } from '../../src/components/HiddenInput';
import React from 'react';
// measure 模块依赖真实 DOM 的 token 结构与 Range 布局测量（jsdom 无布局），
// 统一 mock 为固定坐标：HiddenInput 只消费 getCoordinatesFromIndex /
// toContainerCoords 的返回值，固定 rect 即可渲染出 textarea。
vi.mock('../../src/core/measure', () => ({
  getCoordinatesFromIndex: () => ({ top: 0, left: 0, height: 20, bottom: 20 }),
  toContainerCoords: (rect: { top: number; left: number; height: number }) => ({
    top: rect.top,
    left: rect.left,
    height: rect.height,
    bottom: rect.height,
  }),
  getGlobalIndexFromDOMNode: () => null,
  getArrowNavigationIndex: () => null,
}));

// React 19 act 要求显式声明测试环境（testing-library 通常代设，此处手写）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 重置 store 到初始单行空文档（与既有测试同款，含 isComposing 复位）
function resetStore() {
  useEditorStore.setState({
    lines: [''],
    lineOffsets: new LineOffsetTree([0]),
    codeBlockState: ['none'],
    textLength: 0,
    cursorPos: 0,
    selectionStart: 0,
    selectionEnd: 0,
    undoStack: [],
    redoStack: [],
    isComposing: false,
  });
}

// 挂载 HiddenInput（measure 已 mock，coords 恒非 null → textarea 渲染）。
// 注意：本文件保持 .ts 后缀（.ts 内不能写 JSX 字面量），故用
// createElement 构造组件元素。
function mountHiddenInput() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const containerRef = { current: container } as React.RefObject<HTMLDivElement | null>;
  act(() => {
    root.render(React.createElement(HiddenInput, { containerRef }));
  });
  return {
    container,
    root,
    getTextarea: () => container.querySelector('textarea') as HTMLTextAreaElement,
  };
}

// —— 事件构造辅助（jsdom 构造 CompositionEvent/InputEvent 序列）——

function startComposition(ta: HTMLTextAreaElement) {
  ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
}

// 组合中候选更新：浏览器写入 value 并派发 input（React onChange 入口）
function updateComposition(ta: HTMLTextAreaElement, value: string) {
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function endComposition(ta: HTMLTextAreaElement, data: string) {
  ta.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true, data })
  );
}

// 派发 beforeinput（inputType/data）；jsdom 版本差异兜底：不支持
// InputEvent 构造时回退为普通 Event + 属性注入
function fireBeforeInput(
  ta: HTMLTextAreaElement,
  inputType: string,
  data: string | null = null
) {
  let ev: Event;
  try {
    ev = new InputEvent('beforeinput', {
      bubbles: true,
      inputType,
      data: data ?? undefined,
    });
  } catch {
    ev = new Event('beforeinput', { bubbles: true });
    Object.defineProperty(ev, 'inputType', { value: inputType });
    Object.defineProperty(ev, 'data', { value: data });
  }
  ta.dispatchEvent(ev);
}

// 把 pending flush 定时器走到期（50ms 延迟窗口结束）
function flushPending() {
  act(() => {
    vi.advanceTimersByTime(50);
  });
}

describe('IME 合成状态机（R4-C）', () => {
  let ta: HTMLTextAreaElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
    const mounted = mountHiddenInput();
    root = mounted.root;
    ta = mounted.getTextarea();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('全流程：start/update/end 组内缓冲不丢，end 后以 value 为准一次提交', () => {
    act(() => {
      startComposition(ta);
      updateComposition(ta, 'n');
      updateComposition(ta, 'ni');
      updateComposition(ta, 'nihao');
    });

    // 组合期间：变更缓冲在组内，store 未提交（不提前污染文档）
    expect(useEditorStore.getState().getText()).toBe('');
    // 缓冲载体（textarea.value）保持累积，未清空
    expect(ta.value).toBe('nihao');

    act(() => {
      endComposition(ta, 'nihao');
    });

    // 延迟窗口内仍未提交（等待浏览器最终 value 写入）
    expect(useEditorStore.getState().getText()).toBe('');
    expect(ta.value).toBe('nihao');

    flushPending();

    // 提交后以 value 为准落库（此处 end 的 data 与 value 一致）
    expect(useEditorStore.getState().getText()).toBe('nihao');
    expect(useEditorStore.getState().cursorPos).toBe(5);
    // 提交后 textarea 清空，等待下一次输入
    expect(ta.value).toBe('');
  });

  it('compositionend 空 data（Android/Safari）：以 value 为准不丢字', () => {
    act(() => {
      startComposition(ta);
      updateComposition(ta, '中');
      // Android/Safari 的 compositionend 常带空 data，但 value 已含提交文本
      endComposition(ta, '');
    });

    flushPending();

    expect(useEditorStore.getState().getText()).toBe('中');
  });

  it('中途 flush（候选预测拆段）：50ms 窗口内同组延续，一次提交、撤销一步回退', () => {
    act(() => {
      startComposition(ta);
      updateComposition(ta, '中');
      // 第一轮组合结束（如候选确认），浏览器随即开新一轮预测组合
      endComposition(ta, '中');
      // 50ms 窗口内新一轮 compositionstart → 沿用同 compositionGroupId，
      // value 保留不清空、继续累积
      startComposition(ta);
      updateComposition(ta, '中文');
      endComposition(ta, '文');
    });

    flushPending();

    // 两次会话的变更合并为一次提交
    expect(useEditorStore.getState().getText()).toBe('中文');
    expect(useEditorStore.getState().undoStack).toHaveLength(1);

    // 撤销一步回退整段组合（undo 栈仅一步，天然回退）
    act(() => {
      useEditorStore.getState().undo();
    });
    expect(useEditorStore.getState().getText()).toBe('');
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
  });

  it('撤销粒度：组内多次候选替换合并为一个 undo 步', () => {
    act(() => {
      startComposition(ta);
      updateComposition(ta, '一');
      updateComposition(ta, '二');
      updateComposition(ta, '十二');
      endComposition(ta, '十二');
    });

    flushPending();

    expect(useEditorStore.getState().getText()).toBe('十二');
    expect(useEditorStore.getState().undoStack).toHaveLength(1);

    // 一次 undo 回退整段组合（不含中间候选文本残留）
    act(() => {
      useEditorStore.getState().undo();
    });
    expect(useEditorStore.getState().getText()).toBe('');
  });

  it('两个独立组合（间隔 >50ms）：各自一个 undo 步，逐个回退', () => {
    act(() => {
      startComposition(ta);
      updateComposition(ta, '中');
      endComposition(ta, '中');
    });
    flushPending();
    expect(useEditorStore.getState().getText()).toBe('中');

    // 间隔超过延迟窗口 → 新一轮组合开新组（id 递增）；第二组合为多字符
    // 文本，不满足连续打字合并（insert.length === 1），独立一步
    act(() => {
      vi.advanceTimersByTime(60);
      startComposition(ta);
      updateComposition(ta, '你好');
      endComposition(ta, '你好');
    });
    flushPending();
    expect(useEditorStore.getState().getText()).toBe('中你好');
    expect(useEditorStore.getState().undoStack).toHaveLength(2);

    act(() => {
      useEditorStore.getState().undo();
    });
    expect(useEditorStore.getState().getText()).toBe('中');
    act(() => {
      useEditorStore.getState().undo();
    });
    expect(useEditorStore.getState().getText()).toBe('');
  });

  it('组合内 Backspace 不删除文档（候选删除走 value 缓冲）', () => {
    act(() => {
      useEditorStore.getState().setText('已有内容');
      useEditorStore.getState().setCursorPos(4);
    });

    act(() => {
      startComposition(ta);
      ta.value = 'nih';
      ta.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Backspace',
          bubbles: true,
          cancelable: true,
        })
      );
      // 浏览器删掉一个候选字符（value 由浏览器维护）
      ta.value = 'ni';
      endComposition(ta, 'ni');
    });

    flushPending();

    // 文档中的已有内容未被组合内退格触碰
    expect(useEditorStore.getState().getText()).toBe('已有内容ni');
  });

  it('组外 beforeinput insertReplacementText：替换选区且不重复提交', () => {
    act(() => {
      useEditorStore.getState().setText('teh');
      useEditorStore.getState().setSelection(0, 3);
    });

    act(() => {
      fireBeforeInput(ta, 'insertReplacementText', 'the');
    });

    // 拼写纠错/候选替换直接替换选区，独立一步
    expect(useEditorStore.getState().getText()).toBe('the');

    // 双写防御：preventDefault 失效时浏览器仍派发 input，但 value 已被
    // 清空 → onChange 读到空值不会重复插入
    act(() => {
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useEditorStore.getState().getText()).toBe('the');
  });

  it('组外 beforeinput deleteContentBackward：Android 无 keydown 退格补丁', () => {
    act(() => {
      useEditorStore.getState().setText('abc');
      useEditorStore.getState().setCursorPos(3);
    });

    act(() => {
      fireBeforeInput(ta, 'deleteContentBackward', null);
    });

    expect(useEditorStore.getState().getText()).toBe('ab');
  });

  it('普通输入（非组合）回归：onChange 单字符提交', () => {
    act(() => {
      ta.value = 'a';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(useEditorStore.getState().getText()).toBe('a');
    expect(ta.value).toBe('');
  });
});
