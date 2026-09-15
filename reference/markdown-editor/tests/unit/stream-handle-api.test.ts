// tests/unit/stream-handle-api.test.ts
// W3-1 包（docs/streaming-render/00-流式渲染极致化总方案.md：S-EL-09 / D-7 /
// D-8，验收断言 S-T-3-01）：MarkdownEngineHandle 扩展 API 语义单测——
// getStreamState / onStreamEnd / discardStream / getContent / exportHtml。
//
// 覆盖（S-T-3-01 语义单测：状态机转移 / 回调触发 / 导出含直刷累积）：
// 1. getStreamState 四字段在空闲/直刷注入/帧聚合/收口各状态正确（对照
//    MarkdownEngine.tsx:1379-1387 实现体读 ref 语义）：
//    - active = store.streamActive——直刷期间 store 滞后（appendText 未调）
//      → false，flush 后置位 true，streamEnd stop-flush 后熄灭 false；
//    - bufferedChars = StreamBuffer.pending——降级 chunk 入帧聚合缓冲 >0，
//      flushStream 同步吐出后归零；
//    - directPendingChars = pendingStreamRef.length——直刷累积 >0，
//      flush 后归零；
//    - followState 三态（W1-2 D-3）：初始 'follow'；用户上滚离开尾部
//      （距底 > 20px）→ 'paused'；滚回尾部 20px 内 → 'follow'。
// 2. onStreamEnd 完成信号：
//    - streamEnd 正常收口触发 { flushed:true, discarded:false } 恰一次；
//    - 重复 streamEnd 幂等不重复触发；无会话的 streamEnd 不触发；
//    - discardStream 触发 { flushed:true, discarded:true }；
//    - 解绑函数生效（幂等，可重复调用）；多次注册分别触发；单个回调
//      抛错被引擎 try/catch 隔离，不打断收口与其他回调。
// 3. discardStream 中断丢弃（D-7 / S-EL-06）：
//    - 可编辑会话：flush（直刷累积 + 帧聚合缓冲）→ stop-flush 收口
//      meta:'stream' op → 撤销单步精确回到会话前（撤销产物留 redo 栈，
//      redo 可恢复被丢弃内容——D-7「后悔键」语义）；
//    - 只读快路径：截断到会话起点文本长度（setText 整档重置，不污染
//      undo/redo/changeLog/version/lastUserEditTime——后续会话的只读
//      快路径门禁不被破坏，S-EL-08）；
//    - 幂等：无进行中会话再调为空操作（不触发回调）；
//    - streamEnd 后用户继续编辑（栈顶为普通 op）时不误伤撤销用户工作；
//    - 会话起点标志复位：discard 后新会话按新起点重新探测。
// 4. getContent/exportHtml 导出聚合（D-8）：直刷累积在取数/导出前先
//    flush（store 滞后语义透明化——未 flush 的 getText 不含直刷累积）；
//    exportHtml 返回非空 HTML 字符串且含直刷文本内容。
//
// 挂载模式仿 stream-unmount-flush / stream-follow-scroll 测试：jsdom +
// FakeResizeObserver 收敛虚拟化窗口（视口 2000px，全部测试行入窗——直刷
// 依赖末行 tokenEl 挂载）+ measure 模块 mock 固定坐标 + offsetHeight stub
// （jsdom 无布局，行高固定 28px）。followState 用例对滚动容器 stub 动态
// 内容高度（28px × 行数 + 基底）模拟真实几何，scroll 事件走用户滚动
// 模拟（原 scrollTop setter + dispatchEvent）。
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

// measure 模块部分 mock（jsdom 无布局）：固定测量结果——stream-unmount-flush
// 同款模式（BlockRenderer 依赖的渲染热路径保留真实实现）
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
 * 同步回调的假 ResizeObserver——observe 时立即上报固定尺寸（2000×800，
 * 行高 28px → 约 71 行入窗，本文件 1-4 行文档全部挂载——直刷依赖末行
 * 入窗拿到 tokenEl，视口必须覆盖全部行）。
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
          borderBoxSize: [{ blockSize: 2000, inlineSize: 800 }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {}
  disconnect() {}
}

