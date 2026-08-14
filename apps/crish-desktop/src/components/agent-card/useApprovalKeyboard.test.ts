// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useApprovalKeyboard } from './useApprovalKeyboard';

describe('useApprovalKeyboard (DEF-01 / P-02 全局按键安全与焦点收敛)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('在 rootRef 外部触发 Enter 时不触发 onEnterAllow，不拦截默认行为', () => {
    const root = document.createElement('div');
    const allowBtn = document.createElement('button');
    root.appendChild(allowBtn);
    document.body.appendChild(root);

    const outsideInput = document.createElement('input');
    document.body.appendChild(outsideInput);

    const onEnterAllow = vi.fn();
    const onDisarm = vi.fn();

    renderHook(() =>
      useApprovalKeyboard({
        rootRef: { current: root },
        allowBtnRef: { current: allowBtn },
        confirmArmed: false,
        busy: false,
        msgId: 'msg-1',
        onDisarm,
        onEnterAllow,
      })
    );

    // 外部 input 焦点并按下 Enter
    outsideInput.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const prevented = !outsideInput.dispatchEvent(event);

    expect(onEnterAllow).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it('在 rootRef 内部触发 Enter 时触发 onEnterAllow 并拦截默认行为', () => {
    const root = document.createElement('div');
    const allowBtn = document.createElement('button');
    root.appendChild(allowBtn);
    document.body.appendChild(root);

    const onEnterAllow = vi.fn();
    const onDisarm = vi.fn();

    renderHook(() =>
      useApprovalKeyboard({
        rootRef: { current: root },
        allowBtnRef: { current: allowBtn },
        confirmArmed: false,
        busy: false,
        msgId: 'msg-1',
        onDisarm,
        onEnterAllow,
      })
    );

    allowBtn.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const prevented = !allowBtn.dispatchEvent(event);

    expect(onEnterAllow).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it('在 rootRef 内部的 TEXTAREA 按 Enter 时不拦截，允许正常换行', () => {
    const root = document.createElement('div');
    const textarea = document.createElement('textarea');
    const allowBtn = document.createElement('button');
    root.appendChild(textarea);
    root.appendChild(allowBtn);
    document.body.appendChild(root);

    const onEnterAllow = vi.fn();
    const onDisarm = vi.fn();

    renderHook(() =>
      useApprovalKeyboard({
        rootRef: { current: root },
        allowBtnRef: { current: allowBtn },
        confirmArmed: false,
        busy: false,
        msgId: 'msg-1',
        onDisarm,
        onEnterAllow,
      })
    );

    textarea.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const prevented = !textarea.dispatchEvent(event);

    expect(onEnterAllow).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it('在 rootRef 内部的 isContentEditable 元素按 Enter 时不拦截', () => {
    const root = document.createElement('div');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.setAttribute('contenteditable', 'true');
    const allowBtn = document.createElement('button');
    root.appendChild(editable);
    root.appendChild(allowBtn);
    document.body.appendChild(root);

    const onEnterAllow = vi.fn();
    const onDisarm = vi.fn();

    renderHook(() =>
      useApprovalKeyboard({
        rootRef: { current: root },
        allowBtnRef: { current: allowBtn },
        confirmArmed: false,
        busy: false,
        msgId: 'msg-1',
        onDisarm,
        onEnterAllow,
      })
    );

    editable.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const prevented = !editable.dispatchEvent(event);

    expect(onEnterAllow).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it('外部聚焦时按 Escape 不拦截全局按键，不触发 onDisarm (A-03)', () => {
    const root = document.createElement('div');
    const allowBtn = document.createElement('button');
    root.appendChild(allowBtn);
    document.body.appendChild(root);

    const outsideInput = document.createElement('input');
    document.body.appendChild(outsideInput);

    const onEnterAllow = vi.fn();
    const onDisarm = vi.fn();

    renderHook(() =>
      useApprovalKeyboard({
        rootRef: { current: root },
        allowBtnRef: { current: allowBtn },
        confirmArmed: true,
        busy: false,
        msgId: 'msg-1',
        onDisarm,
        onEnterAllow,
      })
    );

    outsideInput.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    const prevented = !outsideInput.dispatchEvent(event);

    expect(onDisarm).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
  });

  it('内部聚焦时按 Escape 触发 onDisarm 并拦截事件传播 (A-03)', () => {
    const root = document.createElement('div');
    const allowBtn = document.createElement('button');
    root.appendChild(allowBtn);
    document.body.appendChild(root);

    const onEnterAllow = vi.fn();
    const onDisarm = vi.fn();

    renderHook(() =>
      useApprovalKeyboard({
        rootRef: { current: root },
        allowBtnRef: { current: allowBtn },
        confirmArmed: true,
        busy: false,
        msgId: 'msg-1',
        onDisarm,
        onEnterAllow,
      })
    );

    allowBtn.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    const prevented = !allowBtn.dispatchEvent(event);

    expect(onDisarm).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it('输入法合成态（isComposing / keyCode 229）下按 Escape 不触发 onDisarm', () => {
    const root = document.createElement('div');
    const allowBtn = document.createElement('button');
    root.appendChild(allowBtn);
    document.body.appendChild(root);

    const onEnterAllow = vi.fn();
    const onDisarm = vi.fn();

    renderHook(() =>
      useApprovalKeyboard({
        rootRef: { current: root },
        allowBtnRef: { current: allowBtn },
        confirmArmed: true,
        busy: false,
        msgId: 'msg-1',
        onDisarm,
        onEnterAllow,
      })
    );

    allowBtn.focus();
    const composingEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEvent, 'isComposing', { value: true });
    allowBtn.dispatchEvent(composingEvent);

    expect(onDisarm).not.toHaveBeenCalled();
  });
});
