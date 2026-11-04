// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  CHAT_SCROLL_PAD_BOTTOM,
  CHAT_SCROLL_PAD_TOP,
  CHAT_SCROLL_TAIL_BUFFER_MAX_PX,
  CHAT_SCROLL_TAIL_BUFFER_MIN_PX,
  chatSpacerHeight,
  contentOffsetToDocOffset,
  readStreamPadX,
  readStreamPadding,
  resolveTailBufferPx,
  resolveTailBufferRampStepPx,
  resolveTailBufferTargetPx,
} from './chatScrollGeometry';

describe('chatScrollGeometry', () => {
  it('spacer = padTop + content + padBottom', () => {
    expect(chatSpacerHeight(1000)).toBe(
      CHAT_SCROLL_PAD_TOP + 1000 + CHAT_SCROLL_PAD_BOTTOM
    );
  });

  it('空内容仍有顶/底衬（避免 sticky 遮挡与贴边）', () => {
    expect(chatSpacerHeight(0)).toBe(
      CHAT_SCROLL_PAD_TOP + CHAT_SCROLL_PAD_BOTTOM
    );
    expect(chatSpacerHeight(-10)).toBe(
      CHAT_SCROLL_PAD_TOP + CHAT_SCROLL_PAD_BOTTOM
    );
  });

  it('内容偏移映射到文档坐标', () => {
    expect(contentOffsetToDocOffset(0)).toBe(CHAT_SCROLL_PAD_TOP);
    expect(contentOffsetToDocOffset(120)).toBe(CHAT_SCROLL_PAD_TOP + 120);
  });

  it('R12：spacer 第三项为尾部缓冲，默认 0 与原公式逐值一致', () => {
    expect(chatSpacerHeight(1000, 224)).toBe(
      CHAT_SCROLL_PAD_TOP + 1000 + CHAT_SCROLL_PAD_BOTTOM + 224
    );
    expect(chatSpacerHeight(1000, -5)).toBe(chatSpacerHeight(1000));
    expect(chatSpacerHeight(1000, Number.NaN)).toBe(chatSpacerHeight(1000));
  });

  it('R12：resolveTailBufferPx = clamp(160, 28% × 视口高, 360)', () => {
    // 比例段为浮点结果（0.28 非二进制精确值），以 1e-6 精度断言；钳制段为精确值
    expect(resolveTailBufferPx(600)).toBeCloseTo(168, 6);
    expect(resolveTailBufferPx(800)).toBeCloseTo(224, 6);
    expect(resolveTailBufferPx(1080)).toBeCloseTo(302.4, 6);
    expect(resolveTailBufferPx(400)).toBe(CHAT_SCROLL_TAIL_BUFFER_MIN_PX);
    expect(resolveTailBufferPx(2000)).toBe(CHAT_SCROLL_TAIL_BUFFER_MAX_PX);
  });

  it('R12b：尾部缓冲目标由轮次窗口裁决——窗口外恒 0、窗口内只随视口高（无溢出门）', () => {
    // 静止 / 阅读态：窗口外目标恒 0，消息可滑到物理真底
    expect(
      resolveTailBufferTargetPx({ turnActive: false, viewportHeight: 800 })
    ).toBe(0);
    expect(
      resolveTailBufferTargetPx({ turnActive: false, viewportHeight: 1080 })
    ).toBe(0);
    // 窗口内：目标 = clamp(160, 28% × 视口高, 360)，只随视口高（外生量，无测高反馈环）
    expect(
      resolveTailBufferTargetPx({ turnActive: true, viewportHeight: 800 })
    ).toBeCloseTo(224, 6);
    expect(
      resolveTailBufferTargetPx({ turnActive: true, viewportHeight: 1080 })
    ).toBeCloseTo(302.4, 6);
    // 无溢出门：短会话（内容装得下）发送同样张开，临时可滚区即发送上推的本意
    expect(
      resolveTailBufferTargetPx({ turnActive: true, viewportHeight: 400 })
    ).toBe(CHAT_SCROLL_TAIL_BUFFER_MIN_PX);
    expect(
      resolveTailBufferTargetPx({ turnActive: true, viewportHeight: 2000 })
    ).toBe(CHAT_SCROLL_TAIL_BUFFER_MAX_PX);
  });

  it('R12：斜坡单帧步长 ≤ max(内容增量×25%, 12) 且 ≤24，且不超过剩余量', () => {
    expect(resolveTailBufferRampStepPx(0, 100)).toBe(12);
    expect(resolveTailBufferRampStepPx(40, 100)).toBe(12);
    expect(resolveTailBufferRampStepPx(96, 100)).toBe(24);
    expect(resolveTailBufferRampStepPx(200, 100)).toBe(24);
    expect(resolveTailBufferRampStepPx(200, 10)).toBe(10);
    expect(resolveTailBufferRampStepPx(0, 0)).toBe(0);
  });

  it('readStreamPadX 遵循 CSS 变量 SSOT 与 20px 安全回退', () => {
    expect(readStreamPadX(null)).toBe(20);

    const el = document.createElement('div');
    el.style.setProperty('--stream-pad-x', '24px');
    document.body.appendChild(el);
    expect(readStreamPadX(el)).toBe(24);

    const legacyEl = document.createElement('div');
    legacyEl.style.setProperty('--chat-stream-pad-x', '18px');
    document.body.appendChild(legacyEl);
    expect(readStreamPadX(legacyEl)).toBe(18);

    document.body.removeChild(el);
    document.body.removeChild(legacyEl);
  });

  it('readStreamPadding 彻底清除未定义变量引用与虚假 fallback，保持单源几何真理', () => {
    // null 目标回退至 readStreamPadX SSOT
    expect(readStreamPadding(null)).toEqual({ padStart: 20, padEnd: 20 });

    // 未设置 padding 的元素同样回退至 readStreamPadX
    const emptyEl = document.createElement('div');
    document.body.appendChild(emptyEl);
    expect(readStreamPadding(emptyEl)).toEqual({ padStart: 20, padEnd: 20 });

    // 真实盒模型 computed padding 正确度量
    const customEl = document.createElement('div');
    customEl.style.paddingLeft = '20px';
    customEl.style.paddingRight = '48px';
    document.body.appendChild(customEl);
    expect(readStreamPadding(customEl)).toEqual({ padStart: 20, padEnd: 48 });

    document.body.removeChild(emptyEl);
    document.body.removeChild(customEl);
  });
});
