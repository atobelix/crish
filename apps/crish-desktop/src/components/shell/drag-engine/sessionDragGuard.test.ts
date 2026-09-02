import { describe, expect, it } from 'vitest';
import { evaluateSessionSplitGuard } from './sessionDragGuard';
import type { LayoutTree } from '../../../store/layout-tree/types';

describe('sessionDragGuard — 跨域分屏互斥守门状态机测试', () => {
  const singleLeafTree: LayoutTree = {
    root: {
      type: 'leaf',
      id: 'leaf-1',
      panelId: 'chat',
      tabs: [
        { tabId: 't-1', sessionId: 'sess-active', title: '当前会话', dirty: false },
        { tabId: 't-2', sessionId: 'sess-history', title: '历史会话', dirty: false },
      ],
      activeTabId: 't-1',
      dock: { primary: null, pinned: [] },
    },
    version: 1,
  };

  const multiLeafTree: LayoutTree = {
    root: {
      type: 'branch',
      id: 'branch-1',
      direction: 'horizontal',
      splitRatio: 0.5,
      children: [
        {
          type: 'leaf',
          id: 'leaf-1',
          panelId: 'chat',
          tabs: [
            { tabId: 't-1', sessionId: 'sess-active', title: '当前会话', dirty: false },
          ],
          activeTabId: 't-1',
          dock: { primary: null, pinned: [] },
        },
        {
          type: 'leaf',
          id: 'leaf-2',
          panelId: 'chat',
          tabs: [
            { tabId: 't-3', sessionId: 'sess-other', title: '另一会话', dirty: false },
          ],
          activeTabId: 't-3',
          dock: { primary: null, pinned: [] },
        },
      ],
    },
    version: 1,
  };

  it('场景 G-01：单窗口模式下拖拽当前激活的会话 → 刚性拦截分屏', () => {
    const res = evaluateSessionSplitGuard(
      singleLeafTree,
      'sess-active',
      'leaf-1',
      'right'
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('SINGLE_LEAF_SELF_SPLIT_BLOCKED');
  });

  it('场景 G-02：单窗口模式下拖拽未激活的历史会话 → 放行分屏', () => {
    const res = evaluateSessionSplitGuard(
      singleLeafTree,
      'sess-history',
      'leaf-1',
      'right'
    );
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe('OK');
  });

  it('场景 G-03：单窗口模式下拖拽从未打开过的全新会话 → 放行分屏', () => {
    const res = evaluateSessionSplitGuard(
      singleLeafTree,
      'sess-brand-new',
      'leaf-1',
      'left'
    );
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe('OK');
  });

  it('场景 G-04：多窗口模式下拖拽任何会话向其他窗格分屏 → 放行分屏', () => {
    const res = evaluateSessionSplitGuard(
      multiLeafTree,
      'sess-active',
      'leaf-2',
      'bottom'
    );
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe('OK');
  });
});
