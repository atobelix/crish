// @vitest-environment jsdom
/**
 * useTreeDrag hook 集成测试 — 拖拽生命周期 + zone 去重 + 多指隔离 + resize 重收集。
 *
 * 测试维度（覆盖 REFACTOR_NOTES 中标记的 useTreeDrag 待办）：
 * 1. 拖拽启动：startDragLeaf / startDragTab 在 idle 阶段设置 pending
 * 2. 阈值过渡：pending → active（移动超过 DRAG_THRESHOLD_PX=5px）
 * 3. zone 去重：连续 pointermove 同一 zone → store setActiveDropZone 仅调用一次
 * 4. 多指隔离：第二指 pointermove 被忽略（pointerId 过滤）
 * 5. resize 重收集：拖拽中 window resize → cachedLeafRects 更新
 * 6. 拖拽取消：escape key / pointercancel 清理状态不变更结构
 * 7. 同 leaf 防自拖：leaf 拖拽到自身 leaf → zone=null
 *
 * 测试策略（系统性设计）：
 * - 真实 store：不 mock useLayoutTreeStore，用 setState 直写绕过持久化
 * - 真实 DOM：jsdom 创建 canvas + leaf 元素，mock getBoundingClientRect
 * - 真实事件：dispatchEvent(new PointerEvent(...)) 模拟原生事件
 * - 订阅计数：subscribe 监听 store 变化，记录 activeDropZone 引用变化次数
 *   （每次 setActiveDropZone 都创建新对象引用，引用变化 = 调用次数）
 *
 * 关键不变量：
 * - 拖拽期间 tree 不可变（commitDrop 仅 pointerUp 触发）
 * - lastZoneRef 浅相等短路 → 同语义 zone 不推 store
 * - 多指隔离 → 仅启动 pointerId 的事件被处理
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useTreeDrag } from './useTreeDrag';
import { useLayoutTreeStore, layoutTreeStorageKey } from '../store/layout-tree';
import {
  createDefaultTree,
  createLeaf,
  createBranch,
  type LayoutTree,
} from '../store/layout-tree/types';
import { collectLeaves } from '../store/layout-tree/operations';
import type { DropZone } from '../store/layout-tree/dropDetection';

// ── 夹具 ────────────────────────────────────────────────────────────

/** Window-scoped persist key (multi-window isolation). */
const STORAGE_KEY = layoutTreeStorageKey();

/**
 * 时间控制 — useTreeDrag 用 performance.now() 做 drop zone 检测节流
 * （DROP_DETECT_INTERVAL_MS=16ms）。act() 是同步的，多次 act 之间的
 * 真实时间差几乎为 0，会导致节流跳过所有检测。
 *
 * 用 vi.spyOn(performance, 'now') 控制 currentTime，advanceTime() 推进
 * 时间到下一帧，确保节流逻辑不短路。
 */
let currentTime = 1000;
let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

function installTimeMock(): void {
  currentTime = 1000;
  nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => currentTime);
}
function advanceTime(ms: number): void {
  currentTime += ms;
}
function restoreTimeMock(): void {
  if (nowSpy) {
    nowSpy.mockRestore();
    nowSpy = null;
  }
}

/** 构造一个 React.PointerEvent（仅左键，pointerId=1） */
function makePointerEvent(
  clientX: number,
  clientY: number,
  options: { pointerId?: number; button?: number } = {}
): React.PointerEvent {
  return {
    button: options.button ?? 0,
    pointerId: options.pointerId ?? 1,
    clientX,
    clientY,
    // 其余字段非 hook 关键路径，省略
  } as unknown as React.PointerEvent;
}

/**
 * 构造两 leaf 的同域树：branch(diff, terminal) — 同属 tool 域。
 *
 * 旧实现用 branch(chat, diff) 跨域树，但跨域防护生效后 chat→diff 拖拽会被
 * applyDrop 拒绝。改为同域树让 split / merge-tab 等正常路径可被验证。
 *
 * 注意：测试 DOM mock 必须设置 data-panel-id，否则 collectLeafRects 默认
 * panelId='chat'，会让 useTreeDrag 的跨域检查与 store 真实 panelId 不一致。
 */
