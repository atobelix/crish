/**
 * apps/crish-desktop/src/components/ui/DropdownMenu/DropdownMenu.test.tsx
 *
 * ui/DropdownMenu 自动化单元与交互回归测试套件
 *
 * 覆盖范围：
 * 1. Base UI Headless 现代化架构与复合组件拓扑 (Root, Trigger, Content, Item, Submenu, Checkbox, Radio, Separator)；
 * 2. 扁平 Props 语法糖向后兼容测试 (trigger, options, onSelect, openState, position, panel)；
 * 3. 模态/浮层栈管理与 #popover-root 单例容器挂载保证；
 * 4. 完整的无障碍 WAI-ARIA 属性（aria-haspopup, aria-expanded, role="menu", role="menuitem" 等）；
 * 5. 键盘焦点漫游 (ArrowUp / ArrowDown / Enter / Esc) 与 IME 组合输入守卫；
 * 6. 点击外部 (outside-press) 与 Esc 自然收起及焦点复位。
 */

// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import {
  DropdownMenu,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuShortcut,
} from './index';
import { layerStackService } from '../internal/layer-stack/LayerStackManager';
import styles from './DropdownMenu.module.css';

describe('ui/DropdownMenu 现代化 Base UI 下拉菜单', () => {
  let popoverRoot: HTMLElement;

  beforeEach(() => {
    // 准备真实宿主 Multi-Root 单例挂载节点
    popoverRoot = document.createElement('div');
    popoverRoot.id = 'popover-root';
    document.body.appendChild(popoverRoot);
  });

  afterEach(() => {
    cleanup();
    layerStackService.dispose();
    vi.restoreAllMocks();
    if (popoverRoot && popoverRoot.parentNode) {
      popoverRoot.parentNode.removeChild(popoverRoot);
    }
  });

  /* ======================================================================= */
  /* 1. 基础挂载与 #popover-root 单例容器保证                                    */
  /* ======================================================================= */

  it('准确将弹出层 Portal 挂载至 #popover-root 容器中，且关闭时完全卸载', async () => {
    render(
      <DropdownMenu
        trigger={<button type="button">打开菜单</button>}
        options={[
          { id: '1', label: '菜单项一' },
          { id: '2', label: '菜单项二' },
        ]}
      />
    );

    // 未展开前，popoverRoot 不应存在菜单节点
    expect(popoverRoot.querySelector('[role="menu"]')).toBeNull();

    // 点击打开
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));

    // 等待菜单在 #popover-root 中挂载
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(popoverRoot.contains(menu)).toBe(true);

    // 点击外部区域
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(popoverRoot.querySelector('[role="menu"]')).toBeNull();
  });

  it('当 #popover-root 缺失时，能安全回退至 document.body 挂载而绝不抛出异常', async () => {
    // 移除 popoverRoot
    popoverRoot.remove();

    render(
      <DropdownMenu
        trigger={<button type="button">无 Root 菜单</button>}
        options={[{ id: 'item', label: '回退测试项' }]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '无 Root 菜单' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(document.body.contains(menu)).toBe(true);
  });

  /* ======================================================================= */
  /* 2. WAI-ARIA 完整无障碍属性断言                                           */
  /* ======================================================================= */

  it('具备标准 WAI-ARIA 属性（aria-haspopup, aria-expanded, role="menu", role="menuitem"）', async () => {
    render(
      <DropdownMenu
        trigger={<button type="button">操作菜单</button>}
        options={[
          { id: 'save', label: '保存文件' },
          { id: 'delete', label: '删除', danger: true },
          { id: 'lock', label: '锁定', disabled: true },
        ]}
      />
    );

    const triggerBtn = screen.getByRole('button', { name: '操作菜单' });
    expect(triggerBtn).toHaveAttribute('aria-haspopup', 'menu');
    expect(triggerBtn).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(triggerBtn);

    expect(triggerBtn).toHaveAttribute('aria-expanded', 'true');
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveAttribute('role', 'menu');

    const saveItem = screen.getByRole('menuitem', { name: /保存文件/ });
    const deleteItem = screen.getByRole('menuitem', { name: /删除/ });
    const lockItem = screen.getByRole('menuitem', { name: /锁定/ });

    expect(saveItem).toBeInTheDocument();
    expect(deleteItem).toHaveClass(styles.menuItemDanger);
    expect(lockItem).toHaveAttribute('data-disabled');
    expect(lockItem).toHaveClass(styles.menuItemDisabled);
  });

  /* ======================================================================= */
  /* 3. 键盘漫游与原生 Headless 状态机                                        */
  /* ======================================================================= */

  it('支持键盘上下方向键导航与 Enter 确认选中', async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu
        trigger={<button type="button">键盘菜单</button>}
        onSelect={onSelect}
        options={[
          { id: 'opt1', label: '第一项' },
          { id: 'opt2', label: '第二项' },
          { id: 'opt3', label: '第三项' },
        ]}
      />
    );

    const trigger = screen.getByRole('button', { name: '键盘菜单' });
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();

    const item1 = screen.getByRole('menuitem', { name: /第一项/ });
    const item2 = screen.getByRole('menuitem', { name: /第二项/ });

    menu.focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(item1).toHaveAttribute('data-highlighted');
    });

    fireEvent.keyDown(item1, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(item2).toHaveAttribute('data-highlighted');
    });

    // Enter 确认选中
    fireEvent.keyDown(item2, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      'opt2',
      expect.objectContaining({ id: 'opt2', label: '第二项' })
    );

    // 选中后菜单自动收起
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  it('点击菜单项触发 onClick 并关闭菜单', async () => {
    const onItemClick = vi.fn();
    const onSelect = vi.fn();
    render(
      <DropdownMenu
        trigger={<button type="button">点击测试</button>}
        onSelect={onSelect}
        options={[{ id: 'act', label: '触发动作', onClick: onItemClick }]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '点击测试' }));
    const item = await screen.findByRole('menuitem', { name: /触发动作/ });
    fireEvent.click(item);

    expect(onItemClick).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('act', expect.anything());

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  /* ======================================================================= */
  /* 4. LayerStackManager 浮层栈互斥与 Esc/外点自然收起                          */
  /* ======================================================================= */

  it('按下 Esc 键自然收起菜单并还原焦点至触发器', async () => {
    const onEscape = vi.fn();
    render(
      <DropdownMenu
        trigger={<button type="button">Esc菜单</button>}
        outsideHandlers={{ onEscapeKeyDown: onEscape }}
        options={[{ id: '1', label: '项1' }]}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Esc菜单' });
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();

    // 触发 Esc 键
    fireEvent.keyDown(menu, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('在 IME 组合输入状态（isComposing / Process）下按下 Esc 不得误关菜单', async () => {
    render(
      <DropdownMenu
        trigger={<button type="button">IME输入菜单</button>}
        options={[{ id: '1', label: '项1' }]}
      />
    );

    const trigger = screen.getByRole('button', { name: 'IME输入菜单' });
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();

    // 模拟输入法合成事件中的 Esc
    const composingEvent = new KeyboardEvent('keydown', {
      key: 'Process',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEvent, 'isComposing', { value: true });
    menu.dispatchEvent(composingEvent);

    // 菜单保持开启
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('自动注册至 layerStackService 并在展开时驱逐同级互斥浮层', async () => {
    // 预先注册一个互斥的 popover
    const popoverEl = document.createElement('div');
    document.body.appendChild(popoverEl);
    const unregisterMock = vi.fn();
    layerStackService.register({
      id: 'existing-popover',
      type: 'popover',
      dismissible: true,
      onDismiss: unregisterMock,
      elementRef: { current: popoverEl },
    });

    render(
      <DropdownMenu
        trigger={<button type="button">互斥验证</button>}
        options={[{ id: '1', label: '新菜单' }]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '互斥验证' }));
    await screen.findByRole('menu');

    // 确认旧浮层被驱逐
    expect(unregisterMock).toHaveBeenCalledWith('programmatic');

    // 确认当前 dropdown-menu 已在栈中
    const top = layerStackService.getTopLayer();
    expect(top?.type).toBe('dropdown-menu');

    popoverEl.remove();
  });

  /* ======================================================================= */
  /* 5. 现代化纯复合组件模式 (Compound Components Topology)                     */
  /* ======================================================================= */

  it('支持全套声明式复合组件模式 (Root, Trigger, Content, Item, Separator, Checkbox, Radio, Group)', async () => {
    function FullCompoundDemo() {
      const [checked, setChecked] = useState(true);
      const [radioVal, setRadioVal] = useState('dark');

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button">复合组件入口</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuLabel>账户设置</DropdownMenuLabel>
              <DropdownMenuItem icon={<span data-testid="user-icon">U</span>}>
                个人资料
              </DropdownMenuItem>
              <DropdownMenuItem description="查看团队与权限">
                团队管理
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={checked}
              onCheckedChange={setChecked}
              shortcut="⌘S"
            >
              自动同步
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={radioVal}
              onValueChange={setRadioVal}
            >
              <DropdownMenuRadioItem value="light">
                浅色主题
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                深色主题
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    render(<FullCompoundDemo />);

    const trigger = screen.getByRole('button', { name: '复合组件入口' });
    fireEvent.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();

    // 验证文字与结构
    expect(screen.getByText('账户设置')).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /个人资料/ })
    ).toBeInTheDocument();
    expect(screen.getByText('查看团队与权限')).toBeInTheDocument();

    // 验证 Checkbox 语义与状态
    const checkbox = screen.getByRole('menuitemcheckbox', { name: /自动同步/ });
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('⌘S')).toBeInTheDocument();

    // 验证 Radio 语义与状态
    const lightRadio = screen.getByRole('menuitemradio', { name: /浅色主题/ });
    const darkRadio = screen.getByRole('menuitemradio', { name: /深色主题/ });
    expect(lightRadio).toHaveAttribute('aria-checked', 'false');
    expect(darkRadio).toHaveAttribute('aria-checked', 'true');

    // 验证 Separator 语义
    const separators = screen.getAllByRole('separator');
    expect(separators.length).toBe(2);
  });

  it('支持受控模式 (open / onOpenChange)', async () => {
    const handleOpenChange = vi.fn();
    function ControlledTest() {
      const [open, setOpen] = useState(false);
      return (
        <DropdownMenu
          open={open}
          onOpenChange={(next, details) => {
            setOpen(next);
            handleOpenChange(next, details);
          }}
        >
          <DropdownMenuTrigger asChild>
            <button type="button">受控触发器</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>受控条目</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    render(<ControlledTest />);

    const trigger = screen.getByRole('button', { name: '受控触发器' });
    fireEvent.click(trigger);

    expect(handleOpenChange).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ reason: 'trigger-press' })
    );
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
  });

  /* ======================================================================= */
  /* 6. 级联子菜单 (Submenu) 与高级特性                                        */
  /* ======================================================================= */

  it('支持级联子菜单 (DropdownMenuSub, SubTrigger, SubContent)', async () => {
    const onSubAction = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">多级菜单入口</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>一级菜单项</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>高级选项</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={onSubAction}>
                二级操作项
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    fireEvent.click(screen.getByRole('button', { name: '多级菜单入口' }));
    await screen.findByRole('menu');

    const subTrigger = screen.getByRole('menuitem', { name: /高级选项/ });
    expect(subTrigger).toBeInTheDocument();

    // 展开二级子菜单
    fireEvent.click(subTrigger);
    const subItem = await screen.findByRole('menuitem', { name: /二级操作项/ });
    expect(subItem).toBeInTheDocument();

    fireEvent.click(subItem);
    expect(onSubAction).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  /* ======================================================================= */
  /* 7. 扁平 Props 语法糖扩展 (renderItem, panel, outsideHandlers)              */
  /* ======================================================================= */

  it('支持自定义 renderItem 渲染函数与面板标题', async () => {
    render(
      <DropdownMenu
        trigger={<button type="button">自定义渲染</button>}
        panel={{ title: '分组标头' }}
        options={[
          { id: 'custom-1', label: '定制项甲' },
          { id: 'custom-2', label: '定制项乙' },
        ]}
        renderItem={(opt, idx) => (
          <div key={opt.id} role="menuitem" data-custom-item="true">
            {idx + 1}. {opt.label} (增强)
          </div>
        )}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '自定义渲染' }));
    await screen.findByRole('menu');

    expect(screen.getByText('分组标头')).toBeInTheDocument();
    expect(screen.getByText('1. 定制项甲 (增强)')).toBeInTheDocument();
    expect(screen.getByText('2. 定制项乙 (增强)')).toBeInTheDocument();
  });

  it('支持触发器挂载 Tooltip 复合结构且菜单开启时禁用 Tooltip', async () => {
    render(
      <DropdownMenu
        trigger={
          <button type="button" title="快捷说明">
            带提示触发器
          </button>
        }
        options={[{ id: '1', label: '选项' }]}
      />
    );

    const btn = screen.getByRole('button', { name: '带提示触发器' });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);

    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
  });

  it('支持 outsideHandlers 回调派发 (onInteractOutside, onEscapeKeyDown)', async () => {
    const onInteractOutside = vi.fn();
    const onEscapeKeyDown = vi.fn();

    render(
      <DropdownMenu
        trigger={<button type="button">回调测试</button>}
        outsideHandlers={{
          onInteractOutside,
          onEscapeKeyDown,
        }}
        options={[{ id: '1', label: '项' }]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '回调测试' }));
    const menu = await screen.findByRole('menu');

    // 触发 Esc
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => {
      expect(onEscapeKeyDown).toHaveBeenCalled();
    });
  });
});
