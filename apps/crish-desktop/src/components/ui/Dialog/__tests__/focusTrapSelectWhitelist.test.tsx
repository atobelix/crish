// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FocusTrap } from '../focusTrap';

describe('FocusTrap: Select Whitelist & Event Unblocking Suite (Plan 09)', () => {
  it('FocusTrap 激活时，自研 SelectContent 与 role="listbox" 节点不被施加 inert 与 aria-hidden', () => {
    render(
      <div>
        <FocusTrap active={true}>
          <div data-testid="trap-content">
            <button>弹窗内按钮</button>
          </div>
        </FocusTrap>
        <div
          data-slot="select-content"
          role="listbox"
          data-testid="external-select"
        >
          <button role="option">外置下拉项</button>
        </div>
      </div>
    );

    const externalSelect = screen.getByTestId('external-select');
    // 白名单放行断言
    expect(externalSelect).not.toHaveAttribute('inert');
    expect(externalSelect).not.toHaveAttribute('aria-hidden');
  });

  it('在 FocusTrap 激活且焦点处于 SelectContent 内部时，按下 Tab 键不会被强行扯回弹窗起点', () => {
    render(
      <div>
        <FocusTrap active={true}>
          <div data-testid="trap-content">
            <button data-testid="trap-btn-1">按钮 1</button>
            <button data-testid="trap-btn-2">按钮 2</button>
          </div>
        </FocusTrap>
        <div data-slot="select-content" role="listbox">
          <button data-testid="select-option-1" role="option">选项 1</button>
        </div>
      </div>
    );

    const selectOption = screen.getByTestId('select-option-1');
    selectOption.focus();
    expect(document.activeElement).toBe(selectOption);

    // 派发 Tab 键
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tabEvent);

    // 断言焦点依然处于浮层内或未被强制 reset 到 trap-btn-1
    expect(tabEvent.defaultPrevented).toBe(false);
  });
});