function makeTwoLeafTree(): LayoutTree {
  return {
    root: createBranch(
      'horizontal',
      createLeaf('diff', ['diff'], 'diff'),
      createLeaf('terminal', ['terminal'], 'terminal'),
      0.5
    ),
    version: 2,
  };
}

/**
 * 创建 mock leaf DOM：fixed rect，可被 getBoundingClientRect 读取。
 * useTreeDrag 通过 querySelectorAll('[data-leaf-id]') 查询 leaf 元素。
 */
function makeLeafDOM(
  id: string,
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  },
  panelId?: string
): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-leaf-id', id);
  if (panelId) el.setAttribute('data-panel-id', panelId);
  el.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  }) as DOMRect;
  return el;
}

/** 创建 canvas + 2 个 leaf 的 DOM 结构 */
function setupDOM(): {
  chatLeaf: HTMLElement;
  diffLeaf: HTMLElement;
  cleanup: () => void;
} {
  document.body.innerHTML = '';

  const canvas = document.createElement('div');
  canvas.setAttribute('data-tree-canvas', 'true');

  // 两个 leaf 各占一半：chat 在左，diff 在右
  const chatLeaf = makeLeafDOM('leaf-chat', {
    left: 0,
    top: 0,
    width: 500,
    height: 800,
  });
  // 注意：DOM 中的 leaf-id 必须与 store 中的 leaf id 匹配
  // 但 store 中 leaf id 是动态生成的（createLeaf 不接受 id 参数）
  // 测试中通过 collectLeaves 获取真实 id，再设置 DOM
  const diffLeaf = makeLeafDOM('leaf-diff', {
    left: 500,
    top: 0,
    width: 500,
    height: 800,
  });

  canvas.appendChild(chatLeaf);
  canvas.appendChild(diffLeaf);
  document.body.appendChild(canvas);

  return {
    chatLeaf,
    diffLeaf,
    cleanup: () => {
      document.body.innerHTML = '';
    },
  };
}

/** 复位 store 到指定 tree，绕过 setTree 避免推历史 */
function resetStore(tree?: LayoutTree): void {
  const t = tree ?? createDefaultTree('chat');
  useLayoutTreeStore.setState({
    tree: t,
    activeLeafId: collectLeaves(t.root)[0]?.id ?? null,
    past: [],
    future: [],
    draggedSource: null,
    activeDropZone: null,
  });
}

/**
 * 订阅 store 变化，记录 activeDropZone 引用变化次数。
 *
 * 每次 setActiveDropZone 都创建新对象引用（即使语义相同），
 * 故引用变化次数 = setActiveDropZone 调用次数。
 * useTreeDrag 的 isZoneSame 去重 → 同语义 zone 不调用 setActiveDropZone → 引用不变。
 */
function countZoneUpdates(): {
  count: () => number;
  unsubscribe: () => void;
} {
  let updateCount = 0;
  let lastZone: DropZone | null = useLayoutTreeStore.getState().activeDropZone;
  const unsubscribe = useLayoutTreeStore.subscribe((state) => {
    if (state.activeDropZone !== lastZone) {
      updateCount++;
      lastZone = state.activeDropZone;
    }
  });
  return {
    count: () => updateCount,
    unsubscribe,
  };
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  installTimeMock();
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.removeItem(STORAGE_KEY);
  restoreTimeMock();
});

// ── 1. 拖拽启动 ────────────────────────────────────────────────────

