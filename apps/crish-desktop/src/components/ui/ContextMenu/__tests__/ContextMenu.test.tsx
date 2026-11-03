// @vitest-environment jsdom
/**
 * ui/ContextMenu（Base UI 收敛版）契约测试：
 * 受控 open + 锚点定位、LayerStack 登记/驱逐、外点关闭与锚点豁免、
 * Esc 分层（先收子菜单）、条目选中/禁用语义。
 */
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
  ContextMenu,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '../ContextMenu';
import { layerStackService } from '../../internal/layer-stack/LayerStackService';

function Harness({
  onOpenChange,
  onSelect,
  withSubmenu = false,
}: {
  onOpenChange?: (open: boolean) => void;
  onSelect?: (id: string) => void;
  withSubmenu?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  return (
    <>
      <button ref={setAnchorEl} type="button">
        锚点按钮
      </button>
      <ContextMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange?.(next);
        }}
        anchor={{ x: 24, y: 32 }}
        anchorElement={anchorEl}
        layerId="test-context-menu"
        data-testid="ctx-menu"
        aria-label="测试菜单"
      >
        <ContextMenuItem onSelect={() => onSelect?.('open')}>
          打开
        </ContextMenuItem>
        <ContextMenuItem disabled onSelect={() => onSelect?.('disabled')}>
          禁用项
        </ContextMenuItem>
        <ContextMenuSeparator />
        {withSubmenu ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>打开方式</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => onSelect?.('with-a')}>
                用 A 打开
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onSelect?.('with-b')}>
                用 B 打开
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
        <ContextMenuRadioGroup value="abs">
          <ContextMenuRadioItem value="abs" checked>
            绝对路径
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="rel">相对路径</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      </ContextMenu>
    </>
  );
}

beforeEach(() => {
  layerStackService.dispose();
});

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('ui/ContextMenu', () => {
  it('打开时登记 LayerStack context-menu 并置 data-floating-active', async () => {
    render(<Harness />);
    expect(await screen.findByTestId('ctx-menu')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        layerStackService
          .getLayers()
          .some(
            (l) => l.id === 'test-context-menu' && l.type === 'context-menu'
          )
      ).toBe(true);
    });
    expect(document.documentElement.getAttribute('data-floating-active')).toBe(
      'true'
    );
    expect(screen.getByRole('menu', { name: '测试菜单' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /打开/ })).toBeInTheDocument();
  });

  it('登记时驱逐已开的 exclusive 浮层', async () => {
    const onDismissPeer = vi.fn();
    layerStackService.register({
      id: 'peer-dropdown',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: onDismissPeer,
    });
    render(<Harness />);
    await waitFor(() => {
      expect(onDismissPeer).toHaveBeenCalledWith('programmatic');
    });
  });

  it('点击条目触发 onSelect 并关闭', async () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(<Harness onSelect={onSelect} onOpenChange={onOpenChange} />);
    const item = await screen.findByRole('menuitem', { name: /打开/ });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith('open');
    await waitFor(() => {
      expect(screen.queryByTestId('ctx-menu')).not.toBeInTheDocument();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('禁用条目不触发 onSelect 且菜单保持打开', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const item = await screen.findByRole('menuitem', { name: /禁用项/ });
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId('ctx-menu')).toBeInTheDocument();
  });

  it('外点按下关闭（LayerStack/Base UI 任一路径）', async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await screen.findByTestId('ctx-menu');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    outside.remove();
  });

  it('按下锚点元素不被基座抢先关闭（触发侧 toggle 裁决）', async () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await screen.findByTestId('ctx-menu');
    const anchorBtn = screen.getByRole('button', { name: '锚点按钮' });
    fireEvent.pointerDown(anchorBtn);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId('ctx-menu')).toBeInTheDocument();
  });

  it('子菜单：点击触发器展开，Esc 只收子菜单不关父菜单', async () => {
    const onOpenChange = vi.fn();
    render(<Harness withSubmenu onOpenChange={onOpenChange} />);
    const trigger = await screen.findByRole('menuitem', {
      name: /打开方式/,
    });
    fireEvent.click(trigger);
    const subItem = await screen.findByRole('menuitem', {
      name: /用 A 打开/,
    });
    expect(subItem).toBeInTheDocument();

    fireEvent.keyDown(subItem, { key: 'Escape' });
    await waitFor(() => {
      expect(
        screen.queryByRole('menuitem', { name: /用 A 打开/ })
      ).not.toBeInTheDocument();
    });
    // 父菜单仍在，onOpenChange 未收到关闭
    expect(screen.getByTestId('ctx-menu')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // 第二次 Esc（焦点回到父菜单条目）关闭整个菜单
    fireEvent.keyDown(screen.getByTestId('ctx-menu'), { key: 'Escape' });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('子菜单条目选中触发 onSelect 并关闭整个菜单', async () => {
    const onSelect = vi.fn();
    render(<Harness withSubmenu onSelect={onSelect} />);
    const trigger = await screen.findByRole('menuitem', {
      name: /打开方式/,
    });
    fireEvent.click(trigger);
    const subItem = await screen.findByRole('menuitem', {
      name: /用 B 打开/,
    });
    fireEvent.click(subItem);
    expect(onSelect).toHaveBeenCalledWith('with-b');
    await waitFor(() => {
      expect(screen.queryByTestId('ctx-menu')).not.toBeInTheDocument();
    });
  });
});
