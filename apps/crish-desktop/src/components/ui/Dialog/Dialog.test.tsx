// @vitest-environment jsdom
/**
 * ui/Dialog 基座测试：Esc 关闭、焦点归还、Tab 循环、inert 旁路还原、aria
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from '@testing-library/react';
import React, { useState } from 'react';
import { Dialog } from './Dialog';
import { layerStackService } from '../../../services/LayerStackService';

/** 受控包装：open 状态由父层持有，模拟真实消费方用法 */
function DialogHarness({
  initialOpen = true,
  onClose,
  children,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  initialOpen?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开弹窗
      </button>
      <Dialog
        {...props}
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
      >
        {children ?? <input aria-label="弹窗输入" />}
      </Dialog>
    </>
  );
}

beforeEach(() => {
  layerStackService.dispose();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  layerStackService.dispose();
});

describe('ui/Dialog', () => {
  it('渲染到 body portal，带 dialog 角色与 aria-modal', () => {
    render(<DialogHarness title="设置" />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // portal 结构：body > FocusTrap 容器 > 遮罩壳 > 面板
    expect(dialog.parentElement?.parentElement?.parentElement).toBe(
      document.body
    );
  });

  it('标题经 aria-labelledby 关联', () => {
    render(<DialogHarness title="导出确认" />);
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent('导出确认');
  });

  it('description 经 aria-describedby 关联', () => {
    render(<DialogHarness title="确认" description="该操作不可撤销" />);
    const dialog = screen.getByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      '该操作不可撤销'
    );
  });

  it('alertdialog 角色透传（供危险操作确认）', () => {
    render(<DialogHarness role="alertdialog" title="警告" />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('打开时自动聚焦弹窗内首个可交互元素（关闭按钮）', () => {
    render(<DialogHarness />);
    expect(screen.getByRole('button', { name: '关闭弹窗' })).toHaveFocus();
  });

  it('initialFocusRef 接管初始聚焦目标', () => {
    function Harness() {
      const inputRef = React.useRef<HTMLInputElement>(null);
      return (
        <DialogHarness initialFocusRef={inputRef}>
          <input ref={inputRef} aria-label="弹窗输入" />
        </DialogHarness>
      );
    }
    render(<Harness />);
    expect(screen.getByLabelText('弹窗输入')).toHaveFocus();
  });

  it('Esc 关闭并回调 onClose', async () => {
    const onClose = vi.fn();
    render(<DialogHarness title="测试" onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    // 退出动画结束后卸载
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('dismissible=false 时 Esc 不关闭', () => {
    const onClose = vi.fn();
    render(
      <DialogHarness title="强制步进" dismissible={false} onClose={onClose} />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('backdrop 点击关闭，面板内点击不关闭', () => {
    const onClose = vi.fn();
    render(<DialogHarness title="遮罩" onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    const overlay = dialog.parentElement!;
    const backdrop = overlay.firstElementChild as HTMLElement;

    fireEvent.click(dialog); // 面板内点击：不关闭
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(backdrop); // 遮罩点击：关闭
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab 循环：焦点在首尾元素间循环', () => {
    render(
      <DialogHarness title="循环">
        <button type="button">第一</button>
        <button type="button">第二</button>
        <button type="button">第三</button>
      </DialogHarness>
    );
    const closeBtn = screen.getByRole('button', { name: '关闭弹窗' });
    const first = screen.getByText('第一');
    const third = screen.getByText('第三');

    // 可聚焦序：[关闭按钮, 第一, 第二, 第三]；初始聚焦关闭按钮
    expect(document.activeElement).toBe(closeBtn);

    // 从最后一个元素 Tab 回到第一个（关闭按钮）
    third.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);

    // 从第一个 Shift+Tab 回到最后一个
    closeBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(third);

    // 回绕后再 Shift+Tab 仍停留在最后一个
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(third);

    // 中间元素 Tab 不被 trap 拦截（jsdom 无原生 Tab 遍历，焦点保持原位）
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('inert 旁路：打开时对 body 兄弟节点设置 aria-hidden，关闭后还原', () => {
    const { unmount } = render(<DialogHarness title="旁路" />);
    const trapContainer =
      screen.getByRole('dialog').parentElement!.parentElement!;
    expect(trapContainer.parentElement).toBe(document.body);

    const hiddenSiblings = Array.from(document.body.children).filter(
      (c) => c !== trapContainer
    );
    expect(hiddenSiblings.length).toBeGreaterThan(0);
    for (const s of hiddenSiblings) {
      expect(s.getAttribute('aria-hidden')).toBe('true');
    }

    unmount();
    for (const s of hiddenSiblings) {
      expect(s.getAttribute('aria-hidden')).toBeNull();
    }
  });

  it('关闭按钮点击触发 onClose', () => {
    const onClose = vi.fn();
    render(<DialogHarness title="有关闭" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭后焦点归还到触发打开的元素', async () => {
    render(<DialogHarness initialOpen={false} title="归还" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const opener = screen.getByText('打开弹窗');
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 300));
    expect(document.activeElement).toBe(opener);
  });

  it('fullscreen 形态：面板铺满视口、忽略尺寸档、无面板进出场动画', () => {
    render(<DialogHarness variant="fullscreen" title="设置" />);
    const dialog = screen.getByRole('dialog');
    // fullscreen 不应用尺寸档宽度（480px 默认被替换）
    expect(dialog.classList.contains('dialogMd')).toBe(false);
    // 遮罩壳仍挂动画类（盖层整体淡入淡出），面板自身不挂动画类
    const overlay = dialog.parentElement!;
    expect(overlay.className).toMatch(/overlayEnter|overlayExit/);
  });

  it('ariaLabel 在无 title 时作为可访问名称', () => {
    render(<DialogHarness ariaLabel="设置" />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', '设置');
    expect(dialog.getAttribute('aria-labelledby')).toBeFalsy();
  });

  it('showCloseButton=false 不渲染关闭按钮，Esc 关闭仍生效', async () => {
    const onClose = vi.fn();
    render(
      <DialogHarness title="确认" showCloseButton={false} onClose={onClose}>
        <button type="button">唯一按钮</button>
      </DialogHarness>
    );
    expect(
      screen.queryByRole('button', { name: '关闭弹窗' })
    ).not.toBeInTheDocument();
    // 初始聚焦落到内容区首个可交互元素（无关闭按钮兜底）
    expect(screen.getByText('唯一按钮')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('overlayClassName 追加到遮罩壳（--dialog-z 层级覆盖落点）', () => {
    render(<DialogHarness title="层级" overlayClassName="custom-overlay" />);
    const overlay = screen.getByRole('dialog').parentElement!;
    expect(overlay.classList.contains('custom-overlay')).toBe(true);
  });

  it('嵌套 Dialog：一次 Esc 只关闭最顶层（F7-F5）', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    render(
      <>
        <DialogHarness title="外层" onClose={onCloseOuter}>
          <button type="button">外层内容</button>
        </DialogHarness>
        <DialogHarness title="内层" onClose={onCloseInner} />
      </>
    );
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    // 仅最顶层（后挂载的内层）响应 Esc，外层不得同时关闭
    expect(onCloseInner).toHaveBeenCalledTimes(1);
    expect(onCloseOuter).not.toHaveBeenCalled();
  });

  it('嵌套 Dialog：Esc 关闭最顶层后，再按 Esc 才轮到外层（F7-F5）', async () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();
    function NestedHarness() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(true);
      return (
        <>
          <Dialog
            title="外层"
            open={outerOpen}
            onClose={() => {
              onCloseOuter();
              setOuterOpen(false);
            }}
          >
            <button type="button">外层内容</button>
          </Dialog>
          <Dialog
            title="内层"
            open={innerOpen}
            onClose={() => {
              onCloseInner();
              setInnerOpen(false);
            }}
          />
        </>
      );
    }
    render(<NestedHarness />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseInner).toHaveBeenCalledTimes(1);
    expect(onCloseOuter).not.toHaveBeenCalled();
    // 等内层退出动画卸载后，外层恢复为最顶层
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseOuter).toHaveBeenCalledTimes(1);
  });

  it('initialFocusRef 指向容器外元素时回退到弹窗内首个可交互元素（F7-F6）', () => {
    function Harness() {
      const outsideRef = React.useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={outsideRef} type="button">
            容器外按钮
          </button>
          <DialogHarness
            title="圈定"
            initialFocusRef={outsideRef as React.RefObject<HTMLElement>}
          />
        </>
      );
    }
    render(<Harness />);
    // 焦点不得逃逸到 trap 容器外
    expect(document.activeElement).not.toBe(screen.getByText('容器外按钮'));
    expect(screen.getByRole('button', { name: '关闭弹窗' })).toHaveFocus();
  });

  it('退出动画时长与 CSS --duration-exit（150ms）对齐（F7-F5）', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      render(<DialogHarness title="时长" onClose={onClose} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      // CSS --duration-exit = 150ms：动画结束后即应卸载，不留 50ms 空窗
      act(() => vi.advanceTimersByTime(150));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
