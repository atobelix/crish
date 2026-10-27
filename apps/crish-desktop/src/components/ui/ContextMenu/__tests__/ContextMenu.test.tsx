// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/ContextMenu/__tests__/ContextMenu.test.tsx
 *
 * 自研现代化 ContextMenu 复合组件全覆盖自动化测试套件
 * 覆盖：
 * 1. 右键触发打开 (VirtualPoint 坐标捕获与 Portal 挂载)
 * 2. 键盘上下方向键漫游 (ArrowDown / ArrowUp / 跳过 disabled / 循环)
 * 3. 打字快速检索 (600ms 动态窗口 Typeahead 字符检索、多字符前缀、超时重置与单字符轮换)
 * 4. 二级子菜单级联 (ArrowRight 打开子菜单聚焦首项、ArrowLeft 关闭子菜单退回父项、Safe-Aim 防抖)
 * 5. 点击与回车触发 onSelect 并自动关闭菜单体系
 * 6. 多选 CheckboxItem、单选 RadioGroup 与 Escape/Outside 安全关闭
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from '@testing-library/react';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
  ContextMenuLabel,
  ContextMenuGroup,
  ContextMenuShortcut,
} from '../index';

describe('ContextMenu 现代化自研复合组件体系', () => {
  beforeEach(() => {
    // Mock 浏览器几何排版引擎，确保 JSDOM 中真实尺寸测量正常运转
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return {
          width: 200,
          height: 240,
          top: 100,
          left: 100,
          right: 300,
          bottom: 340,
          x: 100,
          y: 100,
          toJSON: () => {},
        } as DOMRect;
      }
    );

    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      value: 240,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // 测试辅助菜单拓扑
  function TestMenu({
    onProfileSelect,
    onSettingsSelect,
    onDeleteSelect,
    onSubItemSelect,
  }: {
    onProfileSelect?: () => void;
    onSettingsSelect?: () => void;
    onDeleteSelect?: () => void;
    onSubItemSelect?: () => void;
  } = {}) {
    const [checked, setChecked] = useState(true);
    const [theme, setTheme] = useState('dark');

    return (
      <ContextMenu>
        <ContextMenuTrigger data-testid="context-trigger">
          <div style={{ width: 300, height: 200 }}>右键点击此区域</div>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid="context-content">
          <ContextMenuLabel>操作列表</ContextMenuLabel>
          <ContextMenuItem
            id="item-profile"
            onSelect={onProfileSelect}
            shortcut="⌘P"
          >
            Profile 个人档案
          </ContextMenuItem>
          <ContextMenuItem
            id="item-settings"
            onSelect={onSettingsSelect}
            shortcut="⌘,"
          >
            Settings 系统设置
          </ContextMenuItem>
          <ContextMenuItem id="item-disabled" disabled>
            Disabled 禁用条目
          </ContextMenuItem>
          <ContextMenuSeparator />

          <ContextMenuSub>
            <ContextMenuSubTrigger id="sub-trigger-more">
              More 更多操作
            </ContextMenuSubTrigger>
            <ContextMenuSubContent data-testid="sub-content">
              <ContextMenuItem id="sub-item-export" onSelect={onSubItemSelect}>
                Export 导出数据
              </ContextMenuItem>
              <ContextMenuItem id="sub-item-share">
                Share 分享链接
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator />

          <ContextMenuCheckboxItem
            id="checkbox-item"
            checked={checked}
            onCheckedChange={setChecked}
          >
            Show Line Numbers
          </ContextMenuCheckboxItem>

          <ContextMenuRadioGroup value={theme} onValueChange={setTheme}>
            <ContextMenuRadioItem id="radio-dark" value="dark">
              Dark Theme
            </ContextMenuRadioItem>
            <ContextMenuRadioItem id="radio-light" value="light">
              Light Theme
            </ContextMenuRadioItem>
          </ContextMenuRadioGroup>

          <ContextMenuSeparator />
          <ContextMenuItem
            id="item-delete"
            variant="danger"
            onSelect={onDeleteSelect}
            shortcut="⌫"
          >
            Delete 删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  /* ========================================================================= */
  /* 1. 右键触发打开测试                                                        */
  /* ========================================================================= */
  describe('1. 右键触发打开与基础结构', () => {
    it('默认情况下菜单未挂载，不渲染内容', () => {
      render(<TestMenu />);
      expect(screen.queryByTestId('context-content')).toBeNull();
      expect(screen.queryByText('Profile 个人档案')).toBeNull();
    });

    it('在 Trigger 上右键触发 contextmenu 事件，阻止默认行为并渲染内容', async () => {
      render(<TestMenu />);
      const trigger = screen.getByTestId('context-trigger');

      fireEvent.contextMenu(trigger, {
        clientX: 150,
        clientY: 220,
      });

      const content = await screen.findByTestId('context-content');
      expect(content).toBeInTheDocument();
      expect(content).toHaveAttribute('data-slot', 'context-menu-content');
      expect(content).toHaveAttribute('data-state', 'open');
      expect(content).toHaveAttribute('role', 'menu');

      // 验证条目正常挂载
      expect(screen.getByText('Profile 个人档案')).toBeInTheDocument();
      expect(screen.getByText('Settings 系统设置')).toBeInTheDocument();
      expect(screen.getByText('Disabled 禁用条目')).toBeInTheDocument();
      expect(screen.getByText('⌘P')).toBeInTheDocument();
    });
  });

  /* ========================================================================= */
  /* 2. 键盘上下方向键漫游测试                                                  */
  /* ========================================================================= */
  describe('2. 键盘上下方向键漫游 (ArrowDown / ArrowUp)', () => {
    it('打开菜单后自动高亮第一项，按 ArrowDown 移动聚焦并自动跳过 disabled 项', async () => {
      render(<TestMenu />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });

      const content = await screen.findByTestId('context-content');

      // 首个有效项 Profile 自动高亮
      const itemProfile = screen
        .getByText('Profile 个人档案')
        .closest('[role="menuitem"]')!;
      expect(itemProfile).toHaveAttribute('data-highlighted', 'true');

      // 按下 ArrowDown 移动到 Settings
      fireEvent.keyDown(content, { key: 'ArrowDown' });
      const itemSettings = screen
        .getByText('Settings 系统设置')
        .closest('[role="menuitem"]')!;
      expect(itemSettings).toHaveAttribute('data-highlighted', 'true');
      expect(itemProfile).not.toHaveAttribute('data-highlighted');

      // 再次按下 ArrowDown，跳过 disabled 项，移动到 More (SubTrigger)
      fireEvent.keyDown(content, { key: 'ArrowDown' });
      const subTrigger = screen
        .getByText('More 更多操作')
        .closest('[role="menuitem"]')!;
      expect(subTrigger).toHaveAttribute('data-highlighted', 'true');
      expect(itemSettings).not.toHaveAttribute('data-highlighted');

      // 按下 ArrowUp 退回到 Settings
      fireEvent.keyDown(content, { key: 'ArrowUp' });
      expect(itemSettings).toHaveAttribute('data-highlighted', 'true');
      expect(subTrigger).not.toHaveAttribute('data-highlighted');
    });

    it('支持首尾循环漫游 (loop: true)', async () => {
      render(<TestMenu />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });
      const content = await screen.findByTestId('context-content');

      // 处于第 1 项 Profile，按 ArrowUp 应该循环跳转至末尾有效项 Delete
      fireEvent.keyDown(content, { key: 'ArrowUp' });
      const itemDelete = screen
        .getByText('Delete 删除')
        .closest('[role="menuitem"]')!;
      expect(itemDelete).toHaveAttribute('data-highlighted', 'true');

      // 再次按 ArrowDown 循环回到第 1 项 Profile
      fireEvent.keyDown(content, { key: 'ArrowDown' });
      const itemProfile = screen
        .getByText('Profile 个人档案')
        .closest('[role="menuitem"]')!;
      expect(itemProfile).toHaveAttribute('data-highlighted', 'true');
    });
  });

  /* ========================================================================= */
  /* 3. 打字快速检索测试 (600ms Typeahead)                                      */
  /* ========================================================================= */
  describe('3. 打字快速检索 (600ms Typeahead)', () => {
    it('键入字符时快速匹配对应项并高亮聚焦，并在超时后重置缓冲区', async () => {
      render(<TestMenu />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });
      const content = await screen.findByTestId('context-content');

      // 初始高亮 Profile
      const itemProfile = screen
        .getByText('Profile 个人档案')
        .closest('[role="menuitem"]')!;
      expect(itemProfile).toHaveAttribute('data-highlighted', 'true');

      // 快速键入 's' -> 匹配到 Settings
      fireEvent.keyDown(content, { key: 's' });
      const itemSettings = screen
        .getByText('Settings 系统设置')
        .closest('[role="menuitem"]')!;
      expect(itemSettings).toHaveAttribute('data-highlighted', 'true');

      // 紧接着键入 'e' -> 前缀匹配 "se" -> 依然精准聚焦在 Settings
      fireEvent.keyDown(content, { key: 'e' });
      expect(itemSettings).toHaveAttribute('data-highlighted', 'true');

      // 等待 650ms 超过 600ms 动态窗口，缓冲区自动清空
      await act(async () => {
        await new Promise((r) => setTimeout(r, 650));
      });

      // 清空后键入 'd' -> 首个命中 Dark Theme (自动跳过 disabled 的 "Disabled" 项)
      fireEvent.keyDown(content, { key: 'd' });
      const radioDark = screen
        .getByText('Dark Theme')
        .closest('[role="menuitemradio"]')!;
      expect(radioDark).toHaveAttribute('data-highlighted', 'true');

      // 再次键入 'd' -> 单字符轮换匹配下一个以 'd' 开头的有效项 Delete
      fireEvent.keyDown(content, { key: 'd' });
      const itemDelete = screen
        .getByText('Delete 删除')
        .closest('[role="menuitem"]')!;
      expect(itemDelete).toHaveAttribute('data-highlighted', 'true');
    });
  });

  /* ========================================================================= */
  /* 4. 二级子菜单级联测试 (ArrowRight/ArrowLeft/Safe-Aim)                      */
  /* ========================================================================= */
  describe('4. 二级子菜单级联 (ArrowRight / ArrowLeft / 鼠标交互)', () => {
    it('在 SubTrigger 上按 ArrowRight 打开子菜单并聚焦子菜单首项，按 ArrowLeft 关闭退回', async () => {
      render(<TestMenu />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });
      const content = await screen.findByTestId('context-content');

      // 移动高亮至 SubTrigger (More 更多操作)
      fireEvent.keyDown(content, { key: 'ArrowDown' }); // Settings
      fireEvent.keyDown(content, { key: 'ArrowDown' }); // More
      const subTrigger = screen
        .getByText('More 更多操作')
        .closest('[role="menuitem"]')!;
      expect(subTrigger).toHaveAttribute('data-highlighted', 'true');
      expect(subTrigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(subTrigger).toHaveAttribute('aria-expanded', 'false');

      // 按下 ArrowRight 打开子菜单
      fireEvent.keyDown(content, { key: 'ArrowRight' });

      // 验证子菜单挂载展开
      const subContent = await screen.findByTestId('sub-content');
      expect(subContent).toBeInTheDocument();
      expect(subTrigger).toHaveAttribute('aria-expanded', 'true');

      // 验证子菜单首项 Export 自动聚焦高亮
      const subItemExport = screen
        .getByText('Export 导出数据')
        .closest('[role="menuitem"]')!;
      expect(subItemExport).toHaveAttribute('data-highlighted', 'true');

      // 在子菜单内部按 ArrowDown，在子菜单内漫游至 Share
      fireEvent.keyDown(subContent, { key: 'ArrowDown' });
      const subItemShare = screen
        .getByText('Share 分享链接')
        .closest('[role="menuitem"]')!;
      expect(subItemShare).toHaveAttribute('data-highlighted', 'true');
      expect(subItemExport).not.toHaveAttribute('data-highlighted');

      // 在子菜单内按下 ArrowLeft，收起子菜单并退回父级 SubTrigger
      fireEvent.keyDown(subContent, { key: 'ArrowLeft' });

      await waitFor(() => {
        expect(screen.queryByTestId('sub-content')).toBeNull();
      });
      expect(subTrigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('鼠标悬停 SubTrigger 打开子菜单，移出时防抖关闭', async () => {
      render(<TestMenu />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });

      const subTrigger = (await screen.findByText('More 更多操作')).closest(
        '[role="menuitem"]'
      )!;

      // 鼠标移入 SubTrigger
      fireEvent.mouseEnter(subTrigger);
      expect(await screen.findByTestId('sub-content')).toBeInTheDocument();

      // 鼠标移出 SubTrigger (触发 220ms 防抖安全保护)
      fireEvent.mouseLeave(subTrigger);
      // 尚未到 220ms，子菜单仍保持打开
      expect(screen.queryByTestId('sub-content')).not.toBeNull();

      // 等待 260ms 真实时间，定时器触发后子菜单平滑关闭
      await act(async () => {
        await new Promise((r) => setTimeout(r, 260));
      });
      expect(screen.queryByTestId('sub-content')).toBeNull();
    });
  });

  /* ========================================================================= */
  /* 5. 点击与回车触发 onSelect 并关闭菜单                                       */
  /* ========================================================================= */
  describe('5. 点击与回车选择', () => {
    it('鼠标点击菜单项触发 onSelect 回调并关闭顶级菜单', async () => {
      const onProfileSelect = vi.fn();
      render(<TestMenu onProfileSelect={onProfileSelect} />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });

      const itemProfile = await screen.findByText('Profile 个人档案');
      fireEvent.click(itemProfile);

      expect(onProfileSelect).toHaveBeenCalledTimes(1);
      // 验证菜单已关闭并卸载
      await waitFor(() => {
        expect(screen.queryByTestId('context-content')).toBeNull();
      });
    });

    it('回车键激活选中当前高亮项并关闭顶级菜单', async () => {
      const onSettingsSelect = vi.fn();
      render(<TestMenu onSettingsSelect={onSettingsSelect} />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });
      const content = await screen.findByTestId('context-content');

      // 聚焦至 Settings
      fireEvent.keyDown(content, { key: 'ArrowDown' });
      // 按 Enter 键执行选择
      fireEvent.keyDown(content, { key: 'Enter' });

      expect(onSettingsSelect).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(screen.queryByTestId('context-content')).toBeNull();
      });
    });

    it('子菜单条目点击后，触发对应回调并关闭包括父级在内的整个菜单体系', async () => {
      const onSubItemSelect = vi.fn();
      render(<TestMenu onSubItemSelect={onSubItemSelect} />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });
      const content = await screen.findByTestId('context-content');

      // 打开子菜单
      fireEvent.keyDown(content, { key: 'ArrowDown' });
      fireEvent.keyDown(content, { key: 'ArrowDown' });
      fireEvent.keyDown(content, { key: 'ArrowRight' });

      const subItemExport = await screen.findByText('Export 导出数据');
      fireEvent.click(subItemExport);

      expect(onSubItemSelect).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(screen.queryByTestId('sub-content')).toBeNull();
        expect(screen.queryByTestId('context-content')).toBeNull();
      });
    });
  });

  /* ========================================================================= */
  /* 6. CheckboxItem / RadioItem / Escape / PointerDownOutside 关闭             */
  /* ========================================================================= */
  describe('6. 状态条目与安全关闭交互', () => {
    it('CheckboxItem 勾选状态切换与指示器展示', async () => {
      render(<TestMenu />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });

      const checkboxItem = (
        await screen.findByText('Show Line Numbers')
      ).closest('[role="menuitemcheckbox"]')!;
      expect(checkboxItem).toHaveAttribute('aria-checked', 'true');
      expect(checkboxItem.querySelector('svg')).toBeInTheDocument();

      // 点击切换
      fireEvent.click(checkboxItem);
      // 再次右键打开查看状态是否已更新
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });
      const updatedCheckboxItem = (
        await screen.findByText('Show Line Numbers')
      ).closest('[role="menuitemcheckbox"]')!;
      expect(updatedCheckboxItem).toHaveAttribute('aria-checked', 'false');
    });

    it('RadioGroup 与 RadioItem 单选状态切换', async () => {
      render(<TestMenu />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });

      const radioDark = (await screen.findByText('Dark Theme')).closest(
        '[role="menuitemradio"]'
      )!;
      const radioLight = (await screen.findByText('Light Theme')).closest(
        '[role="menuitemradio"]'
      )!;

      expect(radioDark).toHaveAttribute('aria-checked', 'true');
      expect(radioLight).toHaveAttribute('aria-checked', 'false');

      // 切换至 Light
      fireEvent.click(radioLight);
      // 重新打开验证
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });
      const newDark = (await screen.findByText('Dark Theme')).closest(
        '[role="menuitemradio"]'
      )!;
      const newLight = (await screen.findByText('Light Theme')).closest(
        '[role="menuitemradio"]'
      )!;

      expect(newDark).toHaveAttribute('aria-checked', 'false');
      expect(newLight).toHaveAttribute('aria-checked', 'true');
    });

    it('按下 Escape 键安全关闭菜单', async () => {
      render(<TestMenu />);
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });

      const content = await screen.findByTestId('context-content');
      fireEvent.keyDown(content, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByTestId('context-content')).toBeNull();
      });
    });

    it('点击菜单外部区域安全关闭菜单', async () => {
      render(
        <div>
          <button data-testid="outside-button">Outside Button</button>
          <TestMenu />
        </div>
      );
      const trigger = screen.getByTestId('context-trigger');
      fireEvent.contextMenu(trigger, { clientX: 100, clientY: 100 });

      expect(await screen.findByTestId('context-content')).toBeInTheDocument();

      // 在外部按钮触发 pointerdown
      const outsideButton = screen.getByTestId('outside-button');
      fireEvent.pointerDown(outsideButton);

      await waitFor(() => {
        expect(screen.queryByTestId('context-content')).toBeNull();
      });
    });
  });
});
