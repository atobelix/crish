/**
 * ui/Menu 基座测试：双模 open、键盘漫游、Esc 关闭、a11y
 */
// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { Menu, toggleExclusiveMenu } from './index';
import { Dialog } from '../Dialog/Dialog';
import { layerStackService } from '../internal/layer-stack/LayerStackService';
import styles from './Menu.module.css';

const TRIGGER_TEXT = '菜单触发器';

/** 双模受控示例：外部 open + onOpenChange 桥接 */
function ControlledMenu({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      trigger={<button type="button">{TRIGGER_TEXT}</button>}
      openState={{
        open,
        onOpenChange: (next) => {
          setOpen(next);
          onOpenChange?.(next);
        },
      }}
      options={[
        { id: 'a', label: '选项甲' },
        { id: 'b', label: '选项乙' },
        { id: 'c', label: '选项丙', disabled: true },
      ]}
    />
  );
}

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('ui/Menu', () => {
  it('Trigger 不无条件拼 no-drag（窗拖排除留给 drag region 自己写）', () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[{ id: 'a', label: '选项甲' }]}
      />
    );
    const btn = screen.getByRole('button', { name: TRIGGER_TEXT });
    expect(btn.className).not.toMatch(/\bno-drag\b/);
    expect(btn.closest('.no-drag')).toBeNull();
  });

  it('点击触发器打开面板并渲染选项', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[{ id: 'a', label: '选项甲' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /选项甲/ });
    expect(item).toBeInTheDocument();
  });

  it('菜单项带 disabled/danger 语义类', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[
          { id: 'a', label: '普通项' },
          { id: 'b', label: '禁用项', disabled: true },
          { id: 'c', label: '危险项', danger: true },
        ]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const normal = await screen.findByRole('menuitem', { name: /普通项/ });
    const disabled = screen.getByRole('menuitem', { name: /禁用项/ });
    const danger = screen.getByRole('menuitem', { name: /危险项/ });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveClass(styles.menuItemDisabled);
    expect(danger).toHaveClass(styles.menuItemDanger);
    expect(normal).not.toHaveClass(styles.menuItemDanger);
  });

  it('点击选项触发 onSelect 并关闭面板', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        onSelect={onSelect}
        options={[
          { id: 'a', label: '选项甲' },
          { id: 'b', label: '选项乙' },
        ]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /选项乙/ });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith(
      'b',
      expect.objectContaining({ id: 'b', label: '选项乙' })
    );
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
  });

  it('键盘漫游：初始落首项、ArrowDown 跳过 disabled、Enter 选中', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        onSelect={onSelect}
        options={[
          { id: 'a', label: '选项甲' },
          { id: 'b', label: '禁用乙', disabled: true },
          { id: 'c', label: '选项丙' },
        ]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByRole('menu');
    // F7-F2：打开后初始焦点落首个未禁用项（ARIA menu 模式）
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /选项甲/ })).toHaveFocus()
    );
    // ArrowDown：跳过 disabled 的索引 1，落在索引 2
    fireEvent.keyDown(content, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /选项丙/ })).toHaveFocus();
    // Enter 选中
    fireEvent.keyDown(content, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      'c',
      expect.objectContaining({ id: 'c' })
    );
  });

  it('ArrowUp 反向漫游', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[
          { id: 'a', label: '选项甲' },
          { id: 'b', label: '选项乙' },
        ]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByRole('menu');
    fireEvent.keyDown(content, { key: 'ArrowUp' });
    // 从 -1 上翻 → 回绕到最后一个（索引 1）
    expect(screen.getByRole('menuitem', { name: /选项乙/ })).toHaveFocus();
  });

  it('Esc 关闭面板并重置漫游索引', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        options={[{ id: 'a', label: '选项甲' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByRole('menu');
    fireEvent.keyDown(content, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
  });

  it('受控 open/onOpenChange 双模桥接', async () => {
    const onOpenChange = vi.fn();
    render(<ControlledMenu onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /选项甲/ });
    expect(onOpenChange).toHaveBeenCalledWith(true);
    fireEvent.click(item);
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('非模态菜单不声明 aria-modal，面板标题正常渲染（F7-F2）', async () => {
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        panel={{ title: '菜单标题' }}
        options={[{ id: 'a', label: '选项甲' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByText('菜单标题');
    // 非模态菜单声明 aria-modal 会切断后台内容的 SR 读取（F7-F2）
    expect(content.parentElement).not.toHaveAttribute('aria-modal');
    expect(content.parentElement).toHaveClass(styles.menuContent);
  });

  it('trigger 事件保留：原 onClick 正常触发且菜单展开', async () => {
    const originalOnClick = vi.fn();
    render(
      <Menu
        trigger={
          <button type="button" onClick={originalOnClick}>
            {TRIGGER_TEXT}
          </button>
        }
        options={[{ id: 'a', label: '选项甲' }]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    expect(originalOnClick).toHaveBeenCalledTimes(1);
    await screen.findByRole('menuitem', { name: /选项甲/ });
  });

  it('打开即聚焦首项：无需按键即可直接 Enter 选中（F7-F2）', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        onSelect={onSelect}
        options={[
          { id: 'a', label: '选项甲' },
          { id: 'b', label: '选项乙' },
        ]}
      />
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const content = await screen.findByRole('menu');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /选项甲/ })).toHaveFocus()
    );
    fireEvent.keyDown(content, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ id: 'a' })
    );
  });

  it('受控模式无内部写回：打开后不产生额外渲染（F7-F3）', async () => {
    // children 模式（无 options → 不受 F2 初始聚焦二次渲染干扰），
    // 直接观测「外部受控 + useEffect 写回 internalOpen」的额外渲染
    const childrenSpy = vi.fn(() => <div>面板内容</div>);
    render(
      <Menu
        trigger={<button type="button">{TRIGGER_TEXT}</button>}
        openState={{ open: true, onOpenChange: () => {} }}
      >
        {childrenSpy()}
      </Menu>
    );
    await screen.findByText('面板内容');
    // 外部受控时内部状态不得再被 useEffect 写回（双模 OR + 同步链 = 多一次渲染）
    expect(childrenSpy).toHaveBeenCalledTimes(1);
  });

  it('受控模式关闭信号不被内部状态重开（F7-F3）', async () => {
    function ControlledWithLateClose() {
      const [open, setOpen] = useState(false);
      return (
        <Menu
          trigger={<button type="button">{TRIGGER_TEXT}</button>}
          openState={{ open, onOpenChange: setOpen }}
          options={[{ id: 'a', label: '选项甲' }]}
        />
      );
    }
    render(<ControlledWithLateClose />);
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    await screen.findByRole('menuitem', { name: /选项甲/ });
    // 模拟父级延迟关闭：onOpenChange(false) 后父级仍持 true 一段时间
    // 受控模式下菜单是否关闭只由父级 open 决定，内部不得悄悄重开
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
  });

  it('漫游焦点滚动跟随：scrollIntoView({block: nearest})（F7-F4）', async () => {
    const scrollIntoView = vi.fn();
    // jsdom 未实现 scrollIntoView（spyOn 会抛错），先定义再验证
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    try {
      render(
        <Menu
          trigger={<button type="button">{TRIGGER_TEXT}</button>}
          options={[
            { id: 'a', label: '选项甲' },
            { id: 'b', label: '选项乙' },
          ]}
        />
      );
      fireEvent.click(screen.getByText(TRIGGER_TEXT));
      const content = await screen.findByRole('menu');
      scrollIntoView.mockClear();
      fireEvent.keyDown(content, { key: 'ArrowDown' });
      await waitFor(() =>
        expect(screen.getByRole('menuitem', { name: /选项乙/ })).toHaveFocus()
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.calls[0]?.[0]).toEqual({ block: 'nearest' });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('Dialog 内 Menu portal 进 overlay，不挂 body（设置壳 z 压不住下拉）', async () => {
    render(
      <Dialog open onClose={() => {}} title="设置">
        <Menu
          trigger={<button type="button">{TRIGGER_TEXT}</button>}
          options={[{ id: 'a', label: '选项甲' }]}
        />
      </Dialog>
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const item = await screen.findByRole('menuitem', { name: /选项甲/ });
    const overlay = document.querySelector('[data-dialog-overlay]');
    expect(overlay).toBeTruthy();
    await waitFor(() => {
      expect(overlay?.contains(item)).toBe(true);
    });
    expect(item.parentElement).not.toBe(document.body);
  });
});

describe('ui/Menu children 模式键盘漫游（08-步5 T4-4，P2-8）', () => {
  function ChildrenMenu() {
    return (
      <Menu trigger={<button type="button">{TRIGGER_TEXT}</button>}>
        <button type="button" role="menuitem">
          子项甲
        </button>
        <button type="button" role="menuitem">
          子项乙
        </button>
        <button type="button" role="menuitem">
          子项丙
        </button>
      </Menu>
    );
  }

  async function openAndFocusFirst(): Promise<HTMLElement> {
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const first = await screen.findByRole('menuitem', { name: /子项甲/ });
    first.focus();
    // children 模式内容本身为 Radix Popover.Content（role=dialog）
    return first.closest('[role="dialog"]') as HTMLElement;
  }

  it('ArrowDown/ArrowUp 循环漫游 + Home/End', async () => {
    render(<ChildrenMenu />);
    const content = await openAndFocusFirst();
    fireEvent.keyDown(content, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /子项乙/ })).toHaveFocus();
    fireEvent.keyDown(content, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /子项丙/ })).toHaveFocus();
    // 回绕到首项
    fireEvent.keyDown(content, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /子项甲/ })).toHaveFocus();
    // 上翻回绕
    fireEvent.keyDown(content, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: /子项丙/ })).toHaveFocus();
    fireEvent.keyDown(content, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: /子项甲/ })).toHaveFocus();
    fireEvent.keyDown(content, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: /子项丙/ })).toHaveFocus();
  });

  it('首次漫游从当前聚焦项出发（不强制跳回首项）', async () => {
    render(<ChildrenMenu />);
    const content = await openAndFocusFirst();
    // 焦点已在首项：ArrowDown 应到次项而非原地不动
    fireEvent.keyDown(content, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /子项乙/ })).toHaveFocus();
  });

  it('Enter 不劫持：交给原生 button 激活（菜单保持打开、不触发基座选中）', async () => {
    const onPick = vi.fn();
    render(
      <Menu trigger={<button type="button">{TRIGGER_TEXT}</button>}>
        <button type="button" role="menuitem" onClick={onPick}>
          子项甲
        </button>
      </Menu>
    );
    const content = await openAndFocusFirst();
    fireEvent.keyDown(content, { key: 'Enter' });
    // 基座不拦截 Enter（不 preventDefault、不自行关闭/回调）
    expect(onPick).not.toHaveBeenCalled();
    expect(
      screen.getByRole('menuitem', { name: /子项甲/ })
    ).toBeInTheDocument();
  });

  it('焦点不在漫游项上时不劫持方向键（搜索框输入场景）', async () => {
    render(
      <Menu trigger={<button type="button">{TRIGGER_TEXT}</button>}>
        <input aria-label="搜索项目" />
        <button type="button" role="menuitem">
          子项甲
        </button>
      </Menu>
    );
    fireEvent.click(screen.getByText(TRIGGER_TEXT));
    const input = await screen.findByLabelText('搜索项目');
    input.focus();
    const content = input.closest('[role="dialog"]') as HTMLElement;
    fireEvent.keyDown(content, { key: 'ArrowDown' });
    expect(input).toHaveFocus();
  });

  it('打开第二个 Menu 时关闭第一个（同级互斥）', async () => {
    render(
      <>
        <Menu
          trigger={<button type="button">菜单甲</button>}
          options={[{ id: 'a', label: '选项甲' }]}
        />
        <Menu
          trigger={<button type="button">菜单乙</button>}
          options={[{ id: 'b', label: '选项乙' }]}
        />
      </>
    );
    fireEvent.click(screen.getByText('菜单甲'));
    expect(
      await screen.findByRole('menuitem', { name: /选项甲/ })
    ).toBeTruthy();
    fireEvent.click(screen.getByText('菜单乙'));
    expect(
      await screen.findByRole('menuitem', { name: /选项乙/ })
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole('menuitem', { name: /选项甲/ })
      ).not.toBeInTheDocument()
    );
  });

  it('Anchor 模式：点击外部 Anchor 按钮关闭时，不发生开→关→开振荡', async () => {
    const AnchorComponent = () => {
      const [open, setOpen] = useState(true);
      const anchorRef = React.useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button
            ref={anchorRef}
            data-testid="anchor-btn"
            onClick={() =>
              toggleExclusiveMenu(open, setOpen, anchorRef.current)
            }
          >
            Toggle
          </button>
          <Menu
            openState={{
              open,
              onOpenChange: (next) => {
                if (!next) setOpen(false);
              },
            }}
            anchor={anchorRef}
            options={[{ id: '1', label: 'Item 1' }]}
          />
        </div>
      );
    };

    render(<AnchorComponent />);
    expect(screen.getByText('Item 1')).toBeInTheDocument();

    const anchorBtn = screen.getByTestId('anchor-btn');
    fireEvent.pointerDown(anchorBtn);
    fireEvent.pointerUp(anchorBtn);
    fireEvent.click(anchorBtn);

    expect(screen.queryByText('Item 1')).not.toBeInTheDocument();
  });

  it('两个 Anchor 菜单：点 B 关 A 并开 B（一开一关）', async () => {
    function Pair() {
      const [openA, setOpenA] = useState(true);
      const [openB, setOpenB] = useState(false);
      const refA = React.useRef<HTMLButtonElement>(null);
      const refB = React.useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button
            ref={refA}
            type="button"
            onClick={() => toggleExclusiveMenu(openA, setOpenA, refA.current)}
          >
            锚甲
          </button>
          <button
            ref={refB}
            type="button"
            onClick={() => toggleExclusiveMenu(openB, setOpenB, refB.current)}
          >
            锚乙
          </button>
          <Menu
            openState={{
              open: openA,
              onOpenChange: (n) => {
                if (!n) setOpenA(false);
              },
            }}
            anchor={refA}
            options={[{ id: 'a', label: '选项甲' }]}
          />
          <Menu
            openState={{
              open: openB,
              onOpenChange: (n) => {
                if (!n) setOpenB(false);
              },
            }}
            anchor={refB}
            options={[{ id: 'b', label: '选项乙' }]}
          />
        </div>
      );
    }
    render(<Pair />);
    expect(
      await screen.findByRole('menuitem', { name: /选项甲/ })
    ).toBeInTheDocument();
    const btnB = screen.getByRole('button', { name: '锚乙' });
    fireEvent.pointerDown(btnB);
    fireEvent.pointerUp(btnB);
    fireEvent.click(btnB);
    expect(
      await screen.findByRole('menuitem', { name: /选项乙/ })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole('menuitem', { name: /选项甲/ })
      ).not.toBeInTheDocument()
    );
  });

  it('Anchor 模式：在 Anchor 按钮上按下后拖拽移出（Drag-off）应正常关闭菜单', async () => {
    const onOpenChange = vi.fn();
    const AnchorComponent = () => {
      const [open, setOpen] = useState(false);
      const anchorRef = React.useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button
            ref={anchorRef}
            data-testid="anchor-btn"
            onClick={() => setOpen((prev) => !prev)}
          >
            Toggle
          </button>
          <Menu
            openState={{
              open,
              onOpenChange: (next) => {
                setOpen(next);
                onOpenChange(next);
              },
            }}
            anchor={anchorRef}
            options={[{ id: '1', label: 'Item 1' }]}
          />
        </div>
      );
    };

    render(<AnchorComponent />);
    const anchorBtn = screen.getByTestId('anchor-btn');
    fireEvent.click(anchorBtn);

    expect(await screen.findByText('Item 1')).toBeInTheDocument();

    const outsideEl = document.body;
    fireEvent.pointerDown(anchorBtn);
    fireEvent.pointerUp(outsideEl);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
