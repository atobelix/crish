// tests/unit/stream-frame-batch.test.ts
// W1-1（D-4）StreamBuffer 引擎内接线：不可直刷 chunk 帧聚合提交
//（docs/streaming-render/00-流式渲染极致化总方案.md W1-1 包）。
//
// 覆盖（任务书三项）：
// 1. S-T-1-01：500 token/s 注入（100 个不可直刷 chunk、2ms 间隔模拟）
//    → appendText（React 提交）次数 ≤ 帧数（约 13 vs 现状 100）；
// 2. S-T-1-02：顺序不变量（R-2）——直刷/不可直刷混合注入 + 伪随机间隔
//    + 帧交错，flush 后 store 全文 = 注入顺序拼接（逐字符比对）；
// 3. 交叉顺序专项：buffer 有累积时直刷先 flush buffer 再直写（提交序 =
//    到达序，R-2 的交叉场景）；
// 4. S-T-1-06：capture 键 / 滚动 / streamEnd / 卸载四类时机触发后
//    store 文本完整（buffer 无残留——帧推进后无重复提交）。
//
// rAF stub 先例 stream-buffer.test.ts（fake timers + rAF = setTimeout 16ms）；
// 挂载模式仿 selection-protect（jsdom + FakeResizeObserver + measure mock）。
// @vitest-environment jsdom

import './helpers/layout-fixture';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import {
  MarkdownEngine,
  type MarkdownEngineHandle,
} from '../../src/components/MarkdownEngine';
import {
  createEditorStore,
  type EditorStore,
} from '../../src/core/EditorStore';

// measure 模块部分 mock：jsdom 无布局，固定测量结果（selection-protect
// 同款模式；BlockRenderer 依赖的渲染热路径保留真实实现）
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
 * jsdom 无布局/无 ResizeObserver：同步回调的假 ResizeObserver 使虚拟化
 * 窗口在 act 内收敛（selection-protect 同款）。
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

// —— 挂载生命周期管理（afterEach 统一卸载，防跨用例污染）——
const mountedRoots: Root[] = [];

beforeEach(() => {
  // W1-1 帧聚合依赖 rAF：stub 为 16ms 定时器（stream-buffer.test.ts 先例），
  // fake timers 手动推进帧——测试可精确控制「帧边界」提交时点
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(cb, 16)
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const r of mountedRoots) {
    act(() => r.unmount());
  }
  mountedRoots.length = 0;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
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
  return { container, root, getHandle: () => handle! };
}

/** 不可直刷 chunk（数字在 DIRECT_STREAM_FORBIDDEN_CHARS 禁集内） */
function indirectChunk(i: number): string {
  return `第${i}行`;
}

