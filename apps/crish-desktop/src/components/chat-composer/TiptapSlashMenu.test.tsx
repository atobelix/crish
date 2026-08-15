// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  TiptapSlashMenu,
  isValidClientRect,
  isCursorVisibleInField,
} from './TiptapSlashMenu';
import { measureCursorLineBox } from './SlashExtension';

describe('LineBox Geometric Clearance & No-Occlusion Assertion (WO-13)', () => {
  it('should construct a LineBox DOMRect containing real physical line-height', () => {
    const mockView = {
      coordsAtPos: vi.fn().mockReturnValue({
        top: 300,
        bottom: 320.3,
        left: 150,
        right: 150,
      }),
    };

    const rect = measureCursorLineBox(mockView as any, 10, 1);

    expect(rect.top).toBe(300);
    expect(rect.bottom).toBe(320.3);
    expect(rect.height).toBeCloseTo(20.3, 1);
    expect(rect.width).toBeGreaterThanOrEqual(2);
    expect(rect.left).toBe(150);
  });

  it('should guarantee +8px physical clearance when side="top"', () => {
    const cursorTop = 300;
    const cursorBottom = 320.3;
    const sideOffset = 8;
    const popoverHeight = 240;

    const anchorRect = new DOMRect(150, cursorTop, 2, cursorBottom - cursorTop);

    // Floating UI side="top" 放置方程
    const popoverY = anchorRect.top - popoverHeight - sideOffset;
    const popoverBottom = popoverY + popoverHeight; // 300 - 8 = 292

    const clearance = anchorRect.top - popoverBottom;
    expect(clearance).toBe(8); // 必须具有确切 8px 正向安全间隙，严禁 <= 0
  });

  it('should handle null or invalid view safely without throwing', () => {
    const rectNull = measureCursorLineBox(null, 0);
    expect(rectNull.width).toBe(0);
    expect(rectNull.height).toBe(0);

    const rectInvalid = measureCursorLineBox({} as any, 0);
    expect(rectInvalid.width).toBe(0);
    expect(rectInvalid.height).toBe(0);
  });

  it('should enforce fallback minimum height (16px) and width (2px)', () => {
    const mockViewZero = {
      coordsAtPos: vi.fn().mockReturnValue({
        top: 100,
        bottom: 100,
        left: 50,
        right: 50,
      }),
    };
    const rect = measureCursorLineBox(mockViewZero as any, 0, 1);
    expect(rect.height).toBe(16);
    expect(rect.width).toBe(2);
  });
});

describe('Rect Validity & Zero-Point Non-Poisoning Assertion (WO-14)', () => {
  it('should accept valid (0, 0, 2, 20) viewport origin rect without fallback to editorDom', () => {
    const originRect = new DOMRect(0, 0, 2, 20);
    expect(isValidClientRect(originRect)).toBe(true);
  });

  it('should accept (0, 0, 0, 0) as valid geometric rect structure', () => {
    const zeroRect = new DOMRect(0, 0, 0, 0);
    expect(isValidClientRect(zeroRect)).toBe(true);
  });

  it('should reject non-finite rects and non-rect inputs', () => {
    expect(
      isValidClientRect({ top: NaN, left: 0, width: 10, height: 10 })
    ).toBe(false);
    expect(
      isValidClientRect({ top: Infinity, left: 0, width: 10, height: 10 })
    ).toBe(false);
    expect(isValidClientRect({ top: 0, left: 0, width: -1, height: 10 })).toBe(
      false
    );
    expect(isValidClientRect({ top: 0, left: 0, width: 10, height: -5 })).toBe(
      false
    );
    expect(isValidClientRect(null)).toBe(false);
    expect(isValidClientRect(undefined)).toBe(false);
    expect(isValidClientRect('invalid')).toBe(false);
    expect(isValidClientRect(123)).toBe(false);
  });
});

