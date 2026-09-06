// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LayoutLeaf } from '../../store/types';
import { useSessionStore } from '../../store/storeAccess';

const shellMocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  addTab: vi.fn(),
  removeTab: vi.fn(),
}));

vi.mock('../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({ shell: shellMocks }),
}));

vi.mock('../shell/SessionTabDragContext', () => ({
  useSessionTabDrag: () => ({
    startSessionDrag: vi.fn(),
  }),
}));

import { PaneHeader } from './PaneHeader';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

function makeTab(
  tabId: string,
  sessionId: string,
  title: string
) {
  return {
    tabId,
    sessionId,
    title,
    workspaceKey: '对话',
    dock: {
      collapsed: true,
      openPanelIds: [] as string[],
      activePanelId: null as string | null,
      widthRatio: 0.5,
    },
  };
}

function makeLeaf(
  id: string,
  tabs: ReturnType<typeof makeTab>[],
  activeTabId: string
): LayoutLeaf {
  return {
    type: 'leaf',
    id,
    panelId: 'chat',
    tabs,
    activeTab: 'chat',
    activeTabId,
  } as unknown as LayoutLeaf;
}

describe('PaneHeader 叶子拥有会话标签', () => {
  beforeEach(() => {
    shellMocks.activateTab.mockReset();
    shellMocks.addTab.mockReset();
    shellMocks.removeTab.mockReset();
    useSessionStore.setState({
      sessionsById: {
        s1: { id: 's1', title: '会话一' },
        s2: { id: 's2', title: '会话二' },
        s3: { id: 's3', title: '会话三' },
      },
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('两叶各自 aria-selected 只跟本叶 activeTabId', () => {
    const leafA = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一'), makeTab('ta3', 's3', '会话三')],
      'ta1'
    );
    const leafB = makeLeaf('leaf-b', [makeTab('tb2', 's2', '会话二')], 'tb2');

    const { container } = render(
      <div>
        <PaneHeader leaf={leafA} isActive isChat />
        <PaneHeader leaf={leafB} isActive={false} isChat />
      </div>
    );

    const aTabs = container.querySelectorAll(
      '[data-leaf-id], [data-pane-header="true"]'
    );
    const headers = container.querySelectorAll('[data-pane-header="true"]');
    expect(headers).toHaveLength(2);

    const aSelected = headers[0]!.querySelectorAll('[aria-selected="true"]');
    const bSelected = headers[1]!.querySelectorAll('[aria-selected="true"]');
    expect(aSelected).toHaveLength(1);
    expect(aSelected[0]!.getAttribute('data-tab-id')).toBe('ta1');
    expect(bSelected).toHaveLength(1);
    expect(bSelected[0]!.getAttribute('data-tab-id')).toBe('tb2');
    void aTabs;
  });

  it('点 tab 只调 activateTab(leafId, tabId)', () => {
    const leaf = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一'), makeTab('ta3', 's3', '会话三')],
      'ta1'
    );
    const { getByText } = render(<PaneHeader leaf={leaf} isActive isChat />);
    fireEvent.click(getByText('会话三'));
    expect(shellMocks.activateTab).toHaveBeenCalledTimes(1);
    expect(shellMocks.activateTab).toHaveBeenCalledWith('leaf-a', 'ta3');
    expect(shellMocks.addTab).not.toHaveBeenCalled();
    expect(shellMocks.removeTab).not.toHaveBeenCalled();
  });

  it('加号只调 addTab(leafId)', () => {
    const leaf = makeLeaf('leaf-b', [makeTab('tb2', 's2', '会话二')], 'tb2');
    const { getAllByLabelText } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    fireEvent.click(getAllByLabelText('新对话')[0]!);
    expect(shellMocks.addTab).toHaveBeenCalledTimes(1);
    expect(shellMocks.addTab).toHaveBeenCalledWith('leaf-b');
    expect(shellMocks.activateTab).not.toHaveBeenCalled();
  });

  it('关 active tab：先 activate 左邻，220ms 后再 removeTab', () => {
    vi.useFakeTimers();
    const leaf = makeLeaf(
      'leaf-a',
      [
        makeTab('ta1', 's1', '会话一'),
        makeTab('ta3', 's3', '会话三'),
        makeTab('ta4', 's4', '会话四'),
      ],
      'ta3'
    );
    const { getByLabelText } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    fireEvent.click(getByLabelText('关闭 会话三'));
    expect(shellMocks.activateTab).toHaveBeenCalledWith('leaf-a', 'ta1');
    expect(shellMocks.removeTab).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(219);
    });
    expect(shellMocks.removeTab).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shellMocks.removeTab).toHaveBeenCalledWith('leaf-a', 'ta3');
  });

  it('源码点击路径不含死轨符号', () => {
    const src = readFileSync(join(DIR, './PaneHeader.tsx'), 'utf8');
    expect(src).not.toMatch(/setLeafSessionId/);
    expect(src).not.toMatch(/bindActiveChatLeafSession/);
    expect(src).not.toMatch(/tabsForUnit/);
    expect(src).not.toMatch(/openNewDraftTab/);
    expect(src).not.toMatch(/applyDockToTree/);
    expect(src).toMatch(/visibleTabs/);
    expect(src).toMatch(/leaf\.tabs/);
  });

  it('窗口拖拽只在标签按钮以外：标签项退出 drag-region', () => {
    const leaf = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一')],
      'ta1'
    );
    const { container, getByRole } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    const header = container.querySelector('[data-pane-header="true"]');
    expect(header?.hasAttribute('data-tauri-drag-region')).toBe(true);
    const tab = getByRole('tab');
    expect(tab.getAttribute('data-tauri-drag-region')).toBe('false');
    const list = header?.querySelector('[role="tablist"] > div');
    expect(list?.hasAttribute('data-tauri-drag-region')).toBe(false);
  });

  it('多标签关闭时激活锁定态并在鼠标移出或超时后解除锁定', () => {
    vi.useFakeTimers();
    const leaf = makeLeaf(
      'leaf-a',
      [
        makeTab('ta1', 's1', '会话一'),
        makeTab('ta2', 's2', '会话二'),
        makeTab('ta3', 's3', '会话三'),
      ],
      'ta1'
    );
    const { container, getByLabelText } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    expect(tablist.getAttribute('data-locked')).toBe('false');

    // 模拟鼠标悬停并模拟标签元素宽度
    fireEvent.mouseEnter(tablist);
    const tab1 = tablist.querySelector('[data-tab-id="ta1"]') as HTMLElement;
    Object.defineProperty(tab1, 'offsetWidth', { configurable: true, value: 120 });

    // 点击关闭标签
    fireEvent.click(getByLabelText('关闭 会话一'));

    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-locked-width')).toBe('120px');

    // 鼠标移出标签栏触发平缓解锁
    fireEvent.mouseLeave(tablist);
    expect(tablist.getAttribute('data-locked')).toBe('false');
    expect(tablist.style.getPropertyValue('--tab-locked-width')).toBe('');
  });

  it('连续快速关闭多个标签时锁定态持续保持且各自计时互不取消', () => {
    vi.useFakeTimers();
    const leaf = makeLeaf(
      'leaf-a',
      [
        makeTab('ta1', 's1', '会话一'),
        makeTab('ta2', 's2', '会话二'),
        makeTab('ta3', 's3', '会话三'),
      ],
      'ta1'
    );
    const { container, getByLabelText } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    fireEvent.mouseEnter(tablist);

    const tab1 = tablist.querySelector('[data-tab-id="ta1"]') as HTMLElement;
    Object.defineProperty(tab1, 'offsetWidth', { configurable: true, value: 95 });

    // 第一次点击关闭 ta1
    fireEvent.click(getByLabelText('关闭 会话一'));
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-locked-width')).toBe('95px');

    // 80ms 后在 ta1 动画尚未结束前快速连续点击关闭 ta2
    act(() => {
      vi.advanceTimersByTime(80);
    });
    fireEvent.click(getByLabelText('关闭 会话二'));

    // 锁定态持续保持，绝不意外改变大小
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-locked-width')).toBe('95px');

    // 再过 140ms（累计 220ms）：ta1 成功 removeTab，且 ta2 的计时未被冲刷掉
    act(() => {
      vi.advanceTimersByTime(140);
    });
    expect(shellMocks.removeTab).toHaveBeenCalledWith('leaf-a', 'ta1');
    expect(shellMocks.removeTab).not.toHaveBeenCalledWith('leaf-a', 'ta2');

    // 再过 80ms（累计 300ms）：ta2 也成功被 removeTab
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(shellMocks.removeTab).toHaveBeenCalledWith('leaf-a', 'ta2');

    // 鼠标移出后释放锁定
    fireEvent.mouseLeave(tablist);
    expect(tablist.getAttribute('data-locked')).toBe('false');
  });

  it('删除末尾标签时前序标签主动对齐光标但在超出正常宽度时不强行拉伸', () => {
    vi.useFakeTimers();
    const leaf = makeLeaf(
      'leaf-a',
      [
        makeTab('ta1', 's1', '会话一'),
        makeTab('ta2', 's2', '会话二'),
        makeTab('ta3', 's3', '会话三'),
      ],
      'ta3'
    );
    const { container, getByLabelText, rerender } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    fireEvent.mouseEnter(tablist);

    // 模拟容器左边界 0
    vi.spyOn(tablist, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 500,
      bottom: 36,
      width: 500,
      height: 36,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // 场景 1：在 clientX = 230px 关闭末尾标签 ta3
    // 剩余 2 个标签：neededWidth = (230 + 15 - 1*4) / 2 = 241 / 2 = 120.5px <= 180px
    // 会主动计算并拉伸至 121px 将 ta2 的叉号精准对齐到光标
    fireEvent.click(getByLabelText('关闭 会话三'), { clientX: 230 });
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-locked-width')).toBe('121px');

    // 场景 2：若用户光标很远（如 clientX = 450px），此时 neededWidth = (450 + 15 - 0) / 1 = 465px > 240px
    // 用户铁律：已超出正常标准标签宽度（240px），不强行放大，严格锁定在 240px 上限
    act(() => {
      vi.advanceTimersByTime(220); // ta3 离场完成
    });
    // 模拟应用层 store 更新后传入已移除 ta3 的新 leaf
    rerender(
      <PaneHeader
        leaf={makeLeaf(
          'leaf-a',
          [makeTab('ta1', 's1', '会话一'), makeTab('ta2', 's2', '会话二')],
          'ta2'
        )}
        isActive
        isChat
      />
    );
    fireEvent.click(getByLabelText('关闭 会话二'), { clientX: 450 });
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-locked-width')).toBe('240px');
  });

  it('标签始终具备严格等宽的 CSS 变量契约，绝不因文字字数长短而不同', () => {
    const leaf = makeLeaf(
      'leaf-a',
      [
        makeTab('ta1', 's1', '1'), // 极短标题
        makeTab('ta2', 's2', '这是一个非常非常非常长的会话标题'), // 超长标题
      ],
      'ta1'
    );
    const { container } = render(<PaneHeader leaf={leaf} isActive isChat />);
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    // 默认空闲态下均分使用标准 240px 宽度
    expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('240px');
  });

  it('当标签总宽度超出容器时全员等宽均分压缩，严禁溢出屏幕', () => {
    // 模拟 4 个标签在 500px 宽度容器中
    const leaf = makeLeaf(
      'leaf-a',
      [
        makeTab('ta1', 's1', '会话一'),
        makeTab('ta2', 's2', '会话二'),
        makeTab('ta3', 's3', '会话三'),
        makeTab('ta4', 's4', '会话四'),
      ],
      'ta1'
    );
    // 模拟 ResizeObserver 回调触发 clientWidth = 500
    let roCallback: ResizeObserverCallback | null = null;
    const OriginalResizeObserver = global.ResizeObserver;
    global.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const { container } = render(<PaneHeader leaf={leaf} isActive isChat />);
      const tablist = container.querySelector('[role="tablist"]') as HTMLElement;

      act(() => {
        Object.defineProperty(tablist, 'clientWidth', { configurable: true, value: 500 });
        Object.defineProperty(tablist, 'scrollWidth', { configurable: true, value: 500 });
        roCallback?.([], {} as ResizeObserver);
      });

      // 容器 500px，非标签占用 36px，可用 464px
      // 4 标签 3 间隙 (12px)，(464 - 12) / 4 = 113px
      expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('113px');
    } finally {
      global.ResizeObserver = OriginalResizeObserver;
    }
  });

  it('新增标签时触发生长入场动效类，动画结束后平滑退出生长态', () => {
    vi.useFakeTimers();
    const leaf = makeLeaf('leaf-a', [makeTab('ta1', 's1', '会话一')], 'ta1');
    const { container, rerender } = render(<PaneHeader leaf={leaf} isActive isChat />);
    const tab1 = container.querySelector('[data-tab-id="ta1"]') as HTMLElement;
    // 首轮挂载不触发入场生长
    expect(tab1.className).not.toMatch(/tabItemEntering/);

    // 模拟从侧边栏打开新会话，新增 ta2
    const nextLeaf = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一'), makeTab('ta2', 's2', '会话二')],
      'ta2'
    );
    rerender(<PaneHeader leaf={nextLeaf} isActive isChat />);

    const tab2 = container.querySelector('[data-tab-id="ta2"]') as HTMLElement;
    expect(tab2).not.toBeNull();
    expect(tab2.className).toMatch(/tabItemEntering/);

    // 190ms 后生长动画完成，清除生长态类名
    act(() => {
      vi.advanceTimersByTime(190);
    });
    expect(tab2.className).not.toMatch(/tabItemEntering/);
  });
});
