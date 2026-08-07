// @vitest-environment jsdom
/**
 * usePointerDragBase 指针捕获兜底测试（P1-F5 拖拽悬挂）。
 *
 * 缺陷（F7 F10）：基座 start 时未 setPointerCapture，也无一等 lostpointercapture /
 * window blur 兜底监听。指针移出 WebView（桌面窗口边缘）后释放时 pointerup
 * 不再派发 → phase 悬挂在 active（isDragging 恒 true、body class 残留）。
 *
 * 红测试断言（修复前无监听，派发后状态不复位必红）：
 * 1. lostpointercapture 派发 → isDragging 复位 + onDrop(cancelled=true) + onGestureEnd('cancel')
 * 2. window blur 派发 → 同上（兜底二）
 * 3. 正常 pointerup 路径回归：cancelled=false 提交
 *
 * 防作弊（PS-05 §三.2 T5.5）：禁止 mock endGesture 自身或直接调 endGesture 断言复位——
 * 本文件全部经 lostpointercapture / blur / pointerup 事件触发。
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePointerDragBase, DRAG_THRESHOLD_PX } from './usePointerDragBase';

interface TestPayload {
  id: string;
}

const PAYLOAD: TestPayload = { id: 'leaf-a' };

/** 构造 React.PointerEvent：真实 DOM 元素作 currentTarget，走 setPointerCapture 路径 */
function makePointerEvent(
  clientX: number,
  clientY: number,
  options: { pointerId?: number; button?: number } = {}
): React.PointerEvent {
  const el = document.createElement('div');
  return {
    button: options.button ?? 0,
    pointerId: options.pointerId ?? 1,
    clientX,
    clientY,
    currentTarget: el,
    target: el,
  } as unknown as React.PointerEvent;
}

function setup() {
  const onDragStart = vi.fn();
  const onDragMove = vi.fn();
  const onDrop = vi.fn();
  const onCancel = vi.fn();
  const onGestureEnd = vi.fn();
  const { result } = renderHook(() =>
    usePointerDragBase<TestPayload>({
      onDragStart,
      onDragMove,
      onDrop,
      onCancel,
      onGestureEnd,
    })
  );
  return { result, onDragStart, onDragMove, onDrop, onCancel, onGestureEnd };
}

/** 标准启动流程：start(button=0) → 跨阈值 pointermove 进入 active */
function enterActive(
  result: ReturnType<typeof setup>['result'],
  offset = DRAG_THRESHOLD_PX + 5
): void {
  act(() => {
    result.current.start(PAYLOAD, makePointerEvent(0, 0));
  });
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: offset,
        clientY: 0,
        pointerId: 1,
      })
    );
  });
  expect(result.current.isDragging).toBe(true);
}

describe('usePointerDragBase 指针捕获兜底（P1-F5）', () => {
  it('lostpointercapture 兜底：捕获丢失 → 拖拽结束不悬挂（cancelled=true）', () => {
    const { result, onDrop, onGestureEnd } = setup();
    enterActive(result);

    // 不派发 pointerup：指针移出 WebView 释放，捕获丢失（lostpointercapture）
    act(() => {
      window.dispatchEvent(new Event('lostpointercapture'));
    });

    expect(result.current.isDragging).toBe(false);
    expect(onDrop).toHaveBeenCalledWith(
      PAYLOAD,
      DRAG_THRESHOLD_PX + 5,
      0,
      true
    );
    expect(onGestureEnd).toHaveBeenCalledWith(PAYLOAD, 'cancel');
  });

  it('window blur 兜底：失焦 → 拖拽结束不悬挂（cancelled=true）', () => {
    const { result, onDrop, onGestureEnd } = setup();
    enterActive(result);

    // 不派发 pointerup：窗口失焦（blur）后指针事件丢失
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(result.current.isDragging).toBe(false);
    expect(onDrop).toHaveBeenCalledWith(
      PAYLOAD,
      DRAG_THRESHOLD_PX + 5,
      0,
      true
    );
    expect(onGestureEnd).toHaveBeenCalledWith(PAYLOAD, 'cancel');
  });

  it('正常 pointerup 路径不回归：cancelled=false 提交', () => {
    const { result, onDrop, onGestureEnd } = setup();
    enterActive(result);

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    });

    expect(result.current.isDragging).toBe(false);
    expect(onDrop).toHaveBeenCalledWith(PAYLOAD, 0, 0, false);
    expect(onGestureEnd).toHaveBeenCalledWith(PAYLOAD, 'drop');
  });
});