describe('拖拽启动', () => {
  it('startDragLeaf 在 idle 阶段不立即触发 isDragging（pending 阶段）', () => {
    resetStore();
    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });

    // pending 阶段：未超过阈值，isDragging 仍为 false
    expect(result.current.isDragging).toBe(false);
    // draggedSource 也未设置（enterActive 才设置）
    expect(useLayoutTreeStore.getState().draggedSource).toBeNull();
  });

  it('startDragTab 在 idle 阶段不立即触发 isDragging（pending 阶段）', () => {
    resetStore();
    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragTab(
        'leaf-1',
        'tab-1',
        'chat',
        makePointerEvent(0, 0)
      );
    });

    expect(result.current.isDragging).toBe(false);
  });

  it('非左键 button 拒绝启动', () => {
    resetStore();
    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf(
        'leaf-1',
        'chat',
        makePointerEvent(0, 0, { button: 2 })
      );
    });

    // 右键不应启动拖拽
    expect(result.current.isDragging).toBe(false);
  });

  it('已在拖拽中时拒绝第二次启动（多指场景）', () => {
    resetStore();
    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });

    // 第二次启动应被拒绝（phaseRef !== 'idle'）
    act(() => {
      result.current.startDragLeaf(
        'leaf-2',
        'diff',
        makePointerEvent(0, 0, { pointerId: 2 })
      );
    });

    // 仍是第一次的 pending 状态，isDragging 为 false
    expect(result.current.isDragging).toBe(false);
  });
});

// ── 2. 阈值过渡 ────────────────────────────────────────────────────

describe('阈值过渡：pending → active', () => {
  it('pointermove 移动 < 5px 不进入 active', () => {
    resetStore();
    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });

    // 移动 3px（< DRAG_THRESHOLD_PX=5）
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 3,
          clientY: 0,
          pointerId: 1,
        })
      );
    });

    expect(result.current.isDragging).toBe(false);
  });

  it('pointermove 移动 >= 5px 进入 active', () => {
    resetStore();
    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });

    // 移动 10px（> 阈值 5）
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 10,
          clientY: 0,
          pointerId: 1,
        })
      );
    });

    expect(result.current.isDragging).toBe(true);
    expect(useLayoutTreeStore.getState().draggedSource).not.toBeNull();
  });
});

// ── 3. zone 去重 ───────────────────────────────────────────────────

