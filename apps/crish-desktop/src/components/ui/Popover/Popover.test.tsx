// @vitest-environment jsdom
/**
 * ui/Popover 浮层弹出原语单元测试
 * 覆盖：平铺 Props 模式、受控与非受控 open 状态、禁用防护、复合组件模式、指示箭头渲染与 a11y 契约
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { Popover } from './Popover';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ui/Popover (平铺 Props 高级模式)', () => {
  it('点击 trigger 打开弹出层并渲染内容', async () => {
    render(
      <Popover
        trigger={<button type="button">打开浮层</button>}
        content={<div>浮层内容测试</div>}
      />
    );

    expect(screen.queryByText('浮层内容测试')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('打开浮层'));

    expect(await screen.findByText('浮层内容测试')).toBeInTheDocument();
  });

  it('支持 children 作为内容区', async () => {
    render(
      <Popover trigger={<button type="button">打开浮层2</button>}>
        <div>子节点内容区</div>
      </Popover>
    );

    fireEvent.click(screen.getByText('打开浮层2'));

    expect(await screen.findByText('子节点内容区')).toBeInTheDocument();
  });

  it('非受控 defaultOpen={true} 挂载时立即展示弹出层', () => {
    render(
      <Popover
        defaultOpen
        trigger={<button type="button">触发按钮</button>}
        content={<div>默认展开内容</div>}
      />
    );

    expect(screen.getByText('默认展开内容')).toBeInTheDocument();
  });

  it('受控模式 open + onOpenChange 正确驱动状态', async () => {
    function ControlledTest() {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setIsOpen((prev) => !prev)}>
            外部切换器
          </button>
          <Popover
            open={isOpen}
            onOpenChange={setIsOpen}
            trigger={<button type="button">浮层触发器</button>}
            content={<div>受控浮层内部</div>}
          />
        </div>
      );
    }

    render(<ControlledTest />);

    expect(screen.queryByText('受控浮层内部')).not.toBeInTheDocument();

    // 通过外部状态开启
    fireEvent.click(screen.getByText('外部切换器'));
    expect(await screen.findByText('受控浮层内部')).toBeInTheDocument();

    // 点击触发器关闭
    fireEvent.click(screen.getByText('浮层触发器'));
    await waitFor(() => {
      expect(screen.queryByText('受控浮层内部')).not.toBeInTheDocument();
    });
  });

  it('disabled 状态下拦截打开请求', () => {
    const handleOpenChange = vi.fn();
    render(
      <Popover
        disabled
        onOpenChange={handleOpenChange}
        trigger={<button type="button">禁用触发器</button>}
        content={<div>不应展示的内容</div>}
      />
    );

    fireEvent.click(screen.getByText('禁用触发器'));

    expect(handleOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText('不应展示的内容')).not.toBeInTheDocument();
  });

  it('showArrow 开启时渲染指示箭头', async () => {
    const { container } = render(
      <Popover
        defaultOpen
        showArrow
        trigger={<button type="button">箭头触发器</button>}
        content={<div>带箭头的浮层</div>}
      />
    );

    expect(screen.getByText('带箭头的浮层')).toBeInTheDocument();
    // BasePopover.Arrow 会被渲染
    const arrow = document.querySelector('[class*="arrow"]');
    expect(arrow).toBeTruthy();
  });

  it('按下 Esc 键触发 onEscapeKeyDown 回调', async () => {
    const handleEscape = vi.fn();
    render(
      <Popover
        defaultOpen
        onEscapeKeyDown={handleEscape}
        trigger={<button type="button">Esc 测试触发器</button>}
        content={<div>Esc 浮层内容</div>}
      />
    );

    expect(screen.getByText('Esc 浮层内容')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(handleEscape).toHaveBeenCalled();
    });
  });
});

describe('ui/Popover (复合组件 Compound Components 模式)', () => {
  it('正确装配 Popover.Root, Popover.Trigger, Popover.Portal, Popover.Positioner, Popover.Popup', async () => {
    render(
      <Popover.Root>
        <Popover.Trigger render={<button type="button">复合触发器</button>} />
        <Popover.Portal>
          <Popover.Positioner side="top" align="center">
            <Popover.Popup>
              <div>复合组件弹窗内容</div>
              <Popover.Close render={<button type="button">关闭按钮</button>} />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    );

    expect(screen.queryByText('复合组件弹窗内容')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('复合触发器'));

    expect(await screen.findByText('复合组件弹窗内容')).toBeInTheDocument();
    expect(screen.getByText('关闭按钮')).toBeInTheDocument();

    fireEvent.click(screen.getByText('关闭按钮'));
    await waitFor(() => {
      expect(screen.queryByText('复合组件弹窗内容')).not.toBeInTheDocument();
    });
  });
});