describe('Scroll Out-of-Bounds Visibility Assertion (WO-14)', () => {
  it('should detect cursor scrolled out of visible editor field', () => {
    const mockField = document.createElement('div');
    mockField.getBoundingClientRect = vi.fn().mockReturnValue(
      new DOMRect(100, 500, 600, 200) // top: 500, bottom: 700
    );

    // 1. 光标在可视区内 (top: 550, bottom: 570)
    const insideCursor = new DOMRect(120, 550, 2, 20);
    expect(isCursorVisibleInField(insideCursor, mockField)).toBe(true);

    // 2. 光标向上滚出可视区 (top: 450, bottom: 470 < 500 - 4)
    const scrolledAboveCursor = new DOMRect(120, 450, 2, 20);
    expect(isCursorVisibleInField(scrolledAboveCursor, mockField)).toBe(false);

    // 3. 光标向下滚出可视区 (top: 720 > 700 + 4)
    const scrolledBelowCursor = new DOMRect(120, 720, 2, 20);
    expect(isCursorVisibleInField(scrolledBelowCursor, mockField)).toBe(false);

    // 4. fieldElement 为空时默认可见
    expect(isCursorVisibleInField(insideCursor, null)).toBe(true);
  });
});

describe('CJK IME Composition State Anti-Hijack Assertion (WO-19)', () => {
  it('should pass through Enter, ArrowDown, ArrowUp, Space during isComposing', () => {
    let menuRef: any;
    const onSelect = vi.fn();
    const onClose = vi.fn();

    const items = [
      { id: '1', title: 'Help', command: onSelect },
      { id: '2', title: 'Clear', command: onSelect },
    ];

    render(
      <TiptapSlashMenu
        ref={(r) => {
          menuRef = r;
        }}
        isOpen={true}
        items={items}
        command={onSelect}
        onClose={onClose}
        clientRect={new DOMRect(100, 100, 2, 20)}
      />
    );

    // 1. 模拟输入法合成态下的 Enter (拼音确认)
    const imeEnterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
    });
    Object.defineProperty(imeEnterEvent, 'isComposing', { value: true });

    const handledEnter = menuRef.onKeyDown({ event: imeEnterEvent });
    expect(handledEnter).toBe(false); // 必须放行给输入法
    expect(onSelect).not.toHaveBeenCalled(); // 绝不触发斜杠命令执行

    // 2. 模拟输入法合成态下的 ArrowDown (候选词挑选)
    const imeArrowDownEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      keyCode: 229,
    });
    Object.defineProperty(imeArrowDownEvent, 'isComposing', { value: true });

    const handledArrow = menuRef.onKeyDown({ event: imeArrowDownEvent });
    expect(handledArrow).toBe(false); // 必须放行给输入法选词

    // 3. 模拟输入法合成态下的 Escape (取消拼音)
    const imeEscEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 229,
    });
    Object.defineProperty(imeEscEvent, 'isComposing', { value: true });

    const handledEsc = menuRef.onKeyDown({ event: imeEscEvent });
    expect(handledEsc).toBe(false); // 放行给输入法取消拼音
    expect(onClose).not.toHaveBeenCalled(); // 绝不关闭 Slash 菜单

    // 4. 模拟 Windows IME Process 键（keyCode 229）
    const processEvent = new KeyboardEvent('keydown', {
      key: 'Process',
      keyCode: 229,
    });
    const handledProcess = menuRef.onKeyDown({ event: processEvent });
    expect(handledProcess).toBe(false);
  });

  it('should normally handle keys in non-composing state', () => {
    let menuRef: any;
    const onSelect = vi.fn();
    const onClose = vi.fn();

    const items = [
      { id: '1', title: 'Help', command: onSelect },
      { id: '2', title: 'Clear', command: onSelect },
    ];

    render(
      <TiptapSlashMenu
        ref={(r) => {
          menuRef = r;
        }}
        isOpen={true}
        items={items}
        command={onSelect}
        onClose={onClose}
        clientRect={new DOMRect(100, 100, 2, 20)}
      />
    );

    // Arrow navigation
    const arrowDownEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      keyCode: 40,
    });
    const handledDown = menuRef.onKeyDown({ event: arrowDownEvent });
    expect(handledDown).toBe(true);

    const arrowUpEvent = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      keyCode: 38,
    });
    const handledUp = menuRef.onKeyDown({ event: arrowUpEvent });
    expect(handledUp).toBe(true);

    // Enter selection
    const normalEnterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 13,
    });
    const handled = menuRef.onKeyDown({ event: normalEnterEvent });
    expect(handled).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(items[0]);

    // Escape closing
    const normalEscEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 27,
    });
    const handledEsc = menuRef.onKeyDown({ event: normalEscEvent });
    expect(handledEsc).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});
