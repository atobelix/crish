// tests/unit/store-factory.test.ts
// R5 实例工厂（createEditorStore，06 §8 宿主集成接口 / 05 §2.4 文档工作区前置）
//
// 背景：引擎原为全局单例 store（useEditorStore），宿主文档工作区/多面板
// 需要多实例并行——createEditorStore() 每次构建独立 zustand store：
// - 独立 state / 独立订阅 / 独立 dispatchSet 闭包（setState 归一 + 视图物化）；
// - 分块加载代际计数为实例内局部（setText 竞态保护不跨实例取消）；
// - store body 内薄封装（insertText/applyChange 等）经实例内 get() 路由，
//   不再引用全局单例（旧实现的串台隐患在实例化重构中根除）。
// 本文件验证双实例隔离 + 全链可用 + 与全局单例互不影响（R5 验收）。

import { describe, it, expect } from 'vitest';
import { createEditorStore, useEditorStore } from '../../src/core/EditorStore';

describe('createEditorStore 实例工厂（R5）', () => {
  it('1a setText 隔离：A 设置内容不影响 B（B 保持初始空文档）', () => {
    const a = createEditorStore();
    const b = createEditorStore();
    a.getState().setText('alpha\nbeta');
    expect(a.getState().getText()).toBe('alpha\nbeta');
    expect(b.getState().getText()).toBe('');
    expect(b.getState().getLineCount()).toBe(1);
    expect(b.getState().getLine(0)).toBe('');
  });

  it('1b appendText 隔离：双实例并行流式互不干扰', () => {
    const a = createEditorStore();
    const b = createEditorStore();
    a.getState().appendText('stream-A');
    b.getState().appendText('stream-B');
    expect(a.getState().getText()).toBe('stream-A');
    expect(b.getState().getText()).toBe('stream-B');
    expect(a.getState().getLineCount()).toBe(1);
    expect(b.getState().getLineCount()).toBe(1);
  });

  it('1c 光标/选区隔离：A 移动光标不影响 B', () => {
    const a = createEditorStore();
    const b = createEditorStore();
    a.getState().setText('hello world');
    b.getState().setText('second doc');
    a.getState().setCursorPos(5);
    a.getState().setSelection(2, 7);
    // setSelection 既有契约：cursorPos 恒等于 end（选区活动端）
    expect(a.getState().cursorPos).toBe(7);
    expect(a.getState().selectionStart).toBe(2);
    expect(a.getState().selectionEnd).toBe(7);
    expect(b.getState().cursorPos).toBe(0);
    expect(b.getState().selectionStart).toBe(0);
    expect(b.getState().selectionEnd).toBe(0);
  });

  it('1d undo/redo 隔离：A 撤销不影响 B 的编辑历史', () => {
    const a = createEditorStore();
    const b = createEditorStore();
    a.getState().setText('alpha');
    b.getState().setText('bravo');
    // A 追加一段流式并收口（进 undo 栈的仅用户编辑步）
    a.getState().setCursorPos(5);
    a.getState().insertText('!');
    expect(a.getState().getText()).toBe('alpha!');
    a.getState().undo();
    expect(a.getState().getText()).toBe('alpha');
    // B 无 undo 历史：undo 空操作，内容不变
    b.getState().undo();
    expect(b.getState().getText()).toBe('bravo');
    expect(b.getState().undoStack.length).toBe(0);
  });

  it('1e 工厂实例与全局单例互不影响', () => {
    const inst = createEditorStore();
    const before = useEditorStore.getState().getText();
    inst.getState().setText('instance-only');
    inst.getState().appendText(' +tail');
    expect(inst.getState().getText()).toBe('instance-only +tail');
    expect(useEditorStore.getState().getText()).toBe(before);
  });

  it('1f 工厂实例全链可用：setText/appendText/insertText + 一致性', () => {
    const inst = createEditorStore();
    inst.getState().setText('a\nb\nc');
    inst.getState().appendText('\nd');
    expect(inst.getState().getText()).toBe('a\nb\nc\nd');
    // 编辑路径（mergeTailInto → applyChange）在实例上同样收敛
    inst.getState().setCursorPos(inst.getState().getText().length);
    inst.getState().insertText('!');
    expect(inst.getState().getText()).toBe('a\nb\nc\nd!');
    // 行偏移树/文本长度/块状态全链一致（既有 verifyConsistency 校验）
    expect(inst.getState().verifyConsistency()).toBe(true);
  });

  it('1g 订阅隔离：A 的 set 不触发 B 的监听器', () => {
    const a = createEditorStore();
    const b = createEditorStore();
    let bTicks = 0;
    const unsub = b.subscribe(() => {
      bTicks++;
    });
    a.getState().setText('change-A');
    a.getState().appendText(' +more');
    expect(bTicks).toBe(0);
    unsub();
    // A 自身订阅正常触发（对照）
    let aTicks = 0;
    const unsubA = a.subscribe(() => {
      aTicks++;
    });
    a.getState().appendText(' +even-more');
    expect(aTicks).toBeGreaterThan(0);
    unsubA();
  });

  it('1h 独立视图物化：实例 A 的兼容视图不与 B 串（双段结构独立）', () => {
    const a = createEditorStore();
    const b = createEditorStore();
    a.getState().setText('doc-A');
    b.getState().setText('doc-B');
    // 流式期间尾段物化视图（concat 路径）同样按实例隔离
    a.getState().appendText('\nA2');
    expect(a.getState().lines).toEqual(['doc-A', 'A2']);
    expect(b.getState().lines).toEqual(['doc-B']);
    expect(b.getState().streamTail.length).toBe(0);
  });

  it('1i 分块加载代际隔离：A 的大文档分块不被 B 取消，B 同步完成', async () => {
    const a = createEditorStore();
    const b = createEditorStore();
    // >1000 行走异步分块路径（node 下经 setTimeout 逐块推进）；
    // 若代际计数是全局的，B 的 setText 会推进全局代际使 A 的分块作废
    const big = Array.from({ length: 2500 }, (_, i) => `line-${i}`).join('\n');
    a.getState().setText(big);
    // B 的小文档走同步路径（≤1000 行），立即完成——不受 A 分块影响
    b.getState().setText('b-doc');
    expect(b.getState().getText()).toBe('b-doc');
    // A 的分块加载继续推进到完整文档（不被 B 的代际取消）
    const deadline = Date.now() + 10000;
    while (a.getState().getLineCount() < 2500 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(a.getState().getLineCount()).toBe(2500);
    expect(a.getState().getText()).toBe(big);
    expect(a.getState().verifyConsistency()).toBe(true);
  });
});