const mountedRoots: Root[] = [];

// jsdom 无布局：offsetHeight 恒 0 → 批量测量把行高回填为 0 → 零高行使
// tanstack 窗口范围膨胀（stream-unmount-flush 同款收敛：实测 = 预测 → 稳定点
// 护栏跳过回填，测量立即收敛）
const REAL_ROW_HEIGHT = 28;
const origOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight'
);

// —— 滚动几何原型 descriptor 快照（followState 用例 stub；afterEach 恢复，
// 防跨用例污染）——
const ORIG_SCROLL_TOP = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollTop'
)!;
const ORIG_SCROLL_HEIGHT = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollHeight'
)!;
const ORIG_CLIENT_HEIGHT = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'clientHeight'
)!;

// followState 用例的固定视口高度与内容高度基底（与 stream-follow-scroll
// 同口径：跟随判定 = scrollHeight - scrollTop - clientHeight ≤ 20px 贴底）
const CLIENT_HEIGHT = 800;
const GEOM_BASE = 100;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return REAL_ROW_HEIGHT;
    },
  });
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

afterEach(() => {
  for (const r of mountedRoots) {
    act(() => r.unmount());
  }
  mountedRoots.length = 0;
  document.body.innerHTML = '';
  if (origOffsetHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      'offsetHeight',
      origOffsetHeight
    );
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .offsetHeight;
  }
  Object.defineProperty(Element.prototype, 'scrollTop', ORIG_SCROLL_TOP);
  Object.defineProperty(Element.prototype, 'scrollHeight', ORIG_SCROLL_HEIGHT);
  Object.defineProperty(Element.prototype, 'clientHeight', ORIG_CLIENT_HEIGHT);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// —— 滚动几何 stub 工厂（followState 用例专用）——
// jsdom 无布局：scrollHeight/clientHeight 恒 0。stub 滚动容器为动态
// 内容高度（28px × 当前行数 + GEOM_BASE），模拟真实浏览器的滚动几何。
// userSet = 「用户滚动模拟」：原 setter 写 scrollTop + 派发 scroll 事件
// （引擎 onScroll 监听 handleScrollFlush 据此更新 followState，与
// stream-follow-scroll 同款机制）。
function installScrollStubs(store: EditorStore) {
  const contentHeight = () => GEOM_BASE + 28 * store.getState().getLineCount();
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      if (this.classList?.contains('editor-scroll-container')) {
        return contentHeight();
      }
      return ORIG_SCROLL_HEIGHT.get!.call(this);
    },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      if (this.classList?.contains('editor-scroll-container')) {
        return CLIENT_HEIGHT;
      }
      return 0;
    },
  });
  return {
    contentHeight,
    userSet(el: HTMLElement, v: number) {
      ORIG_SCROLL_TOP.set!.call(el, v);
      el.dispatchEvent(new Event('scroll'));
    },
  };
}

// 滚动容器（引擎 parentRef 容器，follow 判定作用对象）
function scroller(): HTMLElement {
  return document.querySelector('.editor-scroll-container')! as HTMLElement;
}

