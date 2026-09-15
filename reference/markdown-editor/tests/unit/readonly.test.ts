// tests/unit/readonly.test.ts
// R5 readOnly 只读渲染模式（05 §2.2 消息历史渲染器定位 / 06 §8 props readOnly）
//
// 背景：宿主把聊天历史渲染交给引擎——只读模式隐藏输入层
// （HiddenInput/CursorLayer/SelectionHighlight）、点击不移动光标（保留原生
// 选区与选择复制）、滚动/虚拟化/token 映射全保留；流式追加（appendText /
// streamAppend 走 store）仍可用——渲染层由 store 订阅驱动增量更新，
// readOnly 渲染 + 流式追加天然兼容（数据源契约不变，仅展示层禁编辑）。
//
// 测试策略（node 环境无 DOM/jsdom，遵循既有 unit 测试惯例）：
// - 组件结构契约经 react-dom/server renderToString 验证：readOnly=true 时
//   data-readonly 标记 + 输入层组件整体不渲染（条件渲染排除）；
// - 流式追加兼容经 store 订阅链路验证：appendText 后订阅触发、访问器读到
//   新内容——这正是 readOnly 渲染层「增量更新可见」的驱动源；
// - 只读语义（append 不进 undo、不移动光标）在 store 层验证。

import './helpers/layout-fixture';
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { MarkdownEngine } from '../../src/components/MarkdownEngine';
import { createEditorStore } from '../../src/core/EditorStore';

describe('MarkdownEngine readOnly 只读模式（R5）', () => {
  it('1a readOnly=true：输入层不渲染 + data-readonly 标记 + 滚动容器保留', () => {
    const store = createEditorStore();
    store.getState().setText('alpha\nbeta\ngamma');
    const html = renderToString(
      React.createElement(MarkdownEngine, { store, readOnly: true })
    );
    // 只读标记
    expect(html).toContain('data-readonly="true"');
    // 输入捕获层全部不渲染（HiddenInput textarea / 光标层 / 选区高亮 /
    // a11y 播报节点均属输入层组件，readOnly 下条件渲染排除）
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('cursor-caret');
    expect(html).not.toContain('selection-layer');
    expect(html).not.toContain('a11y-live-region');
    // 滚动/虚拟化容器结构保留（readOnly 只禁编辑不禁浏览）
    expect(html).toContain('engine-container');
    expect(html).toContain('editor-scroll-container');
  });

  it('1b readOnly=false：无 data-readonly（缺省编辑态向后兼容）', () => {
    const store = createEditorStore();
    const html = renderToString(
      React.createElement(MarkdownEngine, { store })
    );
    expect(html).not.toContain('data-readonly');
  });

  it('1c 缺省 store prop 回退全局单例（SSR 冒烟：组件契约完整）', () => {
    const html = renderToString(React.createElement(MarkdownEngine, {}));
    expect(html).toContain('engine-container');
    expect(html).toContain('editor-scroll-container');
  });

  it('2a 流式追加兼容：appendText 后订阅触发 + 访问器读到新内容', () => {
    const store = createEditorStore();
    store.getState().setText('hello');
    // 模拟 readOnly 渲染层的订阅链路（MarkdownEngine 订阅 main*/streamTail
    // 信号 + getLine 惰性读取——此处以 store.subscribe 等价验证数据源）
    let ticks = 0;
    let lastCount = store.getState().getLineCount();
    const unsub = store.subscribe((s) => {
      ticks++;
      lastCount = s.getLineCount();
    });
    store.getState().appendText('\nworld');
    expect(store.getState().getText()).toBe('hello\nworld');
    expect(store.getState().getLine(1)).toBe('world');
    expect(lastCount).toBe(2);
    expect(ticks).toBeGreaterThan(0);
    unsub();
  });

  it('2b 多 chunk 流式 + 收口（readOnly 宿主场景：append → flushStreamTail）', () => {
    const store = createEditorStore();
    store.getState().setText('# 标题');
    store.getState().appendText('\n第一段');
    store.getState().appendText('持续输出');
    // 渲染数据源按行可读（渲染层增量更新的消费视图）
    const count = store.getState().getLineCount();
    const lines: string[] = [];
    for (let i = 0; i < count; i++) lines.push(store.getState().getLine(i));
    expect(lines).toEqual(['# 标题', '第一段持续输出']);
    // 流式收口（宿主流式结束）：尾段并入主数组，内容不丢失
    store.getState().flushStreamTail();
    expect(store.getState().getText()).toBe('# 标题\n第一段持续输出');
    expect(store.getState().streamTail.length).toBe(0);
  });

  it('2c 只读流式语义：append 不进 undo 栈（流式契约在只读场景不变）', () => {
    const store = createEditorStore();
    store.getState().setText('base');
    store.getState().appendText(' +stream');
    expect(store.getState().undoStack.length).toBe(0);
    // append 光标平移契约：光标不在追加点（全文末尾）之后 → 不平移，
    // 保持原位置（setText 重置光标到 0）
    expect(store.getState().cursorPos).toBe(0);
    expect(store.getState().textLength).toBe(12);
    // 光标恰在末尾时随追加推进（wasAtEnd 语义）
    store.getState().setCursorPos(12);
    store.getState().appendText('!');
    expect(store.getState().cursorPos).toBe(13);
  });

  it('3a 渲染层只读契约：readOnly 是纯展示 prop，store 全链 API 不受影响', () => {
    const store = createEditorStore();
    store.getState().setText('a\nb');
    // 先以只读姿态渲染一次（验证组件不修改 store）
    renderToString(
      React.createElement(MarkdownEngine, { store, readOnly: true })
    );
    expect(store.getState().getText()).toBe('a\nb');
    // 渲染后 store 仍可正常编辑/流式（只读只作用于展示层）
    store.getState().setCursorPos(2);
    store.getState().insertText('X');
    // pos 2 位于 'a\nb' 的 '\n' 之后（'b' 之前），插入得到 'a\nXb'
    expect(store.getState().getText()).toBe('a\nXb');
    // 光标移到全文末尾再流式追加（追加点 = 末尾 → 'a\nXb\nc'）
    store.getState().setCursorPos(store.getState().textLength);
    store.getState().appendText('\nc');
    expect(store.getState().getText()).toBe('a\nXb\nc');
    expect(store.getState().verifyConsistency()).toBe(true);
  });
});
