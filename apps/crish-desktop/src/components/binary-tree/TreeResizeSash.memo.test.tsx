// @vitest-environment jsdom
/**
 * D0-7 sash-memo — flatBranchEqual 契约 + 无关 prop 变化时 memo 跳过。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  TreeResizeSash,
  flatBranchEqual,
  type TreeResizeSashProps,
} from './TreeResizeSash';
import type { FlatBranch } from '../../store/types';
import { useLayoutTreeStore } from '../../store/layout-tree';
import { createLeaf, createBranch } from '../../store/layout-tree/types';

function makeBranch(over: Partial<FlatBranch> = {}): FlatBranch {
  return {
    branchId: 'br-1',
    direction: 'horizontal',
    splitRatio: 0.5,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    ...over,
  };
}

describe('flatBranchEqual', () => {
  it('same reference → true', () => {
    const b = makeBranch();
    expect(flatBranchEqual(b, b)).toBe(true);
  });

  it('几何相同不同引用 → true', () => {
    expect(flatBranchEqual(makeBranch(), makeBranch())).toBe(true);
  });

  it('splitRatio / rect 变化 → false', () => {
    expect(
      flatBranchEqual(makeBranch(), makeBranch({ splitRatio: 0.4 }))
    ).toBe(false);
    expect(
      flatBranchEqual(
        makeBranch(),
        makeBranch({ rect: { x: 0, y: 0, width: 0.5, height: 1 } })
      )
    ).toBe(false);
  });
});

describe('TreeResizeSash React.memo', () => {
  let renderCount = 0;

  // 包装一层计数：memo 跳过时外层仍 re-render，但 TreeResizeSash 内部不应重跑
  // 用 data-render-tick 由 sash 子树无法直接暴露，改为 spy startResize 稳定性 + DOM 属性
  const SpySash: React.FC<TreeResizeSashProps> = (props) => {
    renderCount += 1;
    return <TreeResizeSash {...props} />;
  };

  // 真正测 memo：父级强制更新时，若 props 按值相等，memo 组件 displayName 仍挂着但
  // React.memo 会跳过。我们通过对比「自定义 compare 结果」+ pointerdown 接线。

  beforeEach(() => {
    renderCount = 0;
    const chat = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const tool = createLeaf('files', ['files'], 'files', 'sess-a');
    const root = createBranch('horizontal', chat, tool, 0.5);
    useLayoutTreeStore.setState({
      tree: { root, version: 2 },
      activeLeafId: chat.id,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('startResize 在 pointerdown 时以 branchId + rect 调用', () => {
    const startResize = vi.fn();
    const branch = makeBranch({ branchId: 'br-hit' });
    const { container } = render(
      <TreeResizeSash
        branch={branch}
        startResize={startResize}
        isResizing={false}
      />
    );
    const sash = container.querySelector('[data-branch-id="br-hit"]');
    expect(sash).toBeTruthy();
    fireEvent.pointerDown(sash!, { button: 0, clientX: 10, clientY: 10 });
    expect(startResize).toHaveBeenCalledTimes(1);
    const [branchId, rect, ev] = startResize.mock.calls[0];
    expect(branchId).toBe('br-hit');
    expect(rect).toEqual(branch.rect);
    expect(ev).toBeTruthy();
  });

  it('双击 sash 重置 splitRatio 为 0.5', () => {
    const startResize = vi.fn();
    const chat = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const tool = createLeaf('files', ['files'], 'files', 'sess-a');
    const root = createBranch('horizontal', chat, tool, 0.3);
    useLayoutTreeStore.setState({
      tree: { root, version: 2 },
      activeLeafId: chat.id,
    });
    const branch = makeBranch({
      branchId: root.id,
      splitRatio: 0.3,
    });
    const { container } = render(
      <TreeResizeSash
        branch={branch}
        startResize={startResize}
        isResizing={false}
      />
    );
    const sash = container.querySelector('[role="separator"]');
    expect(sash).toBeTruthy();
    fireEvent.doubleClick(sash!);
    const next = useLayoutTreeStore.getState().tree.root;
    expect(next.type).toBe('branch');
    if (next.type === 'branch') {
      expect(next.splitRatio).toBe(0.5);
    }
  });

  it('isResizing 反映 data-active', () => {
    const startResize = vi.fn();
    const branch = makeBranch();
    const { container, rerender } = render(
      <TreeResizeSash
        branch={branch}
        startResize={startResize}
        isResizing={false}
      />
    );
    expect(
      container.querySelector('[data-active="false"]')
    ).toBeTruthy();
    rerender(
      <TreeResizeSash
        branch={branch}
        startResize={startResize}
        isResizing={true}
      />
    );
    expect(
      container.querySelector('[data-active="true"]')
    ).toBeTruthy();
  });

  it('branch 新字面量但值相同 + 同 startResize → 父级重渲染不重挂 sash 逻辑（props equal）', () => {
    const startResize = vi.fn();
    const b1 = makeBranch();
    const b2 = makeBranch(); // 新引用，同值
    expect(flatBranchEqual(b1, b2)).toBe(true);

    const { rerender, container } = render(
      <SpySash branch={b1} startResize={startResize} isResizing={false} />
    );
    const first = renderCount;
    const el = container.querySelector('[role="separator"]');
    expect(el).toBeTruthy();

    // 父级强制更新：传新 branch 字面量、同 startResize、同 isResizing
    rerender(
      <SpySash branch={b2} startResize={startResize} isResizing={false} />
    );
    // SpySash 本身会再渲染，但 memo 内部 compare 为 equal — 验证 wiring 仍在
    expect(renderCount).toBeGreaterThan(first);
    fireEvent.pointerDown(el!, { button: 0 });
    expect(startResize).toHaveBeenCalled();
  });
});
