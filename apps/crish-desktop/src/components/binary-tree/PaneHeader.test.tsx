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

// ResizeObserverManager 单例 mock：捕获 observe 注册的回调供测试驱动
const roManagerMock = vi.hoisted(() => {
  const state = { cb: null as ((entry: unknown) => void) | null };
  return {
    state,
    instance: {
      observe: (_el: unknown, cb: (entry: unknown) => void) => {
        state.cb = cb;
      },
      unobserve: () => {
        state.cb = null;
      },
    },
  };
});

vi.mock('../../services/ResizeObserverManager', () => ({
  ResizeObserverManager: { getInstance: () => roManagerMock.instance },
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
    roManagerMock.state.cb = null;
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

    const headers = container.querySelectorAll('[data-pane-header="true"]');
    expect(headers).toHaveLength(2);

    const aSelected = headers[0]!.querySelectorAll('[aria-selected="true"]');
    const bSelected = headers[1]!.querySelectorAll('[aria-selected="true"]');
    expect(aSelected).toHaveLength(1);
    expect(aSelected[0]!.getAttribute('data-tab-id')).toBe('ta1');
    expect(bSelected).toHaveLength(1);
    expect(bSelected[0]!.getAttribute('data-tab-id')).toBe('tb2');
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

  it('关 active tab：邻居激活延后两帧，removeTab 由 transitionend(flex-basis) 驱动', async () => {
    const leaf = makeLeaf(
      'leaf-a',
      [
        makeTab('ta1', 's1', '会话一'),
        makeTab('ta3', 's3', '会话三'),
        makeTab('ta4', 's4', '会话四'),
      ],
      'ta3'
    );
    const { getByLabelText, container } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    fireEvent.click(getByLabelText('关闭 会话三'));

    // 离场立即标记，摘除绝不先行
    const tab = container.querySelector('[data-tab-id="ta3"]') as HTMLElement;
    expect(tab.getAttribute('data-leaving')).toBe('true');
    expect(shellMocks.activateTab).not.toHaveBeenCalled();
    expect(shellMocks.removeTab).not.toHaveBeenCalled();

    // 等待真实帧时钟走完两帧：条带离场首帧先行绘制，随后内容面切换
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    });
    expect(shellMocks.activateTab).toHaveBeenCalledWith('leaf-a', 'ta1');
    expect(shellMocks.removeTab).not.toHaveBeenCalled();

    // 离场 transition 到位后由 transitionend 驱动摘除
    fireEvent.transitionEnd(tab, { propertyName: 'flex-basis' });
    expect(shellMocks.removeTab).toHaveBeenCalledWith('leaf-a', 'ta3');
  });

  it('transitionend 丢失时保险丝按真实时长 ×3 兜底摘除', () => {
    vi.useFakeTimers();
    const leaf = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一'), makeTab('ta2', 's2', '会话二')],
      'ta2'
    );
    const { getByLabelText } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    fireEvent.click(getByLabelText('关闭 会话一'));

    // jsdom 读不到 computed transition 时长，兜底取 DURATION_FAST_MS(150) ×3 = 450ms
    act(() => {
      vi.advanceTimersByTime(449);
    });
    expect(shellMocks.removeTab).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shellMocks.removeTab).toHaveBeenCalledWith('leaf-a', 'ta1');
  });

  it('源码点击路径不含死轨符号', () => {
    const src = readFileSync(join(DIR, './PaneHeader.tsx'), 'utf8');
    expect(src).not.toMatch(/setLeafSessionId/);
    expect(src).not.toMatch(/bindActiveChatLeafSession/);
    expect(src).not.toMatch(/tabsForUnit/);
    expect(src).not.toMatch(/openNewDraftTab/);
    expect(src).not.toMatch(/applyDockToTree/);
    expect(src).not.toMatch(/tabItemEntering|tabItemLeaving/);
    expect(src).toMatch(/visibleTabs/);
    expect(src).toMatch(/leaf\.tabs/);
  });

  it('窗口拖拽遵从系统原生通道：顶行叶子挂载 data-tauri-drag-region，非顶行不挂载，可交互元素免疫', () => {
    const leaf = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一')],
      'ta1'
    );
    const { container, rerender } = render(
      <PaneHeader leaf={leaf} isActive isChat isTopRow={true} />
    );
    const header = container.querySelector('[data-pane-header="true"]');
    // 顶行叶子挂载原生拖拽区
    expect(header?.hasAttribute('data-tauri-drag-region')).toBe(true);

    // 内部标签项显式声明 data-tauri-drag-region="false"，防止系统标题栏手势劫持标签点选与拖拽
    const tab = container.querySelector('[role="tab"]');
    expect(tab?.getAttribute('data-tauri-drag-region')).toBe('false');

    // 加号按钮显式声明 data-tauri-drag-region="false"
    const newTabBtn = container.querySelector('button[aria-label="新对话"]');
    expect(newTabBtn?.getAttribute('data-tauri-drag-region')).toBe('false');

    // 非顶行窗格（如上下分屏的下方叶子）不挂载窗口拖拽区，避免非标题栏区域污染系统拖拽
    rerender(<PaneHeader leaf={leaf} isActive isChat isTopRow={false} />);
    const nonTopHeader = container.querySelector('[data-pane-header="true"]');
    expect(nonTopHeader?.hasAttribute('data-tauri-drag-region')).toBe(false);
  });

  it('多标签关闭时锁定等宽单变量通道生效，鼠标移出后解锁', () => {
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

    const tab1 = tablist.querySelector('[data-tab-id="ta1"]') as HTMLElement;
    Object.defineProperty(tab1, 'offsetWidth', { configurable: true, value: 120 });

    fireEvent.click(getByLabelText('关闭 会话一'));

    // 锁宽仅经 --tab-item-width 单变量通道（无 --tab-locked-width 第二变量、无 !important 覆盖）
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('120px');

    // 场景 A：伪离开事件（如指针仍处于顶部条带矩形内部或子节点卸载）不解锁
    const header = container.querySelector('[data-pane-header="true"]') as HTMLElement;
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 36,
      width: 800,
      height: 36,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    // 指针仍在顶栏范围 (y=18, x=200) 内时触发的 mouseleave 绝不误清
    fireEvent.mouseLeave(tablist, { clientX: 200, clientY: 18 });
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('120px');

    // 场景 B：指针真正离开顶部条带（如向下移入聊天区 y=50 或无坐标移出）才触发平缓解锁
    fireEvent.mouseLeave(tablist, { clientX: 200, clientY: 50 });
    expect(tablist.getAttribute('data-locked')).toBe('false');
    expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('240px');
  });

  it('连续快速关闭多个标签时锁定态持续保持且各自摘除互不取消', () => {
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

    const tab1 = tablist.querySelector('[data-tab-id="ta1"]') as HTMLElement;
    Object.defineProperty(tab1, 'offsetWidth', { configurable: true, value: 95 });

    // 第一次点击关闭 ta1
    fireEvent.click(getByLabelText('关闭 会话一'));
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('95px');

    // ta1 离场到位摘除；连击节奏下锁定态绝不意外改变大小
    fireEvent.transitionEnd(tab1, { propertyName: 'flex-basis' });
    expect(shellMocks.removeTab).toHaveBeenCalledWith('leaf-a', 'ta1');
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('95px');

    // 快速连续点击关闭 ta2：与 ta1 的摘除互不取消
    fireEvent.click(getByLabelText('关闭 会话二'));
    const tab2 = tablist.querySelector('[data-tab-id="ta2"]') as HTMLElement;
    fireEvent.transitionEnd(tab2, { propertyName: 'flex-basis' });
    expect(shellMocks.removeTab).toHaveBeenCalledWith('leaf-a', 'ta2');
    expect(shellMocks.removeTab).toHaveBeenCalledTimes(2);

    // 鼠标移出后释放锁定
    fireEvent.mouseLeave(tablist);
    expect(tablist.getAttribute('data-locked')).toBe('false');
  });

  it('删除末尾标签时前序标签主动对齐光标但在超出正常宽度时不强行拉伸', () => {
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
    // 剩余 2 个标签：neededWidth = (230 + 15 - 1*4) / 2 = 120.5px
    // 会主动计算并拉伸至 121px 将 ta2 的叉号精准对齐到光标
    fireEvent.click(getByLabelText('关闭 会话三'), { clientX: 230 });
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('121px');

    const tab3 = tablist.querySelector('[data-tab-id="ta3"]') as HTMLElement;
    fireEvent.transitionEnd(tab3, { propertyName: 'flex-basis' });
    expect(shellMocks.removeTab).toHaveBeenCalledWith('leaf-a', 'ta3');

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

    // 场景 2：若用户光标很远（如 clientX = 450px），此时 neededWidth = (450 + 15 - 0) / 1 = 465px > 240px
    // 用户铁律：已超出正常标准标签宽度（240px），不强行放大，严格锁定在 240px 上限
    fireEvent.click(getByLabelText('关闭 会话二'), { clientX: 450 });
    expect(tablist.getAttribute('data-locked')).toBe('true');
    expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('240px');
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
    const { container } = render(<PaneHeader leaf={leaf} isActive isChat />);
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;

    act(() => {
      Object.defineProperty(tablist, 'clientWidth', { configurable: true, value: 500 });
      Object.defineProperty(tablist, 'scrollWidth', { configurable: true, value: 500 });
      roManagerMock.state.cb?.({} as never);
    });

    // 容器 500px，非标签占用 36px，可用 464px
    // 4 标签 3 间隙 (12px)，(464 - 12) / 4 = 113px
    expect(tablist.style.getPropertyValue('--tab-item-width')).toBe('113px');
  });

  it('入场为 @starting-style 揭幕单轨：挂载后 data-booted 置位，无入场类状态机', () => {
    const leaf = makeLeaf('leaf-a', [makeTab('ta1', 's1', '会话一')], 'ta1');
    const { container, rerender } = render(
      <PaneHeader leaf={leaf} isActive isChat />
    );
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    // 首轮挂载后 booted 置位（首轮标签不重播生长动画由 CSS 门控保证）
    expect(tablist.getAttribute('data-booted')).toBe('true');
    const tab1 = container.querySelector('[data-tab-id="ta1"]') as HTMLElement;
    expect(tab1).not.toBeNull();
    expect(tab1.getAttribute('data-leaving')).toBeNull();

    // 新增 ta2：仅渲染新节点，无任何 JS 入场状态
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

    const tab2 = container.querySelector('[data-tab-id="ta2"]') as HTMLElement;
    expect(tab2).not.toBeNull();
    expect(tab2.getAttribute('data-leaving')).toBeNull();
  });

  it('键盘方向键在标签间循环移动并激活（tablist 键盘可达）', () => {
    const leaf = makeLeaf(
      'leaf-a',
      [makeTab('ta1', 's1', '会话一'), makeTab('ta2', 's2', '会话二')],
      'ta1'
    );
    const { container } = render(<PaneHeader leaf={leaf} isActive isChat />);
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    const tab1 = tablist.querySelector('[data-tab-id="ta1"]') as HTMLElement;
    const tab2 = tablist.querySelector('[data-tab-id="ta2"]') as HTMLElement;
    expect(tab1.getAttribute('tabindex')).toBe('0');
    expect(tab2.getAttribute('tabindex')).toBe('-1');

    tab1.focus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab2);
    expect(shellMocks.activateTab).toHaveBeenCalledWith('leaf-a', 'ta2');

    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab1);
    expect(shellMocks.activateTab).toHaveBeenCalledWith('leaf-a', 'ta1');
  });
});