describe('W1-1 StreamBuffer 引擎内接线（D-4 帧聚合）', () => {
  it('S-T-1-01 500 token/s 帧聚合：100 个不可直刷 chunk 提交次数 ≤ 帧数（现状 100 次）', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    // spy 计数 appendText = React 提交次数（每次提交恰一次 appendText）
    const appendSpy = vi.spyOn(store.getState(), 'appendText');

    // 模拟 500 token/s（2ms 间隔）：rAF stub 帧周期 16ms → 100 token
    // 覆盖约 200ms ≈ 13 帧 → 聚合后提交 ≈ 每帧 1 次
    const chunks = Array.from({ length: 100 }, (_, i) => indirectChunk(i));
    for (const c of chunks) {
      act(() => {
        vi.advanceTimersByTime(2);
        getHandle().streamAppend(c);
      });
    }
    // 注入完成即断言：提交次数远小于 chunk 数（帧聚合已生效）
    const duringInject = appendSpy.mock.calls.length;
    const maxFrames = Math.ceil((chunks.length * 2) / 16) + 2;
    expect(duringInject).toBeLessThanOrEqual(maxFrames);
    expect(duringInject).toBeLessThan(chunks.length / 2);

    // 收口：推进帧 + streamEnd（显式 flush buffer）
    act(() => {
      vi.advanceTimersByTime(1000);
      getHandle().streamEnd();
    });
    const total = appendSpy.mock.calls.length;
    expect(total).toBeLessThanOrEqual(maxFrames);
    expect(total).toBeLessThan(chunks.length);
    // 提交文本完整 = 注入拼接（顺序不变量底线）
    expect(store.getState().getText()).toBe('seed' + chunks.join(''));
    // streamEnd 后无残留：再推进帧无新提交（buffer 已空、rAF 已取消）
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(appendSpy.mock.calls.length).toBe(total);
  });

  it('S-T-1-02 顺序不变量（R-2）：直刷/不可直刷混合 + 伪随机间隔 + 帧交错，store 全文 = 到达顺序拼接', () => {
    const store = createEditorStore();
    store.getState().setText('seed\n');
    const { getHandle } = mountEngine(store);
    const appendSpy = vi.spyOn(store.getState(), 'appendText');

    // 确定性伪随机（固定种子 LCG）：间隔 0-5ms 抖动，每 5 个 chunk 推进
    // 一次完整帧（覆盖「帧内累积」「帧跨边界」「帧回调提交中再注入」）
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const delay = () => Math.floor(rnd() * 6);

    // 混合序列：直刷 chunk（纯文本，canDirect 命中）与不可直刷 chunk
    //（含数字/换行/语法字符，canDirect 未命中）交替，覆盖全部交叉形态
    const directs = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const indirects = ['\n第2段', '42', '\n| a | b |', '# 标题', '~x~'];
    const seq: string[] = [];
    for (let i = 0; i < 20; i++) {
      seq.push(
        i % 2 === 0
          ? directs[(i / 2) % directs.length]
          : indirects[Math.floor(i / 2) % indirects.length]
      );
    }

    for (let i = 0; i < seq.length; i++) {
      act(() => {
        vi.advanceTimersByTime(delay());
        getHandle().streamAppend(seq[i]);
        // 每 5 个 chunk 跨一次帧边界（部分批在帧内提交、部分留到帧后）
        if ((i + 1) % 5 === 0) vi.advanceTimersByTime(16);
      });
    }
    // 注入过程中（未收口）：可能存在尚未提交的直刷累积/buffer 累积
    //（提交序断言以收口后为准；此处不约束中间态）

    // 收口：flush 全部（直刷累积 + buffer 累积 + 尾段合并）
    act(() => {
      vi.advanceTimersByTime(1000);
      getHandle().streamEnd();
    });
    // 顺序不变量（R-2）：store 全文 = 到达顺序拼接（逐字符比对）
    expect(store.getState().getText()).toBe('seed\n' + seq.join(''));
    // 提交序 = 到达序：appendText 各次收到的文本按序拼接 = 注入全文
    const submitted = appendSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(submitted).toBe(seq.join(''));
    // 无残留：再推进帧无新提交
    const totalAfterEnd = appendSpy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(appendSpy.mock.calls.length).toBe(totalAfterEnd);
  });

  it('交叉顺序专项（R-2）：帧队列保留后续到达顺序，不写入旧末行', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const appendSpy = vi.spyOn(store.getState(), 'appendText');

    // 队列非空后所有后续内容继续入队，避免刷新队列后误用旧末行引用。
    // W2-2 调整：d 原为 '42'（数字当时在禁集，天然降级）；数字放开后不再
    // 构成降级触发，改用仍禁的 `&` 保持「混合路径 + 提交序」测试意图。
    act(() => {
      getHandle().streamAppend('alpha'); // 直刷：pending = 'alpha'
    });
    expect(store.getState().getText()).toBe('seed'); // 直刷延迟提交
    act(() => {
      getHandle().streamAppend('\n第2段'); // 降级：先提交 pending('alpha') 再入 buffer
    });
    expect(store.getState().getText()).toBe('seedalpha'); // 'alpha' 已提交；'\n第2段' 待帧
    act(() => {
      getHandle().streamAppend('beta');
    });
    expect(store.getState().getText()).toBe('seedalpha');
    act(() => {
      getHandle().streamAppend('&42');
    });
    expect(store.getState().getText()).toBe('seedalpha');
    expect(appendSpy.mock.calls.map(call => call[0])).toEqual(['alpha']);
    act(() => {
      getHandle().streamEnd();
    });
    // 提交序 = 到达序：alpha → \n第2段 → beta → &42
    const submitted = appendSpy.mock.calls.map((c) => c[0] as string);
    expect(submitted.join('')).toBe('alpha\n第2段beta&42');
    expect(store.getState().getText()).toBe('seedalpha\n第2段beta&42');
    // 无残留：再推进帧无新提交（rAF 已由 flush 取消）
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(appendSpy.mock.calls.length).toBe(submitted.length);
  });

  it('S-T-1-06a capture 键事件：buffer 非空时 keydown 触达 → store 立即完整（无残留）', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { container, getHandle } = mountEngine(store);
    const appendSpy = vi.spyOn(store.getState(), 'appendText');

    act(() => {
      getHandle().streamAppend('\n第1行'); // 降级入 buffer（帧未到）
    });
    expect(store.getState().getText()).toBe('seed'); // 尚未提交
    // capture 相位监听在 parentRef（滚动容器）——dispatch 冒泡事件到
    // 容器内任意节点即经 capture 相位触达
    act(() => {
      container
        .querySelector('.editor-scroll-container')!
        .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    });
    // buffer 同步吐出：store 完整（无待帧残留）
    expect(store.getState().getText()).toBe('seed\n第1行');
    // 无重复提交：rAF 已由 flush 取消，推进帧后计数不变
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(appendSpy.mock.calls.length).toBe(1);
  });

  it('S-T-1-06b 滚动触达：buffer 非空时 scroll 事件 → store 完整（无残留）', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { container, getHandle } = mountEngine(store);
    const appendSpy = vi.spyOn(store.getState(), 'appendText');

    act(() => {
      getHandle().streamAppend('\n第1行');
    });
    expect(store.getState().getText()).toBe('seed');
    act(() => {
      container
        .querySelector('.editor-scroll-container')!
        .dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(store.getState().getText()).toBe('seed\n第1行');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(appendSpy.mock.calls.length).toBe(1);
  });

  it('S-T-1-06c streamEnd：buffer 非空时 streamEnd → store 完整 + 尾段合并收口 + 无残留', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const appendSpy = vi.spyOn(store.getState(), 'appendText');

    act(() => {
      getHandle().streamAppend('\n第1行');
      getHandle().streamAppend('\n| a | b |');
    });
    expect(store.getState().getText()).toBe('seed'); // 帧未到，未提交
    act(() => {
      getHandle().streamEnd();
    });
    // buffer 同步吐出 + flushStreamTail 合并（R3-A 单 undo 步收口）
    expect(store.getState().getText()).toBe('seed\n第1行\n| a | b |');
    expect(store.getState().streamOp).toBeNull();
    // 无残留：推进帧后计数不变
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(appendSpy.mock.calls.length).toBe(1);
  });

  it('S-T-1-06d 卸载 cleanup：buffer 非空时 unmount → store 完整（buffer 无残留）', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { root, getHandle } = mountEngine(store);
    const appendSpy = vi.spyOn(store.getState(), 'appendText');

    act(() => {
      getHandle().streamAppend('\n第1行');
    });
    expect(store.getState().getText()).toBe('seed');
    // 宿主未调 streamEnd 即卸载：cleanup = flushStreamBuffer + dispose
    act(() => {
      root.unmount();
      const idx = mountedRoots.indexOf(root);
      if (idx >= 0) mountedRoots.splice(idx, 1);
    });
    expect(store.getState().getText()).toBe('seed\n第1行');
    // 无残留：dispose 已取消挂起 rAF，推进帧无新提交
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(appendSpy.mock.calls.length).toBe(1);
  });
});