describe('zone 去重：连续 pointermove 同一 zone，store 只更新一次', () => {
  it('同 leaf 同区域多次 pointermove → setActiveDropZone 仅调用一次', () => {
    const tree = makeTwoLeafTree();
    resetStore(tree);

    // 获取真实 leaf id（makeTwoLeafTree 返回 branch(diff, terminal) — 同域 tool）
    const leaves = collectLeaves(tree.root);
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;
    const terminalId = leaves.find((l) => l.panelId === 'terminal')!.id;

    // 设置 DOM：diff 在左（0-500），terminal 在右（500-1000）
    document.body.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.setAttribute('data-tree-canvas', 'true');
    const diffEl = makeLeafDOM(diffId, { left: 0, top: 0, width: 500, height: 800 }, 'diff');
    const terminalEl = makeLeafDOM(terminalId, { left: 500, top: 0, width: 500, height: 800 }, 'terminal');
    canvas.appendChild(diffEl);
    canvas.appendChild(terminalEl);
    document.body.appendChild(canvas);

    const { result } = renderHook(() => useTreeDrag());
    const counter = countZoneUpdates();

    // 1. 启动 diff leaf 拖拽
    act(() => {
      result.current.startDragLeaf(diffId, 'diff', makePointerEvent(250, 400));
    });

    // 2. 进入 active（移动 > 5px）— 推进时间确保节流不跳过
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 260,
          clientY: 400,
          pointerId: 1,
        })
      );
    });

    // 进入 active 后首次检测 zone — 指针在 diff 内（自身），zone=null
    // 自身 leaf 拖拽到自身 leaf → updateZone(null)
    const countAfterEnter = counter.count();

    // 3. 连续多次 pointermove 到 terminal leaf 的中心（同一区域，同一 zone）
    // terminal leaf 中心：(750, 400) — merge-tab
    advanceTime(20);
    act(() => {
      // 移动到 terminal 中心
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 750,
          clientY: 400,
          pointerId: 1,
        })
      );
    });

    const countAfterFirstMove = counter.count();

    // 再移动到 terminal 中心附近（同一 zone：merge-tab on terminal）
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 751,
          clientY: 401,
          pointerId: 1,
        })
      );
    });

    const countAfterSecondMove = counter.count();

    // 再移动到 terminal 中心附近
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 752,
          clientY: 402,
          pointerId: 1,
        })
      );
    });

    const countAfterThirdMove = counter.count();

    // 验证：首次进入 terminal zone 触发 1 次更新，后续同 zone 不再触发
    expect(countAfterFirstMove).toBeGreaterThan(countAfterEnter);
    expect(countAfterSecondMove).toBe(countAfterFirstMove); // 同 zone 不更新
    expect(countAfterThirdMove).toBe(countAfterFirstMove); // 同 zone 不更新

    counter.unsubscribe();
  });

  it('zone 切换（merge-tab → split-right）触发更新', () => {
    const tree = makeTwoLeafTree();
    resetStore(tree);

    const leaves = collectLeaves(tree.root);
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;
    const terminalId = leaves.find((l) => l.panelId === 'terminal')!.id;

    document.body.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.setAttribute('data-tree-canvas', 'true');
    const diffEl = makeLeafDOM(diffId, { left: 0, top: 0, width: 500, height: 800 }, 'diff');
    const terminalEl = makeLeafDOM(terminalId, { left: 500, top: 0, width: 500, height: 800 }, 'terminal');
    canvas.appendChild(diffEl);
    canvas.appendChild(terminalEl);
    document.body.appendChild(canvas);

    const { result } = renderHook(() => useTreeDrag());
    const counter = countZoneUpdates();

    // 启动 diff 拖拽
    act(() => {
      result.current.startDragLeaf(diffId, 'diff', makePointerEvent(250, 400));
    });
    // 进入 active
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 260,
          clientY: 400,
          pointerId: 1,
        })
      );
    });

    // 移到 terminal 中心 → merge-tab
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 750,
          clientY: 400,
          pointerId: 1,
        })
      );
    });
    const afterMergeTab = counter.count();

    // 移到 terminal 右边缘 → split-right
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 980,
          clientY: 400,
          pointerId: 1,
        })
      );
    });
    const afterSplitRight = counter.count();

    expect(afterSplitRight).toBeGreaterThan(afterMergeTab); // zone 切换触发更新

    counter.unsubscribe();
  });
});

// ── 4. 多指隔离 ────────────────────────────────────────────────────

describe('多指隔离：第二指 pointermove 被忽略', () => {
  it('启动拖拽后，第二指的 pointermove 不影响 ghost 位置', () => {
    resetStore();
    setupDOM();
    const { result } = renderHook(() => useTreeDrag());

    // 第一指启动拖拽（pointerId=1）
    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });
    // 第一指移动进入 active
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 100,
          clientY: 100,
          pointerId: 1,
        })
      );
    });
    expect(result.current.isDragging).toBe(true);

    // 第二指（pointerId=2）的 pointermove 应被忽略
    const storeBefore = useLayoutTreeStore.getState().activeDropZone;
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 9999,
          clientY: 9999,
          pointerId: 2,
        })
      );
    });
    const storeAfter = useLayoutTreeStore.getState().activeDropZone;

    // 第二指不应改变 store 状态
    expect(storeAfter).toBe(storeBefore);
  });

  it('第二指的 pointerup 不结束拖拽', () => {
    resetStore();
    setupDOM();
    const { result } = renderHook(() => useTreeDrag());

    // 第一指启动 + 进入 active
    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 100,
          clientY: 100,
          pointerId: 1,
        })
      );
    });
    expect(result.current.isDragging).toBe(true);

    // 第二指 pointerup — 不应结束拖拽
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 2,
        })
      );
    });

    expect(result.current.isDragging).toBe(true); // 仍在拖拽
  });
});

