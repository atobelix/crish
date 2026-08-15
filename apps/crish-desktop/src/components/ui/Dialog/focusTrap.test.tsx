/**
 * ui/Dialog/focusTrap.test.tsx
 *
 * 针对 WO-21 FocusTrap 状态机与白名单隔离测试：
 * 1. 验证白名单旁路：Radix Popper、Tooltip、Toast 容器不被错误打上 aria-hidden="true" / inert=true；
 * 2. 验证多层 Dialog 嵌套时父级 Dialog 被正确隔离冻结，引用计数退栈后按顺序解冻，不发生外层早解；
 * 3. 验证 Tab 环形焦点漫游锁定与 wrap-around 冒泡阻断。
 */
// @vitest-environment jsdom
import React, { useRef, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FocusTrap } from './focusTrap';

describe('FocusTrap 引用计数沙盒与白名单隔离 (WO-21)', () => {
  beforeEach(() => {
    // 准备 DOM 环境：模拟 #root 和各个白名单容器
    document.body.innerHTML = `
      <div id="root">
        <button id="main-btn">主应用按钮</button>
      </div>
      <div id="portal-root"></div>
    `;
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('白名单旁路：Radix Popper、Tooltip、Toast 不被隔离打上 aria-hidden', () => {
    // 模拟应用中同时挂载在 document.body 下的 Radix Popper / Tooltip / Toast
    const radixPopper = document.createElement('div');
    radixPopper.setAttribute('data-radix-popper-content-wrapper', '');
    document.body.appendChild(radixPopper);

    const tooltip = document.createElement('div');
    tooltip.setAttribute('data-tooltip-portal', 'true');
    document.body.appendChild(tooltip);

    const toast = document.createElement('div');
    toast.setAttribute('data-toast-container', 'true');
    document.body.appendChild(toast);

    const rootEl = document.getElementById('root')!;

    const { unmount } = render(
      <FocusTrap active={true}>
        <div data-testid="trap-1">
          <button data-testid="btn-1">弹窗内按钮</button>
        </div>
      </FocusTrap>,
      { container: document.getElementById('portal-root')! }
    );

    // 主应用 #root 应被标记为 aria-hidden / inert
    expect(rootEl.getAttribute('aria-hidden')).toBe('true');
    expect(rootEl.hasAttribute('inert')).toBe(true);

    // 白名单兄弟节点绝不能被打上 aria-hidden 或 inert
    expect(radixPopper.getAttribute('aria-hidden')).toBeNull();
    expect(radixPopper.hasAttribute('inert')).toBe(false);
    expect(tooltip.getAttribute('aria-hidden')).toBeNull();
    expect(tooltip.hasAttribute('inert')).toBe(false);
    expect(toast.getAttribute('aria-hidden')).toBeNull();
    expect(toast.hasAttribute('inert')).toBe(false);

    unmount();

    // 卸载后 #root 应恢复
    expect(rootEl.getAttribute('aria-hidden')).toBeNull();
    expect(rootEl.hasAttribute('inert')).toBe(false);
  });

  it('多层 Dialog 嵌套：父级 Dialog 在内层挂载时被正确打上 inert 冻结，内层卸载后父级解冻', () => {
    const rootEl = document.getElementById('root')!;

    function NestedDialogHarness() {
      const [showInner, setShowInner] = useState(false);
      return (
        <>
          <FocusTrap active={true}>
            <div data-testid="outer-dialog" role="dialog">
              <button
                data-testid="open-inner"
                onClick={() => setShowInner(true)}
              >
                打开内层
              </button>
            </div>
          </FocusTrap>
          {showInner && (
            <FocusTrap active={true}>
              <div data-testid="inner-dialog" role="dialog">
                <button
                  data-testid="close-inner"
                  onClick={() => setShowInner(false)}
                >
                  关闭内层
                </button>
              </div>
            </FocusTrap>
          )}
        </>
      );
    }

    render(<NestedDialogHarness />, {
      container: document.getElementById('portal-root')!,
    });

    const outerDialog = screen.getByTestId('outer-dialog').parentElement!;
    expect(rootEl.getAttribute('aria-hidden')).toBe('true');
    // 单层时外层 Dialog 活跃，未被 inert
    expect(outerDialog.getAttribute('aria-hidden')).toBeNull();
    expect(outerDialog.hasAttribute('inert')).toBe(false);

    // 打开内层 Dialog
    fireEvent.click(screen.getByTestId('open-inner'));
    const innerDialog = screen.getByTestId('inner-dialog').parentElement!;

    // 内层打开后，外层 Dialog 应当被 freeze（标记 aria-hidden 与 inert）
    expect(outerDialog.getAttribute('aria-hidden')).toBe('true');
    expect(outerDialog.hasAttribute('inert')).toBe(true);

    // 内层 Dialog 保持活跃
    expect(innerDialog.getAttribute('aria-hidden')).toBeNull();
    expect(innerDialog.hasAttribute('inert')).toBe(false);

    // 关闭内层 Dialog
    fireEvent.click(screen.getByTestId('close-inner'));

    // 内层卸载后，外层 Dialog 应正确解冻恢复活跃，且 #root 依然保持冻结（引用计数安全）
    expect(outerDialog.getAttribute('aria-hidden')).toBeNull();
    expect(outerDialog.hasAttribute('inert')).toBe(false);
    expect(rootEl.getAttribute('aria-hidden')).toBe('true');
  });

  it('键盘 Tab 循环锁定与边界切换', () => {
    function TabHarness() {
      const firstBtnRef = useRef<HTMLButtonElement>(null);
      return (
        <FocusTrap active={true} initialFocusRef={firstBtnRef}>
          <div data-testid="trap-box">
            <button ref={firstBtnRef} data-testid="btn-first">
              First
            </button>
            <button data-testid="btn-second">Second</button>
            <button data-testid="btn-last">Last</button>
          </div>
        </FocusTrap>
      );
    }

    render(<TabHarness />, {
      container: document.getElementById('portal-root')!,
    });

    const firstBtn = screen.getByTestId('btn-first');
    const lastBtn = screen.getByTestId('btn-last');

    // 初始聚焦到 initialFocusRef
    expect(firstBtn).toHaveFocus();

    // 在 first 元素上按 Shift+Tab 应回绕到 last 元素
    fireEvent.keyDown(firstBtn, { key: 'Tab', shiftKey: true });
    expect(lastBtn).toHaveFocus();

    // 在 last 元素上按 Tab 应回绕到 first 元素
    fireEvent.keyDown(lastBtn, { key: 'Tab', shiftKey: false });
    expect(firstBtn).toHaveFocus();
  });
});
