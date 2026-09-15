// tests/unit/a11y.test.ts
// R4-H a11y 短程测试（04 编辑深度扩展 §6.3 短程方案 1）
//
// 覆盖：
// 1. textarea 无障碍语义：aria-label（含占位符/行同步说明）/ role="textbox" /
//    aria-multiline——SR 焦点进入编辑器即可感知编辑器身份；
// 2. 光标行 value 同步：移动光标后 value 变为光标所在行文本；与 R4-C 的
//    value 缓冲协调——composition 期间 value 不被同步覆盖（组合缓冲载体），
//    组合结束后恢复同步；编辑直刷（打字）后保持空缓冲不变量；
// 3. aria-live 播报：光标/选区变化 polite 播报「第 N 行，第 M 列」（有选区
//    附选中字符数）；同位置不重复 + 时间节流防刷屏；
// 4. SelectionHighlight 选区层 aria-hidden（装饰性层对 SR 隐藏）。
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createEditorStore, useEditorStore } from '../../src/core/EditorStore';
import {
  HiddenInput,
  formatAnnouncement,
} from '../../src/components/HiddenInput';
import { SelectionHighlight } from '../../src/components/SelectionHighlight';
import React from 'react';
// measure 模块依赖真实 DOM 布局（jsdom 无布局），统一 mock 固定坐标：
// HiddenInput 消费固定光标盒；SelectionHighlight 仍从真实来源文本创建 Range，
// 下方夹具仅为 jsdom 补充 Range 的物理矩形，不替换源码投影或选区模型。
vi.mock('../../src/core/measure', () => ({
  getCoordinatesFromIndex: (i: number) => ({
    top: 0,
    left: i * 10,
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
  getDOMPointFromIndex: () => null,
  syncDOMSelection: () => {},
}));

// React 19 act 要求显式声明测试环境（与 ime-composition.test.ts 同款）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 三行文档（LineOffsetTree 行长含换行编码：行偏移 0 / 4 / 8）
const DOC = '第一行\n第二行\n第三行';

function mountHiddenInput() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const containerRef = {
    current: container,
  } as React.RefObject<HTMLDivElement | null>;
  act(() => {
    root.render(React.createElement(HiddenInput, { containerRef }));
  });
  return {
    container,
    root,
    getTextarea: () =>
      container.querySelector('textarea') as HTMLTextAreaElement,
    getLiveRegion: () =>
      container.querySelector('.a11y-live-region') as HTMLDivElement,
  };
}

// —— IME 组合事件辅助（与 ime-composition.test.ts 同款序列）——
function startComposition(ta: HTMLTextAreaElement) {
  ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
}

function updateComposition(ta: HTMLTextAreaElement, value: string) {
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function endComposition(ta: HTMLTextAreaElement, data: string) {
  ta.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true, data })
  );
}

// 把 pending flush 定时器走到期（50ms 延迟窗口结束）
function flushPending() {
  act(() => {
    vi.advanceTimersByTime(50);
  });
}