// ── 5. resize 重收集 ───────────────────────────────────────────────

describe('resize 重收集：拖拽中 window resize 更新 cachedLeafRects', () => {
  it('拖拽中 window resize → leaf rect 重新收集（drop zone 检测用新坐标）', () => {
    const tree = makeTwoLeafTree();
    resetStore(tree);

    const leaves = collectLeaves(tree.root);
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;
    const terminalId = leaves.find((l) => l.panelId === 'terminal')!.id;

    // 初始 DOM：diff 0-500，terminal 500-1000
    document.body.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.setAttribute('data-tree-canvas', 'true');
    const diffEl = makeLeafDOM(diffId, { left: 0, top: 0, width: 500, height: 800 }, 'diff');
    const terminalEl = makeLeafDOM(terminalId, { left: 500, top: 0, width: 500, height: 800 }, 'terminal');
    canvas.appendChild(diffEl);
    canvas.appendChild(terminalEl);
    document.body.appendChild(canvas);

    const { result } = renderHook(() => useTreeDrag());

    // 启动 diff 拖拽
    act(() => {
      result.current.startDragLeaf(diffId, 'diff', makePointerEvent(250, 400));
    });
    // 进入 active
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 260,
          clientY: 400,
          pointerId: 1,
        })
      );
    });

    // resize：窗口变小，leaf rect 重新分配
    // diff 0-300，terminal 300-600
    diffEl.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 300,
      bottom: 800,
      width: 300,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
    terminalEl.getBoundingClientRect = () => ({
      left: 300,
      top: 0,
      right: 600,
      bottom: 800,
      width: 300,
      height: 800,
      x: 300,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

    // 触发 window resize
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    // 移动指针到新坐标系下的 terminal 中心（450, 400）
    // 旧坐标系下 (450, 400) 在 diff 内（0-500），但 resize 后在 terminal 内（300-600）
    const counter = countZoneUpdates();
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 450,
          clientY: 400,
          pointerId: 1,
        })
      );
    });

    // 验证：resize 后指针位置 (450,400) 落在 terminal leaf 内
    // 如果未重收集缓存，会误判为 diff 内 → zone=null（自拖）
    // 重收集后正确识别为 terminal → zone 非 null
    const { activeDropZone } = useLayoutTreeStore.getState();
    expect(activeDropZone).not.toBeNull();
    expect(activeDropZone!.targetLeafId).toBe(terminalId);

    counter.unsubscribe();
  });
});

// ── 6. 拖拽取消 ────────────────────────────────────────────────────

describe('拖拽取消', () => {
  it('escape key 取消拖拽，清理状态不变更结构', () => {
    const tree = makeTwoLeafTree();
    resetStore(tree);
    setupDOM();
    const treeBefore = useLayoutTreeStore.getState().tree;

    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 100,
          clientY: 100,
          pointerId: 1,
        })
      );
    });
    expect(result.current.isDragging).toBe(true);

    // 按 Escape 取消
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' })
      );
    });

    expect(result.current.isDragging).toBe(false);
    expect(useLayoutTreeStore.getState().draggedSource).toBeNull();
    expect(useLayoutTreeStore.getState().activeDropZone).toBeNull();
    // 结构未变更
    expect(useLayoutTreeStore.getState().tree).toBe(treeBefore);
  });

  it('pointercancel 取消拖拽，清理状态', () => {
    resetStore();
    setupDOM();
    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 100,
          clientY: 100,
          pointerId: 1,
        })
      );
    });
    expect(result.current.isDragging).toBe(true);

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointercancel', { pointerId: 1 })
      );
    });

    expect(result.current.isDragging).toBe(false);
    expect(useLayoutTreeStore.getState().draggedSource).toBeNull();
  });

  it('cancelDrag() 主动取消', () => {
    resetStore();
    setupDOM();
    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 100,
          clientY: 100,
          pointerId: 1,
        })
      );
    });
    expect(result.current.isDragging).toBe(true);

    act(() => {
      result.current.cancelDrag();
    });

    expect(result.current.isDragging).toBe(false);
    expect(useLayoutTreeStore.getState().draggedSource).toBeNull();
  });
});

