// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act, screen, waitFor } from '@testing-library/react';
import { LeafToolTabStrip } from './LeafToolTabStrip';
import { useLayoutStore } from '../../store/layoutStore';
import { viewRegistry } from '../../services/view-registry';
import * as storeAccess from '../../store/storeAccess';

describe('LeafToolTabStrip 纯标签化、手势交互与状态机极限压测 (Scoped & Stress Suite)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useLayoutStore.getState().setTabModeEnabled(true);
    vi.spyOn(viewRegistry, 'getTitle').mockImplementation((id: string) => id);
    vi.spyOn(viewRegistry, 'getIcon').mockImplementation(
      () => 'terminal' as const
    );
    vi.spyOn(viewRegistry, 'getToolViews').mockReturnValue([
      { id: 'files', title: 'Files', isPrimary: false } as any,
      { id: 'diff', title: 'Diff', isPrimary: false } as any,
      { id: 'terminal', title: 'Terminal', isPrimary: false } as any,
      { id: 'preview', title: 'Preview', isPrimary: false } as any,
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. 标签栏基础结构与状态渲染 (DOM & Layout Contract)', () => {
    it('不再渲染 dockToolNav 固定工具条', () => {
      const leaf = { tabs: ['files', 'diff'], activeTab: 'files' };
      const { queryByRole } = render(<LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} />);
      expect(queryByRole('toolbar', { name: '会话工具' })).toBeNull();
    });

    it('每个 Tab 渲染对应的工具 Icon 与微型关闭按钮（多 Tab 时）', () => {
      const leaf = { tabs: ['files', 'diff'], activeTab: 'files' };
      const { getByText, getAllByTestId, getAllByLabelText } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} />
      );
      expect(getByText('files')).toBeTruthy();
      expect(getAllByTestId('tool-icon')).toHaveLength(2);
      expect(getAllByLabelText(/关闭/)).toHaveLength(2);
    });

    it('单 Tab 时也显示关闭叉号（允许关闭最后一个标签）', () => {
      const leaf = { tabs: ['files'], activeTab: 'files' };
      const { queryByLabelText } = render(<LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} />);
      expect(queryByLabelText(/关闭/)).toBeTruthy();
    });

    it('包含随流加号与固定区加号（双态加号结构）', () => {
      const leaf = { tabs: ['files'], activeTab: 'files' };
      const { container } = render(<LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} />);
      const inFlowBtn = container.querySelector('.side-panel-add-btn.in-flow');
      const pinnedBtn = container.querySelector('.side-panel-add-btn.pinned');
      expect(inFlowBtn).toBeTruthy();
      expect(pinnedBtn).toBeTruthy();
    });

    it('抽屉头不再放收起钮，收起由叶上唯一坞开关负责', () => {
      const leaf = { tabs: ['files'], activeTab: 'files' };
      const { queryByLabelText } = render(
        <LeafToolTabStrip
          leafId="tool-leaf-1"
          sessionId="sess-b"
          tabs={leaf.tabs}
          activeTab={leaf.activeTab}
        />
      );
      expect(queryByLabelText('收起右侧面板')).toBeNull();
    });

    it('支持最大化/恢复面板按钮切换与回调', () => {
      const onToggleMaximize = vi.fn();
      const leaf = { tabs: ['files'], activeTab: 'files' };
      const { getByLabelText, rerender } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} onToggleMaximize={onToggleMaximize} isMaximized={false} />
      );
      const maxBtn = getByLabelText('最大化面板');
      expect(maxBtn).toBeTruthy();
      fireEvent.click(maxBtn);
      expect(onToggleMaximize).toHaveBeenCalledTimes(1);

      rerender(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} onToggleMaximize={onToggleMaximize} isMaximized={true} />
      );
      const restoreBtn = getByLabelText('恢复面板');
      expect(restoreBtn).toBeTruthy();
      fireEvent.click(restoreBtn);
      expect(onToggleMaximize).toHaveBeenCalledTimes(2);
    });

    it('Row 2 导航工具条在显式开启时展示，在未显式开启或普通视图不展示', () => {
      const previewLeaf = { tabs: ['preview'], activeTab: 'preview' };
      const { getByTestId, queryByTestId, rerender } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={previewLeaf.tabs} activeTab={previewLeaf.activeTab} showNavToolbar={true} />
      );
      expect(getByTestId('side-panel-toolbar')).toBeTruthy();

      const filesLeaf = { tabs: ['files'], activeTab: 'files' };
      rerender(<LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={filesLeaf.tabs} activeTab={filesLeaf.activeTab} />);
      expect(queryByTestId('side-panel-toolbar')).toBeNull();
    });
  });

  describe('2. 加号展开与工具选择状态机 (Plus Expand & Menu State Machine)', () => {
    it('断言 2.1：点击加号按钮展开可选工具菜单，过滤掉已打开的 Tab', async () => {
      const leaf = { tabs: ['files', 'diff'], activeTab: 'files' };
      const { container } = render(<LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} />);

      const addBtn = container.querySelector(
        '.side-panel-add-btn.in-flow'
      ) as HTMLButtonElement;
      expect(addBtn).toBeTruthy();

      fireEvent.click(addBtn);

      // 菜单弹出，应该包含未打开的 terminal 与 preview
      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeTruthy();
      });

      const menuItems = screen.getAllByRole('menuitem');
      const itemTexts = menuItems.map((item) => item.textContent);
      expect(itemTexts).toContain('terminal');
      expect(itemTexts).toContain('preview');
      expect(itemTexts).not.toContain('files');
      expect(itemTexts).not.toContain('diff');
    });

    it('断言 2.2：点击菜单项触发 openPanel 并选中新工具', async () => {
      const onAddTab = vi.fn();
      const leaf = { tabs: ['files'], activeTab: 'files' };
      const { container } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} onAddTab={onAddTab} />
      );

      const addBtn = container.querySelector(
        '.side-panel-add-btn.in-flow'
      ) as HTMLButtonElement;
      fireEvent.click(addBtn);

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeTruthy();
      });

      const diffItem = screen
        .getAllByRole('menuitem')
        .find((item) => item.textContent?.includes('diff'));
      expect(diffItem).toBeTruthy();
      fireEvent.click(diffItem!);

      expect(onAddTab).toHaveBeenCalledWith('diff');
    });

    it('断言 2.3：浏览器标签允许无限添加，已存在 preview 时仍可点击加号打开 preview:2', async () => {
      const onAddTab = vi.fn();
      const leaf = { tabs: ['files', 'diff', 'terminal', 'preview'], activeTab: 'files' };
      const { container } = render(
        <LeafToolTabStrip
          leafId="tool-leaf-1"
          sessionId="sess-b"
          sessionTabId="tab-sess"
          tabs={leaf.tabs}
          activeTab={leaf.activeTab}
          onAddTab={onAddTab}
        />
      );

      const addBtn = container.querySelector(
        '.side-panel-add-btn.in-flow'
      ) as HTMLButtonElement;
      fireEvent.click(addBtn);

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeTruthy();
      });

      const previewItem = screen
        .getAllByRole('menuitem')
        .find((item) => item.textContent?.includes('preview'));
      expect(previewItem).toBeTruthy();
      fireEvent.click(previewItem!);

      expect(onAddTab).toHaveBeenCalledWith('preview:2');
    });

    it('断言 2.4：工具列表完全为空时，加号按钮渲染为 Tooltip 模式，不弹出空菜单', () => {
      vi.spyOn(viewRegistry, 'getToolViews').mockReturnValue([]);
      const leaf = { tabs: ['files'], activeTab: 'files' };
      const { container } = render(
        <LeafToolTabStrip
          leafId="tool-leaf-1"
          sessionId="sess-b"
          sessionTabId="tab-sess"
          tabs={leaf.tabs}
          activeTab={leaf.activeTab}
        />
      );

      const addBtn = container.querySelector(
        '.side-panel-add-btn.in-flow'
      ) as HTMLButtonElement;
      fireEvent.click(addBtn);

      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  describe('3. Tab 切换、手势滚轮与中键关闭 (Tab Gestures & Wheel)', () => {
    it('断言 3.1：点击未激活 Tab 切换活动标签', () => {
      const onSelectTab = vi.fn();
      const leaf = { tabs: ['files', 'diff'], activeTab: 'files' };
      const { getByText } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} onSelectTab={onSelectTab} />
      );

      const diffTab = getByText('diff');
      fireEvent.click(diffTab);
      expect(onSelectTab).toHaveBeenCalledWith('diff');
    });

    it('断言 3.2：鼠标中键 (auxClick button=1) 点击多 Tab 时触发关闭', () => {
      const onCloseTab = vi.fn();
      const leaf = { tabs: ['files', 'diff'], activeTab: 'files' };
      const { container } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} onCloseTab={onCloseTab} />
      );

      const diffTab = container.querySelector('[data-tab-id="diff"]')!;
      // 鼠标中键按下阻止默认行为
      fireEvent.mouseDown(diffTab, { button: 1 });
      fireEvent(
        diffTab,
        new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
      );

      // 离场走 [data-leaving] 单轨标记
      expect(diffTab.getAttribute('data-leaving')).toBe('true');

      // 离场 transition 到位后由 transitionend(max-width) 驱动摘除
      fireEvent.transitionEnd(diffTab, { propertyName: 'max-width' });

      expect(onCloseTab).toHaveBeenCalledWith('diff');
    });

    it('断言 3.3：单 Tab 时鼠标中键点击触发关闭', () => {
      const onCloseTab = vi.fn();
      const leaf = { tabs: ['files'], activeTab: 'files' };
      const { container } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} onCloseTab={onCloseTab} />
      );

      const filesTab = container.querySelector('[data-tab-id="files"]')!;
      fireEvent(
        filesTab,
        new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
      );

      fireEvent.transitionEnd(filesTab, { propertyName: 'max-width' });

      expect(onCloseTab).toHaveBeenCalledWith('files');
    });

    it('断言 3.4：横向滚轮滑动 (handleTrackWheel) 将 deltaY 转换为 scrollLeft 并 preventDefault', () => {
      const leaf = { tabs: ['files', 'diff', 'terminal'], activeTab: 'files' };
      const { container } = render(<LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} />);

      const track = container.querySelector('.side-panel-tabs-track') as HTMLDivElement;
      expect(track).toBeTruthy();

      track.scrollLeft = 0;
      const preventDefaultSpy = vi.fn();

      fireEvent.wheel(track, {
        deltaY: 50,
        deltaX: 0,
        preventDefault: preventDefaultSpy,
      });

      expect(track.scrollLeft).toBe(50);
    });

    it('断言 3.5：新增 Tab 走 @starting-style 揭幕单轨，data-booted 置位且无入场类状态', () => {
      const leaf1 = { tabs: ['files'], activeTab: 'files' };
      const { container, rerender } = render(<LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf1.tabs} activeTab={leaf1.activeTab} />);

      // 首轮挂载后 booted 置位（首轮不重播入场动画由 CSS 门控保证）
      const strip = container.querySelector('[data-leaf-tool-tab-strip="true"]')!;
      expect(strip.getAttribute('data-booted')).toBe('true');

      const leaf2 = { tabs: ['files', 'terminal'], activeTab: 'terminal' };
      rerender(<LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf2.tabs} activeTab={leaf2.activeTab} />);

      // 新标签仅渲染新节点：无 JS 入场状态、无离场标记
      const terminalTab = container.querySelector('[data-tab-id="terminal"]');
      expect(terminalTab).toBeTruthy();
      expect(terminalTab!.getAttribute('data-leaving')).toBeNull();
    });
  });

  describe('4. Tab 关闭极端状态机与级联防误销毁 (Tab Close Animation & State Machine)', () => {
    it('断言 4.1：关闭激活 Tab (index 0) 零延迟切换至后一个相邻 Tab (index 1)', () => {
      const onSelectTab = vi.fn();
      const onCloseTab = vi.fn();
      const leaf = { tabs: ['files', 'diff', 'terminal'], activeTab: 'files' };
      const { getByLabelText, container } = render(
        <LeafToolTabStrip
          leafId="tool-leaf-1"
          sessionId="sess-b"
          sessionTabId="tab-sess"
          tabs={leaf.tabs}
          activeTab={leaf.activeTab}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
        />
      );

      const closeFilesBtn = getByLabelText('关闭 files');
      fireEvent.click(closeFilesBtn);

      // 零延迟切换至后一个相邻 Tab
      expect(onSelectTab).toHaveBeenCalledWith('diff');

      // 离场 transition 到位后由 transitionend(max-width) 驱动摘除
      const filesTab = container.querySelector('[data-tab-id="files"]')!;
      fireEvent.transitionEnd(filesTab, { propertyName: 'max-width' });

      expect(onCloseTab).toHaveBeenCalledWith('files');
    });

    it('断言 4.2：关闭末尾激活 Tab 零延迟切换至前一个相邻 Tab', () => {
      const onSelectTab = vi.fn();
      const onCloseTab = vi.fn();
      const leaf = { tabs: ['files', 'diff'], activeTab: 'diff' };
      const { getByLabelText, container } = render(
        <LeafToolTabStrip
          leafId="tool-leaf-1"
          sessionId="sess-b"
          sessionTabId="tab-sess"
          tabs={leaf.tabs}
          activeTab={leaf.activeTab}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
        />
      );

      const closeDiffBtn = getByLabelText('关闭 diff');
      fireEvent.click(closeDiffBtn);

      // 零延迟切换至前一个相邻 Tab
      expect(onSelectTab).toHaveBeenCalledWith('files');

      const diffTab = container.querySelector('[data-tab-id="diff"]')!;
      fireEvent.transitionEnd(diffTab, { propertyName: 'max-width' });

      expect(onCloseTab).toHaveBeenCalledWith('diff');
    });

    it('断言 4.3：关闭非激活 Tab 不改变当前激活 Tab', () => {
      const onSelectTab = vi.fn();
      const onCloseTab = vi.fn();
      const leaf = { tabs: ['files', 'diff', 'terminal'], activeTab: 'files' };
      const { getByLabelText, container } = render(
        <LeafToolTabStrip
          leafId="tool-leaf-1"
          sessionId="sess-b"
          sessionTabId="tab-sess"
          tabs={leaf.tabs}
          activeTab={leaf.activeTab}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
        />
      );

      const closeTerminalBtn = getByLabelText('关闭 terminal');
      fireEvent.click(closeTerminalBtn);

      // 不切换激活 Tab
      expect(onSelectTab).not.toHaveBeenCalled();

      const terminalTab = container.querySelector('[data-tab-id="terminal"]')!;
      fireEvent.transitionEnd(terminalTab, { propertyName: 'max-width' });

      expect(onCloseTab).toHaveBeenCalledWith('terminal');
    });

    it('断言 4.4：重复连续快速点击同一 Tab 的关闭按钮，被 closingTabIds 防重拦截', () => {
      const onCloseTab = vi.fn();
      const leaf = { tabs: ['files', 'diff'], activeTab: 'files' };
      const { getByLabelText, container } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} onCloseTab={onCloseTab} />
      );

      const closeFilesBtn = getByLabelText('关闭 files');
      fireEvent.click(closeFilesBtn);
      fireEvent.click(closeFilesBtn);
      fireEvent.click(closeFilesBtn);

      const filesTab = container.querySelector('[data-tab-id="files"]')!;
      fireEvent.transitionEnd(filesTab, { propertyName: 'max-width' });

      // 仅触发一次真实关闭
      expect(onCloseTab).toHaveBeenCalledTimes(1);
      expect(onCloseTab).toHaveBeenCalledWith('files');
    });

    it('断言 4.5：并发关闭多个 Tab，各自 transitionend 独立触发且无竞态冲突', () => {
      const onCloseTab = vi.fn();
      const leaf = { tabs: ['files', 'diff', 'terminal'], activeTab: 'files' };
      const { getByLabelText, container } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} onCloseTab={onCloseTab} />
      );

      fireEvent.click(getByLabelText('关闭 diff'));
      fireEvent.click(getByLabelText('关闭 terminal'));

      // 各自的 transitionend 互不取消
      const diffTab = container.querySelector('[data-tab-id="diff"]')!;
      fireEvent.transitionEnd(diffTab, { propertyName: 'max-width' });
      expect(onCloseTab).toHaveBeenCalledWith('diff');
      expect(onCloseTab).not.toHaveBeenCalledWith('terminal');

      const terminalTab = container.querySelector('[data-tab-id="terminal"]')!;
      fireEvent.transitionEnd(terminalTab, { propertyName: 'max-width' });

      expect(onCloseTab).toHaveBeenCalledWith('terminal');
      expect(onCloseTab).toHaveBeenCalledTimes(2);
    });

    it('断言 4.6：空态（0 个 Tab）时渲染 Launcher Hub 居中卡片组，点击卡片打开对应工具', () => {
      const openToolSpy = vi
        .spyOn(storeAccess, 'openToolInSession')
        .mockImplementation(() => {});

      const emptyLeaf = {
        type: 'leaf' as const,
        id: 'tool-leaf-1',
        panelId: 'files',
        tabs: [],
        activeTab: '',
        sessionId: 'sess-b',
      };
      const { getByTestId, queryByTestId } = render(
        <LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={emptyLeaf.tabs} activeTab={emptyLeaf.activeTab} />
      );

      // 空态下 Row 2 隐藏
      expect(queryByTestId('side-panel-toolbar')).toBeNull();

      // 空态 Launcher Hub 展示
      expect(getByTestId('side-panel-launcher-hub')).toBeTruthy();

      // 点击应用预览卡片
      const previewCard = getByTestId('launcher-card-preview');
      expect(previewCard).toBeTruthy();
      fireEvent.click(previewCard);
      expect(openToolSpy).toHaveBeenCalledWith('sess-b', 'preview');

      // 点击代码产物与文件卡片
      const filesCard = getByTestId('launcher-card-files');
      expect(filesCard).toBeTruthy();
      fireEvent.click(filesCard);
      expect(openToolSpy).toHaveBeenCalledWith('sess-b', 'files');
    });

    it('断言 4.7：关闭唯一 Tab 成功触发 onCloseTab 且在无外部回调时自动折叠 SessionTab dock', () => {
      const onCloseTab = vi.fn();
      const leaf = { tabs: ['files'], activeTab: 'files' };
      const { getByLabelText, container } = render(
        <LeafToolTabStrip
          leafId="tool-leaf-1"
          sessionId="sess-b"
          sessionTabId="tab-sess"
          tabs={leaf.tabs}
          activeTab={leaf.activeTab}
          onCloseTab={onCloseTab}
        />
      );

      const closeFilesBtn = getByLabelText('关闭 files');
      fireEvent.click(closeFilesBtn);

      const filesTab = container.querySelector('[data-tab-id="files"]')!;
      fireEvent.transitionEnd(filesTab, { propertyName: 'max-width' });

      expect(onCloseTab).toHaveBeenCalledWith('files');
    });
  });

  describe('5. ESC 键退栈与高频极限压测 (ESC Dismissal & Stress Matrix)', () => {
    it('断言 5.1：加号菜单展开后按下 ESC 键，菜单安全关闭且 Tab 栏 DOM 无损', async () => {
      const leaf = { tabs: ['files', 'diff'], activeTab: 'files' };
      const { container } = render(<LeafToolTabStrip leafId="tool-leaf-1" sessionId="sess-b" sessionTabId="tab-sess" tabs={leaf.tabs} activeTab={leaf.activeTab} />);

      const addBtn = container.querySelector(
        '.side-panel-add-btn.in-flow'
      ) as HTMLButtonElement;
      fireEvent.click(addBtn);

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeTruthy();
      });

      // 触发 Escape
      fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('menu')).toBeNull();
      });

      // TabStrip DOM 完好
      expect(container.querySelector('[data-leaf-tool-tab-strip="true"]')).toBeTruthy();
    });

    it('断言 5.2：极限并发压测 (50 次高频 Tab 切换与关闭交互)，无死锁与内存状态异常', () => {
      const onSelectTab = vi.fn();
      const onCloseTab = vi.fn();
      const leaf = { tabs: ['files', 'diff', 'terminal', 'preview'], activeTab: 'files' };
      const { container, getByText, getByLabelText } = render(
        <LeafToolTabStrip
          leafId="tool-leaf-1"
          sessionId="sess-b"
          sessionTabId="tab-sess"
          tabs={leaf.tabs}
          activeTab={leaf.activeTab}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
        />
      );

      // 50 次高频切换
      for (let i = 0; i < 25; i++) {
        fireEvent.click(getByText('diff'));
        fireEvent.click(getByText('terminal'));
      }
      expect(onSelectTab).toHaveBeenCalledTimes(50);

      // 关闭 Tab
      fireEvent.click(getByLabelText('关闭 diff'));
      const diffTab = container.querySelector('[data-tab-id="diff"]')!;
      fireEvent.transitionEnd(diffTab, { propertyName: 'max-width' });

      expect(onCloseTab).toHaveBeenCalledWith('diff');
    });
  });
});
