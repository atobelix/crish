// @vitest-environment jsdom
/**
 * 会话右键菜单 exclusive：进 LayerStack context-menu，
 * 开时驱逐其它点击面板、开其它菜单时自己关、灭 Tooltip、外点关后 trigger 不重开。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
  renderHook,
} from '@testing-library/react';
import {
  SessionContextMenu,
  SESSION_CONTEXT_MENU_LAYER_ID,
} from './SessionContextMenu';
import { useSidebarContextMenu } from './useSidebarContextMenu';
import { layerStackService, shouldSuppressMenuReopen } from '@/components/ui';
import type { SessionContextMenuState } from './SidebarContextMenus';

const MENU_STATE: SessionContextMenuState = {
  x: 40,
  y: 80,
  sessionId: 'sess-1',
};

function renderSessionMenu(
  overrides?: Partial<React.ComponentProps<typeof SessionContextMenu>>
) {
  const menuRef = React.createRef<HTMLDivElement>();
  const triggerRef = React.createRef<HTMLButtonElement>();
  const onClose = vi.fn();
  const onAction = vi.fn();
  const utils = render(
    <>
      <button ref={triggerRef} type="button" data-testid="session-more-button">
        更多
      </button>
      <SessionContextMenu
        contextMenu={MENU_STATE}
        menuRef={menuRef}
        isPinned={false}
        onSessionAction={onAction}
        onCloseContextMenu={onClose}
        contextMenuTriggerRef={triggerRef}
        {...overrides}
      />
    </>
  );
  return { utils, menuRef, triggerRef, onClose, onAction };
}

function fakeMouseEvent(
  el: HTMLElement,
  opts: { button: number; x?: number; y?: number }
): React.MouseEvent {
  return {
    preventDefault() {},
    clientX: opts.x ?? 12,
    clientY: opts.y ?? 24,
    button: opts.button,
    currentTarget: el,
    target: el,
  } as unknown as React.MouseEvent;
}

beforeEach(() => {
  layerStackService.dispose();
});

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  vi.restoreAllMocks();
});

describe('SessionContextMenu exclusive 层栈', () => {
  it('挂载时登记 context-menu，并置 data-floating-active（灭 Tooltip）', async () => {
    renderSessionMenu();
    expect(
      await screen.findByTestId('session-context-menu')
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        layerStackService
          .getLayers()
          .some(
            (l) =>
              l.id === SESSION_CONTEXT_MENU_LAYER_ID &&
              l.type === 'context-menu'
          )
      ).toBe(true);
    });
    expect(document.documentElement.getAttribute('data-floating-active')).toBe(
      'true'
    );
    expect(layerStackService.isTooltipSilenced()).toBe(true);
  });

  it('开菜单时驱逐已开的 dropdown-menu', async () => {
    const onDismissPeer = vi.fn();
    layerStackService.register({
      id: 'peer-permission',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: onDismissPeer,
    });
    renderSessionMenu();
    await waitFor(() => {
      expect(onDismissPeer).toHaveBeenCalledWith('programmatic');
    });
    expect(layerStackService.getLayers().map((l) => l.id)).toEqual([
      SESSION_CONTEXT_MENU_LAYER_ID,
    ]);
  });

  it('开其它 exclusive 菜单时自己关', async () => {
    const { onClose } = renderSessionMenu();
    await waitFor(() => {
      expect(
        layerStackService
          .getLayers()
          .some((l) => l.id === SESSION_CONTEXT_MENU_LAYER_ID)
      ).toBe(true);
    });
    layerStackService.register({
      id: 'peer-model',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: vi.fn(),
    });
    expect(onClose).toHaveBeenCalled();
    expect(
      layerStackService
        .getLayers()
        .some((l) => l.id === SESSION_CONTEXT_MENU_LAYER_ID)
    ).toBe(false);
  });

  it('外点关闭走 LayerStack', async () => {
    const { onClose } = renderSessionMenu();
    await screen.findByTestId('session-context-menu');
    await waitFor(() =>
      expect(
        layerStackService
          .getLayers()
          .some((l) => l.id === SESSION_CONTEXT_MENU_LAYER_ID)
      ).toBe(true)
    );
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    expect(onClose).toHaveBeenCalled();
    outside.remove();
  });

  it('菜单 z-index 回落到 --z-popover，不被侧栏/叶盖住', async () => {
    renderSessionMenu();
    const menu = await screen.findByTestId('session-context-menu');
    expect(menu.style.zIndex).toMatch(/--z-context-menu|--z-popover/);
    expect(menu.style.pointerEvents).toBe('auto');
  });

  it('保留归档/分叉/删除/导出等现有动作', async () => {
    renderSessionMenu();
    const menu = await screen.findByRole('menu', { name: '会话操作' });
    // 纯数据驱动 MenuItem：断言可见文案（不再依赖内部 data-action 实现细节）
    for (const label of [
      '归档',
      '分叉',
      '删除当前对话',
      '导出 Markdown',
      '在此处打开',
      '拆分视图',
      '置顶',
    ]) {
      expect(menu).toHaveTextContent(label);
    }
  });
});

describe('useSidebarContextMenu 外点关 vs trigger 对打', () => {
  it('左键更多：外点关后同一 trigger 不重开', () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu({ setSortDropdownOpen: vi.fn() })
    );
    const btn = document.createElement('button');
    btn.dataset.testid = 'session-more-button';
    const content = document.createElement('div');
    const outside = document.createElement('div');
    document.body.append(content, btn, outside);
    layerStackService.register({
      id: SESSION_CONTEXT_MENU_LAYER_ID,
      type: 'context-menu',
      dismissible: true,
      onDismiss: () => undefined,
      elementRef: { current: content },
      anchorRef: { current: btn },
    });
    outside.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    );
    expect(shouldSuppressMenuReopen(btn)).toBe(true);

    act(() => {
      result.current.handleContextMenu(
        fakeMouseEvent(btn, { button: 0 }),
        'sess-1'
      );
    });
    expect(result.current.contextMenu).toBeNull();
    content.remove();
    btn.remove();
    outside.remove();
  });

  it('右键不受 suppress：关权限丸后仍能打开会话菜单', () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu({ setSortDropdownOpen: vi.fn() })
    );
    const pill = document.createElement('button');
    const row = document.createElement('div');
    const content = document.createElement('div');
    document.body.append(content, pill, row);
    layerStackService.register({
      id: 'perm-pill',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => undefined,
      elementRef: { current: content },
      anchorRef: { current: pill },
    });
    row.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    );
    expect(shouldSuppressMenuReopen(row)).toBe(false);

    act(() => {
      result.current.handleContextMenu(
        fakeMouseEvent(row, { button: 2, x: 30, y: 40 }),
        'sess-1'
      );
    });
    expect(result.current.contextMenu).toEqual({
      x: 30,
      y: 40,
      sessionId: 'sess-1',
    });
    content.remove();
    pill.remove();
    row.remove();
  });

  it('左键同一会话已开则写死关闭（禁止 !prev）', () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu({ setSortDropdownOpen: vi.fn() })
    );
    const btn = document.createElement('button');
    btn.dataset.testid = 'session-more-button';
    document.body.append(btn);

    act(() => {
      result.current.handleContextMenu(
        fakeMouseEvent(btn, { button: 0 }),
        'sess-1'
      );
    });
    expect(result.current.contextMenu?.sessionId).toBe('sess-1');

    act(() => {
      result.current.handleContextMenu(
        fakeMouseEvent(btn, { button: 0 }),
        'sess-1'
      );
    });
    expect(result.current.contextMenu).toBeNull();
    btn.remove();
  });

  it('pointerdown 外点关（完整手势）', async () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu({ setSortDropdownOpen: vi.fn() })
    );
    const btn = document.createElement('button');
    btn.dataset.testid = 'session-more-button';
    document.body.append(btn);

    act(() => {
      result.current.handleContextMenu(
        fakeMouseEvent(btn, { button: 0 }),
        'sess-1'
      );
    });
    expect(result.current.contextMenu).not.toBeNull();

    const { rerender } = render(
      <SessionContextMenu
        contextMenu={result.current.contextMenu!}
        menuRef={result.current.menuRef}
        isPinned={false}
        onSessionAction={vi.fn()}
        onCloseContextMenu={() => result.current.setContextMenu(null)}
        contextMenuTriggerRef={result.current.contextMenuTriggerRef}
      />
    );
    await waitFor(() =>
      expect(
        layerStackService
          .getLayers()
          .some((l) => l.id === SESSION_CONTEXT_MENU_LAYER_ID)
      ).toBe(true)
    );

    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    await waitFor(() => expect(result.current.contextMenu).toBeNull());
    rerender(<></>);
    btn.remove();
  });

  it('非更多左键不当 exclusive：行节点 button=0 仍打开（不吞选择路径）', () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu({ setSortDropdownOpen: vi.fn() })
    );
    const row = document.createElement('div');
    row.dataset.testid = 'sidebar-session-item';
    document.body.append(row);
    act(() => {
      result.current.handleContextMenu(
        fakeMouseEvent(row, { button: 0, x: 8, y: 16 }),
        'sess-2'
      );
    });
    expect(result.current.contextMenu).toEqual({
      x: 8,
      y: 16,
      sessionId: 'sess-2',
    });
    row.remove();
  });
});