// ── 7. 同 leaf 防自拖 ──────────────────────────────────────────────

describe('同 leaf 防自拖', () => {
  it('leaf 拖拽到自身 leaf → zone=null', () => {
    const tree = makeTwoLeafTree();
    resetStore(tree);

    const leaves = collectLeaves(tree.root);
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;

    document.body.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.setAttribute('data-tree-canvas', 'true');
    const diffEl = makeLeafDOM(diffId, { left: 0, top: 0, width: 500, height: 800 }, 'diff');
    canvas.appendChild(diffEl);
    document.body.appendChild(canvas);

    const { result } = renderHook(() => useTreeDrag());

    // 启动 diff 拖拽
    act(() => {
      result.current.startDragLeaf(diffId, 'diff', makePointerEvent(250, 400));
    });
    // 进入 active
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 260,
          clientY: 400,
          pointerId: 1,
        })
      );
    });

    // 指针仍在 diff 内（自身）→ zone 应为 null
    expect(useLayoutTreeStore.getState().activeDropZone).toBeNull();
  });
});

// ── 8. 拖拽提交 ────────────────────────────────────────────────────

describe('拖拽提交', () => {
  it('pointerup 提交 drop，清理拖拽状态', () => {
    const tree = makeTwoLeafTree();
    resetStore(tree);

    const leaves = collectLeaves(tree.root);
    const diffId = leaves.find((l) => l.panelId === 'diff')!.id;
    const terminalId = leaves.find((l) => l.panelId === 'terminal')!.id;

    document.body.innerHTML = '';
    const canvas = document.createElement('div');
    canvas.setAttribute('data-tree-canvas', 'true');
    const diffEl = makeLeafDOM(diffId, { left: 0, top: 0, width: 500, height: 800 }, 'diff');
    const terminalEl = makeLeafDOM(terminalId, { left: 500, top: 0, width: 500, height: 800 }, 'terminal');
    canvas.appendChild(diffEl);
    canvas.appendChild(terminalEl);
    document.body.appendChild(canvas);

    const { result } = renderHook(() => useTreeDrag());
    const treeBefore = useLayoutTreeStore.getState().tree;

    // 启动 diff 拖拽
    act(() => {
      result.current.startDragLeaf(diffId, 'diff', makePointerEvent(250, 400));
    });
    // 进入 active
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 260,
          clientY: 400,
          pointerId: 1,
        })
      );
    });
    // 移到 terminal 中心（merge-tab zone）
    advanceTime(20);
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 750,
          clientY: 400,
          pointerId: 1,
        })
      );
    });
    // pointerup 提交
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1 })
      );
    });

    expect(result.current.isDragging).toBe(false);
    expect(useLayoutTreeStore.getState().draggedSource).toBeNull();
    expect(useLayoutTreeStore.getState().activeDropZone).toBeNull();
    // tree 应变更（merge-tab 合并 diff 和 terminal）
    expect(useLayoutTreeStore.getState().tree).not.toBe(treeBefore);
    // 推历史
    expect(useLayoutTreeStore.getState().past.length).toBeGreaterThan(0);
  });

  it('pending 阶段 pointerup（未超过阈值）不提交', () => {
    const tree = makeTwoLeafTree();
    resetStore(tree);
    setupDOM();
    const treeBefore = useLayoutTreeStore.getState().tree;

    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
    });
    // 未移动超过阈值就 pointerup
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1 })
      );
    });

    expect(result.current.isDragging).toBe(false);
    expect(useLayoutTreeStore.getState().tree).toBe(treeBefore);
    expect(useLayoutTreeStore.getState().past.length).toBe(0);
  });
});
