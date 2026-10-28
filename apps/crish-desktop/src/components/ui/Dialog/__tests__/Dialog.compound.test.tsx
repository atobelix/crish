// @vitest-environment jsdom
/**
 * ui/Dialog 复合组件体系（Dialog.Root / Overlay / Content / Header / Title / Description / Body / Footer / Close）测试套件
 */
import React, { useState, useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  Dialog,
  DialogRoot,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogClose,
  useDialogContext,
} from '../Dialog';
import { layerStackService } from '../../internal/layer-stack/LayerStackService';
import { useDialogOverlayContext } from '../dialogOverlayContext';

beforeEach(() => {
  layerStackService.dispose();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  layerStackService.dispose();
});

describe('ui/Dialog 现代复合原语体系 (Compound Components)', () => {
  it('标准复合语法完整渲染：Header, Title, Description, Body, Footer, Close', () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>复合弹窗标题</Dialog.Title>
            <Dialog.Close />
          </Dialog.Header>
          <Dialog.Description>这是一段弹窗辅助说明文案</Dialog.Description>
          <Dialog.Body>
            <p>弹窗正文内容</p>
          </Dialog.Body>
          <Dialog.Footer>
            <button type="button" onClick={onClose}>
              确定
            </button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // 验证 aria-labelledby 自动配对
    const title = screen.getByText('复合弹窗标题');
    expect(title.tagName).toBe('H2');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);

    // 验证 aria-describedby 自动配对
    const desc = screen.getByText('这是一段弹窗辅助说明文案');
    expect(dialog.getAttribute('aria-describedby')).toBe(desc.id);

    // 验证正文与底部
    expect(screen.getByText('弹窗正文内容')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument();

    // 验证关闭按钮
    const closeBtn = screen.getByRole('button', { name: '关闭弹窗' });
    expect(closeBtn).toBeInTheDocument();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Dialog.Root 别名与 Dialog 100% 等价', () => {
    const onClose = vi.fn();
    render(
      <Dialog.Root open={true} onClose={onClose}>
        <Dialog.Content>
          <Dialog.Title>Root别名测试</Dialog.Title>
          <Dialog.Body>内容</Dialog.Body>
        </Dialog.Content>
      </Dialog.Root>
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Root别名测试')).toBeInTheDocument();
  });

  it('DialogTitle 支持通过 as 自定义层级标签 (h1/h3/div)', () => {
    render(
      <Dialog open={true} onClose={() => {}}>
        <Dialog.Content>
          <Dialog.Title as="h3">自定义H3标题</Dialog.Title>
        </Dialog.Content>
      </Dialog>
    );

    const title = screen.getByText('自定义H3标题');
    expect(title.tagName).toBe('H3');
  });

  it('显式声明 Dialog.Overlay 支持自定义类名并提供 DialogOverlayContext', () => {
    let capturedOverlay: HTMLElement | null = null;
    function Consumer() {
      capturedOverlay = useDialogOverlayContext();
      return <div>内部组件</div>;
    }

    render(
      <Dialog open={true} onClose={() => {}}>
        <Dialog.Overlay className="custom-overlay-class">
          <Dialog.Content>
            <Consumer />
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog>
    );

    const overlay = document.querySelector('[data-dialog-overlay]');
    expect(overlay).not.toBeNull();
    expect(overlay?.classList.contains('custom-overlay-class')).toBe(true);
    expect(capturedOverlay).toBe(overlay);
  });

  it('Esc 键与遮罩点击在复合模式下正常触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <Dialog.Content>
          <Dialog.Title>测试 Esc</Dialog.Title>
          <Dialog.Body>内容</Dialog.Body>
        </Dialog.Content>
      </Dialog>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const overlay = document.querySelector('[data-dialog-overlay]')!;
    const backdrop = overlay.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('DialogClose 支持自定义 children 与 onClick 拦截', () => {
    const onClose = vi.fn();
    const customClick = vi.fn();
    render(
      <Dialog open={true} onClose={onClose}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>自定义关闭</Dialog.Title>
            <Dialog.Close onClick={customClick}>
              <span>取消退出</span>
            </Dialog.Close>
          </Dialog.Header>
        </Dialog.Content>
      </Dialog>
    );

    const customBtn = screen.getByRole('button', { name: '关闭弹窗' });
    expect(customBtn).toHaveTextContent('取消退出');
    fireEvent.click(customBtn);
    expect(customClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('在 Dialog 外部调用 useDialogContext 时安全抛出诊断异常', () => {
    function InvalidConsumer() {
      useDialogContext();
      return null;
    }
    expect(() => render(<InvalidConsumer />)).toThrow(
      /<Dialog\.\*> compound components must be rendered within a <Dialog>/
    );
  });
});