// 播报节流窗口过期（ANNOUNCE_THROTTLE_MS = 250ms，给足 300ms 余量）
function waitThrottle() {
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe('a11y（R4-H）', () => {
  let ta: HTMLTextAreaElement;
  let live: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.getState().setText(DOC);
    const mounted = mountHiddenInput();
    root = mounted.root;
    ta = mounted.getTextarea();
    live = mounted.getLiveRegion();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('textarea 无障碍语义：aria-label 含占位符信息、role=textbox、aria-multiline', () => {
    const label = ta.getAttribute('aria-label');
    expect(label).toContain('Markdown 编辑器');
    expect(label).toContain('输入文本');
    expect(ta.getAttribute('role')).toBe('textbox');
    expect(ta.getAttribute('aria-multiline')).toBe('true');
  });

  it('光标行 value 同步：移动光标后 value 变为光标所在行文本', () => {
    // 挂载即同步首行（光标在 0）
    expect(ta.value).toBe('第一行');
    act(() => {
      useEditorStore.getState().setCursorPos(4);
    });
    expect(ta.value).toBe('第二行');
    act(() => {
      useEditorStore.getState().setCursorPos(8);
    });
    expect(ta.value).toBe('第三行');
  });

  it('composition 期间不同步：组合缓冲不被同步覆盖，组合结束后恢复同步', () => {
    expect(ta.value).toBe('第一行');
    act(() => {
      startComposition(ta);
      updateComposition(ta, 'ni');
    });
    // 合成中：value 是组合缓冲载体（R4-C），即使光标移动也不被行文本覆盖
    act(() => {
      useEditorStore.getState().setCursorPos(4);
    });
    expect(ta.value).toBe('ni');
    act(() => {
      endComposition(ta, 'ni');
    });
    flushPending();
    // 组合提交后：以 value 为准落库，缓冲清空（R4-C 提交语义）
    expect(useEditorStore.getState().getText()).toBe(
      'ni第一行\n第二行\n第三行'
    );
    expect(ta.value).toBe('');
    // 组合结束后恢复同步：光标移动 → 新行文本直刷
    // （组合提交后首行为 'ni第一行'，行 2 起点 = 5 + 换行 = 6）
    act(() => {
      useEditorStore.getState().setCursorPos(6);
    });
    expect(ta.value).toBe('第二行');
  });

  it('编辑直刷（打字）后保持空缓冲不变量：value 清空，不与下一次输入冲突', () => {
    act(() => {
      ta.value = 'a';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useEditorStore.getState().getText()).toBe(
      'a第一行\n第二行\n第三行'
    );
    expect(ta.value).toBe('');
  });

  it('aria-live 播报：polite 静默区，光标位置变化播报「第 N 行，第 M 列」', () => {
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('role')).toBe('status');
    // 挂载即播报初始位置
    expect(live.textContent).toBe('第 1 行，第 1 列');
    waitThrottle();
    act(() => {
      useEditorStore.getState().setCursorPos(4);
    });
    expect(live.textContent).toBe('第 2 行，第 1 列');
  });

  it('选区变化播报附选中字符数', () => {
    waitThrottle();
    act(() => {
      useEditorStore.getState().setSelection(2, 10);
    });
    expect(live.textContent).toBe('第 3 行，第 3 列，已选中 8 个字符');
  });

  it('播报节流：同位置（光标行:列未动）不重复播报', () => {
    waitThrottle();
    act(() => {
      useEditorStore.getState().setCursorPos(4);
    });
    expect(live.textContent).toBe('第 2 行，第 1 列');
    // 选区变化但光标仍停在 4：同位置 → 去重，不重复播报
    waitThrottle();
    act(() => {
      useEditorStore.getState().setSelection(0, 4);
    });
    expect(live.textContent).toBe('第 2 行，第 1 列');
    // 真正移动光标：播报新位置
    waitThrottle();
    act(() => {
      useEditorStore.getState().setCursorPos(6);
    });
    expect(live.textContent).toBe('第 2 行，第 3 列');
  });

  it('播报节流：时间窗口内位置变化不推送，窗口过期后恢复', () => {
    waitThrottle();
    act(() => {
      useEditorStore.getState().setCursorPos(4);
    });
    expect(live.textContent).toBe('第 2 行，第 1 列');
    // 同一时刻内再次移动：250ms 窗口内 → 抑制，不推送
    act(() => {
      useEditorStore.getState().setCursorPos(6);
    });
    expect(live.textContent).toBe('第 2 行，第 1 列');
    // 窗口过期后恢复播报
    waitThrottle();
    act(() => {
      useEditorStore.getState().setCursorPos(8);
    });
    expect(live.textContent).toBe('第 3 行，第 1 列');
  });

  it('formatAnnouncement 纯函数：行/列 1 起，有选区附选中字符数', () => {
    expect(formatAnnouncement(0, 1, null)).toBe('第 1 行，第 1 列');
    expect(formatAnnouncement(2, 3, 8)).toBe(
      '第 3 行，第 3 列，已选中 8 个字符'
    );
    // 选中数为 0（选区折叠）不附加
    expect(formatAnnouncement(0, 1, 0)).toBe('第 1 行，第 1 列');
  });
});

describe('SelectionHighlight 选区层（R4-H）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('选区层 aria-hidden：装饰性高亮对屏幕阅读器隐藏', () => {
    // 引擎容器与 React 挂载宿主彻底分离：createRoot 首次渲染会清空挂载
    // 容器内的既有 DOM，故手写的行元素（引擎容器）不能是 React 根容器的
    // 后代——React 只接管独立的 reactHost，engine 挂在其兄弟位
    const engine = document.createElement('div');
    engine.className = 'engine-container';
    const line = document.createElement('div');
    line.setAttribute('data-line-start', '0');
    line.setAttribute('data-line-length', '3');
    line.setAttribute('data-line-index', '0');
    const text = document.createElement('span');
    text.setAttribute('data-token-start', '0');
    text.setAttribute('data-token-length', '3');
    text.setAttribute('data-source-role', 'text');
    text.textContent = '第一行';
    line.appendChild(text);
    engine.appendChild(line);
    const reactHost = document.createElement('div');
    const mountHost = document.createElement('div');
    mountHost.appendChild(reactHost);
    mountHost.appendChild(engine);
    document.body.appendChild(mountHost);

    const store = createEditorStore();
    store.getState().setText(DOC);
    store.getState().setSelection(0, 3);
    const measuredText: string[] = [];
    const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        measuredText.push(this.toString());
        return [new DOMRect(0, 0, 30, 20)];
      },
    });

    const root: Root = createRoot(reactHost);
    try {
      act(() => {
        root.render(React.createElement(SelectionHighlight, {
          containerRef: { current: engine },
          store,
        }));
      });
      const layer = document.querySelector('.selection-layer') as HTMLDivElement;
      expect(layer).not.toBeNull();
      expect(measuredText).toContain('第一行');
      expect(layer.querySelectorAll('.selection-rect')).toHaveLength(1);
      expect(layer.getAttribute('aria-hidden')).toBe('true');
    } finally {
      act(() => root.unmount());
      if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
      else delete (Range.prototype as unknown as Record<string, unknown>).getClientRects;
    }
  });
});