describe('W3-1 getStreamState 状态查询（S-EL-09）', () => {
  it('1a 空闲态四字段初值：active=false / bufferedChars=0 / directPendingChars=0 / followState=follow', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    expect(getHandle().getStreamState()).toEqual({
      active: false,
      bufferedChars: 0,
      directPendingChars: 0,
      followState: 'follow',
    });
  });

  it('1b 直刷注入中 store 滞后：directPendingChars=累积长度 / active=false；flush 后归零且 active 置位；streamEnd 后熄灭', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    // 直刷路径：chunk 无换行、合并后纯文本 → DOM 直写 + pending 累积
    act(() => {
      getHandle().streamAppend('hello');
    });
    // 直刷期间 store 未提交：streamActive 仍 false（appendText 未调），
    // pending 不入帧聚合缓冲（bufferedChars=0），仅 directPendingChars
    // 反映未提交直刷累积（StreamState 注释：宿主应结合该字段判断）
    expect(getHandle().getStreamState()).toEqual({
      active: false,
      bufferedChars: 0,
      directPendingChars: 5,
      followState: 'follow',
    });
    expect(store.getState().getText()).toBe('seed');
    // flush：直刷累积提交 → directPendingChars 归零，appendText 置位
    // streamActive（active=true）
    act(() => {
      getHandle().flushStream();
    });
    expect(getHandle().getStreamState()).toEqual({
      active: true,
      bufferedChars: 0,
      directPendingChars: 0,
      followState: 'follow',
    });
    // streamEnd：stop-flush 熄灭 streamActive（active=false）
    act(() => {
      getHandle().streamEnd();
    });
    expect(getHandle().getStreamState().active).toBe(false);
    expect(store.getState().getText()).toBe('seedhello');
  });

  it('1c 降级 chunk 帧聚合：bufferedChars=缓冲累积；flushStream 同步吐出后归零', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    // 含换行 chunk → 不可直刷 → 入帧聚合缓冲（W1-1：rAF 帧边界批量提交；
    // flushStream 显式提交可同步吐出，不等 rAF）
    act(() => {
      getHandle().streamAppend('\n第二行');
      getHandle().streamAppend('\n第三行');
    });
    // '\n第二行' + '\n第三行' = 4 + 4 = 8 字符（各含 1 换行 + 3 汉字）
    expect(getHandle().getStreamState().bufferedChars).toBe(8);
    expect(getHandle().getStreamState().directPendingChars).toBe(0);
    act(() => {
      getHandle().flushStream();
    });
    const s = getHandle().getStreamState();
    expect(s.bufferedChars).toBe(0);
    expect(s.directPendingChars).toBe(0);
    expect(s.active).toBe(true);
    expect(store.getState().getText()).toBe('seed\n第二行\n第三行');
  });

  it('1d followState 三态：初始 follow；用户上滚离开尾部 → paused；滚回尾部 → follow', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const scroll = installScrollStubs(store);
    const el = scroller();
    const maxTop = () => scroll.contentHeight() - CLIENT_HEIGHT;

    // 初始未滚动 → follow（引擎默认贴底跟随）
    expect(getHandle().getStreamState().followState).toBe('follow');
    // 用户上滚离开尾部（距底 100px > FOLLOW_EDGE_PX=20）→ 阅读态暂停
    scroll.userSet(el, maxTop() - 100);
    expect(getHandle().getStreamState().followState).toBe('paused');
    // 用户滚回尾部（距底 0 ≤ 20px）→ 恢复跟随
    scroll.userSet(el, maxTop());
    expect(getHandle().getStreamState().followState).toBe('follow');
  });
});

describe('W3-1 onStreamEnd 完成信号（S-EL-09）', () => {
  it('2a 正常收口：streamEnd 触发 { flushed:true, discarded:false } 恰一次；重复调用不重复触发', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const cb = vi.fn();
    act(() => {
      getHandle().onStreamEnd(cb);
    });
    act(() => {
      getHandle().streamAppend('hello');
    });
    act(() => {
      getHandle().streamEnd();
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ flushed: true, discarded: false });
    // 幂等：重复 streamEnd 无会话痕迹 → 不重复触发
    act(() => {
      getHandle().streamEnd();
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('2b 无会话的 streamEnd 不触发回调', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const cb = vi.fn();
    act(() => {
      getHandle().onStreamEnd(cb);
    });
    act(() => {
      getHandle().streamEnd();
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('2c discardStream 触发 { flushed:true, discarded:true }', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const cb = vi.fn();
    act(() => {
      getHandle().onStreamEnd(cb);
    });
    act(() => {
      getHandle().streamAppend('hello');
    });
    act(() => {
      getHandle().discardStream();
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ flushed: true, discarded: true });
  });

  it('2d 解绑函数生效（幂等可重复调用）：解绑后会话结束不再触发', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const cb = vi.fn();
    let unbind: () => void = () => {};
    act(() => {
      unbind = getHandle().onStreamEnd(cb);
    });
    act(() => {
      getHandle().streamAppend('one');
      getHandle().streamEnd();
    });
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => {
      unbind();
      // 幂等：重复解绑不抛错
      unbind();
    });
    // 新会话收口不再通知已解绑回调
    act(() => {
      getHandle().streamAppend('two');
      getHandle().streamEnd();
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('2e 多次注册分别触发；单个回调抛错被隔离，不影响其余回调与引擎收口', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('宿主回调异常');
    });
    act(() => {
      getHandle().onStreamEnd(bad);
      getHandle().onStreamEnd(good);
    });
    expect(() => {
      act(() => {
        getHandle().streamAppend('hello');
        getHandle().streamEnd();
      });
    }).not.toThrow();
    // 引擎收口完整（stop-flush 生效）+ 正常回调照常触发
    expect(store.getState().getText()).toBe('seedhello');
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('W3-1 discardStream 中断丢弃（D-7 / S-EL-06）', () => {
  it("3a 可编辑会话：flush → 撤销 meta:'stream' op → 文档精确回退到会话前；redo 可恢复被丢弃内容", () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const cb = vi.fn();
    act(() => {
      getHandle().onStreamEnd(cb);
    });
    // 混合注入：直刷 chunk（pending）+ 含换行 chunk（帧聚合缓冲）
    act(() => {
      getHandle().streamAppend('hello');
      getHandle().streamAppend('\n第二行');
      getHandle().streamAppend('\n第三行');
    });
    // 未 streamEnd 即中断丢弃：内部先 flush（直刷累积 + 缓冲同步吐出）→
    // stop-flush 收口 meta:'stream' op → 撤销该 op 精确回到会话前
    act(() => {
      getHandle().discardStream();
    });
    expect(store.getState().getText()).toBe('seed');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ flushed: true, discarded: true });
    // 撤销产物留在 redo 栈（meta:'stream' 标记保留——redo 可恢复被丢弃内容）
    expect(store.getState().undoStack.length).toBe(0);
    expect(store.getState().redoStack.length).toBe(1);
    expect(store.getState().redoStack[0].meta).toBe('stream');
    // redo 恢复全部流式内容（D-7「后悔键」语义）
    act(() => {
      store.getState().redo();
    });
    expect(store.getState().getText()).toBe('seedhello\n第二行\n第三行');
    expect(store.getState().verifyConsistency()).toBe(true);
  });

  it('3b 只读快路径：截断到会话起点（setText 整档重置，零污染；快路径门禁保持）', () => {
    const store = createEditorStore({ readOnly: true });
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const cb = vi.fn();
    act(() => {
      getHandle().onStreamEnd(cb);
    });
    act(() => {
      getHandle().streamAppend('hello');
      getHandle().streamAppend(' world');
    });
    // 会话起点快照 = 首次 streamAppend 时 textLength（4，'seed'）
    expect(getHandle().getStreamState().directPendingChars).toBe(11);
    act(() => {
      getHandle().discardStream();
    });
    // 文本截断到会话起点；回调 { flushed:true, discarded:true } 一次
    expect(store.getState().getText()).toBe('seed');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ flushed: true, discarded: true });
    // setText 整档重置：undo/redo/changeLog 全空、version 归零、无用户
    // 编辑时间戳——后续会话的只读快路径门禁（readOnly && lastUserEditTime
    // === 0 && streamOp === null）不被破坏（S-EL-08）
    const s = store.getState();
    expect(s.undoStack.length).toBe(0);
    expect(s.redoStack.length).toBe(0);
    expect(s.changeLog.length).toBe(0);
    expect(s.version).toBe(0);
    expect(s.lastUserEditTime).toBe(0);
    expect(s.streamActive).toBe(false);
    // 快路径门禁保持：新会话 append 仍走只读快路径（streamOp 恒 null）
    act(() => {
      getHandle().streamAppend('x');
      getHandle().flushStream();
    });
    const s2 = store.getState();
    expect(s2.streamOp).toBeNull();
    expect(s2.streamActive).toBe(true);
    expect(s2.getText()).toBe('seedx');
  });

  it('3c 幂等：无进行中会话再 discardStream 为空操作（不触发回调、文本不变）', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const cb = vi.fn();
    act(() => {
      getHandle().onStreamEnd(cb);
    });
    act(() => {
      getHandle().discardStream();
      getHandle().discardStream();
    });
    expect(store.getState().getText()).toBe('seed');
    expect(cb).not.toHaveBeenCalled();
  });

  it('3d streamEnd 后用户继续编辑（栈顶为普通 op）：discard 不撤销用户工作', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const cb = vi.fn();
    act(() => {
      getHandle().onStreamEnd(cb);
    });
    // 会话正常收口 → meta:\'stream\' op 入栈（栈底）；收口本身触发
    // 一次 { flushed:true, discarded:false }（基线计数 1）
    act(() => {
      getHandle().streamAppend('hello');
      getHandle().streamEnd();
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith({ flushed: true, discarded: false });
    // 用户继续编辑 → 普通 op 压栈（栈顶非 meta:\'stream\'）
    act(() => {
      store.getState().setSelection(9, 9);
      store.getState().insertText('!');
    });
    expect(store.getState().undoStack.at(-1)?.meta).toBeUndefined();
    // discard：栈顶非流式 op → 不撤销（避免误伤用户工作），回调不新增
    act(() => {
      getHandle().discardStream();
    });
    expect(store.getState().getText()).toBe('seedhello!');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('3e 会话起点标志复位：discard 后新会话按新起点重新探测', () => {
    const store = createEditorStore({ readOnly: true });
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    const cb = vi.fn();
    act(() => {
      getHandle().onStreamEnd(cb);
    });
    // 会话一：注入并丢弃（截断回 'seed'）
    act(() => {
      getHandle().streamAppend('first');
      getHandle().flushStream();
      getHandle().discardStream();
    });
    expect(store.getState().getText()).toBe('seed');
    expect(cb).toHaveBeenCalledTimes(1);
    // 会话二：新起点 = 当前 textLength（4），丢弃同样精确回到 'seed'
    act(() => {
      getHandle().streamAppend('second');
      getHandle().flushStream();
      getHandle().discardStream();
    });
    expect(store.getState().getText()).toBe('seed');
    expect(cb).toHaveBeenCalledTimes(2);
    // 文本树一致性全程保持
    expect(store.getState().verifyConsistency()).toBe(true);
  });
});

describe('W3-1 getContent/exportHtml 导出聚合（D-8）', () => {
  it('4a getContent：直刷累积在取数前先 flush（store 滞后语义透明化）', () => {
    const store = createEditorStore();
    store.getState().setText('seed');
    const { getHandle } = mountEngine(store);
    act(() => {
      getHandle().streamAppend('hello');
      getHandle().streamAppend(' world');
    });
    // 未 flush 的 store 视图不含直刷累积（滞后语义）；聚合 API 先收敛
    expect(store.getState().getText()).toBe('seed');
    expect(getHandle().getStreamState().directPendingChars).toBe(11);
    expect(getHandle().getContent()).toBe('seedhello world');
    // 幂等：无累积时取数空转，文本不重复
    expect(getHandle().getContent()).toBe('seedhello world');
    expect(store.getState().getText()).toBe('seedhello world');
  });

  it('4b exportHtml：直刷累积先 flush；返回非空 HTML 字符串且含直刷内容', () => {
    const store = createEditorStore();
    store.getState().setText('# 标题');
    const { getHandle } = mountEngine(store);
    act(() => {
      getHandle().streamAppend('hello');
    });
    expect(store.getState().getText()).toBe('# 标题');
    const html = getHandle().exportHtml();
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    // 直刷文本在导出前已提交并出现在渲染结果中
    expect(html).toContain('hello');
    // 导出为完成态权威渲染（HTML 结构非空）
    expect(html).toContain('<');
  });
});
